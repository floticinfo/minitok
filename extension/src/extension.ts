import * as vscode from "vscode";
import { spawn, ChildProcessWithoutNullStreams } from "node:child_process";
import { minitokPanel } from "./panel";
import { spawnSpec, requireTrustedWorkspace } from "./workspace";
import { minitokSidebar } from "./sidebar";
import { cliPath, workspacePath, autoApprove, isCliCompatible, mcpCommand, mcpEnvironment, ensureMcpAuthToken, spawnOptionsFor } from "./workspace";
import { checkEntitlement, EntitlementState } from "./entitlement";

function extensionVersion(context: vscode.ExtensionContext) {
  return String(context.extension.packageJSON.version);
}

function runCli(cliPath: string, args: string[]): Promise<string> {
  const cwd = workspacePath();
  requireTrustedWorkspace(cwd);
  return new Promise((resolve, reject) => {
    const spec = spawnSpec(cliPath, args);
    const child = spawn(spec.command, spec.args, spawnOptionsFor(spec, { cwd: workspacePath() }));
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk.toString(); });
    child.stderr.on("data", chunk => { stderr += chunk.toString(); });
    child.on("error", error => reject(error));
    child.on("close", code => code === 0 ? resolve(stdout) : reject(new Error(stderr || stdout || `minitok exited with code ${code}`)));
  });
}

export function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel("minitok");
  void checkEntitlement().then(result => { if (!result.allowed) vscode.window.showWarningMessage(result.message || "An active paid minitok plan is required."); });
  const requireEntitlement = async () => {
    const entitlement = await checkEntitlement();
    if (!entitlement.allowed) throw new Error(entitlement.message || "An active paid minitok plan is required.");
  };
  context.subscriptions.push(output);
  const sidebar = new minitokSidebar(context.extensionUri, context);
  context.subscriptions.push(sidebar, vscode.window.registerWebviewViewProvider(minitokSidebar.viewType, sidebar));
  context.subscriptions.push(vscode.commands.registerCommand("minitok.openPanel", () => minitokPanel.createOrShow(context)));
  context.subscriptions.push(vscode.commands.registerCommand("minitok.openSettings", () => vscode.commands.executeCommand("workbench.action.openSettings", "@ext:flotic.minitok-extension")));
  context.subscriptions.push(vscode.commands.registerCommand("minitok.mcpStatus", async () => {
try { await requireEntitlement(); requireTrustedWorkspace(workspacePath()); } catch (error) { vscode.window.showErrorMessage(String(error)); return; }
     output.show(true);
    const command = mcpCommand();
    if (!command.length || !command[0]) { vscode.window.showErrorMessage("minitok MCP command is not configured"); return; }
    const processSpec = spawnSpec(command[0], command.slice(1));
    // Refresh the short lived runtime token before spawning the server, so both
    // sides read the same credential.
    const authToken = await ensureMcpAuthToken();
    output.appendLine(`[spawn] mcp command=${JSON.stringify(processSpec.command)} args=${JSON.stringify(processSpec.args)} cwd=${JSON.stringify(workspacePath())}`);
    let child: ChildProcessWithoutNullStreams;
    try { child = spawn(processSpec.command, processSpec.args, spawnOptionsFor(processSpec, { cwd: workspacePath(), env: mcpEnvironment() })); } catch (error) { output.appendLine(`[spawn] synchronous error=${String(error)}`); vscode.window.showErrorMessage(`minitok MCP spawn failed: ${String(error)}`); return; }
    let buffer = "";
    const finish = (text: string) => { child.kill(); output.appendLine(text); vscode.window.showInformationMessage(text); };
    const timer = setTimeout(() => finish("minitok MCP handshake timed out"), 5000);
    child.stdout.on("data", (chunk: Buffer) => { buffer += chunk.toString(); const lines = buffer.split(/\r?\n/); buffer = lines.pop() || ""; for (const line of lines) { try { const message = JSON.parse(line); if (message.error) { clearTimeout(timer); finish(`minitok MCP error: ${message.error.message}`); } else if (message.id === 1) child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: { authToken } })}\n`); else if (message.id === 2) { clearTimeout(timer); finish(`minitok MCP online: ${message.result?.tools?.length || 0} tools`); } } catch {} } });
    child.on("error", (error: Error) => { clearTimeout(timer); finish(`minitok MCP offline: ${error.message}`); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "minitok-extension", version: extensionVersion(context) }, authToken } })}\n`);
  }));
  context.subscriptions.push(vscode.commands.registerCommand("minitok.run", async () => {
    try { await requireEntitlement(); } catch (error) { vscode.window.showErrorMessage(String(error)); return; }
    const task = await vscode.window.showInputBox({ prompt: "minitok task" });
    if (!task) return;
    const cwd = workspacePath();
    if (!cwd) { vscode.window.showErrorMessage("Open a workspace folder before running minitok"); return; }
    if (!vscode.workspace.isTrusted) { vscode.window.showErrorMessage("Trust this workspace before running minitok"); return; }
    const autoApproveSetting = autoApprove();
    if (!autoApproveSetting) {
      const answer = await vscode.window.showWarningMessage("Allow minitok to modify this workspace?", "Approve", "Cancel");
      if (answer !== "Approve") return;
    }
    output.show(true);
    try {
      // Pass --repo explicitly: without it cmdRun targets the globally registered
      // workspace, which may be a different repository than the open folder.
      output.appendLine(await runCli(cliPath(), ["run", task, "--repo", cwd, ...(autoApproveSetting ? ["--auto-accept"] : [])]));
    } catch (error) {
      output.appendLine(String(error));
      vscode.window.showErrorMessage("minitok task failed");
    }
  }));
  context.subscriptions.push(vscode.commands.registerCommand("minitok.status", async () => {
    output.show(true);
    try {
      await requireEntitlement();
      const version = await runCli(cliPath(), ["--version"]);
      if (!isCliCompatible(version)) throw new Error(`Unsupported minitok CLI version: ${version.trim()}`);
      // Inspect the open folder, not the globally registered workspace.
      const statusCwd = workspacePath();
      output.appendLine(await runCli(cliPath(), statusCwd ? ["status", "--repo", statusCwd] : ["status"]));
    } catch (error) { output.appendLine(String(error)); }
  }));
}

export function deactivate() {}
