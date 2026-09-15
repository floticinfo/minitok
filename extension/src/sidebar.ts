import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn, ChildProcessWithoutNullStreams, execFile, execFileSync } from "node:child_process";
import * as os from "node:os";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { cliPath, mcpCommand, mcpEnvironment, configuredMcpScopes, ensureMcpAuthToken, workspacePath, requireTrustedWorkspace, autoApprove, spawnSpec, spawnOptionsFor, npmSpawnSpec, normalizeProviderName } from "./workspace";
import { checkEntitlement, invalidateEntitlementCache, requireEntitlement } from "./entitlement";
import { authErrorText, deviceLogin, logoutExtension, refreshExtensionSession } from "./device-auth";
import { redactSensitiveText } from "./redaction";

function cliRelease(context: vscode.ExtensionContext) {
  const release = context.extension.packageJSON.minitok as { cliPackage?: unknown; cliVersion?: unknown } | undefined;
  return { packageName: typeof release?.cliPackage === "string" ? release.cliPackage : "@flotic/minitok", version: typeof release?.cliVersion === "string" ? release.cliVersion : "0.0.0" };
}

const redactTaskText = redactSensitiveText;

function taskRecord(task: string) {
  const preview = redactTaskText(task.trim().slice(0, 300));
  const record: Record<string, unknown> = {
    taskPreview: preview,
    taskHash: `sha256:${createHash("sha256").update(task, "utf8").digest("hex")}`,
  };
  if (vscode.workspace.getConfiguration("minitok").get<boolean>("storeTaskText", false)) record.task = task;
  return record;
}

const redactOutputText = redactSensitiveText;

function redactTaskArgs(args: string[], task: string) {
  if (!task) return args;
  return args.map(value => value.includes(task) ? value.replaceAll(task, "[task redacted]") : value);
}

function acquireMcpConfigLock(configPath: string) {
  const lockPath = `${configPath}.lock`;
  const owner = { pid: process.pid, nonce: randomUUID(), startedAt: new Date().toISOString() };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(lockPath, "wx", 0o600);
      try { fs.writeFileSync(fd, `${JSON.stringify(owner)}\n`, "utf8"); } finally { fs.closeSync(fd); }
      return { release: () => { try { const current = JSON.parse(fs.readFileSync(lockPath, "utf8")); if (current.pid === owner.pid && current.nonce === owner.nonce) fs.unlinkSync(lockPath); } catch {} } };
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
      try {
        const current = JSON.parse(fs.readFileSync(lockPath, "utf8")) as { pid?: number };
        if (typeof current.pid === "number") {
          // A live Extension Host must never reclaim its own lock: another
          // concurrent webview action may still own it. The nonce is per write,
          // so PID equality is not proof that this caller owns the lock.
          if (current.pid === process.pid) throw new Error("MCP config is busy");
          try { process.kill(current.pid, 0); throw new Error("MCP config is busy"); } catch (probeError: any) { if (probeError.message === "MCP config is busy" || probeError.code === "EPERM") throw new Error("MCP config is busy"); }
        }
        fs.unlinkSync(lockPath);
      } catch (probeError: any) {
        if (probeError.message === "MCP config is busy" || probeError.code === "EPERM") throw probeError;
        try { fs.unlinkSync(lockPath); } catch {}
      }
    }
  }
  throw new Error("MCP config is busy");
}

/** Default approval window: how long a proposed change waits for an answer. */
const APPROVAL_TIMEOUT_MS = 30 * 60 * 1000;
/** Extra time a run gets after that window before the sidebar kills it. */
const RUN_TIMEOUT_MARGIN_MS = 5 * 60 * 1000;

/**
 * Timeouts for a sidebar run.
 *
 * The approval timeout and the process kill timer were the same 30 minutes, so an
 * answer given at minute 29:59 raced the kill: the run was terminated while the
 * approve response was being written, and the work was thrown away. The kill timer
 * now defaults to the approval timeout plus a margin, and both are configurable
 * (`minitok.approvalTimeoutMs`, `minitok.runTimeoutMs`).
 */
function runTimeouts() {
  const config = vscode.workspace.getConfiguration("minitok");
  const positive = (value: unknown, fallback: number): number => typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
  const approvalMs = positive(config.get("approvalTimeoutMs"), APPROVAL_TIMEOUT_MS);
  return { approvalMs, runMs: positive(config.get("runTimeoutMs"), approvalMs + RUN_TIMEOUT_MARGIN_MS) };
}

export class minitokSidebar implements vscode.WebviewViewProvider {
  public static readonly viewType = "minitok.sidebar";
  private view?: vscode.WebviewView;
  private readonly output = vscode.window.createOutputChannel("minitok");
  private process?: ChildProcessWithoutNullStreams;
  private mcpProcess?: ChildProcessWithoutNullStreams;
  private approvalFile?: string;
  private activeRunId?: string;
  private activeRunStartedAt?: string;
  private latestCliVersion?: string;
  constructor(private readonly extensionUri: vscode.Uri, private readonly context: vscode.ExtensionContext) {}
  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [this.extensionUri] };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage(message => {
      void this.handle(message).catch(error => {
        this.view?.webview.postMessage({ type: "result", ok: false, text: redactOutputText(String(error)) });
      });
    });
  }

  private async execute(args: string[], cwd: string | undefined): Promise<string> {
    requireTrustedWorkspace(cwd);
    const cli = cliPath();
    const provider = normalizeProviderName(this.context.workspaceState.get<string>("minitok.setting.provider", ""));
    const model = this.context.workspaceState.get<string>("minitok.setting.model", "");
    const roles = ["plan", "work", "review", "intel"];
    const roleEnv: Record<string, string> = {};
    for (const role of roles) {
      const roleProvider = normalizeProviderName(this.context.workspaceState.get<string>(`minitok.setting.${role}.provider`, ""));
      const roleModel = this.context.workspaceState.get<string>(`minitok.setting.${role}.model`, "");
      if (roleProvider) roleEnv[`minitok_${role}_provider`] = roleProvider;
      if (roleModel) roleEnv[`minitok_${role}_model`] = roleModel;
    }
    const apiKey = await this.context.secrets.get("minitok.secret.providerApiKey");
    const customBaseUrl = await this.context.secrets.get("minitok.secret.customBaseUrl");
    if (model) for (const role of roles) if (!roleEnv[`minitok_${role}_model`]) roleEnv[`minitok_${role}_model`] = model;
    const env: NodeJS.ProcessEnv = { ...process.env, ...roleEnv, ...(provider ? { minitok_default_provider: provider } : {}) };
    if (apiKey && provider === "anthropic") env.ANTHROPIC_API_KEY = apiKey;
    if (apiKey && provider === "openai") env.OPENAI_API_KEY = apiKey;
    if (apiKey && provider === "google") env.GOOGLE_API_KEY = apiKey;
    if (apiKey && provider === "custom") env.OPENAI_API_KEY = apiKey;
    if (customBaseUrl && provider === "custom") env.MINITOK_OPENAI_COMPATIBLE_BASE_URL = customBaseUrl;
    const timeouts = runTimeouts();
    if (cwd && args[0] === "run" && !args.includes("--dry-run") && !args.includes("--auto-accept")) {
      // autoApprove() adds --auto-accept just below, and auto-accept now takes
      // precedence over an approval file (loop.promptConfirmation). Passing both
      // would only produce an unused request file, so it is not written at all.
      this.approvalFile = path.join(cwd, ".minitok", "extension-approval.json");
      args.push("--approval-file", this.approvalFile, "--approval-timeout-ms", String(timeouts.approvalMs));
    }
    return new Promise((resolve, reject) => {
      const processSpec = spawnSpec(cli, args);
      this.output.appendLine(`[spawn] cli command=${JSON.stringify(processSpec.command)} args=${JSON.stringify(redactTaskArgs(processSpec.args, args[1] === "run" ? args[2] : ""))} cwd=${JSON.stringify(cwd)}`);
      let child: ChildProcessWithoutNullStreams;
      try { child = spawn(processSpec.command, processSpec.args, spawnOptionsFor(processSpec, { cwd, env, detached: process.platform !== "win32" })); } catch (error) { reject(error); return; }
      this.process = child;
      let output = "";
      let error = "";
      const consume = (chunk: Buffer) => {
        const text = chunk.toString();
        output += text;
        this.output.append(redactOutputText(text));
        for (const line of text.split(/\r?\n/).filter(Boolean)) this.progress(redactOutputText(line));
      };
      child.stdout.on("data", consume);
      child.stderr.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        error += text;
        this.output.append(redactOutputText(text));
        for (const line of text.split(/\r?\n/).filter(Boolean)) this.view?.webview.postMessage({ type: "log", stream: "stderr", text: redactOutputText(line) });
      });
      child.on("error", errorValue => { this.process = undefined; reject(errorValue); });
      const timeout = setTimeout(() => {
        this.stopProcess();
        this.process = undefined;
        reject(new Error(`minitok run timed out after ${Math.round(timeouts.runMs / 60000)} minutes`));
      }, timeouts.runMs);
      child.on("close", code => {
        clearTimeout(timeout);
        this.process = undefined;
        if (code === 0) resolve(output);
        else reject(new Error(error || output || `minitok exited with code ${code}`));
      });
    });
  }
  private stopChild(child?: ChildProcessWithoutNullStreams) {
    if (!child || child.killed) return;
    if (process.platform === "win32") {
      try { execFileSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, timeout: 10000 }); } catch { child.kill(); }
    } else {
      try { process.kill(-child.pid!, "SIGTERM"); } catch { child.kill("SIGTERM"); }
    }
  }
  /**
   * npm is a batch shim on Windows, so it needs the same launch spec as the CLI:
   * `execFile("npm", ...)` throws EINVAL on Node 18.20+ and the update banner
   * silently never appeared.
   */
  private runNpm(args: string[], timeout: number, done: (error: Error | null, stdout: string, stderr: string) => void) {
    const spec = npmSpawnSpec(process.platform, args, { comspec: process.env.ComSpec });
    execFile(spec.command, spec.args, { timeout, windowsHide: true, windowsVerbatimArguments: spec.windowsVerbatimArguments }, (error, stdout, stderr) => done(error as Error | null, String(stdout), String(stderr)));
  }
  private stopProcess() {
    this.stopChild(this.process);
  }
  dispose() {
    this.stopChild(this.process);
    this.stopChild(this.mcpProcess);
    this.output.dispose();
  }
  private progress(line: string) {
    const stage = /Gathering repository intelligence|Planning|Implementing|Running verification|Reviewing|Evaluating goal progress/.exec(line)?.[0];
    if (stage) this.view?.webview.postMessage({ type: "progress", stage });
    if (line.startsWith("MINITOK_APPROVAL_REQUEST ")) {
      try { this.view?.webview.postMessage({ type: "approval-request", request: JSON.parse(line.slice("MINITOK_APPROVAL_REQUEST ".length)) }); }
      catch { this.view?.webview.postMessage({ type: "log", stream: "stdout", text: "Invalid approval request received from minitok" }); }
    }
    const summary = /Summary:.*?(\d+) cycles,.*?(\d[\d,]*) tokens.*?(?:, ~\$(\d+(?:\.\d+)?))?/.exec(line);
    if (summary) this.view?.webview.postMessage({ type: "summary", cycles: summary[1], tokens: summary[2], cost: summary[3] || "0" });
  }
  private async handle(message: { command: string; task?: string; email?: string; password?: string; provider?: string; target?: string; checkpoint?: string; key?: string; settings?: Record<string, unknown>; secrets?: Record<string, string> }) {
    if (message?.command === "auth-status") { const session = await refreshExtensionSession(this.context); if (!session) { invalidateEntitlementCache(); this.view?.webview.postMessage({ type: "auth-state", state: "signed-out", ok: false, authenticated: false, entitled: false, text: "Sign in to continue." }); return; } invalidateEntitlementCache(); const result = await checkEntitlement(); this.view?.webview.postMessage({ type: "auth-state", state: result.allowed ? "authenticated" : "not-entitled", ok: result.allowed, authenticated: true, entitled: result.allowed, text: redactOutputText(result.allowed ? `Signed in with ${result.plan} plan.` : `Entitlement error: ${result.message || "An active paid plan is required."}`) }); return; }
    if (message?.command === "device-login") { try { await deviceLogin(this.context, text => this.view?.webview.postMessage({ type: "auth-state", state: "checking", ok: false, authenticated: false, entitled: false, text: redactOutputText(text) })); invalidateEntitlementCache(); const result = await checkEntitlement(); if (!result.allowed) { this.view?.webview.postMessage({ type: "auth-state", state: "not-entitled", ok: false, authenticated: true, entitled: false, text: redactOutputText(`Entitlement error: ${result.message || "An active paid plan is required."}`) }); return; } this.view?.webview.postMessage({ type: "auth-state", state: "authenticated", ok: true, authenticated: true, entitled: true, text: redactOutputText(`Signed in with ${result.plan} plan.`) }); } catch (error) { this.view?.webview.postMessage({ type: "auth-state", state: "refresh-failed", ok: false, authenticated: false, entitled: false, text: redactOutputText(authErrorText(error)) }); } return; }
    if (message?.command === "device-logout") { const remoteRevoked = await logoutExtension(this.context); invalidateEntitlementCache(); this.view?.webview.postMessage({ type: "auth-state", state: "signed-out", ok: false, authenticated: false, entitled: false, text: redactOutputText(remoteRevoked ? "Signed out locally and from the server." : "Signed out locally. The server session could not be revoked; sign in again when online.") }); return; }
    if (message?.command === "customer-login") { await this.customerLogin(message.email, message.password); return; }
    // Dry run still performs provider planning and can expose paid workflow
    // output, so it intentionally remains entitlement-gated rather than becoming
    // an accidental free execution path.
    const entitlementCommands = new Set(["run", "dry-run"]);
    if (entitlementCommands.has(message?.command)) {
      try { await requireEntitlement(); }
      catch (error) { this.view?.webview.postMessage({ type: "entitlement", ok: false, text: redactOutputText(String(error)) }); return; }
    }
    const commands = new Set(["device-login", "device-logout", "show-output", "stop", "interrupt", "approve", "reject", "open-evidence", "open-diff", "restore-session", "mcp-status", "mcp-connect", "mcp-list", "history", "sessions", "clear-history", "info", "discover-models", "activate", "manage-plan", "attach-file", "attach-folder", "attach-problems", "settings", "save-settings",  "update", "run", "dry-run"]);
    if (!message || typeof message.command !== "string" || !commands.has(message.command)) { this.view?.webview.postMessage({ type: "result", ok: false, text: "Unsupported command" }); return; }
    if (message.task !== undefined && (typeof message.task !== "string" || message.task.length > 20000)) { this.view?.webview.postMessage({ type: "result", ok: false, text: "Task is invalid or too long" }); return; }
    const cwd = workspacePath();
    if (message.command === "show-output") { this.output.show(true); return; }
    if (message.command === "stop" || message.command === "interrupt") { this.stopProcess(); this.view?.webview.postMessage({ type: "stopped", text: message.command === "stop" ? "Run stopped." : "Run interrupted." }); return; }
    if (message.command === "approve" || message.command === "reject") {
      if (this.approvalFile) {
        fs.mkdirSync(path.dirname(this.approvalFile), { recursive: true });
        let request: { nonce?: string; run_id?: string | null } = {};
        try { request = JSON.parse(fs.readFileSync(this.approvalFile, "utf8")); } catch { this.view?.webview.postMessage({ type: "result", ok: false, text: "Approval request is unavailable." }); return; }
        const response = `${this.approvalFile}.response`;
        const temp = `${response}.tmp-${process.pid}-${randomUUID()}`;
        try {
          fs.writeFileSync(temp, `${JSON.stringify({ decision: message.command, nonce: request.nonce, run_id: request.run_id })}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
          fs.renameSync(temp, response);
        } catch (error) {
          try { fs.unlinkSync(temp); } catch {}
          throw error;
        }
      }
      this.view?.webview.postMessage({ type: "approval", decision: message.command }); return;
    }
    if (message.command === "open-evidence") { if (cwd) await this.openEvidence(cwd); return; }
    if (message.command === "open-diff") { if (cwd) await this.openDiff(cwd); return; }
    if (message.command === "restore-session") { if (cwd && message.checkpoint) await this.restoreCheckpoint(cwd, message.checkpoint); return; }
    if (message.command === "mcp-status") { await this.checkMcpHealth(); return; }
    if (message.command === "mcp-connect") { requireTrustedWorkspace(workspacePath()); await this.connectMcp(message.target); return; }
    if (message.command === "mcp-list") { this.listMcpHosts(); return; }
    if (message.command === "history") { this.view?.webview.postMessage({ type: "history", items: this.context.workspaceState.get<Array<Record<string, unknown>>>("minitok.history", []) }); return; }
    if (message.command === "sessions") { this.view?.webview.postMessage({ type: "sessions", items: this.context.workspaceState.get<Array<Record<string, unknown>>>("minitok.history", []) }); return; }
    if (message.command === "clear-history") { await this.context.workspaceState.update("minitok.history", []); this.view?.webview.postMessage({ type: "history-cleared", text: "Local Extension run history cleared. Repository evidence, checkpoints, and patches were preserved." }); return; }
    if (message.command === "info") { await this.readInfo(cwd); return; }
    if (message.command === "discover-models") { await this.discoverModels(cwd, message.provider); return; }
    if (message.command === "activate" || message.command === "manage-plan") { await this.openBilling(message.command === "activate" ? "checkout" : "portal"); return; }
    if (message.command === "attach-file") { const uri = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: "Attach file" }); if (uri?.[0]) this.view?.webview.postMessage({ type: "attachment", value: `@file ${vscode.workspace.asRelativePath(uri[0])}` }); return; }
    if (message.command === "attach-folder") { const uri = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectMany: false, openLabel: "Attach folder" }); if (uri?.[0]) this.view?.webview.postMessage({ type: "attachment", value: `@folder ${vscode.workspace.asRelativePath(uri[0])}` }); return; }
    if (message.command === "attach-problems") { const diagnostics = vscode.languages.getDiagnostics().flatMap(([uri, items]) => items.map(item => `${vscode.workspace.asRelativePath(uri)}:${item.range.start.line + 1} ${item.message}`)); this.view?.webview.postMessage({ type: "attachment", value: redactOutputText(diagnostics.length ? `@problems\n${diagnostics.join("\n")}` : "") }); return; }
    if (message.command === "settings") { await this.readSettings(); await this.discoverModels(cwd, this.context.workspaceState.get<string>("minitok.setting.provider", "")); await this.checkUpdate(); return; }
    if (message.command === "save-settings") { await this.saveSettings(message); return; }
    if (message.command === "update") { requireTrustedWorkspace(workspacePath()); const release = cliRelease(this.context); const targetVersion = this.latestCliVersion || release.version; const answer = await vscode.window.showInformationMessage(`Update minitok to ${targetVersion}?`, "Update", "Cancel"); if (answer === "Update") this.runNpm(["install", "-g", `${release.packageName}@${targetVersion}`], 120000, (error, stdout, stderr) => this.view?.webview.postMessage({ type: "update-result", ok: !error, text: redactOutputText(error ? stderr || error.message : stdout) })); return; }
    try {
      requireTrustedWorkspace(cwd);
      if (this.process) throw new Error("A minitok run is already active");
      if (!message.task?.trim()) throw new Error("Task description required");
      const runId = randomUUID();
      const startedAt = new Date().toISOString();
      const checkpoint = cwd ? path.join(cwd, ".minitok", "checkpoints", runId) : undefined;
      if (cwd && checkpoint) {
        fs.mkdirSync(checkpoint, { recursive: true });
        await this.captureCheckpoint(cwd, checkpoint, { runId, ...taskRecord(message.task || ""), createdAt: startedAt });
      }
      this.activeRunId = runId;
      this.activeRunStartedAt = startedAt;
    const evidencePath = vscode.workspace.getConfiguration("minitok").get<string>("evidencePath", ".minitok/evidence/runs/latest.json").trim() || ".minitok/evidence/runs/latest.json";
    const args = ["run", message.task, "--repo", cwd!, "--evidence-path", evidencePath];
    if (message.command === "dry-run") args.push("--dry-run");
    else if (autoApprove()) args.push("--auto-accept");
      this.view?.webview.postMessage({ type: "started", runId });
      const text = await this.execute(args, cwd);
      const evidence = cwd ? this.readEvidence(cwd) : null;
      const patch = cwd ? this.readPatch(cwd) : null;
      const history = this.context.workspaceState.get<Array<Record<string, unknown>>>("minitok.history", []);
      const totalTokens = evidence?.tokens ? Number(evidence.tokens.input || 0) + Number(evidence.tokens.output || 0) : null;
      await this.context.workspaceState.update("minitok.history", [...history.slice(-19), { runId, ...taskRecord(message.task || ""), startedAt, completedAt: new Date().toISOString(), status: "completed", success: true, totalTokens, cost: evidence?.cost ?? null, evidencePath: cwd ? this.evidenceFile(cwd) : null, patchPath: cwd ? path.join(cwd, ".minitok", "last-run.patch") : null, checkpointPath: checkpoint }]);
      const safeText = redactOutputText(text);
      const safePatch = patch ? redactOutputText(patch) : patch;
      this.view?.webview.postMessage({ type: "result", ok: true, text: safeText, evidence, patch: safePatch }); if (safePatch) this.view?.webview.postMessage({ type: "patch", patch: safePatch });
    } catch (error) {
      const history = this.context.workspaceState.get<Array<Record<string, unknown>>>("minitok.history", []);
      const safeError = redactOutputText(String(error));
      if (this.activeRunId) await this.context.workspaceState.update("minitok.history", [...history.slice(-19), { runId: this.activeRunId, ...taskRecord(message.task || ""), startedAt: this.activeRunStartedAt, completedAt: new Date().toISOString(), status: "failed", success: false, error: safeError }]);
      this.view?.webview.postMessage({ type: "result", ok: false, text: safeError, runId: this.activeRunId });
    } finally { this.activeRunId = undefined; this.activeRunStartedAt = undefined; }
  }
  private async openBilling(kind: "checkout" | "portal") {
    const session = await refreshExtensionSession(this.context);
    if (!session?.access_token) { this.view?.webview.postMessage({ type: "billing", ok: false, text: "Sign in before managing your plan." }); return; }
    const envName = "MINITOK_EXTENSION_CUSTOMER_TOKEN";
    const env: NodeJS.ProcessEnv = { ...process.env, MINITOK_UPDATE_CHECK: "0", [envName]: session.access_token };
    const args = [kind, "--token-env", envName, "--json"];
    const spec = spawnSpec(cliPath(), args);
    execFile(spec.command, spec.args, { ...spawnOptionsFor(spec, { cwd: workspacePath(), env }), timeout: 30000 }, async (error, stdout, stderr) => {
      delete env[envName];
      if (error) { this.view?.webview.postMessage({ type: "billing", ok: false, text: redactOutputText(stderr || error.message) }); return; }
      try {
        const result = JSON.parse(String(stdout).trim()) as { checkout_url?: string; portal_url?: string };
        const target = kind === "checkout" ? result.checkout_url : result.portal_url;
        if (!target || !/^https:\/\//i.test(target)) throw new Error("Billing service returned an invalid URL");
        await vscode.env.openExternal(vscode.Uri.parse(target));
        this.view?.webview.postMessage({ type: "billing", ok: true, text: kind === "checkout" ? "Checkout opened in your browser." : "Billing portal opened in your browser." });
      } catch (parseError) { this.view?.webview.postMessage({ type: "billing", ok: false, text: redactOutputText(parseError instanceof Error ? parseError.message : String(parseError)) }); }
    });
  }
  private async customerLogin(email?: string, password?: string) {
    if (!email?.trim() || !password) { this.view?.webview.postMessage({ type: "auth-state", ok: false, text: "Email and password are required." }); return; }
    const cwd = workspacePath();
    const env: NodeJS.ProcessEnv = { ...process.env, MINITOK_CUSTOMER_EMAIL: email.trim(), MINITOK_CUSTOMER_PASSWORD: password };
    const spec = spawnSpec(cliPath(), ["auth", "customer-login", "--email-env", "MINITOK_CUSTOMER_EMAIL", "--password-env", "MINITOK_CUSTOMER_PASSWORD"]);
    execFile(spec.command, spec.args, { ...spawnOptionsFor(spec, { cwd, env }), timeout: 30000 }, async (error, stdout, stderr) => {
      delete env.MINITOK_CUSTOMER_EMAIL; delete env.MINITOK_CUSTOMER_PASSWORD;
      if (error) { this.view?.webview.postMessage({ type: "auth-state", state: "signed-out", ok: false, authenticated: false, entitled: false, text: redactOutputText(stderr || error.message) }); return; }
      invalidateEntitlementCache();
      const result = await checkEntitlement();
      this.view?.webview.postMessage({ type: "auth-state", state: result.allowed ? "authenticated" : "not-entitled", ok: result.allowed, authenticated: true, entitled: result.allowed, text: redactOutputText(result.allowed ? `Signed in with ${result.plan} plan.` : result.message || stdout) });
    });
  }
private async discoverModels(cwd?: string, provider?: string) {
     requireTrustedWorkspace(cwd);
    const args = ["models", "--discover"];
    if (provider) args.splice(1, 0, provider);
    // cliPath() resolves the real entry point; the configured setting alone
    // defaulted to "minitok" and could not be launched on Windows.
    const spec = spawnSpec(cliPath(), args);
    execFile(spec.command, spec.args, { ...spawnOptionsFor(spec, { cwd }), timeout: 30000 }, (error, stdout, stderr) => {
      const text = redactOutputText(error ? stderr || error.message : stdout);
      const models = error ? [] : [...new Set((stdout.match(/(?:claude|gpt|o[134]|gemini|[\w-]+-\w+)[\w.:-]*/gi) || []).filter(id => !/^(models|available|provider)$/i.test(id)))];
      this.view?.webview.postMessage({ type: "models", ok: !error, text, provider: provider || "all", models });
    });
  }
  private async readInfo(cwd?: string) {
    requireTrustedWorkspace(cwd);
    const commands = [["status", "--repo", cwd!], ["doctor"], ["evolution", "status"], ["workspace", "current"]];
    const outputs: string[] = [];
    for (const args of commands) {
      try { outputs.push(`$ minitok ${args.join(" ")}\n${redactOutputText(await new Promise<string>((resolve, reject) => { const spec = spawnSpec(cliPath(), args); execFile(spec.command, spec.args, { ...spawnOptionsFor(spec, { cwd }), timeout: 15000 }, (error, stdout, stderr) => error ? reject(new Error(stderr || error.message)) : resolve(String(stdout).trim())); }))} `); }
      catch (error) { outputs.push(`$ minitok ${args.join(" ")}\n${redactOutputText(String(error))}`); }
    }
    this.view?.webview.postMessage({ type: "info", text: redactOutputText(outputs.join("\n\n")) });
  }
  private listMcpHosts() {
    const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    const configs = this.mcpConfigPaths();
    const hosts = Object.entries(configs).map(([name, configPath]) => ({ name, detected: this.safeConfigExists(configPath), configPath }));
    this.view?.webview.postMessage({ type: "mcp-hosts", hosts });
  }
  private safeConfigExists(configPath: string) {
    try { fs.lstatSync(configPath); return true; } catch { return false; }
  }
  private mcpConfigPaths() {
    const home = os.homedir();
    let vscodeUser: string;
    let claudeRoot: string;
    let cursorConfig: string;
    if (process.platform === "win32") {
      const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
      vscodeUser = path.join(appData, "Code", "User");
      claudeRoot = path.join(appData, "Claude");
      cursorConfig = path.join(home, ".cursor", "mcp.json");
    } else if (process.platform === "darwin") {
      const support = path.join(home, "Library", "Application Support");
      vscodeUser = path.join(support, "Code", "User");
      claudeRoot = path.join(support, "Claude");
      cursorConfig = path.join(home, ".cursor", "mcp.json");
    } else {
      const configHome = process.env.XDG_CONFIG_HOME || path.join(home, ".config");
      vscodeUser = path.join(configHome, "Code", "User");
      claudeRoot = path.join(configHome, "Claude");
      cursorConfig = path.join(home, ".cursor", "mcp.json");
    }
    const cursorCandidates = [cursorConfig, path.join(vscodeUser, "globalStorage", "mcp.json")];
    const cursor = cursorCandidates.find(candidate => this.safeConfigExists(candidate)) || cursorCandidates[0];
    return {
      cline: path.join(vscodeUser, "globalStorage", "saoudrizwan.claude-dev", "settings", "cline_mcp_settings.json"),
      claude: path.join(claudeRoot, "claude_desktop_config.json"),
      cursor,
    };
  }
  private async connectMcp(target?: string) {
    // Validate local permission configuration before host detection, token refresh,
    // or entitlement checks so a simple settings typo is reported directly.
    configuredMcpScopes();
    const configs = this.mcpConfigPaths();
    const candidates = target && Object.prototype.hasOwnProperty.call(configs, target) ? [target] : target ? [] : Object.keys(configs).filter(name => this.safeConfigExists(configs[name as keyof typeof configs]));
    if (!candidates.length) { this.view?.webview.postMessage({ type: "mcp-connect", ok: false, text: target ? "Unsupported MCP host." : "No supported MCP host detected." }); return; }
    const host = candidates[0] as keyof typeof configs;
    const configPath = configs[host];
    const hasBackup = this.safeConfigExists(configPath);
    const approved = await vscode.window.showInformationMessage(`Connect minitok MCP to ${host}? ${hasBackup ? "A backup will be created before changes." : "No backup will be created because the host configuration is new."}`, "Connect", "Cancel");
    if (approved !== "Connect") { this.view?.webview.postMessage({ type: "mcp-connect", ok: false, text: "Connection cancelled." }); return; }
    const token = await ensureMcpAuthToken();
    if (!token) { this.view?.webview.postMessage({ type: "mcp-connect", ok: false, text: "MCP authentication token could not be prepared." }); return; }
    try { mcpEnvironment(); await requireEntitlement(); } catch (error) { this.view?.webview.postMessage({ type: "mcp-connect", ok: false, text: redactOutputText(String(error)) }); return; }
    fs.mkdirSync(path.dirname(configPath), { recursive: true, mode: 0o700 });
    const configLock = acquireMcpConfigLock(configPath);
    let backup: string | undefined;
    try {
      // Read and validate only after the lock is held. This prevents a
      // concurrent host writer from being overwritten by a stale snapshot.
      let config: Record<string, unknown> = {};
      if (this.safeConfigExists(configPath)) {
        const stat = fs.lstatSync(configPath);
        if (stat.isSymbolicLink()) throw new Error("MCP config symlinks are not supported");
        const parsed = JSON.parse(fs.readFileSync(configPath, "utf8")) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("MCP config must be a JSON object");
        config = parsed as Record<string, unknown>;
      }
      const serversKey = config.mcpServers !== undefined ? "mcpServers" : config.servers !== undefined ? "servers" : "mcpServers";
      const existingServers = config[serversKey] ?? {};
      if (!existingServers || typeof existingServers !== "object" || Array.isArray(existingServers)) throw new Error("MCP server configuration must be an object");
      backup = `${configPath}.minitok-backup-${Date.now()}`;
      if (this.safeConfigExists(configPath)) fs.copyFileSync(configPath, backup, fs.constants.COPYFILE_EXCL);
      const configuredMcp = mcpCommand();
      const configuredEnv = mcpEnvironment();
      const existingMinitok = (existingServers as Record<string, any>).minitok;
      const existingEnv = existingMinitok && typeof existingMinitok === "object" && existingMinitok.env && typeof existingMinitok.env === "object" ? existingMinitok.env as Record<string, string> : {};
      const scopes = typeof existingEnv.MINITOK_MCP_SCOPES === "string" && existingEnv.MINITOK_MCP_SCOPES.trim() ? existingEnv.MINITOK_MCP_SCOPES : configuredEnv.MINITOK_MCP_SCOPES;
      (existingServers as Record<string, unknown>).minitok = { command: configuredMcp[0], args: configuredMcp.slice(1), env: { ...existingEnv, minitok_server_url: existingEnv.minitok_server_url || configuredEnv.minitok_server_url, MINITOK_MCP_AUTH_TOKEN_FILE: configuredEnv.MINITOK_MCP_AUTH_TOKEN_FILE, MINITOK_MCP_SCOPES: scopes }, disabled: false };
      config[serversKey] = existingServers;
      const temp = `${configPath}.tmp-${process.pid}-${randomUUID()}`;
      try {
        fs.writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
        fs.renameSync(temp, configPath);
      } catch (error) {
        try { fs.unlinkSync(temp); } catch {}
        throw error;
      }
    } finally {
      configLock.release();
    }
    this.view?.webview.postMessage({ type: "mcp-connect", ok: true, text: `Connected to ${host}. ${hasBackup && backup ? `Backup: ${path.basename(backup)}` : "Backup: none (new configuration)."}` });
  }
  private async checkMcpHealth() {
    requireTrustedWorkspace(workspacePath());
    // Scope errors are local configuration errors; surface them before token
    // rotation, entitlement lookup, or process spawning.
    configuredMcpScopes();
    const cli = cliPath();
    if (this.mcpProcess) { this.view?.webview.postMessage({ type: "mcp", ok: false, text: "MCP health check already running" }); return; }
    const configured = mcpCommand();
    if (!configured.length || !configured[0]) { this.view?.webview.postMessage({ type: "mcp", ok: false, text: "minitok MCP command is not configured" }); return; }
    const processSpec = spawnSpec(configured[0], configured.slice(1));
    // Refresh the short lived runtime token before spawning the server, so both
    // sides use the same credential instead of failing 15 minutes after setup.
    const token = await ensureMcpAuthToken();
    if (!token) { this.view?.webview.postMessage({ type: "mcp", ok: false, text: "MCP authentication token could not be prepared." }); return; }
    try { mcpEnvironment(); await requireEntitlement(); } catch (error) { this.view?.webview.postMessage({ type: "mcp", ok: false, text: redactOutputText(String(error)) }); return; }
    this.output.appendLine(`[spawn] mcp command=${JSON.stringify(processSpec.command)} args=${JSON.stringify(processSpec.args)} cwd=${JSON.stringify(workspacePath())}`);
    let mcp: ChildProcessWithoutNullStreams;
    try { mcp = spawn(processSpec.command, processSpec.args, spawnOptionsFor(processSpec, { cwd: workspacePath(), env: mcpEnvironment() })); } catch (error) { const safeError = redactOutputText(String(error)); this.output.appendLine(`[spawn] synchronous error=${safeError}`); this.view?.webview.postMessage({ type: "mcp", ok: false, text: `MCP spawn failed: ${safeError}` }); return; }
    this.mcpProcess = mcp;
    let buffer = "";
    let nextId = 1;
    let finished = false;
    let timeout: ReturnType<typeof setTimeout>;
    // Probe exactly the way a real MCP host does. The credential reaches the
    // server through mcpEnvironment() (MINITOK_MCP_AUTH_TOKEN_FILE), never
    // through request params: a host like VS Code, Claude Desktop or Cursor has
    // no way to inject one. Echoing the token here made this probe report
    // "online" while every real host failed on its first tool call.
    const send = (method: string, params: Record<string, unknown> = {}) => mcp.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params })}\n`);
    const sendNotification = (method: string, params: Record<string, unknown> = {}) => mcp.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
    const finish = (ok: boolean, text: string) => { if (finished) return; finished = true; clearTimeout(timeout); if (this.mcpProcess === mcp) this.mcpProcess = undefined; this.stopChild(mcp); this.view?.webview.postMessage({ type: "mcp", ok, text: redactOutputText(text) }); };
    timeout = setTimeout(() => finish(false, "MCP offline: handshake timed out"), 5000);
    mcp.stdout.on("data", chunk => { buffer += chunk.toString(); const lines = buffer.split(/\r?\n/); buffer = lines.pop() || ""; for (const line of lines) { try { const message = JSON.parse(line); if (message.error) finish(false, `MCP handshake error: ${message.error.message}`); else if (message.id === 1) { sendNotification("notifications/initialized"); send("tools/list"); } else if (message.id === 2) finish(true, `MCP online: ${message.result?.tools?.length || 0} tools`); } catch (error) { this.output.appendLine(redactOutputText(`MCP invalid response: ${error instanceof Error ? error.message : String(error)}`)); } } });
    mcp.on("error", error => finish(false, redactOutputText(`MCP offline: ${error.message}`)));
     send("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "minitok-sidebar", version: String(this.context.extension.packageJSON.version) } });

  }
  private execGit(cwd: string, args: string[]): Promise<string> {
    requireTrustedWorkspace(cwd);
    return new Promise((resolve, reject) => execFile("git", args, { cwd, timeout: 30000, windowsHide: true }, (error, stdout, stderr) => error ? reject(new Error(stderr || error.message)) : resolve(stdout)));
  }
  private async captureCheckpoint(cwd: string, checkpoint: string, metadata: Record<string, unknown>) {
    const [diff, status] = await Promise.all([this.execGit(cwd, ["diff", "--binary"]), this.execGit(cwd, ["status", "--short", "--untracked-files=all"])]);
    fs.writeFileSync(path.join(checkpoint, "metadata.json"), JSON.stringify({ ...metadata, repository: cwd, capturedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
    fs.writeFileSync(path.join(checkpoint, "working-tree.patch"), diff, { mode: 0o600 });
    fs.writeFileSync(path.join(checkpoint, "status.txt"), status, { mode: 0o600 });
  }
  private async restoreCheckpoint(cwd: string, checkpoint: string) {
    const patch = path.join(checkpoint, "working-tree.patch");
    if (!fs.existsSync(patch)) throw new Error("Checkpoint patch not found");
    const status = await this.execGit(cwd, ["status", "--porcelain"]);
    const answer = await vscode.window.showWarningMessage("Restore checkpoint? Current working-tree changes will be replaced.", "Restore", "Cancel");
    if (answer !== "Restore") return;
    if (status.trim()) throw new Error("Restore blocked: working tree is not clean");
    await this.execGit(cwd, ["apply", "--3way", patch]);
    this.view?.webview.postMessage({ type: "checkpoint", text: "Checkpoint restored." });
  }
  private readPatch(cwd: string) { try { return fs.readFileSync(path.join(cwd, ".minitok", "last-run.patch"), "utf8").slice(0, 200000); } catch { return null; } }
  private async openDiff(cwd: string) {
    const patch = this.readPatch(cwd);
    if (!patch) { vscode.window.showInformationMessage("No minitok patch found"); return; }
    const file = path.join(cwd, ".minitok", "last-run.patch");
    const original = await vscode.workspace.openTextDocument({ content: "", language: "diff" });
    const modified = await vscode.workspace.openTextDocument({ content: patch, language: "diff" });
    await vscode.commands.executeCommand("vscode.diff", original.uri, modified.uri, "minitok changes", { preview: false });
  }
  private evidenceFile(cwd: string) {
    const configured = vscode.workspace.getConfiguration("minitok").get<string>("evidencePath", ".minitok/evidence/runs/latest.json").trim() || ".minitok/evidence/runs/latest.json";
    const file = path.resolve(cwd, configured);
    const root = path.resolve(cwd) + path.sep;
    if (file !== path.resolve(cwd) && !file.startsWith(root)) throw new Error("minitok.evidencePath must stay inside the workspace");
    return file;
  }
  private async openEvidence(cwd: string) {

    const file = this.evidenceFile(cwd);
    if (fs.existsSync(file)) await vscode.window.showTextDocument(vscode.Uri.file(file));
    else vscode.window.showWarningMessage("No minitok evidence found");
  }
  private readEvidence(cwd: string) {
    const file = this.evidenceFile(cwd);
    try { return JSON.parse(fs.readFileSync(file, "utf8")); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new Error(`Evidence could not be read: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  private async saveSettings(message: { settings?: Record<string, unknown>; secrets?: Record<string, string> }) {
    if (message.settings) for (const [key, value] of Object.entries(message.settings)) {
      if (key === "autoApprove" || key === "storeTaskText") {
        await vscode.workspace.getConfiguration("minitok").update(key, Boolean(value), vscode.ConfigurationTarget.Workspace);
      } else if (/^(provider|model|showCost|evidencePath|enterBehavior|(?:plan|work|review|intel)\.(?:provider|model))$/.test(key)) {
        await this.context.workspaceState.update(`minitok.setting.${key}`, value);
      }
    }
    if (message.secrets) for (const [key, value] of Object.entries(message.secrets)) await this.context.secrets.store(`minitok.secret.${key}`, value);
    this.view?.webview.postMessage({ type: "settings-saved" });
  }
  private async checkUpdate() {
    requireTrustedWorkspace(workspacePath());
    const release = cliRelease(this.context);
    this.runNpm(["view", release.packageName, "version", "--json"], 10000, (error, stdout) => {
      const latest = error ? null : stdout.trim().replace(/^"|"$/g, "");
      if (latest && /^\d+\.\d+\.\d+(?:[-+].*)?$/.test(latest)) this.latestCliVersion = latest;
      this.view?.webview.postMessage({ type: "update", current: release.version, latest });
    });
  }
  private async readSettings() {
    const settings = Object.fromEntries(["provider", "model", "showCost", "evidencePath", "autoApprove", "storeTaskText", "enterBehavior", "plan.provider", "plan.model", "work.provider", "work.model", "review.provider", "review.model", "intel.provider", "intel.model"].map(key => [key, key === "autoApprove" || key === "storeTaskText" ? vscode.workspace.getConfiguration("minitok").get<boolean>(key, false) : this.context.workspaceState.get(`minitok.setting.${key}`, undefined)]));
    const secrets = { providerApiKeySet: Boolean(await this.context.secrets.get("minitok.secret.providerApiKey")), customBaseUrlSet: Boolean(await this.context.secrets.get("minitok.secret.customBaseUrl")) };
    this.view?.webview.postMessage({ type: "settings", settings, secrets });
  }
  private html(webview: vscode.Webview) { const source = fs.readFileSync(path.join(this.extensionUri.fsPath, "src", "sidebar.html"), "utf8"); return source.replaceAll("{{nonce}}", randomBytes(16).toString("base64")).replace("{{cspSource}}", webview.cspSource); }
}
