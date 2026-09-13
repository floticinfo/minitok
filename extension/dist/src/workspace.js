"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.workspacePath = workspacePath;
exports.requireTrustedWorkspace = requireTrustedWorkspace;
exports.cliPath = cliPath;
exports.spawnSpec = spawnSpec;
exports.mcpCommand = mcpCommand;
exports.mcpEnvironment = mcpEnvironment;
exports.mcpAuthToken = mcpAuthToken;
exports.autoApprove = autoApprove;
exports.ensureMcpAuthToken = ensureMcpAuthToken;
exports.isCliCompatible = isCliCompatible;
const vscode = __importStar(require("vscode"));
const path = __importStar(require("node:path"));
const fs = __importStar(require("node:fs"));
const os = __importStar(require("node:os"));
const node_child_process_1 = require("node:child_process");
const mcp_1 = require("./mcp");
const version_1 = require("./version");
function workspacePath() {
    const folders = vscode.workspace.workspaceFolders || [];
    if (!folders.length)
        return undefined;
    const active = vscode.window.activeTextEditor?.document.uri;
    if (active) {
        const match = folders.find(folder => active.fsPath === folder.uri.fsPath || active.fsPath.startsWith(`${folder.uri.fsPath}${path.sep}`));
        if (match)
            return match.uri.fsPath;
    }
    return folders[0].uri.fsPath;
}
function requireTrustedWorkspace(cwd) {
    if (!cwd)
        throw new Error("Open a workspace folder before running minitok");
    if (!vscode.workspace.isTrusted)
        throw new Error("Trust this workspace before running minitok");
}
// Probing the CLI runs synchronously on the extension host thread, so keep the
// cap short: a responsive CLI answers `--version` in well under a second.
const CLI_PROBE_TIMEOUT_MS = 3000;
function isNodeCli(candidate) {
    try {
        const version = (0, node_child_process_1.execFileSync)(candidate, ["--version"], { stdio: ["ignore", "pipe", "ignore"], timeout: CLI_PROBE_TIMEOUT_MS, windowsHide: true }).toString();
        return /^minitok\s+\d+\.\d+\.\d+/i.test(version) || /^\d+\.\d+\.\d+/.test(version.trim());
    }
    catch {
        return false;
    }
}
function defaultCliPath() {
    const candidates = process.platform === "win32" ? ["minitok.cmd", "minitok"] : ["minitok"];
    for (const candidate of candidates)
        if (isNodeCli(candidate))
            return candidate;
    const npmRoot = process.platform === "win32" ? process.env.APPDATA ? path.join(process.env.APPDATA, "npm") : undefined : undefined;
    const fallback = npmRoot ? path.join(npmRoot, "minitok.cmd") : undefined;
    if (fallback && fs.existsSync(fallback) && isNodeCli(fallback))
        return fallback;
    return candidates[0];
}
let cachedCliPath;
function cliPath() {
    const configured = vscode.workspace.getConfiguration("minitok").get("cliPath", "").trim();
    // isNodeCli blocks the extension host, so probe at most once per setting
    // instead of up to three synchronous probes on every call.
    if (cachedCliPath && cachedCliPath.configured === configured)
        return cachedCliPath.resolved;
    const resolved = configured && isNodeCli(configured) ? configured : defaultCliPath();
    cachedCliPath = { configured, resolved };
    return resolved;
}
function quoteCmdArg(value) { return `"${value.replace(/"/g, '\\"')}"`; }
function spawnSpec(command, args) {
    if (process.platform !== "win32" || !command.toLowerCase().endsWith(".cmd"))
        return { command, args, shell: false };
    const commandLine = ["call", quoteCmdArg(command), ...args.map(quoteCmdArg)].join(" ");
    return { command: process.env.ComSpec || "cmd.exe", args: ["/d", "/s", "/c", commandLine], shell: false };
}
function mcpCommand() {
    const configured = vscode.workspace.getConfiguration("minitok").get("mcpCommand", "");
    if (Array.isArray(configured)) {
        const parsed = configured.filter(value => typeof value === "string" && value.length > 0);
        if (parsed.length)
            return parsed;
    }
    if (typeof configured === "string" && configured.trim()) {
        const parsed = (0, mcp_1.parseMcpCommand)(configured);
        if (parsed.length)
            return parsed;
    }
    return (0, mcp_1.packagedMcpCommand)(path.resolve(__dirname, "../.."), process.execPath);
}
function mcpEnvironment() {
    return { ...process.env, MINITOK_MCP_AUTH_TOKEN_FILE: path.join(os.homedir(), ".minitok", "mcp", "runtime-token.json") };
}
function mcpAuthToken() {
    const tokenFile = mcpEnvironment().MINITOK_MCP_AUTH_TOKEN_FILE;
    try {
        const value = JSON.parse(fs.readFileSync(tokenFile, "utf8"));
        if (typeof value.token !== "string" || !value.token || value.revoked_at || typeof value.expires_at !== "number" || Date.now() >= value.expires_at)
            return undefined;
        return value.token;
    }
    catch {
        return undefined;
    }
}
function autoApprove() {
    return vscode.workspace.getConfiguration("minitok").get("autoApprove", false);
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
async function ensureMcpAuthToken() {
    const current = mcpAuthToken();
    if (current)
        return current;
    await refreshRuntimeToken();
    return mcpAuthToken();
}
function refreshRuntimeToken() {
    return new Promise(resolve => {
        const spec = spawnSpec(cliPath(), ["mcp", "token"]);
        let settled = false;
        const done = () => { if (!settled) {
            settled = true;
            resolve();
        } };
        try {
            const child = (0, node_child_process_1.spawn)(spec.command, spec.args, { cwd: workspacePath(), shell: spec.shell, windowsHide: true, stdio: "ignore" });
            const timer = setTimeout(() => { child.kill(); done(); }, 30000);
            child.on("error", () => { clearTimeout(timer); done(); });
            child.on("close", () => { clearTimeout(timer); done(); });
        }
        catch {
            done();
        }
    });
}
function isCliCompatible(version) {
    return (0, version_1.isCliCompatible)(version);
}
