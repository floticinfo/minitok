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
export function configuredServerUrl() {
  const configured = vscode.workspace.getConfiguration("minitok").get<string>("serverUrl", "https://api.minitok.dev").trim();
  let url: URL;
  try { url = new URL(configured); } catch { throw new Error("minitok.serverUrl must be a valid URL"); }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(loopback && url.protocol === "http:")) || url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) throw new Error("minitok.serverUrl must use HTTPS and contain only an origin");
  return url.origin;
}

/** Environment shared by every Extension-owned CLI subprocess. */
export function extensionCliEnvironment(extra: NodeJS.ProcessEnv = {}) {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra, MINITOK_UPDATE_CHECK: "0" };
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

export function mcpEnvironment() {
  const scopes = configuredMcpScopes().join(",");
  return { ...process.env, minitok_server_url: configuredServerUrl(), MINITOK_MCP_AUTH_TOKEN_FILE: path.join(os.homedir(), ".minitok", "mcp", "runtime-token.json"), MINITOK_CAPABILITY_FILE: capabilityFile(), MINITOK_MCP_SCOPES: scopes };
}

export function mcpAuthToken() {
  const tokenFile = path.join(os.homedir(), ".minitok", "mcp", "runtime-token.json");
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
  return new Promise<void>(resolve => {
    const spec = spawnSpec(cliPath(), ["mcp", "token"]);
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(); } };
    try {
      const child = spawn(spec.command, spec.args, { ...spawnOptionsFor(spec, { cwd: workspacePath() }), stdio: "ignore" });
      const timer = setTimeout(() => { child.kill(); done(); }, 30000);
      child.on("error", () => { clearTimeout(timer); done(); });
      child.on("close", () => { clearTimeout(timer); done(); });
    } catch { done(); }
  });
}

export function isCliCompatible(version: string) {
  return cliVersionCompatible(version);
}
