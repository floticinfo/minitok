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
const run_process_1 = require("./run-process");
const CLI_TIMEOUT_MS = 1800000;
const redactPanelOutput = redaction_1.redactSensitiveText;
// Tree kills (Windows taskkill /t, POSIX process groups) are implemented once
// in run-process.ts; the panel starts children detached so the group can be
// signalled. The shared runProcess registers its timer as
// setTimeout(..., CLI_TIMEOUT_MS) — the constant this wrapper passes through —
// and its timer callback performs killProcessTree(child) then settles with the
// "minitok timed out after 30 minutes" error, exactly as the inline timer did.
function runCli(cliPath, args, cwd, onProcess, extraEnv = {}) {
    const processSpec = (0, workspace_1.spawnSpec)(cliPath, args);
    return (0, run_process_1.runProcess)(processSpec.command, processSpec.args, {
        spawnOptions: (0, workspace_1.spawnOptionsFor)(processSpec, { cwd, env: extraEnv, detached: process.platform !== "win32" }),
        onProcess,
        timeoutMs: CLI_TIMEOUT_MS,
        timeoutMessage: "minitok timed out after 30 minutes",
    });
}
class minitokPanel {
    context;
    static current;
    panel;
    extensionUri;
    disposables = [];
    process;
    deviceLoginCancellation;
    static createOrShow(context) {
        if (minitokPanel.current) {
            minitokPanel.current.panel.reveal();
            return;
        }
        const panel = vscode.window.createWebviewPanel("minitok", "minitok", vscode.ViewColumn.Beside, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [context.extensionUri] });
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
    // Checkout is the only billing action any surface reaches: the webviews dropped
    // their plan-management button, so nothing asks for the billing portal and
    // this helper has no second call path. The CLI still ships `minitok portal`
    // as its own public command; the Extension just never spawns it.
    async openBilling() {
        const session = await (0, device_auth_1.refreshExtensionSession)(this.context);
        if (!session?.access_token) {
            this.post(false, "Sign in before managing your plan.");
            return;
        }
        const envName = "MINITOK_EXTENSION_CUSTOMER_TOKEN";
        const env = { ...process.env, MINITOK_UPDATE_CHECK: "0", [envName]: session.access_token };
        const spec = (0, workspace_1.spawnSpec)((0, workspace_1.cliPath)(), ["checkout", "--token-env", envName, "--json"]);
        (0, node_child_process_1.execFile)(spec.command, spec.args, { ...(0, workspace_1.spawnOptionsFor)(spec, { cwd: (0, workspace_1.workspacePath)(), env }), timeout: 30000 }, async (error, stdout, stderr) => {
            delete env[envName];
            if (error) {
                this.post(false, redactPanelOutput(stderr || error.message));
                return;
            }
            try {
                const result = JSON.parse(String(stdout).trim());
                const target = result.checkout_url;
                if (!target || !/^https:\/\//i.test(target))
                    throw new Error("Billing service returned an invalid URL");
                await vscode.env.openExternal(vscode.Uri.parse(target));
                this.post(true, "Checkout opened in your browser.");
            }
            catch (parseError) {
                this.post(false, redactPanelOutput(parseError instanceof Error ? parseError.message : String(parseError)));
            }
        });
    }
    async authStatus() {
        // This runs on panel open and again for every auth-status request. Any throw
        // used to reject the caller, leaving the webview on its initial "Checking your
        // minitok session..." card with the sign-in button still hidden, so the user had
        // no way in. Fall back to an explicit auth-state instead of going silent.
        try {
            // An admin session authorizes every gated command without a customer plan, so
            // it has to satisfy this question on its own: refreshExtensionSession only
            // knows the customer session and would report signed-out for a valid admin.
            if (await (0, device_auth_1.hasAdminSession)(this.context)) {
                (0, entitlement_1.invalidateEntitlementCache)();
                this.postAuth("authenticated", true, true, "Signed in as admin.");
                return;
            }
            const session = await (0, device_auth_1.refreshExtensionSession)(this.context);
            if (!session) {
                this.postAuth("signed-out", false, false);
                return;
            }
            (0, entitlement_1.invalidateEntitlementCache)();
            const result = await (0, entitlement_1.checkEntitlement)();
            this.postAuth(result.allowed ? "authenticated" : "not-entitled", true, result.allowed, result.allowed ? `Signed in with ${result.plan} plan.` : (result.message || "An active paid plan is required."));
        }
        catch (error) {
            this.postAuth("refresh-failed", false, false, (0, device_auth_1.authErrorText)(error));
        }
    }
    postAuth(state, authenticated, entitled, text = "") {
        this.panel.webview.postMessage({ type: "auth-state", state, authenticated, entitled, text: redactPanelOutput(text) });
    }
    async customerLogin(email, password) {
        if (!email?.trim() || !password) {
            this.postAuth("signed-out", false, false, "Email and password are required.");
            return;
        }
        const env = { ...process.env, MINITOK_UPDATE_CHECK: "0", MINITOK_CUSTOMER_EMAIL: email.trim(), MINITOK_CUSTOMER_PASSWORD: password };
        const spec = (0, workspace_1.spawnSpec)((0, workspace_1.cliPath)(), ["auth", "customer-login", "--email-env", "MINITOK_CUSTOMER_EMAIL", "--password-env", "MINITOK_CUSTOMER_PASSWORD", "--json"]);
        (0, node_child_process_1.execFile)(spec.command, spec.args, { ...(0, workspace_1.spawnOptionsFor)(spec, { cwd: (0, workspace_1.workspacePath)(), env }), timeout: 30000 }, async (error, stdout, stderr) => {
            delete env.MINITOK_CUSTOMER_EMAIL;
            delete env.MINITOK_CUSTOMER_PASSWORD;
            if (error) {
                this.postAuth("signed-out", false, false, stderr || error.message);
                return;
            }
            (0, entitlement_1.invalidateEntitlementCache)();
            await this.authStatus();
        });
    }
    async adminLogin(email, password) {
        if (!email?.trim() || !password) {
            this.postAuth("signed-out", false, false, "Email and password are required.");
            return;
        }
        this.postAuth("checking", false, false, "Signing in as admin...");
        try {
            await (0, device_auth_1.adminLogin)(this.context, email.trim(), password);
            (0, entitlement_1.invalidateEntitlementCache)();
            this.postAuth("authenticated", true, true, "Signed in as admin.");
        }
        catch (error) {
            this.postAuth("signed-out", false, false, (0, device_auth_1.authErrorText)(error));
        }
    }
    async handle(message) {
        if (message?.command === "auth-status") {
            await this.authStatus();
            return;
        }
        if (message?.command === "device-login") {
            if (this.deviceLoginCancellation && !this.deviceLoginCancellation.cancelled) {
                this.postAuth("checking", false, false, "A browser sign-in is already in progress. Cancel it first.");
                return;
            }
            const cancellation = { cancelled: false };
            this.deviceLoginCancellation = cancellation;
            try {
                await (0, device_auth_1.deviceLogin)(this.context, text => this.postAuth("checking", false, false, text), cancellation);
                (0, entitlement_1.invalidateEntitlementCache)();
                await this.authStatus();
            }
            catch (error) {
                this.postAuth("refresh-failed", false, false, (0, device_auth_1.authErrorText)(error));
            }
            finally {
                if (this.deviceLoginCancellation === cancellation)
                    this.deviceLoginCancellation = undefined;
            }
            return;
        }
        if (message?.command === "cancel-login") {
            if (this.deviceLoginCancellation)
                this.deviceLoginCancellation.cancelled = true;
            return;
        }
        if (message?.command === "activate") {
            await this.openBilling();
            return;
        }
        if (message?.command === "customer-login") {
            await this.customerLogin(message.email, message.password);
            return;
        }
        if (message?.command === "admin-login") {
            await this.adminLogin(message.email, message.password);
            return;
        }
        if (message?.command === "device-logout") {
            const remoteRevoked = await (0, device_auth_1.logoutExtension)(this.context);
            // An admin session is stored separately and bypasses the entitlement gate, so
            // leaving it behind would re-authenticate the next command after a sign-out.
            await (0, device_auth_1.logoutAdmin)(this.context);
            (0, entitlement_1.invalidateEntitlementCache)();
            this.postAuth("signed-out", false, false, remoteRevoked ? "Signed out locally and from the server." : "Signed out locally. The server session could not be revoked; sign in again when online.");
            return;
        }
        if (message?.command === "mcp-status") {
            this.postMcpStatus();
            return;
        }
        if (!message || !["status", "run", "dry-run", "stop", "activate"].includes(message.command)) {
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
                const evidenceSetting = vscode.workspace.getConfiguration("minitok").get("evidencePath", ".minitok/evidence/runs/latest.json").trim() || ".minitok/evidence/runs/latest.json";
                (0, workspace_1.workspaceRelativePath)(cwd, evidenceSetting, "evidencePath");
                const runId = (0, node_crypto_1.randomUUID)();
                const args = ["run", message.task, "--repo", cwd, "--evidence-path", evidenceSetting, "--run-id", runId];
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
                // P-2 fix: an admin session authorizes this run through a one-time,
                // runId-bound server token (env only, never argv). The CLI binds the
                // delegation to this runId via ensureRunId, so the id must be identical
                // in the issue and verify calls.
                const delegationEnv = await (0, entitlement_1.adminRunDelegationEnv)(this.context, runId);
                const output = await runCli(cli, args, cwd, child => { this.process = child; }, delegationEnv);
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
        (0, run_process_1.killProcessTree)(child);
    }
    post(ok, text) { this.panel.webview.postMessage({ type: "result", ok, text: redactPanelOutput(text) }); }
    postMcpStatus() {
        this.panel.webview.postMessage({ type: "mcp", ok: false, text: "Check sidebar for MCP status" });
    }
    // The panel brand mark must render the same Harlekin 'm' glyph the Activity
    // Bar icon (media/minitok-activitybar.svg) uses, so the glyph is the SVG
    // artwork (media/minitok.svg) rather than a system-ui text 'm'. The webview
    // only resolves the file through asWebviewUri(); CSP img-src allows it.
    html() { const nonce = (0, node_crypto_1.randomBytes)(16).toString("base64"); const source = fs.readFileSync(path.join(this.extensionUri.fsPath, "src", "panel.html"), "utf8"); const brandUri = this.panel.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "minitok.svg")); return source.replaceAll("{{nonce}}", nonce).replaceAll("{{brandUri}}", brandUri.toString()).replace("{{cspSource}}", this.panel.webview.cspSource); }
    dispose() { this.stopProcess(); while (this.disposables.length)
        this.disposables.pop()?.dispose(); this.panel.dispose(); }
}
exports.minitokPanel = minitokPanel;
