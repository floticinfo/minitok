import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn, ChildProcessWithoutNullStreams, execFile, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cliPath, workspacePath, requireTrustedWorkspace, autoApprove, spawnSpec, spawnOptionsFor } from "./workspace";
import { checkEntitlement, invalidateEntitlementCache, requireEntitlement } from "./entitlement";
import { deviceLogin, logoutExtension, refreshExtensionSession, readExtensionSession, authErrorText } from "./device-auth";
import { redactSensitiveText } from "./redaction";

const CLI_TIMEOUT_MS = 1800000;

const redactPanelOutput = redactSensitiveText;

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
    minitokPanel.current = new minitokPanel(panel, context.extensionUri, context);
  }

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, private readonly context: vscode.ExtensionContext) {
    this.panel = panel; this.extensionUri = extensionUri;
    this.panel.webview.html = this.html();
    this.panel.webview.onDidReceiveMessage(message => {
      void this.handle(message).catch(error => this.post(false, redactPanelOutput(String(error))));
    }, null, this.disposables);
    void this.authStatus();
    this.panel.onDidDispose(() => { minitokPanel.current = undefined; this.dispose(); }, null, this.disposables);
  }

  private async openBilling(kind: "checkout" | "portal") {
    const session = await refreshExtensionSession(this.context);
    if (!session?.access_token) { this.post(false, "Sign in before managing your plan."); return; }
    const envName = "MINITOK_EXTENSION_CUSTOMER_TOKEN";
    const env: NodeJS.ProcessEnv = { ...process.env, MINITOK_UPDATE_CHECK: "0", [envName]: session.access_token };
    const spec = spawnSpec(cliPath(), [kind, "--token-env", envName, "--json"]);
    execFile(spec.command, spec.args, { ...spawnOptionsFor(spec, { cwd: workspacePath(), env }), timeout: 30000 }, async (error, stdout, stderr) => {
      delete env[envName];
      if (error) { this.post(false, redactPanelOutput(stderr || error.message)); return; }
      try {
        const result = JSON.parse(String(stdout).trim()) as { checkout_url?: string; portal_url?: string };
        const target = kind === "checkout" ? result.checkout_url : result.portal_url;
        if (!target || !/^https:\/\//i.test(target)) throw new Error("Billing service returned an invalid URL");
        await vscode.env.openExternal(vscode.Uri.parse(target));
        this.post(true, kind === "checkout" ? "Checkout opened in your browser." : "Billing portal opened in your browser.");
      } catch (parseError) { this.post(false, redactPanelOutput(parseError instanceof Error ? parseError.message : String(parseError))); }
    });
  }

  private async authStatus() {
    const session = await refreshExtensionSession(this.context);
    if (!session) {
      this.postAuth("signed-out", false, false, "Sign in to continue.");
      return;
    }
    invalidateEntitlementCache();
    const result = await checkEntitlement();
    this.postAuth(result.allowed ? "authenticated" : "not-entitled", true, result.allowed, result.allowed ? `Signed in with ${result.plan} plan.` : (result.message || "An active paid plan is required."));
  }

  private postAuth(state: "checking" | "signed-out" | "authenticated" | "not-entitled" | "refresh-failed", authenticated: boolean, entitled: boolean, text: string) {
    this.panel.webview.postMessage({ type: "auth-state", state, authenticated, entitled, text: redactPanelOutput(text) });
  }

  private async handle(message: { command: string; task?: string }) {
    if (message?.command === "auth-status") { await this.authStatus(); return; }
    if (message?.command === "device-login") {
      try {
        await deviceLogin(this.context, text => this.postAuth("checking", false, false, text));
        invalidateEntitlementCache();
        await this.authStatus();
      } catch (error) { this.postAuth("refresh-failed", false, false, authErrorText(error)); }
      return;
    }
    if (message?.command === "activate" || message?.command === "manage-plan") { await this.openBilling(message.command === "activate" ? "checkout" : "portal"); return; }
    if (message?.command === "device-logout") {
      const remoteRevoked = await logoutExtension(this.context);
      invalidateEntitlementCache();
      this.postAuth("signed-out", false, false, remoteRevoked ? "Signed out locally and from the server." : "Signed out locally. The server session could not be revoked; sign in again when online.");
      return;
    }
    if (!message || !["status", "run", "dry-run", "stop", "activate", "manage-plan"].includes(message.command)) { this.post(false, "Unsupported command"); return; }
    if (message.task !== undefined && (typeof message.task !== "string" || message.task.length > 20000)) { this.post(false, "Task is invalid or too long"); return; }
      const cwd = workspacePath();
      const cli = cliPath();
      try {
        // The workspace trust check has to live inside the try: the panel's
        // onDidReceiveMessage callback ignores the promise this method returns,
        // so a throw here became an unhandled rejection and the webview never
        // received any feedback at all.
        if (message.command === "stop") { this.stopProcess(); this.post(true, "Run stopped."); return; }
        if (message.command === "status") {
          const statusArgs = cwd ? ["status", "--repo", cwd] : ["status"];
          this.post(true, await runCli(cli, statusArgs, cwd, child => { this.process = child; }));
        } else {
          requireTrustedWorkspace(cwd);
        await requireEntitlement();
        if (!message.task?.trim()) throw new Error("Task description required");
        if (this.process) throw new Error("A minitok run is already active");
        const evidencePath = vscode.workspace.getConfiguration("minitok").get<string>("evidencePath", ".minitok/evidence/runs/latest.json").trim() || ".minitok/evidence/runs/latest.json";
        const args = ["run", message.task, "--repo", cwd!, "--evidence-path", evidencePath];
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
        this.post(true, `${redactPanelOutput(output)}\n${evidence ? `Evidence: ${JSON.stringify(evidence, null, 2)}` : "Evidence unavailable"}`);
      }
    } catch (error) { this.post(false, redactPanelOutput(String(error))); }
  }

  private evidenceFile(cwd: string) {
    const configured = vscode.workspace.getConfiguration("minitok").get<string>("evidencePath", ".minitok/evidence/runs/latest.json").trim() || ".minitok/evidence/runs/latest.json";
    const file = path.resolve(cwd, configured);
    const root = path.resolve(cwd) + path.sep;
    if (file !== path.resolve(cwd) && !file.startsWith(root)) throw new Error("minitok.evidencePath must stay inside the workspace");
    return file;
  }

  private readEvidence(cwd: string): unknown {
    const file = this.evidenceFile(cwd);
    try { return JSON.parse(fs.readFileSync(file, "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw new Error(`Evidence could not be read: ${error instanceof Error ? error.message : String(error)}`); }
  }

  private stopProcess() {
    const child = this.process;
    if (!child || child.killed) return;
    killProcessTree(child);
  }
  private post(ok: boolean, text: string) { this.panel.webview.postMessage({ ok, text: redactPanelOutput(text) }); }
  private html() { const nonce = randomBytes(16).toString("base64"); const source = fs.readFileSync(path.join(this.extensionUri.fsPath, "src", "panel.html"), "utf8"); return source.replaceAll("{{nonce}}", nonce).replace("{{cspSource}}", this.panel.webview.cspSource); }
  private dispose() { this.stopProcess(); while (this.disposables.length) this.disposables.pop()?.dispose(); this.panel.dispose(); }
}
