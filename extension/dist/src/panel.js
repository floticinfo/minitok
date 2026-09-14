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
exports.minitokPanel = void 0;
const vscode = __importStar(require("vscode"));
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const node_child_process_1 = require("node:child_process");
const node_crypto_1 = require("node:crypto");
const workspace_1 = require("./workspace");
const entitlement_1 = require("./entitlement");
const device_auth_1 = require("./device-auth");
const redaction_1 = require("./redaction");
const CLI_TIMEOUT_MS = 1800000;
const redactPanelOutput = redaction_1.redactSensitiveText;
/**
 * Kill a child process and everything it spawned.
 * Windows needs taskkill /t; POSIX children are started detached so the whole
 * process group can be signalled.
 */
function killProcessTree(child) {
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
function runCli(cliPath, args, cwd, onProcess) {
    return new Promise((resolve, reject) => {
        const processSpec = (0, workspace_1.spawnSpec)(cliPath, args);
        const child = (0, node_child_process_1.spawn)(processSpec.command, processSpec.args, (0, workspace_1.spawnOptionsFor)(processSpec, { cwd, detached: process.platform !== "win32" }));
        onProcess(child);
        let stdout = "";
        let stderr = "";
        let settled = false;
        let timer;
        const finish = (error) => {
            if (settled)
                return;
            settled = true;
            if (timer)
                clearTimeout(timer);
            onProcess(undefined);
            if (error)
                reject(error);
            else
                resolve(stdout);
        };
        timer = setTimeout(() => {
            killProcessTree(child);
            // Settle from the timeout as well. If the kill cannot be delivered (a
            // detached tree on Windows, an unkillable handle) no close event ever
            // fires and the panel would stay "run active" forever.
            finish(new Error("minitok timed out after 30 minutes"));
        }, CLI_TIMEOUT_MS);
        child.stdout.on("data", chunk => { stdout += chunk.toString(); });
        child.stderr.on("data", chunk => { stderr += chunk.toString(); });
        child.on("error", error => finish(error));
        child.on("close", code => { if (code === 0)
            finish();
        else
            finish(new Error(stderr || stdout || `minitok exited with code ${code}`)); });
    });
}
class minitokPanel {
    context;
    static current;
    panel;
    extensionUri;
    disposables = [];
    process;
    static createOrShow(context) {
        if (minitokPanel.current) {
            minitokPanel.current.panel.reveal();
            return;
        }
        const panel = vscode.window.createWebviewPanel("minitok", "minitok", vscode.ViewColumn.Beside, { enableScripts: true, retainContextWhenHidden: true });
        minitokPanel.current = new minitokPanel(panel, context.extensionUri, context);
    }
    constructor(panel, extensionUri, context) {
        this.context = context;
        this.panel = panel;
        this.extensionUri = extensionUri;
        this.panel.webview.html = this.html();
        this.panel.webview.onDidReceiveMessage(message => {
            void this.handle(message).catch(error => this.post(false, redactPanelOutput(String(error))));
        }, null, this.disposables);
        void this.authStatus();
        this.panel.onDidDispose(() => { minitokPanel.current = undefined; this.dispose(); }, null, this.disposables);
    }
    async openBilling(kind) {
        const session = await (0, device_auth_1.refreshExtensionSession)(this.context);
        if (!session?.access_token) {
            this.post(false, "Sign in before managing your plan.");
            return;
        }
        const envName = "MINITOK_EXTENSION_CUSTOMER_TOKEN";
        const env = { ...process.env, MINITOK_UPDATE_CHECK: "0", [envName]: session.access_token };
        const spec = (0, workspace_1.spawnSpec)((0, workspace_1.cliPath)(), [kind, "--token-env", envName, "--json"]);
        (0, node_child_process_1.execFile)(spec.command, spec.args, { ...(0, workspace_1.spawnOptionsFor)(spec, { cwd: (0, workspace_1.workspacePath)(), env }), timeout: 30000 }, async (error, stdout, stderr) => {
            delete env[envName];
            if (error) {
                this.post(false, redactPanelOutput(stderr || error.message));
                return;
            }
            try {
                const result = JSON.parse(String(stdout).trim());
                const target = kind === "checkout" ? result.checkout_url : result.portal_url;
                if (!target || !/^https:\/\//i.test(target))
                    throw new Error("Billing service returned an invalid URL");
                await vscode.env.openExternal(vscode.Uri.parse(target));
                this.post(true, kind === "checkout" ? "Checkout opened in your browser." : "Billing portal opened in your browser.");
            }
            catch (parseError) {
                this.post(false, redactPanelOutput(parseError instanceof Error ? parseError.message : String(parseError)));
            }
        });
    }
    async authStatus() {
        const session = await (0, device_auth_1.refreshExtensionSession)(this.context);
        if (!session) {
            this.postAuth("signed-out", false, false, "Sign in to continue.");
            return;
        }
        (0, entitlement_1.invalidateEntitlementCache)();
        const result = await (0, entitlement_1.checkEntitlement)();
        this.postAuth(result.allowed ? "authenticated" : "not-entitled", true, result.allowed, result.allowed ? `Signed in with ${result.plan} plan.` : (result.message || "An active paid plan is required."));
    }
    postAuth(state, authenticated, entitled, text) {
        this.panel.webview.postMessage({ type: "auth-state", state, authenticated, entitled, text: redactPanelOutput(text) });
    }
    async handle(message) {
        if (message?.command === "auth-status") {
            await this.authStatus();
            return;
        }
        if (message?.command === "device-login") {
            try {
                await (0, device_auth_1.deviceLogin)(this.context, text => this.postAuth("checking", false, false, text));
                (0, entitlement_1.invalidateEntitlementCache)();
                await this.authStatus();
            }
            catch (error) {
                this.postAuth("refresh-failed", false, false, (0, device_auth_1.authErrorText)(error));
            }
            return;
        }
        if (message?.command === "activate" || message?.command === "manage-plan") {
            await this.openBilling(message.command === "activate" ? "checkout" : "portal");
            return;
        }
        if (message?.command === "device-logout") {
            const remoteRevoked = await (0, device_auth_1.logoutExtension)(this.context);
            (0, entitlement_1.invalidateEntitlementCache)();
            this.postAuth("signed-out", false, false, remoteRevoked ? "Signed out locally and from the server." : "Signed out locally. The server session could not be revoked; sign in again when online.");
            return;
        }
        if (!message || !["status", "run", "dry-run", "stop", "activate", "manage-plan"].includes(message.command)) {
            this.post(false, "Unsupported command");
            return;
        }
        if (message.task !== undefined && (typeof message.task !== "string" || message.task.length > 20000)) {
            this.post(false, "Task is invalid or too long");
            return;
        }
        const cwd = (0, workspace_1.workspacePath)();
        const cli = (0, workspace_1.cliPath)();
        try {
            // The workspace trust check has to live inside the try: the panel's
            // onDidReceiveMessage callback ignores the promise this method returns,
            // so a throw here became an unhandled rejection and the webview never
            // received any feedback at all.
            if (message.command === "stop") {
                this.stopProcess();
                this.post(true, "Run stopped.");
                return;
            }
            if (message.command === "status") {
                const statusArgs = cwd ? ["status", "--repo", cwd] : ["status"];
                this.post(true, await runCli(cli, statusArgs, cwd, child => { this.process = child; }));
            }
            else {
                (0, workspace_1.requireTrustedWorkspace)(cwd);
                await (0, entitlement_1.requireEntitlement)();
                if (!message.task?.trim())
                    throw new Error("Task description required");
                if (this.process)
                    throw new Error("A minitok run is already active");
                const evidencePath = vscode.workspace.getConfiguration("minitok").get("evidencePath", ".minitok/evidence/runs/latest.json").trim() || ".minitok/evidence/runs/latest.json";
                const args = ["run", message.task, "--repo", cwd, "--evidence-path", evidencePath];
                if (message.command === "dry-run")
                    args.push("--dry-run");
                else if ((0, workspace_1.autoApprove)())
                    args.push("--auto-accept");
                else {
                    // The panel collects consent before the run starts, and the CLI it
                    // spawns has no TTY: without --auto-accept every file change was
                    // refused with "No TTY detected. Refusing to accept file changes".
                    // The answer collected here is the same decision the setting encodes,
                    // so an approved run passes the flag through.
                    const answer = await vscode.window.showWarningMessage("Allow minitok to modify this workspace?", "Approve", "Cancel");
                    if (answer !== "Approve")
                        return;
                    args.push("--auto-accept");
                }
                const output = await runCli(cli, args, cwd, child => { this.process = child; });
                const evidence = cwd ? this.readEvidence(cwd) : null;
                this.post(true, `${redactPanelOutput(output)}\n${evidence ? `Evidence: ${JSON.stringify(evidence, null, 2)}` : "Evidence unavailable"}`);
            }
        }
        catch (error) {
            this.post(false, redactPanelOutput(String(error)));
        }
    }
    evidenceFile(cwd) {
        const configured = vscode.workspace.getConfiguration("minitok").get("evidencePath", ".minitok/evidence/runs/latest.json").trim() || ".minitok/evidence/runs/latest.json";
        const file = path.resolve(cwd, configured);
        const root = path.resolve(cwd) + path.sep;
        if (file !== path.resolve(cwd) && !file.startsWith(root))
            throw new Error("minitok.evidencePath must stay inside the workspace");
        return file;
    }
    readEvidence(cwd) {
        const file = this.evidenceFile(cwd);
        try {
            return JSON.parse(fs.readFileSync(file, "utf8"));
        }
        catch (error) {
            if (error.code === "ENOENT")
                return null;
            throw new Error(`Evidence could not be read: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    stopProcess() {
        const child = this.process;
        if (!child || child.killed)
            return;
        killProcessTree(child);
    }
    post(ok, text) { this.panel.webview.postMessage({ ok, text: redactPanelOutput(text) }); }
    html() { const nonce = (0, node_crypto_1.randomBytes)(16).toString("base64"); const source = fs.readFileSync(path.join(this.extensionUri.fsPath, "src", "panel.html"), "utf8"); return source.replaceAll("{{nonce}}", nonce).replace("{{cspSource}}", this.panel.webview.cspSource); }
    dispose() { this.stopProcess(); while (this.disposables.length)
        this.disposables.pop()?.dispose(); this.panel.dispose(); }
}
exports.minitokPanel = minitokPanel;
