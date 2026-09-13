import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn, ChildProcessWithoutNullStreams, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cliPath, workspacePath, requireTrustedWorkspace, autoApprove, spawnSpec, spawnOptionsFor } from "./workspace";
import { requireEntitlement } from "./entitlement";

const CLI_TIMEOUT_MS = 1800000;

/**
 * Kill a child process and everything it spawned.
 * Windows needs taskkill /t; POSIX children are started detached so the whole
 * process group can be signalled.
 */
function killProcessTree(child: ChildProcessWithoutNullStreams) {
  if (process.platform === "win32") {
    try { execFileSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, timeout: 10000 }); } catch { child.kill(); }
  } else {
    try { process.kill(-child.pid!, "SIGTERM"); } catch { child.kill("SIGTERM"); }
  }
}

function runCli(cliPath: string, args: string[], cwd: string | undefined, onProcess: (child: ChildProcessWithoutNullStreams | undefined) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const processSpec = spawnSpec(cliPath, args);
    const child = spawn(processSpec.command, processSpec.args, spawnOptionsFor(processSpec, { cwd, detached: process.platform !== "win32" }));
    onProcess(child);
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      onProcess(undefined);
      if (error) reject(error); else resolve(stdout);
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
    child.on("close", code => { if (code === 0) finish(); else finish(new Error(stderr || stdout || `minitok exited with code ${code}`)); });
  });
}

export class minitokPanel {
  public static current: minitokPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private readonly disposables: vscode.Disposable[] = [];
  private process?: ChildProcessWithoutNullStreams;

  static createOrShow(context: vscode.ExtensionContext) {
    if (minitokPanel.current) { minitokPanel.current.panel.reveal(); return; }
    const panel = vscode.window.createWebviewPanel("minitok", "minitok", vscode.ViewColumn.Beside, { enableScripts: true, retainContextWhenHidden: true });
    minitokPanel.current = new minitokPanel(panel, context.extensionUri);
  }

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
    this.panel = panel; this.extensionUri = extensionUri;
    this.panel.webview.html = this.html();
    this.panel.webview.onDidReceiveMessage(message => this.handle(message), null, this.disposables);
    this.panel.onDidDispose(() => { minitokPanel.current = undefined; this.dispose(); }, null, this.disposables);
  }

  private async handle(message: { command: string; task?: string }) {
    if (!message || !["status", "run", "dry-run", "stop"].includes(message.command)) { this.post(false, "Unsupported command"); return; }
    if (message.task !== undefined && (typeof message.task !== "string" || message.task.length > 20000)) { this.post(false, "Task is invalid or too long"); return; }
      const cwd = workspacePath();
      const cli = cliPath();
      try {
        // The workspace trust check has to live inside the try: the panel's
        // onDidReceiveMessage callback ignores the promise this method returns,
        // so a throw here became an unhandled rejection and the webview never
        // received any feedback at all.
        requireTrustedWorkspace(cwd);
        if (message.command === "stop") { this.stopProcess(); this.post(true, "Run stopped."); return; }
       await requireEntitlement();
       if (message.command === "status") this.post(true, await runCli(cli, ["status", "--repo", cwd!], cwd, child => { this.process = child; }));
        else {
        if (!message.task?.trim()) throw new Error("Task description required");
        if (this.process) throw new Error("A minitok run is already active");
        const args = ["run", message.task, "--repo", cwd!];
        if (message.command === "dry-run") args.push("--dry-run");
        else if (autoApprove()) args.push("--auto-accept");
        else {
          // The panel collects consent before the run starts, and the CLI it
          // spawns has no TTY: without --auto-accept every file change was
          // refused with "No TTY detected. Refusing to accept file changes".
          // The answer collected here is the same decision the setting encodes,
          // so an approved run passes the flag through.
          const answer = await vscode.window.showWarningMessage("Allow minitok to modify this workspace?", "Approve", "Cancel");
          if (answer !== "Approve") return;
          args.push("--auto-accept");
        }
        const output = await runCli(cli, args, cwd, child => { this.process = child; });
        const evidence = cwd ? this.readEvidence(cwd) : null;
        this.post(true, `${output}\n${evidence ? `Evidence: ${JSON.stringify(evidence, null, 2)}` : "Evidence unavailable"}`);
      }
    } catch (error) { this.post(false, String(error)); }
  }

  private readEvidence(cwd: string): unknown {
    const file = path.join(cwd, ".minitok", "evidence", "runs", "latest.json");
    try { return JSON.parse(fs.readFileSync(file, "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw new Error(`Evidence could not be read: ${error instanceof Error ? error.message : String(error)}`); }
  }

  private stopProcess() {
    const child = this.process;
    if (!child || child.killed) return;
    killProcessTree(child);
  }
  private post(ok: boolean, text: string) { this.panel.webview.postMessage({ ok, text }); }
  private html() { const nonce = randomBytes(16).toString("base64"); const source = fs.readFileSync(path.join(this.extensionUri.fsPath, "src", "panel.html"), "utf8"); return source.replaceAll("{{nonce}}", nonce).replace("{{cspSource}}", this.panel.webview.cspSource); }
  private dispose() { this.stopProcess(); while (this.disposables.length) this.disposables.pop()?.dispose(); this.panel.dispose(); }
}
