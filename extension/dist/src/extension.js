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
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const node_child_process_1 = require("node:child_process");
const panel_1 = require("./panel");
const workspace_1 = require("./workspace");
const sidebar_1 = require("./sidebar");
const workspace_2 = require("./workspace");
const entitlement_1 = require("./entitlement");
const redaction_1 = require("./redaction");
function extensionVersion(context) {
    return String(context.extension.packageJSON.version);
}
const redactExtensionOutput = redaction_1.redactSensitiveText;
/** A pipeline run may legitimately take up to half an hour. */
const CLI_RUN_TIMEOUT_MS = 1800000;
/** Status and version answers are expected in seconds; never leave them hanging. */
const CLI_STATUS_TIMEOUT_MS = 60000;
/**
 * Stop the CLI and everything it spawned.
 *
 * The CLI installs SIGINT/SIGTERM handlers that release its own children and the
 * run lock, so a signal is enough there; on Windows a Node child can survive its
 * parent's signal, hence taskkill /t.
 */
function killProcessTree(child) {
    if (child.killed)
        return;
    if (process.platform === "win32" && child.pid) {
        try {
            (0, node_child_process_1.execFile)("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true }, () => { });
            return;
        }
        catch { /* fall through to kill() */ }
    }
    child.kill("SIGTERM");
}
/**
 * Run the CLI and collect its output.
 *
 * This used to have no timeout and no cancellation path, so `minitok.run` could
 * only be stopped by reloading the extension host and a stuck provider request
 * held the promise (and the sidebar/panel state) forever.
 */
function runCli(cliPath, args, options = {}) {
    const cwd = (0, workspace_2.workspacePath)();
    if (options.requireWorkspace !== false)
        (0, workspace_1.requireTrustedWorkspace)(cwd);
    const timeoutMs = options.timeoutMs ?? CLI_RUN_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
        const spec = (0, workspace_1.spawnSpec)(cliPath, args);
        let child;
        try {
            child = (0, node_child_process_1.spawn)(spec.command, spec.args, (0, workspace_2.spawnOptionsFor)(spec, { cwd: (0, workspace_2.workspacePath)() }));
        }
        catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
            return;
        }
        let stdout = "";
        let stderr = "";
        let settled = false;
        let timer;
        let cancellation;
        const finish = (error, value = "") => {
            if (settled)
                return;
            settled = true;
            if (timer)
                clearTimeout(timer);
            if (cancellation)
                cancellation.dispose();
            if (error)
                reject(error);
            else
                resolve(value);
        };
        timer = setTimeout(() => { killProcessTree(child); finish(new Error(`minitok timed out after ${Math.round(timeoutMs / 1000)}s`)); }, timeoutMs);
        cancellation = options.token?.onCancellationRequested(() => { killProcessTree(child); finish(new Error("minitok run cancelled")); });
        child.stdout.on("data", chunk => { stdout += chunk.toString(); });
        child.stderr.on("data", chunk => { stderr += chunk.toString(); });
        child.on("error", error => finish(error));
        child.on("close", code => code === 0 ? finish(null, stdout) : finish(new Error(stderr || stdout || `minitok exited with code ${code}`)));
    });
}
function activate(context) {
    const output = vscode.window.createOutputChannel("minitok");
    // Authentication is the first gate. The sidebar/panel checks entitlement only
    // after a customer session is known; showing an entitlement warning here made a
    // brand-new, signed-out install look like a billing failure.
    const requireEntitlement = async () => {
        const entitlement = await (0, entitlement_1.checkEntitlement)();
        if (!entitlement.allowed)
            throw new Error(entitlement.message || "An active paid minitok plan is required.");
    };
    context.subscriptions.push(output);
    const sidebar = new sidebar_1.minitokSidebar(context.extensionUri, context);
    context.subscriptions.push(sidebar, vscode.window.registerWebviewViewProvider(sidebar_1.minitokSidebar.viewType, sidebar));
    const onboardingKey = `mcpOnboardingPrompted:${extensionVersion(context)}`;
    if (!context.globalState.get(onboardingKey)) {
        void context.globalState.update(onboardingKey, true).then(() => vscode.window.showInformationMessage("minitok MCP is ready to connect.", "Connect MCP Hosts", "Later").then(answer => { if (answer === "Connect MCP Hosts")
            return vscode.commands.executeCommand("minitok.connectMcp"); return undefined; }));
    }
    context.subscriptions.push(vscode.commands.registerCommand("minitok.openPanel", () => panel_1.minitokPanel.createOrShow(context)));
    context.subscriptions.push(vscode.commands.registerCommand("minitok.openSettings", () => vscode.commands.executeCommand("workbench.action.openSettings", "@ext:flotic.minitok-extension")));
    context.subscriptions.push(vscode.commands.registerCommand("minitok.connectMcp", async () => {
        const answer = await vscode.window.showInformationMessage("Connect minitok to detected MCP hosts with read-only access?", "Connect", "Not now");
        if (answer !== "Connect")
            return;
        output.show(true);
        try {
            output.appendLine(redactExtensionOutput(await runCli((0, workspace_2.cliPath)(), ["mcp", "setup", "all", "--only-unconfigured", "--scopes", "read"], { timeoutMs: CLI_STATUS_TIMEOUT_MS, requireWorkspace: false })));
            vscode.window.showInformationMessage("minitok MCP setup completed. Restart or refresh the MCP host if required.");
        }
        catch (error) {
            const message = redactExtensionOutput(String(error));
            output.appendLine(message);
            vscode.window.showErrorMessage(`minitok MCP setup failed: ${message}`);
        }
    }));
    context.subscriptions.push(vscode.commands.registerCommand("minitok.mcpStatus", async () => {
        try {
            (0, workspace_1.requireTrustedWorkspace)((0, workspace_2.workspacePath)());
        }
        catch (error) {
            vscode.window.showErrorMessage(redactExtensionOutput(String(error)));
            return;
        }
        output.show(true);
        try {
            (0, workspace_2.configuredMcpScopes)();
        }
        catch (error) {
            vscode.window.showErrorMessage(redactExtensionOutput(String(error)));
            return;
        }
        const command = (0, workspace_2.mcpCommand)();
        if (!command.length || !command[0]) {
            vscode.window.showErrorMessage("minitok MCP command is not configured");
            return;
        }
        const processSpec = (0, workspace_1.spawnSpec)(command[0], command.slice(1));
        // Refresh the short lived runtime token before spawning the server, so both
        // sides read the same credential.
        const token = await (0, workspace_2.ensureMcpAuthToken)();
        if (!token) {
            vscode.window.showErrorMessage("minitok MCP authentication token could not be prepared");
            return;
        }
        try {
            (0, workspace_2.mcpEnvironment)();
            await requireEntitlement();
        }
        catch (error) {
            vscode.window.showErrorMessage(redactExtensionOutput(String(error)));
            return;
        }
        output.appendLine(`[spawn] mcp command=${JSON.stringify(processSpec.command)} args=${JSON.stringify(processSpec.args)} cwd=${JSON.stringify((0, workspace_2.workspacePath)())}`);
        let child;
        try {
            child = (0, node_child_process_1.spawn)(processSpec.command, processSpec.args, (0, workspace_2.spawnOptionsFor)(processSpec, { cwd: (0, workspace_2.workspacePath)(), env: (0, workspace_2.mcpEnvironment)() }));
        }
        catch (error) {
            const safeError = redactExtensionOutput(String(error));
            output.appendLine(`[spawn] synchronous error=${safeError}`);
            vscode.window.showErrorMessage(`minitok MCP spawn failed: ${safeError}`);
            return;
        }
        let buffer = "";
        let finished = false;
        let timer;
        const finish = (text) => { if (finished)
            return; finished = true; clearTimeout(timer); const safeText = redactExtensionOutput(text); child.kill(); output.appendLine(safeText); vscode.window.showInformationMessage(safeText); };
        timer = setTimeout(() => finish("minitok MCP handshake timed out"), 5000);
        // The probe must look like a real host: the credential is carried by the
        // spawned process environment (mcpEnvironment) and never by request params.
        // Sending authToken in params made this command report "online" while a
        // standard host (VS Code, Claude Desktop, Cursor) failed on its first call.
        child.stdout.on("data", (chunk) => { buffer += chunk.toString(); const lines = buffer.split(/\r?\n/); buffer = lines.pop() || ""; for (const line of lines) {
            try {
                const message = JSON.parse(line);
                if (message.error) {
                    clearTimeout(timer);
                    finish(`minitok MCP error: ${message.error.message}`);
                }
                else if (message.id === 1) {
                    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
                    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`);
                }
                else if (message.id === 2) {
                    clearTimeout(timer);
                    finish(`minitok MCP online: ${message.result?.tools?.length || 0} tools`);
                }
            }
            catch { }
        } });
        child.on("error", (error) => { clearTimeout(timer); finish(`minitok MCP offline: ${error.message}`); });
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "minitok-extension", version: extensionVersion(context) } } })}\n`);
    }));
    context.subscriptions.push(vscode.commands.registerCommand("minitok.run", async () => {
        try {
            await requireEntitlement();
        }
        catch (error) {
            vscode.window.showErrorMessage(String(error));
            return;
        }
        const task = await vscode.window.showInputBox({ prompt: "minitok task" });
        if (!task)
            return;
        const cwd = (0, workspace_2.workspacePath)();
        if (!cwd) {
            vscode.window.showErrorMessage("Open a workspace folder before running minitok");
            return;
        }
        if (!vscode.workspace.isTrusted) {
            vscode.window.showErrorMessage("Trust this workspace before running minitok");
            return;
        }
        // The spawned CLI has no TTY, so it refuses every file change unless
        // --auto-accept is passed. The modal below collects the same consent the
        // setting encodes; without forwarding it the run rejected every change after
        // the cycle had already been paid for.
        let approved = (0, workspace_2.autoApprove)();
        if (!approved) {
            const answer = await vscode.window.showWarningMessage("Allow minitok to modify this workspace?", "Approve", "Cancel");
            if (answer !== "Approve")
                return;
            approved = true;
        }
        output.show(true);
        try {
            // Pass --repo explicitly: without it cmdRun targets the globally registered
            // workspace, which may be a different repository than the open folder.
            const evidencePath = vscode.workspace.getConfiguration("minitok").get("evidencePath", ".minitok/evidence/runs/latest.json").trim() || ".minitok/evidence/runs/latest.json";
            const runArgs = ["run", task, "--repo", cwd, "--evidence-path", evidencePath, ...(approved ? ["--auto-accept"] : [])];
            // Run inside a cancellable notification. The spawned CLI has no TTY of its
            // own, so this is the only way to stop a long run short of reloading the
            // window (the promise used to have no timeout and no cancel path).
            await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "minitok task", cancellable: true }, async (_progress, token) => {
                output.appendLine(redactExtensionOutput(await runCli((0, workspace_2.cliPath)(), runArgs, { timeoutMs: CLI_RUN_TIMEOUT_MS, token })));
            });
        }
        catch (error) {
            const safeError = redactExtensionOutput(String(error));
            output.appendLine(safeError);
            vscode.window.showErrorMessage(String(error).includes("cancelled") ? "minitok task cancelled" : "minitok task failed");
        }
    }));
    context.subscriptions.push(vscode.commands.registerCommand("minitok.status", async () => {
        output.show(true);
        try {
            const version = await runCli((0, workspace_2.cliPath)(), ["--version"], { timeoutMs: CLI_STATUS_TIMEOUT_MS });
            if (!(0, workspace_2.isCliCompatible)(version))
                throw new Error(`Unsupported minitok CLI version: ${version.trim()}`);
            // Inspect the open folder, not the globally registered workspace.
            const statusCwd = (0, workspace_2.workspacePath)();
            output.appendLine(redactExtensionOutput(await runCli((0, workspace_2.cliPath)(), statusCwd ? ["status", "--repo", statusCwd] : ["status"], { timeoutMs: CLI_STATUS_TIMEOUT_MS, requireWorkspace: false })));
        }
        catch (error) {
            output.appendLine(redactExtensionOutput(String(error)));
        }
    }));
}
function deactivate() { }
