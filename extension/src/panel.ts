import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn, ChildProcessWithoutNullStreams, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cliPath, workspacePath, requireTrustedWorkspace, autoApprove, spawnSpec } from "./workspace";
import { requireEntitlement } from "./entitlement";

function runCli(cliPath: string, args: string[], cwd: string | undefined, onProcess: (child: ChildProcessWithoutNullStreams | undefined) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const processSpec = spawnSpec(cliPath, args);
    const child = spawn(processSpec.command, processSpec.args, { cwd, shell: processSpec.shell, windowsHide: true, detached: process.platform !== "win32" });
    onProcess(child);
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      if (process.platform === "win32") {
        try { execFileSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, timeout: 10000 }); } catch { child.kill(); }
      } else {
        try { process.kill(-child.pid!, "SIGTERM"); } catch { child.kill("SIGTERM"); }
      }
    }, 1800000);
    child.stdout.on("data", chunk => { stdout += chunk.toString(); });
    child.stderr.on("data", chunk => { stderr += chunk.toString(); });
    child.on("error", error => { clearTimeout(timeout); reject(error); });
    child.on("close", code => { clearTimeout(timeout); onProcess(undefined); if (code === 0) resolve(stdout); else reject(new Error(stderr || stdout || `minitok exited with code ${code}`)); });
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
     requireTrustedWorkspace(cwd);
     try {
       if (message.command === "stop") { this.stopProcess(); this.post(true, "Run stopped."); return; }
       await requireEntitlement();
       if (message.command === "status") this.post(true, await runCli(cli, ["status", "--repo", cwd!], cwd, child => { this.process = child; }));
      else {
        requireTrustedWorkspace(cwd);
        if (!message.task?.trim()) throw new Error("Task description required");
        if (this.process) throw new Error("A minitok run is already active");
        const args = ["run", message.task, "--repo", cwd!];
        if (message.command === "dry-run") args.push("--dry-run");
        else if (autoApprove()) args.push("--auto-accept");
        else {
          const answer = await vscode.window.showWarningMessage("Allow minitok to modify this workspace?", "Approve", "Cancel");
          if (answer !== "Approve") return;
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
    if (process.platform === "win32") {
      try { execFileSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, timeout: 10000 }); } catch { child.kill(); }
    } else {
      try { process.kill(-child.pid!, "SIGTERM"); } catch { child.kill("SIGTERM"); }
    }
  }
  private post(ok: boolean, text: string) { this.panel.webview.postMessage({ ok, text }); }
  private html() { const nonce = randomBytes(16).toString("base64"); const source = fs.readFileSync(path.join(this.extensionUri.fsPath, "src", "panel.html"), "utf8"); return source.replaceAll("{{nonce}}", nonce).replace("{{cspSource}}", this.panel.webview.cspSource); }
  private dispose() { this.stopProcess(); while (this.disposables.length) this.disposables.pop()?.dispose(); this.panel.dispose(); }
}
