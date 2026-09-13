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
function extensionVersion(context) {
    return String(context.extension.packageJSON.version);
}
function runCli(cliPath, args) {
    const cwd = (0, workspace_2.workspacePath)();
    (0, workspace_1.requireTrustedWorkspace)(cwd);
    return new Promise((resolve, reject) => {
        const spec = (0, workspace_1.spawnSpec)(cliPath, args);
        const child = (0, node_child_process_1.spawn)(spec.command, spec.args, (0, workspace_2.spawnOptionsFor)(spec, { cwd: (0, workspace_2.workspacePath)() }));
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", chunk => { stdout += chunk.toString(); });
        child.stderr.on("data", chunk => { stderr += chunk.toString(); });
        child.on("error", error => reject(error));
        child.on("close", code => code === 0 ? resolve(stdout) : reject(new Error(stderr || stdout || `minitok exited with code ${code}`)));
    });
}
function activate(context) {
    const output = vscode.window.createOutputChannel("minitok");
    void (0, entitlement_1.checkEntitlement)().then(result => { if (!result.allowed)
        vscode.window.showWarningMessage(result.message || "An active paid minitok plan is required."); });
    const requireEntitlement = async () => {
        const entitlement = await (0, entitlement_1.checkEntitlement)();
        if (!entitlement.allowed)
            throw new Error(entitlement.message || "An active paid minitok plan is required.");
    };
    context.subscriptions.push(output);
    const sidebar = new sidebar_1.minitokSidebar(context.extensionUri, context);
    context.subscriptions.push(sidebar, vscode.window.registerWebviewViewProvider(sidebar_1.minitokSidebar.viewType, sidebar));
    context.subscriptions.push(vscode.commands.registerCommand("minitok.openPanel", () => panel_1.minitokPanel.createOrShow(context)));
    context.subscriptions.push(vscode.commands.registerCommand("minitok.openSettings", () => vscode.commands.executeCommand("workbench.action.openSettings", "@ext:flotic.minitok-extension")));
    context.subscriptions.push(vscode.commands.registerCommand("minitok.mcpStatus", async () => {
        try {
            await requireEntitlement();
            (0, workspace_1.requireTrustedWorkspace)((0, workspace_2.workspacePath)());
        }
        catch (error) {
            vscode.window.showErrorMessage(String(error));
            return;
        }
        output.show(true);
        const command = (0, workspace_2.mcpCommand)();
        if (!command.length || !command[0]) {
            vscode.window.showErrorMessage("minitok MCP command is not configured");
            return;
        }
        const processSpec = (0, workspace_1.spawnSpec)(command[0], command.slice(1));
        // Refresh the short lived runtime token before spawning the server, so both
        // sides read the same credential.
        const authToken = await (0, workspace_2.ensureMcpAuthToken)();
        output.appendLine(`[spawn] mcp command=${JSON.stringify(processSpec.command)} args=${JSON.stringify(processSpec.args)} cwd=${JSON.stringify((0, workspace_2.workspacePath)())}`);
        let child;
        try {
            child = (0, node_child_process_1.spawn)(processSpec.command, processSpec.args, (0, workspace_2.spawnOptionsFor)(processSpec, { cwd: (0, workspace_2.workspacePath)(), env: (0, workspace_2.mcpEnvironment)() }));
        }
        catch (error) {
            output.appendLine(`[spawn] synchronous error=${String(error)}`);
            vscode.window.showErrorMessage(`minitok MCP spawn failed: ${String(error)}`);
            return;
        }
        let buffer = "";
        const finish = (text) => { child.kill(); output.appendLine(text); vscode.window.showInformationMessage(text); };
        const timer = setTimeout(() => finish("minitok MCP handshake timed out"), 5000);
        child.stdout.on("data", (chunk) => { buffer += chunk.toString(); const lines = buffer.split(/\r?\n/); buffer = lines.pop() || ""; for (const line of lines) {
            try {
                const message = JSON.parse(line);
                if (message.error) {
                    clearTimeout(timer);
                    finish(`minitok MCP error: ${message.error.message}`);
                }
                else if (message.id === 1)
                    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: { authToken } })}\n`);
                else if (message.id === 2) {
                    clearTimeout(timer);
                    finish(`minitok MCP online: ${message.result?.tools?.length || 0} tools`);
                }
            }
            catch { }
        } });
        child.on("error", (error) => { clearTimeout(timer); finish(`minitok MCP offline: ${error.message}`); });
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "minitok-extension", version: extensionVersion(context) }, authToken } })}\n`);
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
        const autoApproveSetting = (0, workspace_2.autoApprove)();
        if (!autoApproveSetting) {
            const answer = await vscode.window.showWarningMessage("Allow minitok to modify this workspace?", "Approve", "Cancel");
            if (answer !== "Approve")
                return;
        }
        output.show(true);
        try {
            // Pass --repo explicitly: without it cmdRun targets the globally registered
            // workspace, which may be a different repository than the open folder.
            output.appendLine(await runCli((0, workspace_2.cliPath)(), ["run", task, "--repo", cwd, ...(autoApproveSetting ? ["--auto-accept"] : [])]));
        }
        catch (error) {
            output.appendLine(String(error));
            vscode.window.showErrorMessage("minitok task failed");
        }
    }));
    context.subscriptions.push(vscode.commands.registerCommand("minitok.status", async () => {
        output.show(true);
        try {
            await requireEntitlement();
            const version = await runCli((0, workspace_2.cliPath)(), ["--version"]);
            if (!(0, workspace_2.isCliCompatible)(version))
                throw new Error(`Unsupported minitok CLI version: ${version.trim()}`);
            // Inspect the open folder, not the globally registered workspace.
            const statusCwd = (0, workspace_2.workspacePath)();
            output.appendLine(await runCli((0, workspace_2.cliPath)(), statusCwd ? ["status", "--repo", statusCwd] : ["status"]));
        }
        catch (error) {
            output.appendLine(String(error));
        }
    }));
}
function deactivate() { }
