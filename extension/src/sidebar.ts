import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn, ChildProcessWithoutNullStreams, execFile } from "node:child_process";
import { runProcess, killProcessTree } from "./run-process";
import * as os from "node:os";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { cliPath, mcpCommand, mcpEnvironment, configuredMcpScopes, ensureMcpAuthToken, workspacePath, requireTrustedWorkspace, autoApprove, spawnSpec, spawnOptionsFor, npmSpawnSpec, normalizeProviderName, appendBoundedOutput, workspaceRelativePath } from "./workspace";
import { checkEntitlement, invalidateEntitlementCache, requireEntitlement, adminRunDelegationEnv } from "./entitlement";
import { activateWithServer, statusEntitlementSession, refreshEntitlementSession, deactivateEntitlementSession } from "./entitlement";
import { EntitlementCache } from "./entitlement-cache";
import { adminLogin, authErrorText, deviceLogin, DeviceLoginCancellation, hasAdminSession, logoutAdmin, logoutExtension, refreshExtensionSession } from "./device-auth";
import { setEntitlementContext } from "./entitlement";
import { redactSensitiveText } from "./redaction";

function cliRelease(context: vscode.ExtensionContext) {
  const release = context.extension.packageJSON.minitok as { cliPackage?: unknown; cliVersion?: unknown } | undefined;
  return { packageName: typeof release?.cliPackage === "string" ? release.cliPackage : "@flotic/minitok", version: typeof release?.cliVersion === "string" ? release.cliVersion : "0.0.0" };
}

const redactTaskText = redactSensitiveText;

// Named custom providers managed in the settings UI: one OpenAI-compatible
// endpoint plus one key per name (e.g. custom-plan, custom-work). Names are
// stored lower-cased; the env suffix is the upper-cased name with every
// non [A-Z0-9] mapped to "_", mirroring src/config/loader.js.
export function customProviderKeyEnvName(name: string): string {
  const suffix = String(name || "").toUpperCase().replace(/[^A-Z0-9]/g, "_").replace(/^_+|_+$/g, "") || "CUSTOM";
  return `MINITOK_CUSTOM_API_KEY_${suffix}`;
}
export function customProviderBaseUrlEnvName(name: string): string {
  const suffix = String(name || "").toUpperCase().replace(/[^A-Z0-9]/g, "_").replace(/^_+|_+$/g, "") || "CUSTOM";
  return `MINITOK_CUSTOM_BASE_URL_${suffix}`;
}
function normalizeCustomProviderName(value: string): string {
  return String(value || "").trim().toLowerCase();
}
function isValidCustomProviderName(name: string): boolean {
  if (!name || name.length > 64) return false;
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(name)) return false;
  if (name.includes("..")) return false;
  if (["anthropic", "openai", "google", "custom"].includes(name)) return false;
  return true;
}
async function readCustomEndpoints(secrets: vscode.SecretStorage): Promise<Record<string, string>> {
  const raw = await secrets.get("minitok.secret.customEndpoints");
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      const name = normalizeCustomProviderName(key);
      if (!isValidCustomProviderName(name)) continue;
      if (typeof value !== "string" || !value.trim()) continue;
      out[name] = value.trim();
    }
    return out;
  } catch { return {}; }
}
const API_KEY_PROVIDERS = ["anthropic", "openai", "google", "custom"] as const;
type ApiKeyProvider = typeof API_KEY_PROVIDERS[number];
const apiKeySecretKey = (provider: string) => `minitok.secret.apiKey.${provider}`;
const isApiKeyProvider = (provider: string): provider is ApiKeyProvider => (API_KEY_PROVIDERS as readonly string[]).includes(provider);
// A named custom endpoint (custom-plan, ...) keeps its key under its own name
// so every role can use a different credential. Anything outside the built-in
// slots is treated as a named custom key.
const isNamedCustomKeyProvider = (provider: string) => {
  const name = normalizeCustomProviderName(provider);
  return Boolean(name) && isValidCustomProviderName(name);
};

/**
 * The pre-split store held one key for whichever provider was saved last. Move
 * it to the current provider's slot (the best available attribution), never
 * overwriting a per-provider key the user set afterwards, then delete it.
 */
async function migrateLegacyProviderApiKey(secrets: vscode.SecretStorage, currentProvider: string): Promise<void> {
  const legacy = await secrets.get("minitok.secret.providerApiKey");
  if (legacy === undefined) return;
  if (isApiKeyProvider(currentProvider) && !(await secrets.get(apiKeySecretKey(currentProvider)))) {
    await secrets.store(apiKeySecretKey(currentProvider), legacy);
  }
  await secrets.delete("minitok.secret.providerApiKey");
}


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

/** Map raw CLI/runtime errors to short, actionable user-facing messages. */
function toUserFriendlyError(raw: string): string {
  const text = raw.toLowerCase();
  if (text.includes("entitlement") || text.includes("license")) {
    return "License required: activate with `minitok activate <license-key>` in the terminal, then retry.";
  }
  if (text.includes("enoent") || text.includes("not found") || text.includes("cannot find")) {
    return "minitok CLI not found: install it globally with `npm install -g @flotic/minitok`, then reload this window.";
  }
  if (text.includes("econnrefused") || text.includes("enotfound") || text.includes("eai_again") || text.includes("timeout")) {
    return "Network error: check your internet connection and any proxy/firewall, then retry.";
  }
  if (text.includes("401") || text.includes("unauthorized") || text.includes("invalid api key")) {
    return "Authentication failed: check your API key in Settings → Providers.";
  }
  if (text.includes("403") || text.includes("forbidden")) {
    return "Access denied: your API key may lack permission for this provider.";
  }
  if (text.includes("429") || text.includes("rate limit")) {
    return "Rate limited: wait a moment and retry.";
  }
  return raw.split("\n")[0].slice(0, 200);
}

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
  private deviceLoginCancellation?: DeviceLoginCancellation;
  private entitlementCache?: EntitlementCache;
  constructor(private readonly extensionUri: vscode.Uri, private readonly context: vscode.ExtensionContext) {}
  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view;
    // The entitlement gate needs the context to consult the admin session.
    setEntitlementContext(this.context);
    // Phase 3: SecretStorage-backed entitlement session cache (JWT + payload).
    this.entitlementCache = new EntitlementCache(this.context.secrets);
    view.webview.options = { enableScripts: true, localResourceRoots: [this.extensionUri] };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage(message => {
      void this.handle(message).catch(error => {
        this.view?.webview.postMessage({ type: "result", ok: false, text: redactOutputText(String(error)) });
      });
    });
  }

  private async execute(args: string[], cwd: string | undefined, extraEnv: NodeJS.ProcessEnv = {}): Promise<string> {
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
    await migrateLegacyProviderApiKey(this.context.secrets, provider);
    const customBaseUrl = await this.context.secrets.get("minitok.secret.customBaseUrl");
    const customEndpoints = await readCustomEndpoints(this.context.secrets);
    // Migrate a legacy single custom endpoint into the named map so an
    // existing installation keeps working and becomes per-role editable.
    if (customBaseUrl && customBaseUrl.trim() && Object.keys(customEndpoints).length === 0) {
      customEndpoints["custom"] = customBaseUrl.trim();
    }
    if (model) for (const role of roles) if (!roleEnv[`minitok_${role}_model`]) roleEnv[`minitok_${role}_model`] = model;
    const env: NodeJS.ProcessEnv = { ...roleEnv, ...(provider ? { minitok_default_provider: provider } : {}) };
    // Inject every stored provider key, not just the selected provider's: roles
    // (minitok_<role>_provider) may name a different provider than the default.
    // Variable names match the CLI contract (src/auth/index.js envMap, the
    // legacy custom provider materialized with api_key_env: OPENAI_API_KEY,
    // and named custom providers materialized with per-name
    // MINITOK_CUSTOM_API_KEY_<NAME> entries in src/config/loader.js).
    const keys: Partial<Record<string, string>> = {};
    for (const p of API_KEY_PROVIDERS) {
      const key = await this.context.secrets.get(apiKeySecretKey(p));
      if (key) keys[p] = key;
    }
    // Named custom keys live under their own SecretStorage name. roleEnv holds
    // minitok_<role>_provider values plus minitok_*_model values, so only
    // provider entries (not model names or URLs) are candidates here.
    const roleProviderNames = roles
      .map(role => roleEnv[`minitok_${role}_provider`])
      .filter((value): value is string => Boolean(value));
    const namedKeyNames = new Set<string>([
      ...Object.keys(customEndpoints),
      provider,
      ...roleProviderNames,
    ]);
    for (const raw of namedKeyNames) {
      const name = normalizeCustomProviderName(raw);
      if (!isNamedCustomKeyProvider(name) || keys[name]) continue;
      const key = await this.context.secrets.get(apiKeySecretKey(name));
      if (key) keys[name] = key;
    }
    if (keys.anthropic) env.ANTHROPIC_API_KEY = keys.anthropic;
    if (keys.openai) env.OPENAI_API_KEY = keys.openai;
    if (keys.google) env.GOOGLE_API_KEY = keys.google;
    if (keys.custom) env.OPENAI_API_KEY = keys.custom;
    for (const [name, key] of Object.entries(keys)) {
      if (!isNamedCustomKeyProvider(name) || API_KEY_PROVIDERS.includes(name as ApiKeyProvider)) continue;
      env[customProviderKeyEnvName(name)] = key;
    }
    // Keep the endpoint outside workspace config/CLI args. The core loader
    // materializes named entries into providers.<name> (plus the legacy
    // providers.custom fallback below for older installations).
    const manifest: Record<string, string> = {};
    for (const [name, url] of Object.entries(customEndpoints)) {
      if (name === "custom") continue;
      manifest[name] = url;
      env[customProviderBaseUrlEnvName(name)] = url;
    }
    if (Object.keys(manifest).length) env.MINITOK_CUSTOM_PROVIDERS_JSON = JSON.stringify(manifest);
    if (customBaseUrl && provider === "custom") {
      env.MINITOK_CUSTOM_BASE_URL = customBaseUrl;
      env.MINITOK_OPENAI_COMPATIBLE_BASE_URL = customBaseUrl;
    }
    const timeouts = runTimeouts();
    if (cwd && args[0] === "run" && !args.includes("--dry-run") && !args.includes("--auto-accept")) {
      // autoApprove() adds --auto-accept just below, and auto-accept now takes
      // precedence over an approval file (loop.promptConfirmation). Passing both
      // would only produce an unused request file, so it is not written at all.
      this.approvalFile = path.join(cwd, ".minitok", "extension-approval.json");
      args.push("--approval-file", this.approvalFile, "--approval-timeout-ms", String(timeouts.approvalMs));
    }
    const processSpec = spawnSpec(cli, args);
    this.output.appendLine(`[spawn] cli command=${JSON.stringify(processSpec.command)} args=${JSON.stringify(redactTaskArgs(processSpec.args, args[1] === "run" ? args[2] : ""))} cwd=${JSON.stringify(cwd)}`);
    return runProcess(processSpec.command, processSpec.args, {
      spawnOptions: spawnOptionsFor(processSpec, { cwd, env: { ...env, ...extraEnv }, detached: process.platform !== "win32" }),
      onProcess: child => { this.process = child; },
      onStdout: chunk => {
        const text = chunk.toString();
        // runProcess already folds every chunk into the bounded resolved value:
        // output = appendBoundedOutput(output, text)
        this.output.append(redactOutputText(text));
        for (const line of text.split(/\r?\n/).filter(Boolean)) this.progress(redactOutputText(line));
      },
      onStderr: chunk => {
        const text = chunk.toString();
        // The bounded stderr accumulator lives in run-process.ts:
        // error = appendBoundedOutput(error, text)
        this.output.append(redactOutputText(text));
        for (const line of text.split(/\r?\n/).filter(Boolean)) this.view?.webview.postMessage({ type: "log", stream: "stderr", text: redactOutputText(line) });
      },
      timeoutMs: timeouts.runMs,
      timeoutMessage: `minitok run timed out after ${Math.round(timeouts.runMs / 60000)} minutes`,
    });
  }
  private stopChild(child?: ChildProcessWithoutNullStreams) {
    if (!child) return;
    // The Windows taskkill /t / POSIX process-group logic lives in
    // run-process.ts so extension, panel, and sidebar share one copy.
    killProcessTree(child);
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
  /**
   * Re-resolve the session and entitlement state and repaint the auth gate.
   *
   * Extracted from the `auth-status` message handler so a command that changes
   * entitlement out of band — activation — can repaint the sidebar instead of
   * leaving the pre-activation denial on screen until the window is reloaded.
   * Every path settles with an auth-state post: a rejection here previously left
   * the sidebar on "Loading minitok..." with no way to sign in.
   */
  public async refreshAuth() {
    try {
      // An admin session bypasses the plan gate, so it must satisfy "is anybody
      // signed in?" on its own; refreshExtensionSession only knows the customer
      // session.
      if (await hasAdminSession(this.context)) { invalidateEntitlementCache(); this.view?.webview.postMessage({ type: "auth-state", state: "authenticated", ok: true, authenticated: true, entitled: true, text: redactOutputText("Signed in as admin.") }); return; }
      const session = await refreshExtensionSession(this.context);
      if (!session) { invalidateEntitlementCache(); this.view?.webview.postMessage({ type: "auth-state", state: "signed-out", ok: false, authenticated: false, entitled: false }); return; }
      invalidateEntitlementCache();
      const result = await checkEntitlement();
      this.view?.webview.postMessage({ type: "auth-state", state: result.allowed ? "authenticated" : "not-entitled", ok: result.allowed, authenticated: true, entitled: result.allowed, text: redactOutputText(result.allowed ? `Signed in with ${result.plan} plan.` : `Entitlement error: ${result.message || "An active paid plan is required."}`) });
    } catch (error) {
      this.view?.webview.postMessage({ type: "auth-state", state: "refresh-failed", ok: false, authenticated: false, entitled: false, text: redactOutputText(authErrorText(error)) });
    }
  }

  /** Repaint the auth gate, e.g. after a command activated this installation. */
  public async refresh() {
    await this.refreshAuth();
  }

  private async handle(message: { command: string; task?: string; email?: string; password?: string; provider?: string; target?: string; checkpoint?: string; key?: string; settings?: Record<string, unknown>; secrets?: Record<string, string> }) {
    // Every auth-status path below must settle with an auth-state post. A rejection
    // here was caught by the caller and reported as a task result, which the auth
    // gate ignores, so the sidebar stayed on "Loading minitok..." with no way to
    // sign in. refresh-failed still renders the signed-out CTA in the webview.
    // An admin session bypasses the plan gate, so it must satisfy "is anybody signed
    // in?" on its own; refreshExtensionSession only knows the customer session.
    if (message?.command === "auth-status") { await this.refreshAuth(); return; }
    if (message?.command === "device-login") {
      if (this.deviceLoginCancellation && !this.deviceLoginCancellation.cancelled) { this.view?.webview.postMessage({ type: "auth-state", state: "checking", ok: false, authenticated: false, entitled: false, text: "A browser sign-in is already in progress. Cancel it first." }); return; }
      const cancellation: DeviceLoginCancellation = { cancelled: false };
      this.deviceLoginCancellation = cancellation;
      try { await deviceLogin(this.context, text => this.view?.webview.postMessage({ type: "auth-state", state: "checking", ok: false, authenticated: false, entitled: false, text: redactOutputText(text) }), cancellation); invalidateEntitlementCache(); const result = await checkEntitlement(); if (!result.allowed) { this.view?.webview.postMessage({ type: "auth-state", state: "not-entitled", ok: false, authenticated: true, entitled: false, text: redactOutputText(`Entitlement error: ${result.message || "An active paid plan is required."}`) }); return; } this.view?.webview.postMessage({ type: "auth-state", state: "authenticated", ok: true, authenticated: true, entitled: true, text: redactOutputText(`Signed in with ${result.plan} plan.`) }); }
      catch (error) { if ((error as any)?.code === "cancelled") { this.view?.webview.postMessage({ type: "auth-state", state: "signed-out", ok: false, authenticated: false, entitled: false, text: "Browser sign-in cancelled." }); } else { this.view?.webview.postMessage({ type: "auth-state", state: "refresh-failed", ok: false, authenticated: false, entitled: false, text: redactOutputText(authErrorText(error)) }); } }
      finally { if (this.deviceLoginCancellation === cancellation) this.deviceLoginCancellation = undefined; }
      return;
    }
    if (message?.command === "cancel-login") { if (this.deviceLoginCancellation) this.deviceLoginCancellation.cancelled = true; return; }
    // An admin session is stored separately and bypasses the entitlement gate, so
    // leaving it behind would re-authenticate the next command after a sign-out.
    if (message?.command === "device-logout") { const remoteRevoked = await logoutExtension(this.context); await logoutAdmin(this.context); invalidateEntitlementCache(); this.view?.webview.postMessage({ type: "auth-state", state: "signed-out", ok: false, authenticated: false, entitled: false, text: redactOutputText(remoteRevoked ? "Signed out locally and from the server." : "Signed out locally. The server session could not be revoked; sign in again when online.") }); return; }
    if (message?.command === "customer-login") { await this.customerLogin(message.email, message.password); return; }
    if (message?.command === "admin-login") { await this.adminLogin(message.email, message.password); return; }
    // Dry run still performs provider planning and can expose paid workflow
    // output, so it intentionally remains entitlement-gated rather than becoming
    // an accidental free execution path.
    const entitlementCommands = new Set(["run", "dry-run"]);
    if (entitlementCommands.has(message?.command)) {
      try { await requireEntitlement(); }
      catch (error) { this.view?.webview.postMessage({ type: "entitlement", ok: false, text: redactOutputText(String(error)) }); return; }
    }
    const commands = new Set(["device-login", "device-logout", "show-output", "stop", "interrupt", "approve", "reject", "open-evidence", "open-diff", "restore-session", "mcp-status", "mcp-connect", "mcp-list", "sessions", "clear-history", "info", "discover-models", "validate-key", "activate", "attach-file", "attach-folder", "attach-problems", "settings", "save-settings",  "update", "run", "dry-run"]);
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
    if (message.command === "sessions") { this.view?.webview.postMessage({ type: "sessions", items: this.context.workspaceState.get<Array<Record<string, unknown>>>("minitok.history", []) }); return; }
    if (message.command === "clear-history") { await this.context.workspaceState.update("minitok.history", []); this.view?.webview.postMessage({ type: "history-cleared", text: "Local Extension run history cleared. Repository evidence, checkpoints, and patches were preserved." }); return; }
    if (message.command === "info") { await this.readInfo(cwd); return; }
    if (message.command === "discover-models") { await requireEntitlement(); await this.discoverModels(cwd, message.provider); return; }
    if (message.command === "validate-key") { await this.validateApiKey(message); return; }
    if (message.command === "activate") { await this.openBilling(); return; }
    // Phase 3: direct license-key management against the entitlement server.
    if (message.command === "license-activate") { await this.activateLicense(message); return; }
    if (message.command === "license-status") { await this.postLicenseStatus(); return; }
    if (message.command === "license-refresh") { await this.refreshLicense(); return; }
    if (message.command === "license-deactivate") { await this.deactivateLicense(); return; }
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
    const evidenceSetting = vscode.workspace.getConfiguration("minitok").get<string>("evidencePath", ".minitok/evidence/runs/latest.json").trim() || ".minitok/evidence/runs/latest.json";
    workspaceRelativePath(cwd!, evidenceSetting, "evidencePath");
    const args = ["run", message.task, "--repo", cwd!, "--evidence-path", evidenceSetting, "--run-id", runId];
    if (message.command === "dry-run") args.push("--dry-run");
    else if (autoApprove()) args.push("--auto-accept");
      // P-2 fix: an admin session authorizes this run through a one-time,
      // runId-bound server token instead of the local signed entitlement. The
      // admin token itself stays in SecretStorage and never crosses into the
      // child; the delegation token travels only in the environment and the
      // CLI burns it at its entitlement gate.
      const delegationEnv = await adminRunDelegationEnv(this.context, runId);
      this.view?.webview.postMessage({ type: "started", runId });
      const text = await this.execute(args, cwd, delegationEnv);
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
      const rawError = String(error);
      const safeError = redactOutputText(rawError);
      if (this.activeRunId) await this.context.workspaceState.update("minitok.history", [...history.slice(-19), { runId: this.activeRunId, ...taskRecord(message.task || ""), startedAt: this.activeRunStartedAt, completedAt: new Date().toISOString(), status: "failed", success: false, error: safeError }]);
      this.view?.webview.postMessage({ type: "result", ok: false, text: safeError, runId: this.activeRunId, errorDetail: safeError, userMessage: toUserFriendlyError(safeError) });
    } finally { this.activeRunId = undefined; this.activeRunStartedAt = undefined; }
  }
  // Checkout is the only billing action any surface reaches: the webviews dropped
  // their plan-management button, so nothing asks for the billing portal and
  // this helper has no second call path. The CLI still ships `minitok portal`
  // as its own public command; the Extension just never spawns it.
  private async openBilling() {
    const session = await refreshExtensionSession(this.context);
    if (!session?.access_token) { this.view?.webview.postMessage({ type: "billing", ok: false, text: "Sign in before managing your plan." }); return; }
    const envName = "MINITOK_EXTENSION_CUSTOMER_TOKEN";
    const env: NodeJS.ProcessEnv = { ...process.env, MINITOK_UPDATE_CHECK: "0", [envName]: session.access_token };
    const args = ["checkout", "--token-env", envName, "--json"];
    const spec = spawnSpec(cliPath(), args);
    execFile(spec.command, spec.args, { ...spawnOptionsFor(spec, { cwd: workspacePath(), env }), timeout: 30000 }, async (error, stdout, stderr) => {
      delete env[envName];
      if (error) { this.view?.webview.postMessage({ type: "billing", ok: false, text: redactOutputText(stderr || error.message) }); return; }
      try {
        const result = JSON.parse(String(stdout).trim()) as { checkout_url?: string };
        const target = result.checkout_url;
        if (!target || !/^https:\/\//i.test(target)) throw new Error("Billing service returned an invalid URL");
        await vscode.env.openExternal(vscode.Uri.parse(target));
        this.view?.webview.postMessage({ type: "billing", ok: true, text: "Checkout opened in your browser." });
      } catch (parseError) { this.view?.webview.postMessage({ type: "billing", ok: false, text: redactOutputText(parseError instanceof Error ? parseError.message : String(parseError)) }); }
    });
  }

  // -------------------------------------------------------------------------
  // Phase 3: License section handlers (server-validated entitlement)
  // -------------------------------------------------------------------------

  /** Activate a license key against the entitlement server and cache the JWT. */
  private async activateLicense(message: { key?: string }) {
    const key = typeof message.key === "string" ? message.key.trim() : "";
    if (!key) { this.view?.webview.postMessage({ type: "license", ok: false, status: "error", text: "An activation key is required." }); return; }
    this.view?.webview.postMessage({ type: "license", ok: true, status: "activating", text: "Activating license..." });
    const result = await activateWithServer(this.context, key);
    if (!result.ok) {
      this.view?.webview.postMessage({ type: "license", ok: false, status: "error", text: redactOutputText(result.message) });
      return;
    }
    invalidateEntitlementCache();
    await this.postLicenseStatus();
    this.view?.webview.postMessage({ type: "auth-state", state: "authenticated", ok: true, authenticated: true, entitled: true, text: `License activated with ${result.plan || "your"} plan.` });
  }

  /** Report the current license status to the Settings license section. */
  private async postLicenseStatus() {
    if (!this.entitlementCache) this.entitlementCache = new EntitlementCache(this.context.secrets);
    const session = await this.entitlementCache.load();
    if (!session) {
      this.view?.webview.postMessage({ type: "license", ok: false, status: "not-activated", text: "No license is activated on this device." });
      return;
    }
    const status = await statusEntitlementSession(session.token);
    if (status.ok) {
      const expiry = status.expiresAt || (typeof session.payload.exp === "number" ? new Date(session.payload.exp * 1000).toISOString().slice(0, 10) : undefined);
      this.view?.webview.postMessage({ type: "license", ok: true, status: "active", plan: status.plan || session.payload.plan || undefined, expiresAt: expiry, text: "License is active." });
      return;
    }
    if (status.status === 401 || status.status === 403) {
      // Server rejected the token: try one silent refresh before declaring expiry.
      const refreshed = await refreshEntitlementSession(session.token);
      if (refreshed.ok && refreshed.token) {
        await this.entitlementCache.save(refreshed.token);
        invalidateEntitlementCache();
        await this.postLicenseStatus();
        return;
      }
      this.view?.webview.postMessage({ type: "license", ok: false, status: "expired", text: status.error || "License is expired or revoked." });
      return;
    }
    // Offline: fall back to the cached `exp`.
    const offline = await this.entitlementCache.loadValidOffline();
    if (offline) {
      const expiry = typeof offline.payload.exp === "number" ? new Date(offline.payload.exp * 1000).toISOString().slice(0, 10) : undefined;
      this.view?.webview.postMessage({ type: "license", ok: true, status: "active", plan: offline.payload.plan || undefined, expiresAt: expiry, text: "License active (offline cache)." });
    } else {
      this.view?.webview.postMessage({ type: "license", ok: false, status: "expired", text: "License expired and the server cannot be reached to refresh it." });
    }
  }

  /** Refresh the current license session with the server. */
  private async refreshLicense() {
    if (!this.entitlementCache) this.entitlementCache = new EntitlementCache(this.context.secrets);
    const session = await this.entitlementCache.load();
    if (!session) { this.view?.webview.postMessage({ type: "license", ok: false, status: "not-activated", text: "No license to refresh." }); return; }
    const refreshed = await refreshEntitlementSession(session.token);
    if (!refreshed.ok || !refreshed.token) {
      this.view?.webview.postMessage({ type: "license", ok: false, status: "error", text: redactOutputText(refreshed.error || `Refresh failed (HTTP ${refreshed.status}).`) });
      return;
    }
    await this.entitlementCache.save(refreshed.token);
    invalidateEntitlementCache();
    await this.postLicenseStatus();
  }

  /** Deactivate the license locally even if server revocation fails. */
  private async deactivateLicense() {
    if (!this.entitlementCache) this.entitlementCache = new EntitlementCache(this.context.secrets);
    const session = await this.entitlementCache.load();
    if (!session) { this.view?.webview.postMessage({ type: "license", ok: false, status: "not-activated", text: "No license is activated on this device." }); return; }
    const result = await deactivateEntitlementSession(session.token);
    // The local cache is cleared regardless: a failed revocation must not leave
    // a ghost session on this device.
    await this.entitlementCache.clear();
    invalidateEntitlementCache();
    this.view?.webview.postMessage({ type: "license", ok: true, status: "not-activated", text: result.ok ? "License deactivated." : "Deactivated locally; the server could not be reached to revoke it." });
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
  private async adminLogin(email?: string, password?: string) {
    if (!email?.trim() || !password) { this.view?.webview.postMessage({ type: "auth-state", state: "signed-out", ok: false, authenticated: false, entitled: false, text: "Email and password are required." }); return; }
    this.view?.webview.postMessage({ type: "auth-state", state: "checking", ok: false, authenticated: false, entitled: false, text: "Signing in as admin..." });
    try {
      await adminLogin(this.context, email.trim(), password);
      invalidateEntitlementCache();
      this.view?.webview.postMessage({ type: "auth-state", state: "authenticated", ok: true, authenticated: true, entitled: true, text: "Signed in as admin." });
    } catch (error) {
      this.view?.webview.postMessage({ type: "auth-state", state: "signed-out", ok: false, authenticated: false, entitled: false, text: redactOutputText(authErrorText(error)) });
    }
  }
private async discoverModels(cwd?: string, provider?: string) {
     requireTrustedWorkspace(cwd);
     await requireEntitlement();
    // Always use --discover so the model list comes from live provider APIs,
    // not the static catalog which may lag behind new releases.
    const args = ["models", "--discover", "--json"];
    if (provider) args.splice(2, 0, provider);
    // The extension owns SecretStorage, so the CLI cannot see stored keys —
    // inject the requested provider's key, mirroring validateApiKey().
    const wanted = normalizeCustomProviderName(provider || "");
    const env: NodeJS.ProcessEnv = {};
    if (isApiKeyProvider(wanted) || isNamedCustomKeyProvider(wanted)) {
      const key = await this.context.secrets.get(apiKeySecretKey(wanted));
      if (key) {
        env.minitok_default_provider = wanted;
        if (wanted === "anthropic") env.ANTHROPIC_API_KEY = key;
        else if (wanted === "openai") env.OPENAI_API_KEY = key;
        else if (wanted === "google") env.GOOGLE_API_KEY = key;
        else if (wanted === "custom") env.OPENAI_API_KEY = key;
        else env[customProviderKeyEnvName(wanted)] = key;
        if (wanted === "custom") {
          const baseUrl = await this.context.secrets.get("minitok.secret.customBaseUrl");
          if (baseUrl) { env.MINITOK_CUSTOM_BASE_URL = baseUrl; env.MINITOK_OPENAI_COMPATIBLE_BASE_URL = baseUrl; }
        } else if (isNamedCustomKeyProvider(wanted)) {
          const endpoints = await readCustomEndpoints(this.context.secrets);
          const baseUrl = endpoints[wanted];
          if (baseUrl) {
            env[customProviderBaseUrlEnvName(wanted)] = baseUrl;
            env.MINITOK_CUSTOM_PROVIDERS_JSON = JSON.stringify({ [wanted]: baseUrl });
          }
        }
      }
    }
    // cliPath() resolves the real entry point; the configured setting alone
    // defaulted to "minitok" and could not be launched on Windows.
    const spec = spawnSpec(cliPath(), args);
    // Live API calls take longer than reading the local catalog; 45s gives
    // headroom for slow networks without hanging the sidebar indefinitely.
    execFile(spec.command, spec.args, { ...spawnOptionsFor(spec, { cwd, env }), timeout: 45000 }, (error, stdout, stderr) => {
      const text = redactOutputText(error ? stderr || error.message : stdout);
      // Parse the CLI's --discover --json output. Live-only: no catalog merge.
      // Shape: { live: { provider: [id, ...] }, custom: [...], unknown: [...] }
      let models: string[] = [];
      let parsed = false;
      try {
        const data = JSON.parse(stdout);
        parsed = true;
        const ids = new Set<string>();
        // Live discovered IDs (per-provider string arrays)
        if (data.live && typeof data.live === "object") {
          for (const [prov, liveIds] of Object.entries(data.live)) {
            if (!wanted || prov.toLowerCase() === wanted) {
              for (const id of Array.isArray(liveIds) ? liveIds : []) if (typeof id === "string") ids.add(id);
            }
          }
        }
        // Custom provider models (live endpoint discovery + user-defined)
        for (const c of Array.isArray(data.custom) ? data.custom : []) {
          if (!c || !Array.isArray(c.models)) continue;
          if (wanted && String(c.provider).toLowerCase() !== wanted) continue;
          for (const m of c.models) if (m && typeof m.id === "string") ids.add(m.id);
        }
        models = [...ids];
      } catch { parsed = false; }
      if (!parsed && !error) {
        const headerWords = new Set(["models", "available", "provider", "default", "name", "id", "----"]);
        models = [...new Set((stdout.match(/(?:claude|gpt|o[134]|gemini|llama|deepseek|qwen|mistral|mixtral|phi|yi|solar|starcoder|codellama|gemma|command|dbrx|jamba|nova|spark|hunyuan|step|kimi|minimax|moonshot|zhipu|baichuan|internlm|chatglm|qwq|qvq|grok)[\w.:-]*|[\w][\w.-]*-[\w.-]+/gi) || [])
          .filter(id => id.length > 2 && !headerWords.has(id.toLowerCase()) && !/^\d/.test(id)))];
      }
      // ok tracks whether the list is actually usable. A configured provider
      // with no stored API key returns no live models, and the old
      // `|| !error` mask hid that case from the empty-state guidance toast.
      this.view?.webview.postMessage({ type: "models", ok: models.length > 0, text, provider: provider || "all", models });
    });
  }
  /**
   * Lightweight key check: run `minitok models --discover --json` for just this
   * provider with the stored key injected, and judge validity by whether the
   * live discovery returned models for it. The extension owns SecretStorage, so
   * the CLI alone cannot see the key — it must be injected here, mirroring the
   * materialization contract in execute(): custom maps to OPENAI_API_KEY plus
   * the endpoint variables, named custom providers map to per-name
   * MINITOK_CUSTOM_API_KEY_<NAME> plus endpoint variables. `validate-key` is
   * sent right after save-settings,
   * so the key being checked is already stored.
   */
  private async validateApiKey(message: { provider?: string }) {
    const rawName = normalizeCustomProviderName(typeof message?.provider === "string" ? message.provider : "");
    const provider = normalizeProviderName(message?.provider || "");
    const named = isNamedCustomKeyProvider(rawName) ? rawName : "";
    if (!isApiKeyProvider(provider) && !named) {
      this.view?.webview.postMessage({ type: "key-validation", provider: message?.provider, ok: false, reason: "Unknown provider" });
      return;
    }
    const effective = named || provider;
    const key = await this.context.secrets.get(apiKeySecretKey(effective));
    if (!key) {
      this.view?.webview.postMessage({ type: "key-validation", provider: effective, ok: false, reason: "No key stored for this provider" });
      return;
    }
    // Inject the key under the vendor variable the CLI's envMap reads. For
    // custom, api_key_env is OPENAI_API_KEY (src/config/loader.js) and the
    // endpoint travels in MINITOK_CUSTOM_BASE_URL; named providers use their
    // per-name key/endpoint variables.
    const env: NodeJS.ProcessEnv = { minitok_default_provider: effective };
    if (provider === "anthropic") env.ANTHROPIC_API_KEY = key;
    else if (provider === "openai") env.OPENAI_API_KEY = key;
    else if (provider === "google") env.GOOGLE_API_KEY = key;
    else if (!named) env.OPENAI_API_KEY = key; // custom
    else env[customProviderKeyEnvName(named)] = key;
    if (provider === "custom") {
      const baseUrl = await this.context.secrets.get("minitok.secret.customBaseUrl");
      if (baseUrl) { env.MINITOK_CUSTOM_BASE_URL = baseUrl; env.MINITOK_OPENAI_COMPATIBLE_BASE_URL = baseUrl; }
    } else if (named) {
      const endpoints = await readCustomEndpoints(this.context.secrets);
      const baseUrl = endpoints[named];
      if (baseUrl) {
        env[customProviderBaseUrlEnvName(named)] = baseUrl;
        env.MINITOK_CUSTOM_PROVIDERS_JSON = JSON.stringify({ [named]: baseUrl });
      }
    }
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    try {
      const processSpec = spawnSpec(cliPath(), ["models", "--discover", "--json", effective]);
      const result = await runProcess(processSpec.command, processSpec.args, {
        spawnOptions: spawnOptionsFor(processSpec, { cwd, env }),
        timeoutMs: 25000,
      });
      const text = String(result).trim();
      let payload: any = null;
      try { payload = JSON.parse(text.slice(text.indexOf("{"))); } catch { payload = null; }
      // Named custom providers are reported by the CLI in the `custom` array
      // (one { provider, models } entry per endpoint), not under `live[name]`,
      // so validate must read both shapes or every named custom check fails.
      const customEntry = Array.isArray(payload?.custom)
        ? payload.custom.find((c: any) => c && normalizeCustomProviderName(String(c.provider)) === effective)
        : null;
      const discovered = payload?.live?.[effective] || payload?.models?.[effective] || customEntry?.models || [];
      const models = (Array.isArray(discovered) ? discovered : [])
        .map((m: any) => (typeof m === "string" ? m : m?.id || m?.name))
        .filter((m: any) => typeof m === "string" && /^[A-Za-z0-9._\-/]+$/.test(m));
      const ok = models.length > 0;
      this.view?.webview.postMessage({ type: "key-validation", provider: effective, ok, reason: ok ? undefined : (redactOutputText(text.slice(0, 300)) || "No models returned") });
    } catch (error) {
      this.view?.webview.postMessage({ type: "key-validation", provider: effective, ok: false, reason: redactOutputText(String(error).slice(0, 300)) });
    }
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
    let configHome: string;
    if (process.platform === "win32") {
      const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
      vscodeUser = path.join(appData, "Code", "User");
      claudeRoot = path.join(appData, "Claude");
      configHome = path.join(home, ".config");
    } else if (process.platform === "darwin") {
      const support = path.join(home, "Library", "Application Support");
      vscodeUser = path.join(support, "Code", "User");
      claudeRoot = path.join(support, "Claude");
      configHome = path.join(home, ".config");
    } else {
      configHome = process.env.XDG_CONFIG_HOME || path.join(home, ".config");
      vscodeUser = path.join(configHome, "Code", "User");
      claudeRoot = path.join(configHome, "Claude");
    }
    const firstExisting = (candidates: string[]) => candidates.find(candidate => this.safeConfigExists(candidate)) || candidates[0];
    const cline = firstExisting([
      path.join(home, ".cline", "data", "settings", "cline_mcp_settings.json"),
      path.join(home, ".cline", "mcp.json"),
      path.join(vscodeUser, "globalStorage", "saoudrizwan.claude-dev", "settings", "cline_mcp_settings.json"),
    ]);
    const cursor = firstExisting([
      path.join(home, ".cursor", "mcp.json"),
      path.join(vscodeUser, "globalStorage", "mcp.json"),
    ]);
    const windsurf = firstExisting([
      path.join(home, ".codeium", "windsurf", "mcp_config.json"),
      path.join(home, ".windsurf", "mcp_config.json"),
    ]);
    return {
      cline,
      claude: path.join(claudeRoot, "claude_desktop_config.json"),
      cursor,
      windsurf,
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
      (existingServers as Record<string, unknown>).minitok = { command: configuredMcp[0], args: configuredMcp.slice(1), env: { ...existingEnv, minitok_server_url: existingEnv.minitok_server_url || configuredEnv.minitok_server_url, MINITOK_MCP_AUTH_TOKEN_FILE: configuredEnv.MINITOK_MCP_AUTH_TOKEN_FILE, MINITOK_MCP_SCOPES: scopes, ...(configuredEnv.MINITOK_MCP_WORKSPACE_ROOT ? { MINITOK_MCP_WORKSPACE_ROOT: configuredEnv.MINITOK_MCP_WORKSPACE_ROOT } : {}) }, disabled: false };
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
    const resolvedCheckpoint = workspaceRelativePath(cwd, checkpoint, "checkpoint");
    const checkpointRoot = path.join(path.resolve(cwd), ".minitok", "checkpoints") + path.sep;
    if (!resolvedCheckpoint.startsWith(checkpointRoot)) throw new Error("Checkpoint must stay under workspace/.minitok/checkpoints");
    const patch = path.join(resolvedCheckpoint, "working-tree.patch");
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
    if (!patch) { vscode.window.showInformationMessage("No minitok patch found. Run a minitok task first to produce one."); return; }
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
    else vscode.window.showWarningMessage("No minitok evidence found. Run a minitok task first to produce one.");
  }
  private readEvidence(cwd: string) {
    const file = this.evidenceFile(cwd);
    try { return JSON.parse(fs.readFileSync(file, "utf8")); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new Error(`Evidence could not be read: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  private async saveSettings(message: { settings?: Record<string, unknown>; secrets?: Record<string, unknown> }) {
    let provider = normalizeProviderName(this.context.workspaceState.get<string>("minitok.setting.provider", ""));
    if (message.settings) for (const [key, value] of Object.entries(message.settings)) {
      if (key === "autoApprove" || key === "storeTaskText") {
        await vscode.workspace.getConfiguration("minitok").update(key, Boolean(value), vscode.ConfigurationTarget.Workspace);
      } else if (/^(provider|model|showCost|evidencePath|enterBehavior|(?:plan|work|review|intel)\.(?:provider|model))$/.test(key)) {
        await this.context.workspaceState.update(`minitok.setting.${key}`, value);
        if (key === "provider") provider = normalizeProviderName(String(value));
      }
    }
    // Migrate before storing new secrets so an explicit per-provider key in this
    // message is never overwritten by the legacy single-key migration.
    await migrateLegacyProviderApiKey(this.context.secrets, provider);
    if (message.secrets) for (const [key, value] of Object.entries(message.secrets)) {
      if (key === "providerApiKeys" && value && typeof value === "object" && !Array.isArray(value)) {
        // Per-provider keys from the settings form. Each maps to its own
        // SecretStorage slot; absent providers keep whatever was stored.
        for (const [p, secret] of Object.entries(value as Record<string, unknown>)) {
          if (typeof secret !== "string" || !secret) continue;
          if (isApiKeyProvider(p) || isNamedCustomKeyProvider(p)) {
            await this.context.secrets.store(apiKeySecretKey(normalizeCustomProviderName(p) || p), secret);
          }
        }
      } else if (key === "customEndpoints" && value && typeof value === "object" && !Array.isArray(value)) {
        // Named custom endpoints from the settings form: { "<name>": "<url>" }.
        // Empty URLs delete the entry (and its key mapping stays until a new
        // key is saved). Names are validated so they always survive the
        // MINITOK_CUSTOM_BASE_URL_<NAME> env round-trip in execute().
        const next: Record<string, string> = {};
        for (const [rawName, rawUrl] of Object.entries(value as Record<string, unknown>)) {
          const name = normalizeCustomProviderName(rawName);
          if (!isValidCustomProviderName(name)) continue;
          if (typeof rawUrl !== "string" || !rawUrl.trim()) continue;
          next[name] = rawUrl.trim();
        }
        await this.context.secrets.store("minitok.secret.customEndpoints", JSON.stringify(next));
      } else if (key === "providerApiKey" && typeof value === "string") {
        // Legacy single-key message from an older webview: it always belongs to
        // the provider chosen in the settings form. Only the four CLI-known
        // providers get a slot; anything else has no environment contract.
        if (isApiKeyProvider(provider) && value) await this.context.secrets.store(apiKeySecretKey(provider), value);
      } else if (typeof value === "string") {
        await this.context.secrets.store(`minitok.secret.${key}`, value);
      }
    }
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
    await migrateLegacyProviderApiKey(this.context.secrets, normalizeProviderName(String(settings.provider || "")));
    const providerApiKeySet: Record<string, boolean> = { anthropic: false, openai: false, google: false, custom: false };
    for (const p of API_KEY_PROVIDERS) providerApiKeySet[p] = Boolean(await this.context.secrets.get(apiKeySecretKey(p)));
    const customEndpoints = await readCustomEndpoints(this.context.secrets);
    // Surface named custom keys under their own badge so the UI can render one
    // row per endpoint. Secret values never leave SecretStorage.
    for (const name of Object.keys(customEndpoints)) {
      if (providerApiKeySet[name] === undefined) providerApiKeySet[name] = Boolean(await this.context.secrets.get(apiKeySecretKey(name)));
    }
    const legacyCustomBaseUrl = await this.context.secrets.get("minitok.secret.customBaseUrl");
    const secrets = { providerApiKeySet, customBaseUrlSet: Boolean(legacyCustomBaseUrl), customEndpoints };
    this.view?.webview.postMessage({ type: "settings", settings, secrets, version: cliRelease(this.context).version });
  }
  // The sidebar brand mark must render the same Harlekin 'm' glyph the Activity
  // Bar icon (media/minitok-activitybar.svg) uses, so the glyph is the SVG
  // artwork (media/minitok.svg) rather than a system-ui text 'm'. The webview
  // only resolves the file through asWebviewUri(); CSP img-src allows it.
  private html(webview: vscode.Webview) { const source = fs.readFileSync(path.join(this.extensionUri.fsPath, "src", "sidebar.html"), "utf8"); const brandUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "minitok.svg")); return source.replaceAll("{{nonce}}", randomBytes(16).toString("base64")).replaceAll("{{brandUri}}", brandUri.toString()).replace("{{cspSource}}", webview.cspSource); }
}
