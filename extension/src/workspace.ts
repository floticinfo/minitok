import * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { execFileSync, spawn } from "node:child_process";
import { packagedMcpCommand, parseMcpCommand } from "./mcp";
import { isCliCompatible as cliVersionCompatible } from "./version";

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
  try {
    const version = execFileSync(candidate, ["--version"], { stdio: ["ignore", "pipe", "ignore"], timeout: CLI_PROBE_TIMEOUT_MS, windowsHide: true }).toString();
    return /^minitok\s+\d+\.\d+\.\d+/i.test(version) || /^\d+\.\d+\.\d+/.test(version.trim());
  } catch { return false; }
}

function defaultCliPath() {
  const candidates = process.platform === "win32" ? ["minitok.cmd", "minitok"] : ["minitok"];
  for (const candidate of candidates) if (isNodeCli(candidate)) return candidate;
  const npmRoot = process.platform === "win32" ? process.env.APPDATA ? path.join(process.env.APPDATA, "npm") : undefined : undefined;
  const fallback = npmRoot ? path.join(npmRoot, "minitok.cmd") : undefined;
  if (fallback && fs.existsSync(fallback) && isNodeCli(fallback)) return fallback;
  return candidates[0];
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

function quoteCmdArg(value: string) { return `"${value.replace(/"/g, '\\"')}"`; }

export function spawnSpec(command: string, args: string[]) {
  if (process.platform !== "win32" || !command.toLowerCase().endsWith(".cmd")) return { command, args, shell: false };
  const commandLine = ["call", quoteCmdArg(command), ...args.map(quoteCmdArg)].join(" ");
  return { command: process.env.ComSpec || "cmd.exe", args: ["/d", "/s", "/c", commandLine], shell: false };
}

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

export function mcpEnvironment() {
  return { ...process.env, MINITOK_MCP_AUTH_TOKEN_FILE: path.join(os.homedir(), ".minitok", "mcp", "runtime-token.json") };
}

export function mcpAuthToken() {
  const tokenFile = mcpEnvironment().MINITOK_MCP_AUTH_TOKEN_FILE;
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
      const child = spawn(spec.command, spec.args, { cwd: workspacePath(), shell: spec.shell, windowsHide: true, stdio: "ignore" });
      const timer = setTimeout(() => { child.kill(); done(); }, 30000);
      child.on("error", () => { clearTimeout(timer); done(); });
      child.on("close", () => { clearTimeout(timer); done(); });
    } catch { done(); }
  });
}

export function isCliCompatible(version: string) {
  return cliVersionCompatible(version);
}
