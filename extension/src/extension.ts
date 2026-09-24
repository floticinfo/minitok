import * as vscode from "vscode";
import { spawn, execFile, ChildProcessWithoutNullStreams } from "node:child_process";
import { minitokPanel } from "./panel";
import { spawnSpec, requireTrustedWorkspace } from "./workspace";
import { minitokSidebar } from "./sidebar";
import { cliPath, workspacePath, autoApprove, isCliCompatible, mcpCommand, mcpEnvironment, configuredMcpScopes, ensureMcpAuthToken, spawnOptionsFor, capabilityFile } from "./workspace";
import { checkEntitlement, EntitlementState } from "./entitlement";
import { redactSensitiveText } from "./redaction";

function extensionVersion(context: vscode.ExtensionContext) {
  return String(context.extension.packageJSON.version);
}

const redactExtensionOutput = redactSensitiveText;

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
function killProcessTree(child: ChildProcessWithoutNullStreams) {
  if (child.killed) return;
  if (process.platform === "win32" && child.pid) {
    try { execFile("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true }, () => {}); return; } catch { /* fall through to kill() */ }
  }
  child.kill("SIGTERM");
}

interface RunCliOptions {
  timeoutMs?: number;
  token?: vscode.CancellationToken;
  requireWorkspace?: boolean;
}

/**
 * Run the CLI and collect its output.
 *
 * This used to have no timeout and no cancellation path, so `minitok.run` could
 * only be stopped by reloading the extension host and a stuck provider request
 * held the promise (and the sidebar/panel state) forever.
 */
function runCli(cliPath: string, args: string[], options: RunCliOptions = {}): Promise<string> {
  const cwd = workspacePath();
  if (options.requireWorkspace !== false) requireTrustedWorkspace(cwd);
  const timeoutMs = options.timeoutMs ?? CLI_RUN_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const spec = spawnSpec(cliPath, args);
    let child: ChildProcessWithoutNullStreams;
    try { child = spawn(spec.command, spec.args, spawnOptionsFor(spec, { cwd: workspacePath() })); } catch (error) { reject(error instanceof Error ? error : new Error(String(error))); return; }
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let cancellation: vscode.Disposable | undefined;
    const finish = (error: Error | null, value = "") => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (cancellation) cancellation.dispose();
      if (error) reject(error); else resolve(value);
    };
    timer = setTimeout(() => { killProcessTree(child); finish(new Error(`minitok timed out after ${Math.round(timeoutMs / 1000)}s`)); }, timeoutMs);
    cancellation = options.token?.onCancellationRequested(() => { killProcessTree(child); finish(new Error("minitok run cancelled")); });
    child.stdout.on("data", chunk => { stdout += chunk.toString(); });
    child.stderr.on("data", chunk => { stderr += chunk.toString(); });
    child.on("error", error => finish(error));
    child.on("close", code => code === 0 ? finish(null, stdout) : finish(new Error(stderr || stdout || `minitok exited with code ${code}`)));
  });
}

export function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel("minitok");
  // Authentication is the first gate. The sidebar/panel checks entitlement only
  // after a customer session is known; showing an entitlement warning here made a
  // brand-new, signed-out install look like a billing failure.
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
try { requireTrustedWorkspace(workspacePath()); } catch (error) { vscode.window.showErrorMessage(redactExtensionOutput(String(error))); return; }
     output.show(true);
    try { configuredMcpScopes(); } catch (error) { vscode.window.showErrorMessage(redactExtensionOutput(String(error))); return; }
    const command = mcpCommand();
    if (!command.length || !command[0]) { vscode.window.showErrorMessage("minitok MCP command is not configured"); return; }
    const processSpec = spawnSpec(command[0], command.slice(1));
    // Refresh the short lived runtime token before spawning the server, so both
    // sides read the same credential.
    const token = await ensureMcpAuthToken();
    if (!token) { vscode.window.showErrorMessage("minitok MCP authentication token could not be prepared"); return; }
    try { mcpEnvironment(); await requireEntitlement(); } catch (error) { vscode.window.showErrorMessage(redactExtensionOutput(String(error))); return; }
    output.appendLine(`[spawn] mcp command=${JSON.stringify(processSpec.command)} args=${JSON.stringify(processSpec.args)} cwd=${JSON.stringify(workspacePath())}`);
    let child: ChildProcessWithoutNullStreams;
    try { child = spawn(processSpec.command, processSpec.args, spawnOptionsFor(processSpec, { cwd: workspacePath(), env: mcpEnvironment() })); } catch (error) { const safeError = redactExtensionOutput(String(error)); output.appendLine(`[spawn] synchronous error=${safeError}`); vscode.window.showErrorMessage(`minitok MCP spawn failed: ${safeError}`); return; }
    let buffer = "";
    let finished = false;
    let timer: ReturnType<typeof setTimeout>;
    const finish = (text: string) => { if (finished) return; finished = true; clearTimeout(timer); const safeText = redactExtensionOutput(text); child.kill(); output.appendLine(safeText); vscode.window.showInformationMessage(safeText); };
    timer = setTimeout(() => finish("minitok MCP handshake timed out"), 5000);
    // The probe must look like a real host: the credential is carried by the
    // spawned process environment (mcpEnvironment) and never by request params.
    // Sending authToken in params made this command report "online" while a
    // standard host (VS Code, Claude Desktop, Cursor) failed on its first call.
    child.stdout.on("data", (chunk: Buffer) => { buffer += chunk.toString(); const lines = buffer.split(/\r?\n/); buffer = lines.pop() || ""; for (const line of lines) { try { const message = JSON.parse(line); if (message.error) { clearTimeout(timer); finish(`minitok MCP error: ${message.error.message}`); } else if (message.id === 1) { child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`); child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`); } else if (message.id === 2) { clearTimeout(timer); finish(`minitok MCP online: ${message.result?.tools?.length || 0} tools`); } } catch {} } });
    child.on("error", (error: Error) => { clearTimeout(timer); finish(`minitok MCP offline: ${error.message}`); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "minitok-extension", version: extensionVersion(context) } } })}\n`);
  }));
  context.subscriptions.push(vscode.commands.registerCommand("minitok.run", async () => {
    try { await requireEntitlement(); } catch (error) { vscode.window.showErrorMessage(String(error)); return; }
    const task = await vscode.window.showInputBox({ prompt: "minitok task" });
    if (!task) return;
    const cwd = workspacePath();
    if (!cwd) { vscode.window.showErrorMessage("Open a workspace folder before running minitok"); return; }
    if (!vscode.workspace.isTrusted) { vscode.window.showErrorMessage("Trust this workspace before running minitok"); return; }
    // The spawned CLI has no TTY, so it refuses every file change unless
    // --auto-accept is passed. The modal below collects the same consent the
    // setting encodes; without forwarding it the run rejected every change after
    // the cycle had already been paid for.
    let approved = autoApprove();
    if (!approved) {
      const answer = await vscode.window.showWarningMessage("Allow minitok to modify this workspace?", "Approve", "Cancel");
      if (answer !== "Approve") return;
      approved = true;
    }
    output.show(true);
    try {
      // Pass --repo explicitly: without it cmdRun targets the globally registered
      // workspace, which may be a different repository than the open folder.
      const evidencePath = vscode.workspace.getConfiguration("minitok").get<string>("evidencePath", ".minitok/evidence/runs/latest.json").trim() || ".minitok/evidence/runs/latest.json";
      const runArgs = ["run", task, "--repo", cwd, "--evidence-path", evidencePath, "--capability-file", capabilityFile(), ...(approved ? ["--auto-accept"] : [])];
      // Run inside a cancellable notification. The spawned CLI has no TTY of its
      // own, so this is the only way to stop a long run short of reloading the
      // window (the promise used to have no timeout and no cancel path).
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "minitok task", cancellable: true }, async (_progress, token) => {
        output.appendLine(redactExtensionOutput(await runCli(cliPath(), runArgs, { timeoutMs: CLI_RUN_TIMEOUT_MS, token })));
      });
    } catch (error) {
      const safeError = redactExtensionOutput(String(error));
      output.appendLine(safeError);
      vscode.window.showErrorMessage(String(error).includes("cancelled") ? "minitok task cancelled" : "minitok task failed");
    }
  }));
  context.subscriptions.push(vscode.commands.registerCommand("minitok.status", async () => {
    output.show(true);
    try {
      const version = await runCli(cliPath(), ["--version"], { timeoutMs: CLI_STATUS_TIMEOUT_MS });
      if (!isCliCompatible(version)) throw new Error(`Unsupported minitok CLI version: ${version.trim()}`);
      // Inspect the open folder, not the globally registered workspace.
      const statusCwd = workspacePath();
      output.appendLine(redactExtensionOutput(await runCli(cliPath(), statusCwd ? ["status", "--repo", statusCwd] : ["status"], { timeoutMs: CLI_STATUS_TIMEOUT_MS, requireWorkspace: false })));
    } catch (error) { output.appendLine(redactExtensionOutput(String(error))); }
  }));
}

export function deactivate() {}
