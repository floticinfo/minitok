import * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { packagedMcpCommand, parseMcpCommand } from "./mcp";
import { isCliCompatible as cliVersionCompatible } from "./version";
import { npmSpawnSpec, spawnSpecFor, type SpawnSpec } from "./spawn";

export function workspacePath() {
  const folders = vscode.workspace.workspaceFolders || [];
  if (!folders.length) return undefined;
  const active = vscode.window.activeTextEditor?.document.uri;
  if (active) {
    const match = folders.find(folder => active.fsPath === folder.uri.fsPath || active.fsPath.startsWith(`${folder.uri.fsPath}${path.sep}`));
    if (match) return match.uri.fsPath;
  }
  return folders[0].uri.fsPath;
}

export function requireTrustedWorkspace(cwd?: string) {
  if (!cwd) throw new Error("Open a workspace folder before running minitok");
  if (!vscode.workspace.isTrusted) throw new Error("Trust this workspace before running minitok");
}

// Probing the CLI runs synchronously on the extension host thread, so keep the
// cap short: a responsive CLI answers `--version` in well under a second.
const CLI_PROBE_TIMEOUT_MS = 3000;

function isNodeCli(candidate: string) {
  const spec = launchSpec(candidate, ["--version"]);
  try {
    // execFile* cannot pass a verbatim command line and throws EINVAL for a
    // `.cmd` shim on Node 18.20+, so a Windows candidate always looked unusable.
    // spawnSync supports both, which makes the probe match the real launch.
    const result = spawnSync(spec.command, spec.args, {
      stdio: ["ignore", "pipe", "ignore"],
      timeout: CLI_PROBE_TIMEOUT_MS,
      windowsHide: true,
      windowsVerbatimArguments: spec.windowsVerbatimArguments,
      env: { ...process.env, ...(spec.command === process.execPath ? { ELECTRON_RUN_AS_NODE: "1" } : {}) },
    });
    if (result.error || result.status !== 0) return false;
    const version = String(result.stdout || "");
    return /^minitok\s+\d+\.\d+\.\d+/i.test(version) || /^\d+\.\d+\.\d+/.test(version.trim());
  } catch { return false; }
}

/**
 * npm's global prefix holds the real JavaScript entry point. Running that with
 * node avoids cmd.exe entirely, which is the only reliable way to reach the CLI
 * on Windows (a Python executable that happens to be called `minitok` is
 * explicitly not supported).
 */
export function cliScriptCandidates() {
  const bases: Array<string | undefined> = [process.env.npm_config_prefix];
  if (process.platform === "win32") {
    bases.push(process.env.APPDATA ? path.join(process.env.APPDATA, "npm") : undefined);
    bases.push(process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "npm") : undefined);
    bases.push(process.env.ProgramFiles ? path.join(process.env.ProgramFiles, "nodejs") : undefined);
  } else {
    bases.push("/usr/local/lib", "/usr/lib");
    bases.push(path.join(os.homedir(), ".npm-global", "lib"));
    bases.push(path.join(path.dirname(process.execPath), "..", "lib"));
  }
  return [...new Set(bases.filter((base): base is string => Boolean(base)).map(base => path.join(base, "node_modules", "@flotic", "minitok", "bin", "minitok.js")))];
}

function defaultCliPath() {
  const scripts = cliScriptCandidates().filter(candidate => fs.existsSync(candidate));
  for (const script of scripts) if (isNodeCli(script)) return script;
  const candidates = process.platform === "win32" ? ["minitok.cmd", "minitok"] : ["minitok"];
  for (const candidate of candidates) if (isNodeCli(candidate)) return candidate;
  // Nothing answered the probe: prefer an installed script entry (node can still
  // run it) over a shim that may not exist.
  return scripts[0] || candidates[0];
}

let cachedCliPath: { configured: string; resolved: string } | undefined;

export function cliPath() {
  const configured = vscode.workspace.getConfiguration("minitok").get<string>("cliPath", "").trim();
  // isNodeCli blocks the extension host, so probe at most once per setting
  // instead of up to three synchronous probes on every call.
  if (cachedCliPath && cachedCliPath.configured === configured) return cachedCliPath.resolved;
  const resolved = configured && isNodeCli(configured) ? configured : defaultCliPath();
  cachedCliPath = { configured, resolved };
  return resolved;
}

/**
 * Launch spec for a command. A JavaScript entry runs under node and a
 * `.cmd`/`.bat` shim is handed to cmd.exe with the command line passed verbatim;
 * see ./spawn.ts for why both matter on Windows.
 */
export function launchSpec(command: string, args: string[]): SpawnSpec {
  return spawnSpecFor(process.platform, command, args, { comspec: process.env.ComSpec, nodePath: process.execPath });
}

export function spawnSpec(command: string, args: string[]) {
  return launchSpec(command, args);
}

/**
 * Complete spawn options for a spec. Centralised so every call site inherits the
 * Windows verbatim-argument fix and the Electron-as-Node environment a
 * JavaScript CLI entry needs when the extension host itself is Electron.
 */
export function workspaceRelativePath(cwd: string, configured: string, label: string) {
  const root = path.resolve(cwd);
  const file = path.resolve(root, configured || "");
  const boundary = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (file !== root && !file.startsWith(boundary)) throw new Error(`minitok.${label} must stay inside the workspace`);
  return file;
}

export function configuredServerUrl() {
  const configured = vscode.workspace.getConfiguration("minitok").get<string>("serverUrl", "https://api.minitok.dev").trim();
  let url: URL;
  try { url = new URL(configured); } catch { throw new Error("minitok.serverUrl must be a valid URL"); }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(loopback && url.protocol === "http:")) || url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) throw new Error("minitok.serverUrl must use HTTPS and contain only an origin");
  return url.origin;
}

/** Maximum retained output from an Extension-owned CLI subprocess. */
export const CLI_OUTPUT_MAX_BYTES = 4 * 1024 * 1024;

/** Append process output without allowing a long-lived Extension host to grow unbounded. */
export function appendBoundedOutput(current: string, chunk: string, maxBytes = CLI_OUTPUT_MAX_BYTES) {
  const next = `${current}${chunk}`;
  if (Buffer.byteLength(next, "utf8") <= maxBytes) return next;
  const marker = "\n[output truncated by minitok extension]\n";
  const budget = Math.max(0, maxBytes - Buffer.byteLength(marker, "utf8"));
  let retained = next;
  while (Buffer.byteLength(retained, "utf8") > budget) retained = retained.slice(Math.max(1, Math.ceil(retained.length / 8)));
  return `${retained}${marker}`;
}

const CLI_ENV_ALLOWLIST = [
  "PATH", "Path", "PATHEXT", "ComSpec", "SystemRoot", "WINDIR",
  "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP",
  "LANG", "LC_ALL", "LC_CTYPE", "NODE_PATH",
] as const;
const CLI_EXPLICIT_ENV = new Set([
  "MINITOK_UPDATE_CHECK", "MINITOK_CUSTOM_BASE_URL", "MINITOK_OPENAI_COMPATIBLE_BASE_URL",
  "MINITOK_MCP_AUTH_TOKEN_FILE", "MINITOK_MCP_SCOPES", "MINITOK_MCP_WORKSPACE_ROOT",
  "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GOOGLE_API_KEY", "GEMINI_API_KEY",
  "MINITOK_EXTENSION_CUSTOMER_TOKEN", "MINITOK_CUSTOMER_EMAIL", "MINITOK_CUSTOMER_PASSWORD",
  // Entitlement activation key. Passed by name to `minitok activate --key-env`
  // and never on argv, so the secret stays out of process listings: the CLI
  // rejects a key it cannot find in the environment rather than on the command
  // line. Callers delete it from the child env as soon as the spawn returns.
  "MINITOK_ACTIVATION_KEY",
  // One-time run delegation token (admin run in the extension host). Same
  // env-only contract as the activation key: the CLI reads it in the
  // entitlement gate, verifies it against the server (which burns it), and
  // deletes it from its own environment before the pipeline can spawn
  // grandchildren, so the token never reaches argv or a shell command.
  "MINITOK_RUN_DELEGATION",
]);
function isAllowedCliEnv(key: string) {
  if ((CLI_ENV_ALLOWLIST as readonly string[]).includes(key) || CLI_EXPLICIT_ENV.has(key)) return true;
  if (/^minitok_(?:default_provider|model|server_url|plan_|work_|review_|intel_)/.test(key)) return true;
  // Named custom providers managed in the settings UI: one endpoint pair plus
  // the JSON manifest per run, and one key variable per provider name.
  if (key === "MINITOK_CUSTOM_PROVIDERS_JSON") return true;
  if (/^MINITOK_CUSTOM_BASE_URL_[A-Z0-9_]+$/.test(key)) return true;
  if (/^MINITOK_CUSTOM_API_KEY_[A-Z0-9_]+$/.test(key)) return true;
  return false;
}

/** Environment shared by every Extension-owned CLI subprocess. */
export function extensionCliEnvironment(extra: NodeJS.ProcessEnv = {}) {
  const env: NodeJS.ProcessEnv = {};
  for (const key of CLI_ENV_ALLOWLIST) if (process.env[key] !== undefined) env[key] = process.env[key];
  for (const [key, value] of Object.entries(extra)) if (value !== undefined && isAllowedCliEnv(key)) env[key] = value;
  env.MINITOK_UPDATE_CHECK = "0";
  // The CLI resolver intentionally uses the lower-case name so this also works
  // on POSIX hosts, where environment variable names are case-sensitive.
  env.minitok_server_url = configuredServerUrl();
  return env;
}

export function spawnOptionsFor(spec: SpawnSpec, extra: { cwd?: string; env?: NodeJS.ProcessEnv; detached?: boolean } = {}) {
  const env = extensionCliEnvironment(extra.env || {});
  if (spec.command === process.execPath && !env.ELECTRON_RUN_AS_NODE) env.ELECTRON_RUN_AS_NODE = "1";
  return { cwd: extra.cwd, env, shell: spec.shell, windowsHide: true, windowsVerbatimArguments: spec.windowsVerbatimArguments, ...(extra.detached === undefined ? {} : { detached: extra.detached }) };
}

export { npmSpawnSpec };

export function mcpCommand() {
  const configured = vscode.workspace.getConfiguration("minitok").get<string | string[]>("mcpCommand", "");
  if (Array.isArray(configured)) {
    const parsed = configured.filter(value => typeof value === "string" && value.length > 0);
    if (parsed.length) return parsed;
  }
  if (typeof configured === "string" && configured.trim()) {
    const parsed = parseMcpCommand(configured);
    if (parsed.length) return parsed;
  }
  return packagedMcpCommand(path.resolve(__dirname, "../.."), process.execPath);
}

export const MCP_SCOPES = ["read", "write", "auto_accept", "verify_exec", "unrestricted_autonomous", "unrestricted_general_autonomous"] as const;

export function capabilityFile() {
  return path.join(os.homedir(), ".minitok", "entitlement", "capability-token.json");
}

export function normalizeProviderName(value: string) {
  const aliases: Record<string, string> = { claude: "anthropic", gpt: "openai", gemini: "google" };
  const key = String(value || "").trim().toLowerCase();
  return aliases[key] || key;
}

export function configuredMcpScopes() {
  const configuredValue = vscode.workspace.getConfiguration("minitok").get<string>("mcpScopes", "read");
  if (typeof configuredValue !== "string") throw new Error("minitok.mcpScopes must be a comma-separated string");
  const configured = configuredValue.trim() || "read";
  const scopes = [...new Set(configured.split(",").map(scope => scope.trim()).filter(Boolean))];
  const invalid = scopes.filter(scope => !(MCP_SCOPES as readonly string[]).includes(scope));
  if (invalid.length) throw new Error(`Unsupported MCP scope(s): ${invalid.join(", ")}. Allowed: ${MCP_SCOPES.join(", ")}`);
  return scopes.length ? scopes : ["read"];
}

const MCP_ENV_ALLOWLIST = [
  "PATH", "Path", "PATHEXT", "ComSpec", "SystemRoot", "WINDIR",
  "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP",
  "LANG", "LC_ALL", "LC_CTYPE", "NODE_PATH",
  // Non-secret provider configuration used by the extension custom-provider
  // contract. Credentials are added per provider by the caller, never inherited.
  "MINITOK_CUSTOM_BASE_URL", "MINITOK_OPENAI_COMPATIBLE_BASE_URL",
  "MINITOK_CUSTOM_PROVIDERS_JSON",
] as const;
const MCP_ENV_PATTERN_ALLOWLIST = [/^MINITOK_CUSTOM_BASE_URL_[A-Z0-9_]+$/];
function inheritedMcpEnvironment() {
  const env: NodeJS.ProcessEnv = {};
  for (const key of MCP_ENV_ALLOWLIST) if (process.env[key] !== undefined) env[key] = process.env[key];
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (MCP_ENV_PATTERN_ALLOWLIST.some(pattern => pattern.test(key)) && env[key] === undefined) env[key] = value;
  }
  return env;
}
/** Canonical path of the rotating MCP runtime token file. */
function runtimeTokenFile() {
  const dir = path.join(os.homedir(), ".minitok", "mcp");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return path.join(dir, "runtime-token.json");
}

export function mcpEnvironment() {
  const scopes = configuredMcpScopes().join(",");
  const root = workspacePath();
  return {
    ...inheritedMcpEnvironment(),
    minitok_server_url: configuredServerUrl(),
    MINITOK_MCP_AUTH_TOKEN_FILE: runtimeTokenFile(),
    MINITOK_CAPABILITY_FILE: capabilityFile(),
    MINITOK_MCP_SCOPES: scopes,
    ...(root ? { MINITOK_MCP_WORKSPACE_ROOT: root } : {}),
  };
}

export function mcpAuthToken() {
  const tokenFile = runtimeTokenFile();
  try {
    const value = JSON.parse(fs.readFileSync(tokenFile, "utf8")) as { token?: unknown; expires_at?: unknown; revoked_at?: unknown };
    if (typeof value.token !== "string" || !value.token || value.revoked_at || typeof value.expires_at !== "number" || Date.now() >= value.expires_at) return undefined;
    return value.token;
  } catch { return undefined; }
}

export function autoApprove() {
  return vscode.workspace.getConfiguration("minitok").get<boolean>("autoApprove", false);
}

/**
 * A usable MCP auth token for a handshake.
 *
 * The runtime token expires after 15 minutes and only `minitok mcp connect` used
 * to rotate it, so MCP access silently stopped working 15 minutes after setup.
 * Refresh through the CLI (which owns the installation binding) when the file is
 * missing, expired or revoked. Uses spawn rather than execFileSync so the
 * extension host is never blocked while the CLI runs.
 */
export async function ensureMcpAuthToken() {
  const current = mcpAuthToken();
  if (current) return current;
  await refreshRuntimeToken();
  return mcpAuthToken();
}

function refreshRuntimeToken(): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const spec = spawnSpec(cliPath(), ["mcp", "token"]);
    let settled = false;
    const done = (error?: Error) => { if (!settled) { settled = true; if (error) reject(error); else resolve(); } };
    try {
      const child = spawn(spec.command, spec.args, { ...spawnOptionsFor(spec, { cwd: workspacePath() }), stdio: "ignore" });
      const timer = setTimeout(() => { child.kill(); done(new Error("minitok mcp token timed out")); }, 30000);
      child.on("error", (error) => { clearTimeout(timer); done(error); });
      child.on("close", (code) => { clearTimeout(timer); done(code ? new Error(`minitok mcp token exited with code ${code}`) : undefined); });
    } catch (error) { done(error instanceof Error ? error : new Error(String(error))); }
  });
}

export function isCliCompatible(version: string) {
  return cliVersionCompatible(version);
}
