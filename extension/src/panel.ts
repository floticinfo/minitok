import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn, ChildProcessWithoutNullStreams, execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { cliPath, workspacePath, requireTrustedWorkspace, autoApprove, spawnSpec, spawnOptionsFor, appendBoundedOutput, workspaceRelativePath } from "./workspace";
import { checkEntitlement, invalidateEntitlementCache, requireEntitlement, adminRunDelegationEnv } from "./entitlement";
import { deviceLogin, adminLogin, logoutExtension, logoutAdmin, refreshExtensionSession, readExtensionSession, hasAdminSession, authErrorText, DeviceLoginCancellation } from "./device-auth";
import { redactSensitiveText } from "./redaction";
import { runProcess, killProcessTree } from "./run-process";

const CLI_TIMEOUT_MS = 1800000;

const redactPanelOutput = redactSensitiveText;

// Tree kills (Windows taskkill /t, POSIX process groups) are implemented once
// in run-process.ts; the panel starts children detached so the group can be
// signalled. The shared runProcess registers its timer as
// setTimeout(..., CLI_TIMEOUT_MS) — the constant this wrapper passes through —
// and its timer callback performs killProcessTree(child) then settles with the
// "minitok timed out after 30 minutes" error, exactly as the inline timer did.

function runCli(cliPath: string, args: string[], cwd: string | undefined, onProcess: (child: ChildProcessWithoutNullStreams | undefined) => void, extraEnv: NodeJS.ProcessEnv = {}): Promise<string> {
  const processSpec = spawnSpec(cliPath, args);
  return runProcess(processSpec.command, processSpec.args, {
    spawnOptions: spawnOptionsFor(processSpec, { cwd, env: extraEnv, detached: process.platform !== "win32" }),
    onProcess,
    timeoutMs: CLI_TIMEOUT_MS,
    timeoutMessage: "minitok timed out after 30 minutes",
  });
}

export class minitokPanel {
  public static current: minitokPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private readonly disposables: vscode.Disposable[] = [];
  private process?: ChildProcessWithoutNullStreams;
  private deviceLoginCancellation?: DeviceLoginCancellation;

  static createOrShow(context: vscode.ExtensionContext) {
    if (minitokPanel.current) { minitokPanel.current.panel.reveal(); return; }
    const panel = vscode.window.createWebviewPanel("minitok", "minitok", vscode.ViewColumn.Beside, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [context.extensionUri] });
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

  // Checkout is the only billing action any surface reaches: the webviews dropped
  // their plan-management button, so nothing asks for the billing portal and
  // this helper has no second call path. The CLI still ships `minitok portal`
  // as its own public command; the Extension just never spawns it.
  private async openBilling() {
    const session = await refreshExtensionSession(this.context);
    if (!session?.access_token) { this.post(false, "Sign in before managing your plan."); return; }
    const envName = "MINITOK_EXTENSION_CUSTOMER_TOKEN";
    const env: NodeJS.ProcessEnv = { ...process.env, MINITOK_UPDATE_CHECK: "0", [envName]: session.access_token };
    const spec = spawnSpec(cliPath(), ["checkout", "--token-env", envName, "--json"]);
    execFile(spec.command, spec.args, { ...spawnOptionsFor(spec, { cwd: workspacePath(), env }), timeout: 30000 }, async (error, stdout, stderr) => {
      delete env[envName];
      if (error) { this.post(false, redactPanelOutput(stderr || error.message)); return; }
      try {
        const result = JSON.parse(String(stdout).trim()) as { checkout_url?: string };
        const target = result.checkout_url;
        if (!target || !/^https:\/\//i.test(target)) throw new Error("Billing service returned an invalid URL");
        await vscode.env.openExternal(vscode.Uri.parse(target));
        this.post(true, "Checkout opened in your browser.");
      } catch (parseError) { this.post(false, redactPanelOutput(parseError instanceof Error ? parseError.message : String(parseError))); }
    });
  }

  private async authStatus() {
    // This runs on panel open and again for every auth-status request. Any throw
    // used to reject the caller, leaving the webview on its initial "Checking your
    // minitok session..." card with the sign-in button still hidden, so the user had
    // no way in. Fall back to an explicit auth-state instead of going silent.
    try {
      // An admin session authorizes every gated command without a customer plan, so
      // it has to satisfy this question on its own: refreshExtensionSession only
      // knows the customer session and would report signed-out for a valid admin.
      if (await hasAdminSession(this.context)) {
        invalidateEntitlementCache();
        this.postAuth("authenticated", true, true, "Signed in as admin.");
        return;
      }
      const session = await refreshExtensionSession(this.context);
      if (!session) {
        this.postAuth("signed-out", false, false);
        return;
      }
      invalidateEntitlementCache();
      const result = await checkEntitlement();
      this.postAuth(result.allowed ? "authenticated" : "not-entitled", true, result.allowed, result.allowed ? `Signed in with ${result.plan} plan.` : (result.message || "An active paid plan is required."));
    } catch (error) {
      this.postAuth("refresh-failed", false, false, authErrorText(error));
    }
  }

  private postAuth(state: "checking" | "signed-out" | "authenticated" | "not-entitled" | "refresh-failed", authenticated: boolean, entitled: boolean, text: string = "") {
    this.panel.webview.postMessage({ type: "auth-state", state, authenticated, entitled, text: redactPanelOutput(text) });
  }

  private async customerLogin(email?: string, password?: string) {
    if (!email?.trim() || !password) { this.postAuth("signed-out", false, false, "Email and password are required."); return; }
    const env: NodeJS.ProcessEnv = { ...process.env, MINITOK_UPDATE_CHECK: "0", MINITOK_CUSTOMER_EMAIL: email.trim(), MINITOK_CUSTOMER_PASSWORD: password };
    const spec = spawnSpec(cliPath(), ["auth", "customer-login", "--email-env", "MINITOK_CUSTOMER_EMAIL", "--password-env", "MINITOK_CUSTOMER_PASSWORD", "--json"]);
    execFile(spec.command, spec.args, { ...spawnOptionsFor(spec, { cwd: workspacePath(), env }), timeout: 30000 }, async (error, stdout, stderr) => {
      delete env.MINITOK_CUSTOMER_EMAIL; delete env.MINITOK_CUSTOMER_PASSWORD;
      if (error) { this.postAuth("signed-out", false, false, stderr || error.message); return; }
      invalidateEntitlementCache();
      await this.authStatus();
    });
  }

  private async adminLogin(email?: string, password?: string) {
    if (!email?.trim() || !password) { this.postAuth("signed-out", false, false, "Email and password are required."); return; }
    this.postAuth("checking", false, false, "Signing in as admin...");
    try {
      await adminLogin(this.context, email.trim(), password);
      invalidateEntitlementCache();
      this.postAuth("authenticated", true, true, "Signed in as admin.");
    } catch (error) {
      this.postAuth("signed-out", false, false, authErrorText(error));
    }
  }

  private async handle(message: { command: string; task?: string; email?: string; password?: string }) {
    if (message?.command === "auth-status") { await this.authStatus(); return; }
    if (message?.command === "device-login") {
      if (this.deviceLoginCancellation && !this.deviceLoginCancellation.cancelled) { this.postAuth("checking", false, false, "A browser sign-in is already in progress. Cancel it first."); return; }
      const cancellation: DeviceLoginCancellation = { cancelled: false };
      this.deviceLoginCancellation = cancellation;
      try {
        await deviceLogin(this.context, text => this.postAuth("checking", false, false, text), cancellation);
        invalidateEntitlementCache();
        await this.authStatus();
      } catch (error) { this.postAuth("refresh-failed", false, false, authErrorText(error)); }
      finally { if (this.deviceLoginCancellation === cancellation) this.deviceLoginCancellation = undefined; }
      return;
    }
    if (message?.command === "cancel-login") { if (this.deviceLoginCancellation) this.deviceLoginCancellation.cancelled = true; return; }
    if (message?.command === "activate") { await this.openBilling(); return; }
    if (message?.command === "customer-login") { await this.customerLogin(message.email, message.password); return; }
    if (message?.command === "admin-login") { await this.adminLogin(message.email, message.password); return; }
    if (message?.command === "device-logout") {
      const remoteRevoked = await logoutExtension(this.context);
      // An admin session is stored separately and bypasses the entitlement gate, so
      // leaving it behind would re-authenticate the next command after a sign-out.
      await logoutAdmin(this.context);
      invalidateEntitlementCache();
      this.postAuth("signed-out", false, false, remoteRevoked ? "Signed out locally and from the server." : "Signed out locally. The server session could not be revoked; sign in again when online.");
      return;
    }
    if (message?.command === "mcp-status") { this.postMcpStatus(); return; }
    if (!message || !["status", "run", "dry-run", "stop", "activate"].includes(message.command)) { this.post(false, "Unsupported command"); return; }
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
        const evidenceSetting = vscode.workspace.getConfiguration("minitok").get<string>("evidencePath", ".minitok/evidence/runs/latest.json").trim() || ".minitok/evidence/runs/latest.json";
        workspaceRelativePath(cwd!, evidenceSetting, "evidencePath");
        const runId = randomUUID();
        const args = ["run", message.task, "--repo", cwd!, "--evidence-path", evidenceSetting, "--run-id", runId];
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
        // P-2 fix: an admin session authorizes this run through a one-time,
        // runId-bound server token (env only, never argv). The CLI binds the
        // delegation to this runId via ensureRunId, so the id must be identical
        // in the issue and verify calls.
        const delegationEnv = await adminRunDelegationEnv(this.context, runId);
        const output = await runCli(cli, args, cwd, child => { this.process = child; }, delegationEnv);
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
  private post(ok: boolean, text: string) { this.panel.webview.postMessage({ type: "result", ok, text: redactPanelOutput(text) }); }

  private postMcpStatus() {
    this.panel.webview.postMessage({ type: "mcp", ok: false, text: "Check sidebar for MCP status" });
  }
  // The panel brand mark must render the same Harlekin 'm' glyph the Activity
  // Bar icon (media/minitok-activitybar.svg) uses, so the glyph is the SVG
  // artwork (media/minitok.svg) rather than a system-ui text 'm'. The webview
  // only resolves the file through asWebviewUri(); CSP img-src allows it.
  private html() { const nonce = randomBytes(16).toString("base64"); const source = fs.readFileSync(path.join(this.extensionUri.fsPath, "src", "panel.html"), "utf8"); const brandUri = this.panel.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "minitok.svg")); return source.replaceAll("{{nonce}}", nonce).replaceAll("{{brandUri}}", brandUri.toString()).replace("{{cspSource}}", this.panel.webview.cspSource); }
  private dispose() { this.stopProcess(); while (this.disposables.length) this.disposables.pop()?.dispose(); this.panel.dispose(); }
}
