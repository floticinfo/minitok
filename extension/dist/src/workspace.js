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
exports.MCP_SCOPES = exports.npmSpawnSpec = void 0;
exports.workspacePath = workspacePath;
exports.requireTrustedWorkspace = requireTrustedWorkspace;
exports.cliScriptCandidates = cliScriptCandidates;
exports.cliPath = cliPath;
exports.launchSpec = launchSpec;
exports.spawnSpec = spawnSpec;
exports.configuredServerUrl = configuredServerUrl;
exports.extensionCliEnvironment = extensionCliEnvironment;
exports.spawnOptionsFor = spawnOptionsFor;
exports.mcpCommand = mcpCommand;
exports.normalizeProviderName = normalizeProviderName;
exports.configuredMcpScopes = configuredMcpScopes;
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
const spawn_1 = require("./spawn");
Object.defineProperty(exports, "npmSpawnSpec", { enumerable: true, get: function () { return spawn_1.npmSpawnSpec; } });
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
    const spec = launchSpec(candidate, ["--version"]);
    try {
        // execFile* cannot pass a verbatim command line and throws EINVAL for a
        // `.cmd` shim on Node 18.20+, so a Windows candidate always looked unusable.
        // spawnSync supports both, which makes the probe match the real launch.
        const result = (0, node_child_process_1.spawnSync)(spec.command, spec.args, {
            stdio: ["ignore", "pipe", "ignore"],
            timeout: CLI_PROBE_TIMEOUT_MS,
            windowsHide: true,
            windowsVerbatimArguments: spec.windowsVerbatimArguments,
            env: { ...process.env, ...(spec.command === process.execPath ? { ELECTRON_RUN_AS_NODE: "1" } : {}) },
        });
        if (result.error || result.status !== 0)
            return false;
        const version = String(result.stdout || "");
        return /^minitok\s+\d+\.\d+\.\d+/i.test(version) || /^\d+\.\d+\.\d+/.test(version.trim());
    }
    catch {
        return false;
    }
}
/**
 * npm's global prefix holds the real JavaScript entry point. Running that with
 * node avoids cmd.exe entirely, which is the only reliable way to reach the CLI
 * on Windows (a Python executable that happens to be called `minitok` is
 * explicitly not supported).
 */
function cliScriptCandidates() {
    const bases = [process.env.npm_config_prefix];
    if (process.platform === "win32") {
        bases.push(process.env.APPDATA ? path.join(process.env.APPDATA, "npm") : undefined);
        bases.push(process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "npm") : undefined);
        bases.push(process.env.ProgramFiles ? path.join(process.env.ProgramFiles, "nodejs") : undefined);
    }
    else {
        bases.push("/usr/local/lib", "/usr/lib");
        bases.push(path.join(os.homedir(), ".npm-global", "lib"));
        bases.push(path.join(path.dirname(process.execPath), "..", "lib"));
    }
    return [...new Set(bases.filter((base) => Boolean(base)).map(base => path.join(base, "node_modules", "@flotic", "minitok", "bin", "minitok.js")))];
}
function defaultCliPath() {
    const scripts = cliScriptCandidates().filter(candidate => fs.existsSync(candidate));
    for (const script of scripts)
        if (isNodeCli(script))
            return script;
    const candidates = process.platform === "win32" ? ["minitok.cmd", "minitok"] : ["minitok"];
    for (const candidate of candidates)
        if (isNodeCli(candidate))
            return candidate;
    // Nothing answered the probe: prefer an installed script entry (node can still
    // run it) over a shim that may not exist.
    return scripts[0] || candidates[0];
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
/**
 * Launch spec for a command. A JavaScript entry runs under node and a
 * `.cmd`/`.bat` shim is handed to cmd.exe with the command line passed verbatim;
 * see ./spawn.ts for why both matter on Windows.
 */
function launchSpec(command, args) {
    return (0, spawn_1.spawnSpecFor)(process.platform, command, args, { comspec: process.env.ComSpec, nodePath: process.execPath });
}
function spawnSpec(command, args) {
    return launchSpec(command, args);
}
/**
 * Complete spawn options for a spec. Centralised so every call site inherits the
 * Windows verbatim-argument fix and the Electron-as-Node environment a
 * JavaScript CLI entry needs when the extension host itself is Electron.
 */
function configuredServerUrl() {
    const configured = vscode.workspace.getConfiguration("minitok").get("serverUrl", "https://api.minitok.dev").trim();
    let url;
    try {
        url = new URL(configured);
    }
    catch {
        throw new Error("minitok.serverUrl must be a valid URL");
    }
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if ((url.protocol !== "https:" && !(loopback && url.protocol === "http:")) || url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== ""))
        throw new Error("minitok.serverUrl must use HTTPS and contain only an origin");
    return url.origin;
}
/** Environment shared by every Extension-owned CLI subprocess. */
function extensionCliEnvironment(extra = {}) {
    const env = { ...process.env, ...extra, MINITOK_UPDATE_CHECK: "0" };
    // The CLI resolver intentionally uses the lower-case name so this also works
    // on POSIX hosts, where environment variable names are case-sensitive.
    env.minitok_server_url = configuredServerUrl();
    return env;
}
function spawnOptionsFor(spec, extra = {}) {
    const env = extensionCliEnvironment(extra.env || {});
    if (spec.command === process.execPath && !env.ELECTRON_RUN_AS_NODE)
        env.ELECTRON_RUN_AS_NODE = "1";
    return { cwd: extra.cwd, env, shell: spec.shell, windowsHide: true, windowsVerbatimArguments: spec.windowsVerbatimArguments, ...(extra.detached === undefined ? {} : { detached: extra.detached }) };
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
exports.MCP_SCOPES = ["read", "write", "auto_accept", "verify_exec"];
function normalizeProviderName(value) {
    const aliases = { claude: "anthropic", gpt: "openai", gemini: "google" };
    const key = String(value || "").trim().toLowerCase();
    return aliases[key] || key;
}
function configuredMcpScopes() {
    const configuredValue = vscode.workspace.getConfiguration("minitok").get("mcpScopes", "read");
    if (typeof configuredValue !== "string")
        throw new Error("minitok.mcpScopes must be a comma-separated string");
    const configured = configuredValue.trim() || "read";
    const scopes = [...new Set(configured.split(",").map(scope => scope.trim()).filter(Boolean))];
    const invalid = scopes.filter(scope => !exports.MCP_SCOPES.includes(scope));
    if (invalid.length)
        throw new Error(`Unsupported MCP scope(s): ${invalid.join(", ")}. Allowed: ${exports.MCP_SCOPES.join(", ")}`);
    return scopes.length ? scopes : ["read"];
}
function mcpEnvironment() {
    const scopes = configuredMcpScopes().join(",");
    return { ...process.env, minitok_server_url: configuredServerUrl(), MINITOK_MCP_AUTH_TOKEN_FILE: path.join(os.homedir(), ".minitok", "mcp", "runtime-token.json"), MINITOK_MCP_SCOPES: scopes };
}
function mcpAuthToken() {
    const tokenFile = path.join(os.homedir(), ".minitok", "mcp", "runtime-token.json");
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
            const child = (0, node_child_process_1.spawn)(spec.command, spec.args, { ...spawnOptionsFor(spec, { cwd: workspacePath() }), stdio: "ignore" });
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
