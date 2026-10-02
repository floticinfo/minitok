import { spawn } from "node:child_process";
import { cliPath, workspacePath, spawnSpec, spawnOptionsFor, appendBoundedOutput } from "./workspace";
import * as vscode from "vscode";
import { readAdminSession, issueRunDelegation } from "./device-auth";

export type EntitlementState = { checked: boolean; allowed: boolean; plan?: string | null; message?: string; cached?: boolean };

/** Environment variable that carries the activation key to the CLI child. */
const ACTIVATION_KEY_ENV = "MINITOK_ACTIVATION_KEY";

/** Environment variable that carries the one-time run delegation token. */
export const RUN_DELEGATION_ENV = "MINITOK_RUN_DELEGATION";

/**
 * Environment for a delegated admin run: a one-time token bound to this runId,
 * issued by the server with the admin credential that stays in the extension
 * host. Passed by environment only — never argv — and scrubbed by the CLI as
 * soon as it is read, so neither the admin token nor the delegation token
 * outlives the child's entitlement gate.
 */
export async function adminRunDelegationEnv(context: vscode.ExtensionContext, runId: string): Promise<NodeJS.ProcessEnv> {
  if (!(await isAdminSessionActive())) return {};
  const token = await issueRunDelegation(context, runId);
  return { [RUN_DELEGATION_ENV]: token };
}

/**
 * Activate this installation against a billing-issued key.
 *
 * The key travels in the child environment and is referenced by name through
 * `--key-env`, so it never reaches argv: on every platform the command line is
 * readable by unrelated local processes, while the CLI already rejects a key it
 * cannot resolve from the named variable. The CLI owns the write of the signed
 * artifact and the installation token under ~/.minitok; the Extension neither
 * stores nor returns either secret, and the child environment is discarded with
 * the spawn.
 */
export function activateEntitlement(key: string): Promise<{ ok: boolean; message: string; plan?: string | null }> {
  return new Promise(resolve => {
    const trimmed = typeof key === "string" ? key.trim() : "";
    if (!trimmed) { resolve({ ok: false, message: "An activation key is required." }); return; }
    let settled = false;
    const settle = (result: { ok: boolean; message: string; plan?: string | null }) => { if (!settled) { settled = true; resolve(result); } };
    const env: NodeJS.ProcessEnv = { [ACTIVATION_KEY_ENV]: trimmed };
    const spec = spawnSpec(cliPath(), ["activate", "--key-env", ACTIVATION_KEY_ENV]);
    let child: import("node:child_process").ChildProcessWithoutNullStreams;
    try { child = spawn(spec.command, spec.args, spawnOptionsFor(spec, { cwd: workspacePath(), env })); }
    catch (error) { settle({ ok: false, message: error instanceof Error ? error.message : String(error) }); return; }
    let stdout = "";
    let stderr = "";
    // Activation is one HTTP round trip; a minute covers a slow or proxied link
    // without leaving the webview waiting on a dead child.
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // A failed kill leaves the child and its stream listeners alive; the
        // settle guard already dropped the result, so just stop watching.
      }
      settle({ ok: false, message: "Activation timed out." });
    }, 60000);
    child.stdout.on("data", chunk => { stdout = appendBoundedOutput(stdout, chunk.toString()); });
    child.stderr.on("data", chunk => { stderr = appendBoundedOutput(stderr, chunk.toString()); });
    child.on("error", error => { clearTimeout(timer); settle({ ok: false, message: stderr || error.message }); });
    child.on("close", code => {
      clearTimeout(timer);
      if (code !== 0) {
        // The CLI prints "Error: <reason>" on stderr for a rejected key; the bare
        // exit code alone tells the user nothing actionable.
        const reason = (stderr || stdout).split("\n").map(line => line.trim()).filter(line => line.startsWith("Error:")).map(line => line.slice(6).trim()).find(Boolean);
        settle({ ok: false, message: reason || stderr.trim() || `minitok activate exited with code ${code}` });
        return;
      }
      // The installation token and the signed artifact now exist on disk, so the
      // cached denial from before activation must not outlive it.
      invalidateEntitlementCache();
      const plan = /^\s*Plan:\s+(.+)$/m.exec(stdout)?.[1]?.trim() || null;
      settle({ ok: true, message: "Activation successful.", plan });
    });
  });
}

// Every check spawns the CLI and pays a Node start plus the entitlement lookup.
// Activation, each sidebar command, and the panel all asked the same question, so
// one session spawned several identical processes. A granted decision is reused
// for a minute, a denial for ten seconds so a fixed plan is picked up quickly.
const ALLOWED_CACHE_MS = 60_000;
const DENIED_CACHE_MS = 10_000;
let cachedDecision: { at: number; state: EntitlementState } | undefined;
// Module-scoped extension context: requireEntitlement() callers do not have one.
let extensionContext: vscode.ExtensionContext | undefined;

/** Register the context used to look up the admin session for entitlement bypass. */
export function setEntitlementContext(context: vscode.ExtensionContext) {
  extensionContext = context;
}

/** True while an admin session is stored: admin operations are never plan-gated. */
async function isAdminSessionActive() {
  if (!extensionContext) return false;
  const session = await readAdminSession(extensionContext);
  return Boolean(session?.token);
}

/** Drop the cached decision after a login, a logout, or a plan change. */
export function invalidateEntitlementCache() {
  cachedDecision = undefined;
}

export async function requireEntitlement(): Promise<EntitlementState> {
  if (await isAdminSessionActive()) return { checked: true, allowed: true, plan: "admin", message: undefined };
  const entitlement = await checkEntitlement();
  if (!entitlement.allowed) throw new Error(entitlement.message || "An active paid minitok plan is required.");
  return entitlement;
}

export function checkEntitlement(): Promise<EntitlementState> {
  // The admin bypass is async (secret storage read), so it resolves before the
  // CLI spawn: an admin session authorizes every gated command without a plan.
  return isAdminSessionActive().then(admin => {
    // Capture the cache window after the async admin check, not before the await:
    // a timestamp taken up front is stale by however long the secret read took.
    const now = Date.now();
    return new Promise<EntitlementState>(resolve => {
  if (admin) { cachedDecision = undefined; resolve({ checked: true, allowed: true, plan: "admin", message: undefined }); return; }
  if (cachedDecision && now - cachedDecision.at < (cachedDecision.state.allowed ? ALLOWED_CACHE_MS : DENIED_CACHE_MS)) {
    resolve({ ...cachedDecision.state, cached: true });
    return;
  }
    let settled = false;
    const settle = (state: EntitlementState, cacheable = true) => {
      if (settled) return;
      settled = true;
      // Only a decision the CLI actually reached is worth caching. A local spawn
      // failure (ENOENT — CLI not installed yet) or a killed timeout says nothing
      // about the plan, and caching it locked a just-installed user out for the
      // denial window.
      if (cacheable) cachedDecision = { at: Date.now(), state };
      resolve(state);
    };
    const spec = spawnSpec(cliPath(), ["status", "--json"]);
    let child: import("node:child_process").ChildProcessWithoutNullStreams;
    try { child = spawn(spec.command, spec.args, spawnOptionsFor(spec, { cwd: workspacePath() })); }
    catch (error) { settle({ checked: true, allowed: false, message: error instanceof Error ? error.message : String(error) }, false); return; }
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // A failed kill leaves the child running; the settle guard drops its
        // output, so stop watching rather than throw out of the timer.
      }
      settle({ checked: true, allowed: false, message: "Entitlement check timed out" }, false);
    }, 30000);
    child.stdout.on("data", chunk => { stdout = appendBoundedOutput(stdout, chunk.toString()); });
    child.stderr.on("data", chunk => { stderr = appendBoundedOutput(stderr, chunk.toString()); });
    child.on("error", error => { clearTimeout(timer); settle({ checked: true, allowed: false, message: stderr || error.message }, false); });
    child.on("close", code => {
      clearTimeout(timer);
      if (code !== 0) { settle({ checked: true, allowed: false, message: stderr || `minitok exited with code ${code}` }); return; }
      try {
        const result = JSON.parse(stdout);
        const entitlement = result.entitlement || {};
        const allowed = entitlement.allowed === true && typeof entitlement.plan === "string" && entitlement.plan.length > 0;
        settle({ checked: true, allowed, plan: entitlement.plan || null, message: allowed ? undefined : "An active paid minitok plan is required." });
      } catch (parseError) {
        settle({ checked: true, allowed: false, message: `Could not verify minitok entitlement: ${parseError instanceof Error ? parseError.message : String(parseError)}` });
      }
    });
    });
  });
}
