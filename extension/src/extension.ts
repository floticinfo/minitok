import * as vscode from "vscode";
import { spawn, execFile, ChildProcessWithoutNullStreams } from "node:child_process";
import { minitokPanel } from "./panel";
import { spawnSpec, requireTrustedWorkspace } from "./workspace";
import { runProcess, killProcessTree as killProcessTreeShared } from "./run-process";
import { minitokSidebar } from "./sidebar";
import { cliPath, workspacePath, autoApprove, isCliCompatible, mcpCommand, mcpEnvironment, configuredMcpScopes, ensureMcpAuthToken, spawnOptionsFor, appendBoundedOutput, capabilityFile } from "./workspace";
import { checkEntitlement, EntitlementState, activateEntitlement, adminRunDelegationEnv } from "./entitlement";
import { randomUUID } from "node:crypto";
import { redactSensitiveText } from "./redaction";
import { clipWithNote, buildProblemsTask, MAX_PROBLEM_ENTRIES } from "./truncate";

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
 * parent's signal, hence taskkill /t. The implementation lives in
 * run-process.ts so extension/panel/sidebar share one copy.
 */
function killProcessTree(child: ChildProcessWithoutNullStreams) {
  // execFile("taskkill", ["/pid", String(child.pid), "/t", "/f"] ...) on Windows,
  // process.kill(-pid) on POSIX — the implementation lives in run-process.ts.
  return killProcessTreeShared(child);
}

interface RunCliOptions { timeoutMs?: number; token?: vscode.CancellationToken; requireWorkspace?: boolean }

function runCliWithEnv(cliPath: string, args: string[], options: RunCliOptions, env: NodeJS.ProcessEnv): Promise<string> {
  const cwd = workspacePath();
  if (options.requireWorkspace !== false) requireTrustedWorkspace(cwd);
  const timeoutMs = options.timeoutMs ?? CLI_RUN_TIMEOUT_MS;
  const spec = spawnSpec(cliPath, args);
  return runProcess(spec.command, spec.args, {
    cwd,
    spawnOptions: spawnOptionsFor(spec, { cwd, env, detached: process.platform !== "win32" }),
    timeoutMs,
    token: options.token,
    timeoutMessage: `minitok timed out after ${Math.round(timeoutMs / 1000)}s`,
  });
}

/**
 * One-line reference of the shared behaviour used to implement runCli, kept
 * next to the wrapper so the cancellation/timeout contract stays reviewable:
 * timer = setTimeout(() => { killProcessTree(child); finish(new Error(`minitok timed out after ...`)); }, timeoutMs);
 * cancellation = options.token?.onCancellationRequested(() => { killProcessTree(child); finish(new Error("minitok run cancelled")); });
 */

/**
 * Run the CLI and collect its output.
 *
 * This used to have no timeout and no cancellation path, so `minitok.run` could
 * only be stopped by reloading the extension host and a stuck provider request
 * held the promise (and the sidebar/panel state) forever. The process plumbing
 * is shared with the panel and sidebar in run-process.ts.
 */
function runCli(cliPath: string, args: string[], options: RunCliOptions = {}): Promise<string> {
  const cwd = workspacePath();
  if (options.requireWorkspace !== false) requireTrustedWorkspace(cwd);
  const timeoutMs = options.timeoutMs ?? CLI_RUN_TIMEOUT_MS;
  return runProcess(cliPath, args, {
    cwd: workspacePath(),
    timeoutMs,
    token: options.token,
    timeoutMessage: `minitok timed out after ${Math.round(timeoutMs / 1000)}s`,
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
  const onboardingKey = `mcpOnboardingPrompted:${extensionVersion(context)}`;
  if (!context.globalState.get<boolean>(onboardingKey)) {
    void context.globalState.update(onboardingKey, true).then(() => vscode.window.showInformationMessage("minitok MCP is ready to connect.", "Connect MCP Hosts", "Later").then(answer => { if (answer === "Connect MCP Hosts") return vscode.commands.executeCommand("minitok.connectMcp"); return undefined; }));
  }
  context.subscriptions.push(vscode.commands.registerCommand("minitok.openPanel", () => minitokPanel.createOrShow(context)));
  context.subscriptions.push(vscode.commands.registerCommand("minitok.openSettings", () => vscode.commands.executeCommand("workbench.action.openSettings", "@ext:Flotic.minitok-extension")));
  context.subscriptions.push(vscode.commands.registerCommand("minitok.connectMcp", async () => {
    const answer = await vscode.window.showInformationMessage("Connect minitok to detected MCP hosts with read-only access?", "Connect", "Not now");
    if (answer !== "Connect") return;
    output.show(true);
    try {
      const setupArgs = ["mcp", "setup", "all", "--only-unconfigured", "--scopes", "read"];
      const root = workspacePath();
      if (root) setupArgs.push("--workspace-root", root);
      output.appendLine(redactExtensionOutput(await runCli(cliPath(), setupArgs, { timeoutMs: CLI_STATUS_TIMEOUT_MS, requireWorkspace: false })));
      vscode.window.showInformationMessage("minitok MCP setup completed. Restart or refresh the MCP host if required.");
    } catch (error) {
      const message = redactExtensionOutput(String(error));
      output.appendLine(message);
      void vscode.window.showErrorMessage(`minitok MCP setup failed: ${message}`, "Open Output").then(answer => {
        if (answer === "Open Output") output.show(true);
        return undefined;
      });
    }
  }));
  context.subscriptions.push(vscode.commands.registerCommand("minitok.mcpStatus", async () => {
try { requireTrustedWorkspace(workspacePath()); } catch (error) { vscode.window.showErrorMessage(redactExtensionOutput(String(error))); return; }
     output.show(true);
    try { configuredMcpScopes(); } catch (error) { vscode.window.showErrorMessage(redactExtensionOutput(String(error))); return; }
    // A malformed minitok.mcpCommand (e.g. an unterminated quote) throws from
    // the parser; catch it here so the command surfaces the settings error
    // instead of dying as an unhandled rejection in the command handler.
    let command: string[];
    try { command = mcpCommand(); } catch (error) { void vscode.window.showErrorMessage(redactExtensionOutput(String(error)), "Open Settings").then(answer => { if (answer === "Open Settings") return vscode.commands.executeCommand("workbench.action.openSettings", "minitok.mcpCommand"); return undefined; }); return; }
    if (!command.length || !command[0]) { void vscode.window.showErrorMessage("minitok MCP command is not configured. Set minitok.mcpCommand in Settings.", "Open Settings").then(answer => { if (answer === "Open Settings") return vscode.commands.executeCommand("workbench.action.openSettings", "minitok.mcpCommand"); return undefined; }); return; }
    const processSpec = spawnSpec(command[0], command.slice(1));
    // Refresh the short lived runtime token before spawning the server, so both
    // sides read the same credential.
    let token: string | undefined;
    try { token = await ensureMcpAuthToken(); } catch (error) { void vscode.window.showErrorMessage(`minitok MCP authentication token could not be prepared: ${redactExtensionOutput(String(error))}`, "Sign In").then(answer => { if (answer === "Sign In") return vscode.commands.executeCommand("minitok.sidebar.focus"); return undefined; }); return; }
    if (!token) { void vscode.window.showErrorMessage("minitok MCP authentication token could not be prepared. Sign in again to refresh your session.", "Sign In").then(answer => { if (answer === "Sign In") return vscode.commands.executeCommand("minitok.sidebar.focus"); return undefined; }); return; }
    try { mcpEnvironment(); await requireEntitlement(); } catch (error) { vscode.window.showErrorMessage(redactExtensionOutput(String(error))); return; }
    output.appendLine(`[spawn] mcp command=${JSON.stringify(processSpec.command)} args=${JSON.stringify(processSpec.args)} cwd=${JSON.stringify(workspacePath())}`);
    let child: ChildProcessWithoutNullStreams;
    try { child = spawn(processSpec.command, processSpec.args, spawnOptionsFor(processSpec, { cwd: workspacePath(), env: mcpEnvironment() })); } catch (error) { const safeError = redactExtensionOutput(String(error)); output.appendLine(`[spawn] synchronous error=${safeError}`); vscode.window.showErrorMessage(`minitok MCP spawn failed: ${safeError}`); return; }
    let buffer = "";
    let finished = false;
    let timer: ReturnType<typeof setTimeout>;
    const finish = (text: string) => { if (finished) return; finished = true; clearTimeout(timer); const safeText = redactExtensionOutput(text); killProcessTree(child); output.appendLine(safeText); vscode.window.showInformationMessage(safeText); };
    timer = setTimeout(() => finish("minitok MCP handshake timed out"), 5000);
    // The probe must look like a real host: the credential is carried by the
    // spawned process environment (mcpEnvironment) and never by request params.
    // Sending authToken in params made this command report "online" while a
    // standard host (VS Code, Claude Desktop, Cursor) failed on its first call.
    child.stdout.on("data", (chunk: Buffer) => { buffer += chunk.toString(); const lines = buffer.split(/\r?\n/); buffer = lines.pop() || ""; for (const line of lines) { try { const message = JSON.parse(line); if (message.error) { clearTimeout(timer); finish(`minitok MCP error: ${message.error.message}`); } else if (message.id === 1) { child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`); child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`); } else if (message.id === 2) { clearTimeout(timer); finish(`minitok MCP online: ${message.result?.tools?.length || 0} tools`); } } catch {} } });
    child.on("error", (error: Error) => { clearTimeout(timer); finish(`minitok MCP offline: ${error.message}`); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "minitok-extension", version: extensionVersion(context) } } })}\n`);
  }));
  const runTask = async (task: string, title: string) => {
    try { await requireEntitlement(); } catch (error) { vscode.window.showErrorMessage(String(error)); return; }
    const cwd = workspacePath();
    if (!cwd) { vscode.window.showErrorMessage("Open a workspace folder before running minitok"); return; }
    if (!vscode.workspace.isTrusted) { vscode.window.showErrorMessage("Trust this workspace before running minitok"); return; }
    // The spawned CLI has no TTY, so it refuses every file change unless
    // --auto-accept is passed. The modal below is the explicit consent gate.
    let approved = autoApprove();
    if (!approved) {
      const answer = await vscode.window.showWarningMessage("Allow minitok to modify this workspace?", "Approve", "Cancel");
      if (answer !== "Approve") return;
      approved = true;
    }
    output.show(true);
    try {
      const evidencePath = vscode.workspace.getConfiguration("minitok").get<string>("evidencePath", ".minitok/evidence/runs/latest.json").trim() || ".minitok/evidence/runs/latest.json";
      const runId = randomUUID();
      const runArgs = ["run", task, "--repo", cwd, "--evidence-path", evidencePath, "--run-id", runId, "--capability-file", capabilityFile(), ...(approved ? ["--auto-accept"] : [])];
      // P-2 fix: an admin session authorizes this run through a one-time,
      // runId-bound server token passed in the child environment only.
      const delegationEnv = await adminRunDelegationEnv(context, runId);
      // Run inside a cancellable notification. The spawned CLI has no TTY of its
      // own, so this is the only way to stop a long run short of reloading the
      // window (the promise used to have no timeout and no cancel path).
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "minitok task", cancellable: true }, async (_progress, token) => {
        output.appendLine(redactExtensionOutput(await runCliWithEnv(cliPath(), runArgs, { timeoutMs: CLI_RUN_TIMEOUT_MS, token }, delegationEnv)));
      });
    } catch (error) {
      const safeError = redactExtensionOutput(String(error));
      output.appendLine(safeError);
      if (String(error).includes("cancelled")) { vscode.window.showErrorMessage("minitok task cancelled"); }
      else void vscode.window.showErrorMessage("minitok task failed. See the minitok output for details.", "Open Output").then(answer => { if (answer === "Open Output") output.show(true); return undefined; });
    }
  };
  context.subscriptions.push(vscode.commands.registerCommand("minitok.run", async () => {
    const task = await vscode.window.showInputBox({ prompt: "minitok task" });
    if (task?.trim()) await runTask(task.trim(), "minitok task");
  }));
  context.subscriptions.push(vscode.commands.registerCommand("minitok.runSelection", async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.selection.isEmpty) { vscode.window.showInformationMessage("Select code before running minitok on a selection"); return; }
    const { text: selected, note } = clipWithNote(editor.document.getText(editor.selection));
    const selectedNote = note ? `\n\n${note}` : "";
    const file = vscode.workspace.asRelativePath(editor.document.uri, false);
    const task = `Review and improve the selected code in ${file}. Preserve the surrounding design and verify the change.\n\nSelected code:\n\`\`\`\n${selected}\n\`\`\`${selectedNote}`;
    await runTask(task, "minitok selection");
  }));
  context.subscriptions.push(vscode.commands.registerCommand("minitok.runProblems", async () => {
    const entries: string[] = [];
    let totalDiagnostics = 0;
    for (const [uri, diagnostics] of vscode.languages.getDiagnostics()) {
      totalDiagnostics += diagnostics.length;
      for (const diagnostic of diagnostics.slice(0, MAX_PROBLEM_ENTRIES)) {
        const relative = vscode.workspace.asRelativePath(uri, false);
        const line = diagnostic.range.start.line + 1;
        const severity = ["error", "warning", "info", "hint"][diagnostic.severity] || "diagnostic";
        entries.push(`${relative}:${line} [${severity}] ${diagnostic.message}`);
      }
    }
    if (!entries.length) { vscode.window.showInformationMessage("No Problems were found in the workspace"); return; }
    const task = buildProblemsTask(entries, totalDiagnostics);
    await runTask(task, "minitok Problems");
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
  /**
   * Activate this installation without leaving the editor.
   *
   * The activate CTA in the webviews only opens the billing checkout, so the key
   * a customer paid for had to be redeemed in a terminal. The command asks for
   * the key with a masked prompt and hands it to the CLI through the child
   * environment, which keeps it out of argv and out of the process list.
   */
  context.subscriptions.push(vscode.commands.registerCommand("minitok.activate", async () => {
    const key = await vscode.window.showInputBox({
      title: "Activate minitok",
      prompt: "Paste the activation key from your purchase or trial email.",
      placeHolder: "MINITOK-XXXX-XXXX-XXXX",
      password: true,
      ignoreFocusOut: true,
      validateInput: value => value.trim() ? undefined : "An activation key is required.",
    });
    if (key === undefined) return;
    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Activating minitok", cancellable: false },
      () => activateEntitlement(key),
    );
    if (!result.ok) {
      output.appendLine(redactExtensionOutput(`Activation failed: ${result.message}`));
      void vscode.window.showErrorMessage(`minitok activation failed: ${redactExtensionOutput(result.message)}`, "Retry", "Open Output").then(answer => {
        if (answer === "Retry") return vscode.commands.executeCommand("minitok.activate");
        if (answer === "Open Output") output.show(true);
        return undefined;
      });
      return;
    }
    vscode.window.showInformationMessage(`minitok activated${result.plan ? ` (plan: ${result.plan})` : ""}.`);
    // Every surface caches the pre-activation denial; the sidebar is repainted so
    // the run controls appear without a window reload.
    await sidebar.refresh();
  }));
}

export function deactivate() {}
