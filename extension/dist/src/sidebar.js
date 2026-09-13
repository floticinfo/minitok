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
exports.minitokSidebar = void 0;
const vscode = __importStar(require("vscode"));
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const node_child_process_1 = require("node:child_process");
const os = __importStar(require("node:os"));
const node_crypto_1 = require("node:crypto");
const workspace_1 = require("./workspace");
const entitlement_1 = require("./entitlement");
const device_auth_1 = require("./device-auth");
function cliRelease(context) {
    const release = context.extension.packageJSON.minitok;
    return { packageName: typeof release?.cliPackage === "string" ? release.cliPackage : "@flotic/minitok", version: typeof release?.cliVersion === "string" ? release.cliVersion : "0.0.0" };
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
    const positive = (value, fallback) => typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
    const approvalMs = positive(config.get("approvalTimeoutMs"), APPROVAL_TIMEOUT_MS);
    return { approvalMs, runMs: positive(config.get("runTimeoutMs"), approvalMs + RUN_TIMEOUT_MARGIN_MS) };
}
class minitokSidebar {
    extensionUri;
    context;
    static viewType = "minitok.sidebar";
    view;
    output = vscode.window.createOutputChannel("minitok");
    process;
    mcpProcess;
    approvalFile;
    activeRunId;
    activeRunStartedAt;
    constructor(extensionUri, context) {
        this.extensionUri = extensionUri;
        this.context = context;
    }
    resolveWebviewView(view) {
        this.view = view;
        view.webview.options = { enableScripts: true, localResourceRoots: [this.extensionUri] };
        view.webview.html = this.html(view.webview);
        view.webview.onDidReceiveMessage(message => this.handle(message));
    }
    async execute(args, cwd) {
        (0, workspace_1.requireTrustedWorkspace)(cwd);
        const cli = (0, workspace_1.cliPath)();
        const provider = this.context.workspaceState.get("minitok.setting.provider", "");
        const model = this.context.workspaceState.get("minitok.setting.model", "");
        const roles = ["plan", "work", "review", "intel"];
        const roleEnv = {};
        for (const role of roles) {
            const roleProvider = this.context.workspaceState.get(`minitok.setting.${role}.provider`, "");
            const roleModel = this.context.workspaceState.get(`minitok.setting.${role}.model`, "");
            if (roleProvider)
                roleEnv[`minitok_${role}_provider`] = roleProvider;
            if (roleModel)
                roleEnv[`minitok_${role}_model`] = roleModel;
        }
        const apiKey = await this.context.secrets.get("minitok.secret.providerApiKey");
        const customBaseUrl = await this.context.secrets.get("minitok.secret.customBaseUrl");
        const env = { ...process.env, ...roleEnv, ...(provider ? { minitok_default_provider: provider } : {}), ...(model ? { MINITOK_MODEL: model } : {}) };
        if (apiKey && provider === "anthropic")
            env.ANTHROPIC_API_KEY = apiKey;
        if (apiKey && provider === "openai")
            env.OPENAI_API_KEY = apiKey;
        if (apiKey && provider === "google")
            env.GOOGLE_API_KEY = apiKey;
        if (apiKey && provider === "custom")
            env.OPENAI_API_KEY = apiKey;
        if (customBaseUrl && provider === "custom")
            env.MINITOK_OPENAI_COMPATIBLE_BASE_URL = customBaseUrl;
        const timeouts = runTimeouts();
        if (cwd && args[0] === "run" && !args.includes("--dry-run") && !args.includes("--auto-accept")) {
            // autoApprove() adds --auto-accept just below, and auto-accept now takes
            // precedence over an approval file (loop.promptConfirmation). Passing both
            // would only produce an unused request file, so it is not written at all.
            this.approvalFile = path.join(cwd, ".minitok", "extension-approval.json");
            args.push("--approval-file", this.approvalFile, "--approval-timeout-ms", String(timeouts.approvalMs));
        }
        return new Promise((resolve, reject) => {
            const processSpec = (0, workspace_1.spawnSpec)(cli, args);
            this.output.appendLine(`[spawn] cli command=${JSON.stringify(processSpec.command)} args=${JSON.stringify(processSpec.args)} cwd=${JSON.stringify(cwd)}`);
            let child;
            try {
                child = (0, node_child_process_1.spawn)(processSpec.command, processSpec.args, (0, workspace_1.spawnOptionsFor)(processSpec, { cwd, env, detached: process.platform !== "win32" }));
            }
            catch (error) {
                reject(error);
                return;
            }
            this.process = child;
            let output = "";
            let error = "";
            const consume = (chunk) => {
                const text = chunk.toString();
                output += text;
                this.output.append(text);
                for (const line of text.split(/\r?\n/).filter(Boolean))
                    this.progress(line);
            };
            child.stdout.on("data", consume);
            child.stderr.on("data", (chunk) => {
                const text = chunk.toString();
                error += text;
                this.output.append(text);
                for (const line of text.split(/\r?\n/).filter(Boolean))
                    this.view?.webview.postMessage({ type: "log", stream: "stderr", text: line });
            });
            child.on("error", errorValue => { this.process = undefined; reject(errorValue); });
            const timeout = setTimeout(() => {
                this.stopProcess();
                this.view?.webview.postMessage({ type: "timeout", text: `minitok run timed out after ${Math.round(timeouts.runMs / 60000)} minutes` });
            }, timeouts.runMs);
            child.on("close", code => {
                clearTimeout(timeout);
                this.process = undefined;
                if (code === 0)
                    resolve(output);
                else
                    reject(new Error(error || output || `minitok exited with code ${code}`));
            });
        });
    }
    stopChild(child) {
        if (!child || child.killed)
            return;
        if (process.platform === "win32") {
            try {
                (0, node_child_process_1.execFileSync)("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, timeout: 10000 });
            }
            catch {
                child.kill();
            }
        }
        else {
            try {
                process.kill(-child.pid, "SIGTERM");
            }
            catch {
                child.kill("SIGTERM");
            }
        }
    }
    /**
     * npm is a batch shim on Windows, so it needs the same launch spec as the CLI:
     * `execFile("npm", ...)` throws EINVAL on Node 18.20+ and the update banner
     * silently never appeared.
     */
    runNpm(args, timeout, done) {
        const spec = (0, workspace_1.npmSpawnSpec)(process.platform, args, { comspec: process.env.ComSpec });
        (0, node_child_process_1.execFile)(spec.command, spec.args, { timeout, windowsHide: true, windowsVerbatimArguments: spec.windowsVerbatimArguments }, (error, stdout, stderr) => done(error, String(stdout), String(stderr)));
    }
    stopProcess() {
        this.stopChild(this.process);
    }
    dispose() {
        this.stopChild(this.process);
        this.stopChild(this.mcpProcess);
        this.output.dispose();
    }
    progress(line) {
        const stage = /Gathering repository intelligence|Planning|Implementing|Running verification|Reviewing|Evaluating goal progress/.exec(line)?.[0];
        if (stage)
            this.view?.webview.postMessage({ type: "progress", stage });
        if (line.startsWith("MINITOK_APPROVAL_REQUEST ")) {
            try {
                this.view?.webview.postMessage({ type: "approval-request", request: JSON.parse(line.slice("MINITOK_APPROVAL_REQUEST ".length)) });
            }
            catch {
                this.view?.webview.postMessage({ type: "log", stream: "stdout", text: "Invalid approval request received from minitok" });
            }
        }
        const summary = /Summary:.*?(\d+) cycles,.*?(\d[\d,]*) tokens.*?(?:, ~\$(\d+(?:\.\d+)?))?/.exec(line);
        if (summary)
            this.view?.webview.postMessage({ type: "summary", cycles: summary[1], tokens: summary[2], cost: summary[3] || "0" });
    }
    async handle(message) {
        if (message?.command === "auth-status") {
            const session = await (0, device_auth_1.refreshExtensionSession)(this.context);
            if (!session) {
                (0, entitlement_1.invalidateEntitlementCache)();
                this.view?.webview.postMessage({ type: "auth-state", ok: false, text: "Sign in with browser to continue." });
                return;
            }
            (0, entitlement_1.invalidateEntitlementCache)();
            const result = await (0, entitlement_1.checkEntitlement)();
            this.view?.webview.postMessage({ type: "auth-state", ok: result.allowed, text: result.allowed ? `Signed in with ${result.plan} plan.` : `Entitlement error: ${result.message || "An active paid plan is required."}` });
            return;
        }
        if (message?.command === "device-login") {
            try {
                await (0, device_auth_1.deviceLogin)(this.context, text => this.view?.webview.postMessage({ type: "auth-state", ok: false, text }));
                (0, entitlement_1.invalidateEntitlementCache)();
                const result = await (0, entitlement_1.checkEntitlement)();
                if (!result.allowed) {
                    this.view?.webview.postMessage({ type: "auth-state", ok: false, text: `Entitlement error: ${result.message || "An active paid plan is required."}` });
                    return;
                }
                this.view?.webview.postMessage({ type: "auth-state", ok: true, text: `Signed in with ${result.plan} plan.` });
            }
            catch (error) {
                this.view?.webview.postMessage({ type: "auth-state", ok: false, text: (0, device_auth_1.authErrorText)(error) });
            }
            return;
        }
        if (message?.command === "device-logout") {
            await (0, device_auth_1.logoutExtension)(this.context);
            (0, entitlement_1.invalidateEntitlementCache)();
            this.view?.webview.postMessage({ type: "auth-state", ok: false, text: "Signed out." });
            return;
        }
        if (message?.command === "customer-login") {
            await this.customerLogin(message.email, message.password);
            return;
        }
        const entitlementCommands = new Set(["run", "dry-run", "mcp-status", "mcp-connect", "mcp-list", "discover-models", "info", "open-evidence", "open-diff", "restore-session", "update"]);
        if (entitlementCommands.has(message?.command)) {
            try {
                await (0, entitlement_1.requireEntitlement)();
            }
            catch (error) {
                this.view?.webview.postMessage({ type: "entitlement", ok: false, text: String(error) });
                return;
            }
        }
        const commands = new Set(["device-login", "device-logout", "show-output", "stop", "interrupt", "approve", "reject", "open-evidence", "open-diff", "restore-session", "mcp-status", "mcp-connect", "mcp-list", "history", "sessions", "info", "discover-models", "activate", "attach-file", "attach-folder", "attach-problems", "settings", "save-settings", "update", "run", "dry-run"]);
        if (!message || typeof message.command !== "string" || !commands.has(message.command)) {
            this.view?.webview.postMessage({ type: "result", ok: false, text: "Unsupported command" });
            return;
        }
        if (message.task !== undefined && (typeof message.task !== "string" || message.task.length > 20000)) {
            this.view?.webview.postMessage({ type: "result", ok: false, text: "Task is invalid or too long" });
            return;
        }
        const cwd = (0, workspace_1.workspacePath)();
        if (message.command === "show-output") {
            this.output.show(true);
            return;
        }
        if (message.command === "stop" || message.command === "interrupt") {
            this.stopProcess();
            this.view?.webview.postMessage({ type: "stopped", text: message.command === "stop" ? "Run stopped." : "Run interrupted." });
            return;
        }
        if (message.command === "approve" || message.command === "reject") {
            if (this.approvalFile) {
                fs.mkdirSync(path.dirname(this.approvalFile), { recursive: true });
                let request = {};
                try {
                    request = JSON.parse(fs.readFileSync(this.approvalFile, "utf8"));
                }
                catch {
                    this.view?.webview.postMessage({ type: "result", ok: false, text: "Approval request is unavailable." });
                    return;
                }
                const response = `${this.approvalFile}.response`;
                const temp = `${response}.tmp-${process.pid}-${(0, node_crypto_1.randomUUID)()}`;
                try {
                    fs.writeFileSync(temp, `${JSON.stringify({ decision: message.command, nonce: request.nonce, run_id: request.run_id })}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
                    fs.renameSync(temp, response);
                }
                catch (error) {
                    try {
                        fs.unlinkSync(temp);
                    }
                    catch { }
                    throw error;
                }
            }
            this.view?.webview.postMessage({ type: "approval", decision: message.command });
            return;
        }
        if (message.command === "open-evidence") {
            if (cwd)
                await this.openEvidence(cwd);
            return;
        }
        if (message.command === "open-diff") {
            if (cwd)
                await this.openDiff(cwd);
            return;
        }
        if (message.command === "restore-session") {
            if (cwd && message.checkpoint)
                await this.restoreCheckpoint(cwd, message.checkpoint);
            return;
        }
        if (message.command === "mcp-status") {
            await this.checkMcpHealth();
            return;
        }
        if (message.command === "mcp-connect") {
            (0, workspace_1.requireTrustedWorkspace)((0, workspace_1.workspacePath)());
            await this.connectMcp(message.target);
            return;
        }
        if (message.command === "mcp-list") {
            this.listMcpHosts();
            return;
        }
        if (message.command === "history") {
            this.view?.webview.postMessage({ type: "history", items: this.context.workspaceState.get("minitok.history", []) });
            return;
        }
        if (message.command === "sessions") {
            this.view?.webview.postMessage({ type: "sessions", items: this.context.workspaceState.get("minitok.history", []) });
            return;
        }
        if (message.command === "info") {
            await this.readInfo(cwd);
            return;
        }
        if (message.command === "discover-models") {
            await this.discoverModels(cwd, message.provider);
            return;
        }
        if (message.command === "activate") {
            await this.readSettings();
            return;
        }
        if (message.command === "attach-file") {
            const uri = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: "Attach file" });
            if (uri?.[0])
                this.view?.webview.postMessage({ type: "attachment", value: `@file ${vscode.workspace.asRelativePath(uri[0])}` });
            return;
        }
        if (message.command === "attach-folder") {
            const uri = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectMany: false, openLabel: "Attach folder" });
            if (uri?.[0])
                this.view?.webview.postMessage({ type: "attachment", value: `@folder ${vscode.workspace.asRelativePath(uri[0])}` });
            return;
        }
        if (message.command === "attach-problems") {
            const diagnostics = vscode.languages.getDiagnostics().flatMap(([uri, items]) => items.map(item => `${vscode.workspace.asRelativePath(uri)}:${item.range.start.line + 1} ${item.message}`));
            this.view?.webview.postMessage({ type: "attachment", value: diagnostics.length ? `@problems\n${diagnostics.join("\n")}` : "" });
            return;
        }
        if (message.command === "settings") {
            await this.readSettings();
            await this.discoverModels(cwd, this.context.workspaceState.get("minitok.setting.provider", ""));
            await this.checkUpdate();
            return;
        }
        if (message.command === "save-settings") {
            await this.saveSettings(message);
            return;
        }
        if (message.command === "update") {
            (0, workspace_1.requireTrustedWorkspace)((0, workspace_1.workspacePath)());
            const release = cliRelease(this.context);
            const answer = await vscode.window.showInformationMessage(`Update minitok to ${release.version}?`, "Update", "Cancel");
            if (answer === "Update")
                this.runNpm(["install", "-g", `${release.packageName}@${release.version}`], 120000, (error, stdout, stderr) => this.view?.webview.postMessage({ type: "update-result", ok: !error, text: error ? stderr || error.message : stdout }));
            return;
        }
        try {
            (0, workspace_1.requireTrustedWorkspace)(cwd);
            if (this.process)
                throw new Error("A minitok run is already active");
            if (!message.task?.trim())
                throw new Error("Task description required");
            const runId = (0, node_crypto_1.randomUUID)();
            const startedAt = new Date().toISOString();
            const checkpoint = cwd ? path.join(cwd, ".minitok", "checkpoints", runId) : undefined;
            if (cwd && checkpoint) {
                fs.mkdirSync(checkpoint, { recursive: true });
                await this.captureCheckpoint(cwd, checkpoint, { runId, task: message.task, createdAt: startedAt });
            }
            this.activeRunId = runId;
            this.activeRunStartedAt = startedAt;
            const args = ["run", message.task, "--repo", cwd];
            if (message.command === "dry-run")
                args.push("--dry-run");
            else if ((0, workspace_1.autoApprove)())
                args.push("--auto-accept");
            this.view?.webview.postMessage({ type: "started", runId });
            const text = await this.execute(args, cwd);
            const evidence = cwd ? this.readEvidence(cwd) : null;
            const patch = cwd ? this.readPatch(cwd) : null;
            const history = this.context.workspaceState.get("minitok.history", []);
            const totalTokens = evidence?.tokens ? Number(evidence.tokens.input || 0) + Number(evidence.tokens.output || 0) : null;
            await this.context.workspaceState.update("minitok.history", [...history.slice(-19), { runId, task: message.task, startedAt, completedAt: new Date().toISOString(), status: "completed", success: true, totalTokens, cost: evidence?.cost ?? null, evidence: Boolean(evidence), evidencePath: cwd ? path.join(cwd, ".minitok", "evidence", "runs", "latest.json") : null, patchPath: cwd ? path.join(cwd, ".minitok", "last-run.patch") : null, checkpointPath: checkpoint }]);
            this.view?.webview.postMessage({ type: "result", ok: true, text, evidence, patch });
            if (patch)
                this.view?.webview.postMessage({ type: "patch", patch });
        }
        catch (error) {
            const history = this.context.workspaceState.get("minitok.history", []);
            if (this.activeRunId)
                await this.context.workspaceState.update("minitok.history", [...history.slice(-19), { runId: this.activeRunId, task: message.task, startedAt: this.activeRunStartedAt, completedAt: new Date().toISOString(), status: "failed", success: false, error: String(error) }]);
            this.view?.webview.postMessage({ type: "result", ok: false, text: String(error), runId: this.activeRunId });
        }
        finally {
            this.activeRunId = undefined;
            this.activeRunStartedAt = undefined;
        }
    }
    async customerLogin(email, password) {
        (0, workspace_1.requireTrustedWorkspace)((0, workspace_1.workspacePath)());
        if (!email?.trim() || !password) {
            this.view?.webview.postMessage({ type: "auth-state", ok: false, text: "Email and password are required." });
            return;
        }
        const cwd = (0, workspace_1.workspacePath)();
        const env = { ...process.env, MINITOK_CUSTOMER_EMAIL: email.trim(), MINITOK_CUSTOMER_PASSWORD: password };
        const spec = (0, workspace_1.spawnSpec)((0, workspace_1.cliPath)(), ["auth", "customer-login", "--email-env", "MINITOK_CUSTOMER_EMAIL", "--password-env", "MINITOK_CUSTOMER_PASSWORD"]);
        (0, node_child_process_1.execFile)(spec.command, spec.args, { ...(0, workspace_1.spawnOptionsFor)(spec, { cwd, env }), timeout: 30000 }, async (error, stdout, stderr) => {
            delete env.MINITOK_CUSTOMER_EMAIL;
            delete env.MINITOK_CUSTOMER_PASSWORD;
            if (error) {
                this.view?.webview.postMessage({ type: "auth-state", ok: false, text: stderr || error.message });
                return;
            }
            (0, entitlement_1.invalidateEntitlementCache)();
            const result = await (0, entitlement_1.checkEntitlement)();
            this.view?.webview.postMessage({ type: "auth-state", ok: result.allowed, text: result.allowed ? `Signed in with ${result.plan} plan.` : result.message || stdout });
        });
    }
    async discoverModels(cwd, provider) {
        (0, workspace_1.requireTrustedWorkspace)(cwd);
        const args = ["models", "--discover"];
        if (provider)
            args.splice(1, 0, provider);
        // cliPath() resolves the real entry point; the configured setting alone
        // defaulted to "minitok" and could not be launched on Windows.
        const spec = (0, workspace_1.spawnSpec)((0, workspace_1.cliPath)(), args);
        (0, node_child_process_1.execFile)(spec.command, spec.args, { ...(0, workspace_1.spawnOptionsFor)(spec, { cwd }), timeout: 30000 }, (error, stdout, stderr) => {
            const text = error ? stderr || error.message : stdout;
            const models = error ? [] : [...new Set((stdout.match(/(?:claude|gpt|o[134]|gemini|[\w-]+-\w+)[\w.:-]*/gi) || []).filter(id => !/^(models|available|provider)$/i.test(id)))];
            this.view?.webview.postMessage({ type: "models", ok: !error, text, provider: provider || "all", models });
        });
    }
    async readInfo(cwd) {
        (0, workspace_1.requireTrustedWorkspace)(cwd);
        const commands = [["status", "--repo", cwd], ["doctor"], ["evolution", "status"], ["workspace", "current"]];
        const outputs = [];
        for (const args of commands) {
            try {
                outputs.push(`$ minitok ${args.join(" ")}\n${await new Promise((resolve, reject) => { const spec = (0, workspace_1.spawnSpec)((0, workspace_1.cliPath)(), args); (0, node_child_process_1.execFile)(spec.command, spec.args, { ...(0, workspace_1.spawnOptionsFor)(spec, { cwd }), timeout: 15000 }, (error, stdout, stderr) => error ? reject(new Error(stderr || error.message)) : resolve(String(stdout).trim())); })} `);
            }
            catch (error) {
                outputs.push(`$ minitok ${args.join(" ")}\n${String(error)}`);
            }
        }
        this.view?.webview.postMessage({ type: "info", text: outputs.join("\n\n") });
    }
    listMcpHosts() {
        const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
        const configs = this.mcpConfigPaths();
        const hosts = Object.entries(configs).map(([name, configPath]) => ({ name, detected: this.safeConfigExists(configPath), configPath }));
        this.view?.webview.postMessage({ type: "mcp-hosts", hosts });
    }
    safeConfigExists(configPath) {
        try {
            return fs.existsSync(configPath) && !fs.lstatSync(configPath).isSymbolicLink();
        }
        catch {
            return false;
        }
    }
    mcpConfigPaths() {
        const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
        return {
            cline: path.join(appData, "Code", "User", "globalStorage", "saoudrizwan.claude-dev", "settings", "cline_mcp_settings.json"),
            claude: path.join(appData, "Claude", "claude_desktop_config.json"),
            cursor: path.join(appData, "Cursor", "User", "globalStorage", "mcp.json"),
        };
    }
    async connectMcp(target) {
        const configs = this.mcpConfigPaths();
        const candidates = target && Object.prototype.hasOwnProperty.call(configs, target) ? [target] : target ? [] : Object.keys(configs).filter(name => this.safeConfigExists(configs[name]));
        if (!candidates.length) {
            this.view?.webview.postMessage({ type: "mcp-connect", ok: false, text: target ? "Unsupported MCP host." : "No supported MCP host detected." });
            return;
        }
        const host = candidates[0];
        const configPath = configs[host];
        const approved = await vscode.window.showInformationMessage(`Connect minitok MCP to ${host}? A backup will be created before changes.`, "Connect", "Cancel");
        if (approved !== "Connect") {
            this.view?.webview.postMessage({ type: "mcp-connect", ok: false, text: "Connection cancelled." });
            return;
        }
        let config = {};
        if (this.safeConfigExists(configPath)) {
            const stat = fs.lstatSync(configPath);
            if (stat.isSymbolicLink())
                throw new Error("MCP config symlinks are not supported");
            const raw = fs.readFileSync(configPath, "utf8");
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
                throw new Error("MCP config must be a JSON object");
            config = parsed;
        }
        // Write back to the key the host actually uses. A configuration that lists its
        // servers under `servers` was read from that key but always written to
        // `mcpServers`, so the host never loaded the minitok entry (the CLI's
        // `mcp connect` already preserves the container key).
        const serversKey = config.mcpServers !== undefined ? "mcpServers" : config.servers !== undefined ? "servers" : "mcpServers";
        const existingServers = config[serversKey] ?? {};
        if (!existingServers || typeof existingServers !== "object" || Array.isArray(existingServers))
            throw new Error("MCP server configuration must be an object");
        const backup = `${configPath}.minitok-backup-${Date.now()}`;
        fs.mkdirSync(path.dirname(configPath), { recursive: true, mode: 0o700 });
        if (this.safeConfigExists(configPath))
            fs.copyFileSync(configPath, backup, fs.constants.COPYFILE_EXCL);
        const configuredMcp = (0, workspace_1.mcpCommand)();
        existingServers.minitok = { command: configuredMcp[0], args: configuredMcp.slice(1), env: { MINITOK_MCP_AUTH_TOKEN_FILE: (0, workspace_1.mcpEnvironment)().MINITOK_MCP_AUTH_TOKEN_FILE }, disabled: false };
        config[serversKey] = existingServers;
        const temp = `${configPath}.tmp-${process.pid}-${(0, node_crypto_1.randomUUID)()}`;
        try {
            fs.writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
            fs.renameSync(temp, configPath);
        }
        catch (error) {
            try {
                fs.unlinkSync(temp);
            }
            catch { }
            throw error;
        }
        this.view?.webview.postMessage({ type: "mcp-connect", ok: true, text: `Connected to ${host}. Backup: ${path.basename(backup)}` });
    }
    async checkMcpHealth() {
        (0, workspace_1.requireTrustedWorkspace)((0, workspace_1.workspacePath)());
        const cli = (0, workspace_1.cliPath)();
        if (this.mcpProcess) {
            this.view?.webview.postMessage({ type: "mcp", ok: false, text: "MCP health check already running" });
            return;
        }
        const configured = (0, workspace_1.mcpCommand)();
        if (!configured.length || !configured[0]) {
            this.view?.webview.postMessage({ type: "mcp", ok: false, text: "minitok MCP command is not configured" });
            return;
        }
        const processSpec = (0, workspace_1.spawnSpec)(configured[0], configured.slice(1));
        // Refresh the short lived runtime token before spawning the server, so both
        // sides use the same credential instead of failing 15 minutes after setup.
        await (0, workspace_1.ensureMcpAuthToken)();
        this.output.appendLine(`[spawn] mcp command=${JSON.stringify(processSpec.command)} args=${JSON.stringify(processSpec.args)} cwd=${JSON.stringify((0, workspace_1.workspacePath)())}`);
        let mcp;
        try {
            mcp = (0, node_child_process_1.spawn)(processSpec.command, processSpec.args, (0, workspace_1.spawnOptionsFor)(processSpec, { cwd: (0, workspace_1.workspacePath)(), env: (0, workspace_1.mcpEnvironment)() }));
        }
        catch (error) {
            this.output.appendLine(`[spawn] synchronous error=${String(error)}`);
            this.view?.webview.postMessage({ type: "mcp", ok: false, text: `MCP spawn failed: ${String(error)}` });
            return;
        }
        this.mcpProcess = mcp;
        let buffer = "";
        let nextId = 1;
        const timeout = setTimeout(() => { mcp.kill(); this.view?.webview.postMessage({ type: "mcp", ok: false, text: "MCP offline: handshake timed out" }); }, 5000);
        // Probe exactly the way a real MCP host does. The credential reaches the
        // server through mcpEnvironment() (MINITOK_MCP_AUTH_TOKEN_FILE), never
        // through request params: a host like VS Code, Claude Desktop or Cursor has
        // no way to inject one. Echoing the token here made this probe report
        // "online" while every real host failed on its first tool call.
        const send = (method, params = {}) => mcp.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params })}\n`);
        const finish = (ok, text) => { clearTimeout(timeout); if (this.mcpProcess === mcp)
            this.mcpProcess = undefined; this.stopChild(mcp); this.view?.webview.postMessage({ type: "mcp", ok, text }); };
        mcp.stdout.on("data", chunk => { buffer += chunk.toString(); const lines = buffer.split(/\r?\n/); buffer = lines.pop() || ""; for (const line of lines) {
            try {
                const message = JSON.parse(line);
                if (message.error)
                    finish(false, `MCP handshake error: ${message.error.message}`);
                else if (message.id === 1)
                    send("tools/list");
                else if (message.id === 2)
                    finish(true, `MCP online: ${message.result?.tools?.length || 0} tools`);
            }
            catch (error) {
                this.output.appendLine(`MCP invalid response: ${error instanceof Error ? error.message : String(error)}`);
            }
        } });
        mcp.on("error", error => finish(false, `MCP offline: ${error.message}`));
        send("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "minitok-sidebar", version: String(this.context.extension.packageJSON.version) } });
    }
    execGit(cwd, args) {
        (0, workspace_1.requireTrustedWorkspace)(cwd);
        return new Promise((resolve, reject) => (0, node_child_process_1.execFile)("git", args, { cwd, timeout: 30000, windowsHide: true }, (error, stdout, stderr) => error ? reject(new Error(stderr || error.message)) : resolve(stdout)));
    }
    async captureCheckpoint(cwd, checkpoint, metadata) {
        const [diff, status] = await Promise.all([this.execGit(cwd, ["diff", "--binary"]), this.execGit(cwd, ["status", "--short", "--untracked-files=all"])]);
        fs.writeFileSync(path.join(checkpoint, "metadata.json"), JSON.stringify({ ...metadata, repository: cwd, capturedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
        fs.writeFileSync(path.join(checkpoint, "working-tree.patch"), diff, { mode: 0o600 });
        fs.writeFileSync(path.join(checkpoint, "status.txt"), status, { mode: 0o600 });
    }
    async restoreCheckpoint(cwd, checkpoint) {
        const patch = path.join(checkpoint, "working-tree.patch");
        if (!fs.existsSync(patch))
            throw new Error("Checkpoint patch not found");
        const status = await this.execGit(cwd, ["status", "--porcelain"]);
        const answer = await vscode.window.showWarningMessage("Restore checkpoint? Current working-tree changes will be replaced.", "Restore", "Cancel");
        if (answer !== "Restore")
            return;
        if (status.trim())
            throw new Error("Restore blocked: working tree is not clean");
        await this.execGit(cwd, ["apply", "--3way", patch]);
        this.view?.webview.postMessage({ type: "checkpoint", text: "Checkpoint restored." });
    }
    readPatch(cwd) { try {
        return fs.readFileSync(path.join(cwd, ".minitok", "last-run.patch"), "utf8").slice(0, 200000);
    }
    catch {
        return null;
    } }
    async openDiff(cwd) {
        const patch = this.readPatch(cwd);
        if (!patch) {
            vscode.window.showInformationMessage("No minitok patch found");
            return;
        }
        const file = path.join(cwd, ".minitok", "last-run.patch");
        const original = await vscode.workspace.openTextDocument({ content: "", language: "diff" });
        const modified = await vscode.workspace.openTextDocument({ content: patch, language: "diff" });
        await vscode.commands.executeCommand("vscode.diff", original.uri, modified.uri, "minitok changes", { preview: false });
    }
    async openEvidence(cwd) {
        const file = path.join(cwd, ".minitok", "evidence", "runs", "latest.json");
        if (fs.existsSync(file))
            await vscode.window.showTextDocument(vscode.Uri.file(file));
        else
            vscode.window.showWarningMessage("No minitok evidence found");
    }
    readEvidence(cwd) { try {
        return JSON.parse(fs.readFileSync(path.join(cwd, ".minitok", "evidence", "runs", "latest.json"), "utf8"));
    }
    catch {
        return null;
    } }
    async saveSettings(message) {
        if (message.settings)
            for (const [key, value] of Object.entries(message.settings)) {
                if (key === "autoApprove") {
                    await vscode.workspace.getConfiguration("minitok").update(key, Boolean(value), vscode.ConfigurationTarget.Workspace);
                }
                else if (/^(provider|model|showCost|evidencePath|enterBehavior|(?:plan|work|review|intel)\.(?:provider|model))$/.test(key)) {
                    await this.context.workspaceState.update(`minitok.setting.${key}`, value);
                }
            }
        if (message.secrets)
            for (const [key, value] of Object.entries(message.secrets))
                await this.context.secrets.store(`minitok.secret.${key}`, value);
        this.view?.webview.postMessage({ type: "settings-saved" });
    }
    async checkUpdate() {
        (0, workspace_1.requireTrustedWorkspace)((0, workspace_1.workspacePath)());
        const release = cliRelease(this.context);
        this.runNpm(["view", release.packageName, "version", "--json"], 10000, (error, stdout) => this.view?.webview.postMessage({ type: "update", current: release.version, latest: error ? null : stdout.trim().replace(/^"|"$/g, "") }));
    }
    async readSettings() {
        const settings = Object.fromEntries(["provider", "model", "showCost", "evidencePath", "autoApprove", "enterBehavior", "plan.provider", "plan.model", "work.provider", "work.model", "review.provider", "review.model", "intel.provider", "intel.model"].map(key => [key, key === "autoApprove" ? vscode.workspace.getConfiguration("minitok").get(key, false) : this.context.workspaceState.get(`minitok.setting.${key}`, undefined)]));
        const secrets = { providerApiKeySet: Boolean(await this.context.secrets.get("minitok.secret.providerApiKey")), customBaseUrlSet: Boolean(await this.context.secrets.get("minitok.secret.customBaseUrl")) };
        this.view?.webview.postMessage({ type: "settings", settings, secrets });
    }
    html(webview) { const source = fs.readFileSync(path.join(this.extensionUri.fsPath, "src", "sidebar.html"), "utf8"); return source.replaceAll("{{nonce}}", (0, node_crypto_1.randomBytes)(16).toString("base64")).replace("{{cspSource}}", webview.cspSource); }
}
exports.minitokSidebar = minitokSidebar;
