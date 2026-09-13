import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn, ChildProcessWithoutNullStreams, execFile, execFileSync } from "node:child_process";
import * as os from "node:os";
import { randomBytes, randomUUID } from "node:crypto";
import { cliPath, mcpCommand, mcpEnvironment, ensureMcpAuthToken, workspacePath, requireTrustedWorkspace, autoApprove, spawnSpec, spawnOptionsFor, npmSpawnSpec } from "./workspace";
import { checkEntitlement, invalidateEntitlementCache, requireEntitlement } from "./entitlement";
import { authErrorText, deviceLogin, logoutExtension, refreshExtensionSession, readExtensionSession } from "./device-auth";

function cliRelease(context: vscode.ExtensionContext) {
  const release = context.extension.packageJSON.minitok as { cliPackage?: unknown; cliVersion?: unknown } | undefined;
  return { packageName: typeof release?.cliPackage === "string" ? release.cliPackage : "@flotic/minitok", version: typeof release?.cliVersion === "string" ? release.cliVersion : "0.0.0" };
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
  constructor(private readonly extensionUri: vscode.Uri, private readonly context: vscode.ExtensionContext) {}
  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [this.extensionUri] };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage(message => this.handle(message));
  }

  private async execute(args: string[], cwd: string | undefined): Promise<string> {
    requireTrustedWorkspace(cwd);
    const cli = cliPath();
    const provider = this.context.workspaceState.get<string>("minitok.setting.provider", "");
    const model = this.context.workspaceState.get<string>("minitok.setting.model", "");
    const roles = ["plan", "work", "review", "intel"];
    const roleEnv: Record<string, string> = {};
    for (const role of roles) {
      const roleProvider = this.context.workspaceState.get<string>(`minitok.setting.${role}.provider`, "");
      const roleModel = this.context.workspaceState.get<string>(`minitok.setting.${role}.model`, "");
      if (roleProvider) roleEnv[`minitok_${role}_provider`] = roleProvider;
      if (roleModel) roleEnv[`minitok_${role}_model`] = roleModel;
    }
    const apiKey = await this.context.secrets.get("minitok.secret.providerApiKey");
    const customBaseUrl = await this.context.secrets.get("minitok.secret.customBaseUrl");
    const env: NodeJS.ProcessEnv = { ...process.env, ...roleEnv, ...(provider ? { minitok_default_provider: provider } : {}), ...(model ? { MINITOK_MODEL: model } : {}) };
    if (apiKey && provider === "anthropic") env.ANTHROPIC_API_KEY = apiKey;
    if (apiKey && provider === "openai") env.OPENAI_API_KEY = apiKey;
    if (apiKey && provider === "google") env.GOOGLE_API_KEY = apiKey;
    if (apiKey && provider === "custom") env.OPENAI_API_KEY = apiKey;
    if (customBaseUrl && provider === "custom") env.MINITOK_OPENAI_COMPATIBLE_BASE_URL = customBaseUrl;
    if (cwd && args[0] === "run" && !args.includes("--dry-run")) {
      this.approvalFile = path.join(cwd, ".minitok", "extension-approval.json");
      args.push("--approval-file", this.approvalFile, "--approval-timeout-ms", "1800000");
    }
    return new Promise((resolve, reject) => {
      const processSpec = spawnSpec(cli, args);
      this.output.appendLine(`[spawn] cli command=${JSON.stringify(processSpec.command)} args=${JSON.stringify(processSpec.args)} cwd=${JSON.stringify(cwd)}`);
      let child: ChildProcessWithoutNullStreams;
      try { child = spawn(processSpec.command, processSpec.args, spawnOptionsFor(processSpec, { cwd, env, detached: process.platform !== "win32" })); } catch (error) { reject(error); return; }
      this.process = child;
      let output = "";
      let error = "";
      const consume = (chunk: Buffer) => {
        const text = chunk.toString();
        output += text;
        this.output.append(text);
        for (const line of text.split(/\r?\n/).filter(Boolean)) this.progress(line);
      };
      child.stdout.on("data", consume);
      child.stderr.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        error += text;
        this.output.append(text);
        for (const line of text.split(/\r?\n/).filter(Boolean)) this.view?.webview.postMessage({ type: "log", stream: "stderr", text: line });
      });
      child.on("error", errorValue => { this.process = undefined; reject(errorValue); });
      const timeout = setTimeout(() => {
        this.stopProcess();
        this.view?.webview.postMessage({ type: "timeout", text: "minitok run timed out after 30 minutes" });
      }, 1800000);
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
    if (message?.command === "auth-status") { const session = await refreshExtensionSession(this.context); if (!session) { invalidateEntitlementCache(); this.view?.webview.postMessage({ type: "auth-state", ok: false, text: "Sign in with browser to continue." }); return; } invalidateEntitlementCache(); const result = await checkEntitlement(); this.view?.webview.postMessage({ type: "auth-state", ok: result.allowed, text: result.allowed ? `Signed in with ${result.plan} plan.` : `Entitlement error: ${result.message || "An active paid plan is required."}` }); return; }
    if (message?.command === "device-login") { try { await deviceLogin(this.context, text => this.view?.webview.postMessage({ type: "auth-state", ok: false, text })); invalidateEntitlementCache(); const result = await checkEntitlement(); if (!result.allowed) { this.view?.webview.postMessage({ type: "auth-state", ok: false, text: `Entitlement error: ${result.message || "An active paid plan is required."}` }); return; } this.view?.webview.postMessage({ type: "auth-state", ok: true, text: `Signed in with ${result.plan} plan.` }); } catch (error) { this.view?.webview.postMessage({ type: "auth-state", ok: false, text: authErrorText(error) }); } return; }
    if (message?.command === "device-logout") { await logoutExtension(this.context); invalidateEntitlementCache(); this.view?.webview.postMessage({ type: "auth-state", ok: false, text: "Signed out." }); return; }
    if (message?.command === "customer-login") { await this.customerLogin(message.email, message.password); return; }
    const entitlementCommands = new Set(["run", "dry-run", "mcp-status", "mcp-connect", "mcp-list", "discover-models", "info", "open-evidence", "open-diff", "restore-session", "update"]);
    if (entitlementCommands.has(message?.command)) {
      try { await requireEntitlement(); }
      catch (error) { this.view?.webview.postMessage({ type: "entitlement", ok: false, text: String(error) }); return; }
    }
    const commands = new Set(["device-login", "device-logout", "show-output", "stop", "interrupt", "approve", "reject", "open-evidence", "open-diff", "restore-session", "mcp-status", "mcp-connect", "mcp-list", "history", "sessions", "info", "discover-models", "activate", "attach-file", "attach-folder", "attach-problems", "settings", "save-settings",  "update", "run", "dry-run"]);
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
    if (message.command === "info") { await this.readInfo(cwd); return; }
    if (message.command === "discover-models") { await this.discoverModels(cwd, message.provider); return; }
    if (message.command === "activate") { await this.readSettings(); return; }
    if (message.command === "attach-file") { const uri = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: "Attach file" }); if (uri?.[0]) this.view?.webview.postMessage({ type: "attachment", value: `@file ${vscode.workspace.asRelativePath(uri[0])}` }); return; }
    if (message.command === "attach-folder") { const uri = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectMany: false, openLabel: "Attach folder" }); if (uri?.[0]) this.view?.webview.postMessage({ type: "attachment", value: `@folder ${vscode.workspace.asRelativePath(uri[0])}` }); return; }
    if (message.command === "attach-problems") { const diagnostics = vscode.languages.getDiagnostics().flatMap(([uri, items]) => items.map(item => `${vscode.workspace.asRelativePath(uri)}:${item.range.start.line + 1} ${item.message}`)); this.view?.webview.postMessage({ type: "attachment", value: diagnostics.length ? `@problems\n${diagnostics.join("\n")}` : "" }); return; }
    if (message.command === "settings") { await this.readSettings(); await this.discoverModels(cwd, this.context.workspaceState.get<string>("minitok.setting.provider", "")); await this.checkUpdate(); return; }
    if (message.command === "save-settings") { await this.saveSettings(message); return; }
    if (message.command === "update") { requireTrustedWorkspace(workspacePath()); const release = cliRelease(this.context); const answer = await vscode.window.showInformationMessage(`Update minitok to ${release.version}?`, "Update", "Cancel"); if (answer === "Update") this.runNpm(["install", "-g", `${release.packageName}@${release.version}`], 120000, (error, stdout, stderr) => this.view?.webview.postMessage({ type: "update-result", ok: !error, text: error ? stderr || error.message : stdout })); return; }
    try {
      requireTrustedWorkspace(cwd);
      if (this.process) throw new Error("A minitok run is already active");
      if (!message.task?.trim()) throw new Error("Task description required");
      const runId = randomUUID();
      const startedAt = new Date().toISOString();
      const checkpoint = cwd ? path.join(cwd, ".minitok", "checkpoints", runId) : undefined;
      if (cwd && checkpoint) {
        fs.mkdirSync(checkpoint, { recursive: true });
        await this.captureCheckpoint(cwd, checkpoint, { runId, task: message.task, createdAt: startedAt });
      }
      this.activeRunId = runId;
      this.activeRunStartedAt = startedAt;
    const args = ["run", message.task, "--repo", cwd!];
    if (message.command === "dry-run") args.push("--dry-run");
    else if (autoApprove()) args.push("--auto-accept");
      this.view?.webview.postMessage({ type: "started", runId });
      const text = await this.execute(args, cwd);
      const evidence = cwd ? this.readEvidence(cwd) : null;
      const patch = cwd ? this.readPatch(cwd) : null;
      const history = this.context.workspaceState.get<Array<Record<string, unknown>>>("minitok.history", []);
      const totalTokens = evidence?.tokens ? Number(evidence.tokens.input || 0) + Number(evidence.tokens.output || 0) : null;
      await this.context.workspaceState.update("minitok.history", [...history.slice(-19), { runId, task: message.task, startedAt, completedAt: new Date().toISOString(), status: "completed", success: true, totalTokens, cost: evidence?.cost ?? null, evidence: Boolean(evidence), evidencePath: cwd ? path.join(cwd, ".minitok", "evidence", "runs", "latest.json") : null, patchPath: cwd ? path.join(cwd, ".minitok", "last-run.patch") : null, checkpointPath: checkpoint }]);
      this.view?.webview.postMessage({ type: "result", ok: true, text, evidence, patch }); if (patch) this.view?.webview.postMessage({ type: "patch", patch });
    } catch (error) {
      const history = this.context.workspaceState.get<Array<Record<string, unknown>>>("minitok.history", []);
      if (this.activeRunId) await this.context.workspaceState.update("minitok.history", [...history.slice(-19), { runId: this.activeRunId, task: message.task, startedAt: this.activeRunStartedAt, completedAt: new Date().toISOString(), status: "failed", success: false, error: String(error) }]);
      this.view?.webview.postMessage({ type: "result", ok: false, text: String(error), runId: this.activeRunId });
    } finally { this.activeRunId = undefined; this.activeRunStartedAt = undefined; }
  }
  private async customerLogin(email?: string, password?: string) {
    requireTrustedWorkspace(workspacePath());
    if (!email?.trim() || !password) { this.view?.webview.postMessage({ type: "auth-state", ok: false, text: "Email and password are required." }); return; }
    const cwd = workspacePath();
    const env: NodeJS.ProcessEnv = { ...process.env, MINITOK_CUSTOMER_EMAIL: email.trim(), MINITOK_CUSTOMER_PASSWORD: password };
    const spec = spawnSpec(cliPath(), ["auth", "customer-login", "--email-env", "MINITOK_CUSTOMER_EMAIL", "--password-env", "MINITOK_CUSTOMER_PASSWORD"]);
    execFile(spec.command, spec.args, { ...spawnOptionsFor(spec, { cwd, env }), timeout: 30000 }, async (error, stdout, stderr) => {
      delete env.MINITOK_CUSTOMER_EMAIL; delete env.MINITOK_CUSTOMER_PASSWORD;
      if (error) { this.view?.webview.postMessage({ type: "auth-state", ok: false, text: stderr || error.message }); return; }
      invalidateEntitlementCache();
      const result = await checkEntitlement();
      this.view?.webview.postMessage({ type: "auth-state", ok: result.allowed, text: result.allowed ? `Signed in with ${result.plan} plan.` : result.message || stdout });
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
      const text = error ? stderr || error.message : stdout;
      const models = error ? [] : [...new Set((stdout.match(/(?:claude|gpt|o[134]|gemini|[\w-]+-\w+)[\w.:-]*/gi) || []).filter(id => !/^(models|available|provider)$/i.test(id)))];
      this.view?.webview.postMessage({ type: "models", ok: !error, text, provider: provider || "all", models });
    });
  }
  private async readInfo(cwd?: string) {
    requireTrustedWorkspace(cwd);
    const commands = [["status", "--repo", cwd!], ["doctor"], ["evolution", "status"], ["workspace", "current"]];
    const outputs: string[] = [];
    for (const args of commands) {
      try { outputs.push(`$ minitok ${args.join(" ")}\n${await new Promise<string>((resolve, reject) => { const spec = spawnSpec(cliPath(), args); execFile(spec.command, spec.args, { ...spawnOptionsFor(spec, { cwd }), timeout: 15000 }, (error, stdout, stderr) => error ? reject(new Error(stderr || error.message)) : resolve(String(stdout).trim())); })} `); }
      catch (error) { outputs.push(`$ minitok ${args.join(" ")}\n${String(error)}`); }
    }
    this.view?.webview.postMessage({ type: "info", text: outputs.join("\n\n") });
  }
  private listMcpHosts() {
    const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    const configs = this.mcpConfigPaths();
    const hosts = Object.entries(configs).map(([name, configPath]) => ({ name, detected: this.safeConfigExists(configPath), configPath }));
    this.view?.webview.postMessage({ type: "mcp-hosts", hosts });
  }
  private safeConfigExists(configPath: string) {
    try { return fs.existsSync(configPath) && !fs.lstatSync(configPath).isSymbolicLink(); } catch { return false; }
  }
  private mcpConfigPaths() {
    const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    return {
      cline: path.join(appData, "Code", "User", "globalStorage", "saoudrizwan.claude-dev", "settings", "cline_mcp_settings.json"),
      claude: path.join(appData, "Claude", "claude_desktop_config.json"),
      cursor: path.join(appData, "Cursor", "User", "globalStorage", "mcp.json"),
    };
  }
  private async connectMcp(target?: string) {
    const configs = this.mcpConfigPaths();
    const candidates = target && Object.prototype.hasOwnProperty.call(configs, target) ? [target] : target ? [] : Object.keys(configs).filter(name => this.safeConfigExists(configs[name as keyof typeof configs]));
    if (!candidates.length) { this.view?.webview.postMessage({ type: "mcp-connect", ok: false, text: target ? "Unsupported MCP host." : "No supported MCP host detected." }); return; }
    const host = candidates[0] as keyof typeof configs;
    const configPath = configs[host];
    const approved = await vscode.window.showInformationMessage(`Connect minitok MCP to ${host}? A backup will be created before changes.`, "Connect", "Cancel");
    if (approved !== "Connect") { this.view?.webview.postMessage({ type: "mcp-connect", ok: false, text: "Connection cancelled." }); return; }
    let config: Record<string, unknown> = {};
    if (this.safeConfigExists(configPath)) {
      const stat = fs.lstatSync(configPath);
      if (stat.isSymbolicLink()) throw new Error("MCP config symlinks are not supported");
      const raw = fs.readFileSync(configPath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("MCP config must be a JSON object");
      config = parsed as Record<string, unknown>;
    }
    // Write back to the key the host actually uses. A configuration that lists its
    // servers under `servers` was read from that key but always written to
    // `mcpServers`, so the host never loaded the minitok entry (the CLI's
    // `mcp connect` already preserves the container key).
    const serversKey = config.mcpServers !== undefined ? "mcpServers" : config.servers !== undefined ? "servers" : "mcpServers";
    const existingServers = config[serversKey] ?? {};
    if (!existingServers || typeof existingServers !== "object" || Array.isArray(existingServers)) throw new Error("MCP server configuration must be an object");
    const backup = `${configPath}.minitok-backup-${Date.now()}`;
    fs.mkdirSync(path.dirname(configPath), { recursive: true, mode: 0o700 });
    if (this.safeConfigExists(configPath)) fs.copyFileSync(configPath, backup, fs.constants.COPYFILE_EXCL);
    const configuredMcp = mcpCommand();
    (existingServers as Record<string, unknown>).minitok = { command: configuredMcp[0], args: configuredMcp.slice(1), env: { MINITOK_MCP_AUTH_TOKEN_FILE: mcpEnvironment().MINITOK_MCP_AUTH_TOKEN_FILE }, disabled: false };
    config[serversKey] = existingServers;
    const temp = `${configPath}.tmp-${process.pid}-${randomUUID()}`;
    try {
      fs.writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
      fs.renameSync(temp, configPath);
    } catch (error) {
      try { fs.unlinkSync(temp); } catch {}
      throw error;
    }
    this.view?.webview.postMessage({ type: "mcp-connect", ok: true, text: `Connected to ${host}. Backup: ${path.basename(backup)}` });
  }
  private async checkMcpHealth() {
    requireTrustedWorkspace(workspacePath());
    const cli = cliPath();
    if (this.mcpProcess) { this.view?.webview.postMessage({ type: "mcp", ok: false, text: "MCP health check already running" }); return; }
    const configured = mcpCommand();
    if (!configured.length || !configured[0]) { this.view?.webview.postMessage({ type: "mcp", ok: false, text: "minitok MCP command is not configured" }); return; }
    const processSpec = spawnSpec(configured[0], configured.slice(1));
    // Refresh the short lived runtime token before spawning the server, so both
    // sides use the same credential instead of failing 15 minutes after setup.
    const authToken = await ensureMcpAuthToken();
    this.output.appendLine(`[spawn] mcp command=${JSON.stringify(processSpec.command)} args=${JSON.stringify(processSpec.args)} cwd=${JSON.stringify(workspacePath())}`);
    let mcp: ChildProcessWithoutNullStreams;
    try { mcp = spawn(processSpec.command, processSpec.args, spawnOptionsFor(processSpec, { cwd: workspacePath(), env: mcpEnvironment() })); } catch (error) { this.output.appendLine(`[spawn] synchronous error=${String(error)}`); this.view?.webview.postMessage({ type: "mcp", ok: false, text: `MCP spawn failed: ${String(error)}` }); return; }
    this.mcpProcess = mcp;
    let buffer = "";
    let nextId = 1;
    const timeout = setTimeout(() => { mcp.kill(); this.view?.webview.postMessage({ type: "mcp", ok: false, text: "MCP offline: handshake timed out" }); }, 5000);
    const send = (method: string, params: Record<string, unknown> = {}) => mcp.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params: { ...params, authToken } })}\n`);
    const finish = (ok: boolean, text: string) => { clearTimeout(timeout); if (this.mcpProcess === mcp) this.mcpProcess = undefined; this.stopChild(mcp); this.view?.webview.postMessage({ type: "mcp", ok, text }); };
    mcp.stdout.on("data", chunk => { buffer += chunk.toString(); const lines = buffer.split(/\r?\n/); buffer = lines.pop() || ""; for (const line of lines) { try { const message = JSON.parse(line); if (message.error) finish(false, `MCP handshake error: ${message.error.message}`); else if (message.id === 1) send("tools/list"); else if (message.id === 2) finish(true, `MCP online: ${message.result?.tools?.length || 0} tools`); } catch (error) { this.output.appendLine(`MCP invalid response: ${error instanceof Error ? error.message : String(error)}`); } } });
    mcp.on("error", error => finish(false, `MCP offline: ${error.message}`));
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
  private async openEvidence(cwd: string) {

    const file = path.join(cwd, ".minitok", "evidence", "runs", "latest.json");
    if (fs.existsSync(file)) await vscode.window.showTextDocument(vscode.Uri.file(file));
    else vscode.window.showWarningMessage("No minitok evidence found");
  }
  private readEvidence(cwd: string) { try { return JSON.parse(fs.readFileSync(path.join(cwd, ".minitok", "evidence", "runs", "latest.json"), "utf8")); } catch { return null; } }
  private async saveSettings(message: { settings?: Record<string, unknown>; secrets?: Record<string, string> }) {
    if (message.settings) for (const [key, value] of Object.entries(message.settings)) {
      if (key === "autoApprove") {
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
    this.runNpm(["view", release.packageName, "version", "--json"], 10000, (error, stdout) => this.view?.webview.postMessage({ type: "update", current: release.version, latest: error ? null : stdout.trim().replace(/^"|"$/g, "") }));
  }
  private async readSettings() {
    const settings = Object.fromEntries(["provider", "model", "showCost", "evidencePath", "autoApprove", "enterBehavior", "plan.provider", "plan.model", "work.provider", "work.model", "review.provider", "review.model", "intel.provider", "intel.model"].map(key => [key, key === "autoApprove" ? vscode.workspace.getConfiguration("minitok").get<boolean>(key, false) : this.context.workspaceState.get(`minitok.setting.${key}`, undefined)]));
    const secrets = { providerApiKeySet: Boolean(await this.context.secrets.get("minitok.secret.providerApiKey")), customBaseUrlSet: Boolean(await this.context.secrets.get("minitok.secret.customBaseUrl")) };
    this.view?.webview.postMessage({ type: "settings", settings, secrets });
  }
  private html(webview: vscode.Webview) { const source = fs.readFileSync(path.join(this.extensionUri.fsPath, "src", "sidebar.html"), "utf8"); return source.replaceAll("{{nonce}}", randomBytes(16).toString("base64")).replace("{{cspSource}}", webview.cspSource); }
}
