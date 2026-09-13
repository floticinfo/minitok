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
const CLI_TIMEOUT_MS = 1800000;
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
        minitokPanel.current = new minitokPanel(panel, context.extensionUri);
    }
    constructor(panel, extensionUri) {
        this.panel = panel;
        this.extensionUri = extensionUri;
        this.panel.webview.html = this.html();
        this.panel.webview.onDidReceiveMessage(message => this.handle(message), null, this.disposables);
        this.panel.onDidDispose(() => { minitokPanel.current = undefined; this.dispose(); }, null, this.disposables);
    }
    async handle(message) {
        if (!message || !["status", "run", "dry-run", "stop"].includes(message.command)) {
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
            (0, workspace_1.requireTrustedWorkspace)(cwd);
            if (message.command === "stop") {
                this.stopProcess();
                this.post(true, "Run stopped.");
                return;
            }
            await (0, entitlement_1.requireEntitlement)();
            if (message.command === "status")
                this.post(true, await runCli(cli, ["status", "--repo", cwd], cwd, child => { this.process = child; }));
            else {
                if (!message.task?.trim())
                    throw new Error("Task description required");
                if (this.process)
                    throw new Error("A minitok run is already active");
                const args = ["run", message.task, "--repo", cwd];
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
                this.post(true, `${output}\n${evidence ? `Evidence: ${JSON.stringify(evidence, null, 2)}` : "Evidence unavailable"}`);
            }
        }
        catch (error) {
            this.post(false, String(error));
        }
    }
    readEvidence(cwd) {
        const file = path.join(cwd, ".minitok", "evidence", "runs", "latest.json");
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
    post(ok, text) { this.panel.webview.postMessage({ ok, text }); }
    html() { const nonce = (0, node_crypto_1.randomBytes)(16).toString("base64"); const source = fs.readFileSync(path.join(this.extensionUri.fsPath, "src", "panel.html"), "utf8"); return source.replaceAll("{{nonce}}", nonce).replace("{{cspSource}}", this.panel.webview.cspSource); }
    dispose() { this.stopProcess(); while (this.disposables.length)
        this.disposables.pop()?.dispose(); this.panel.dispose(); }
}
exports.minitokPanel = minitokPanel;
