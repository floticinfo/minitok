import { spawn } from "node:child_process";
import { cliPath, workspacePath, spawnSpec, spawnOptionsFor, appendBoundedOutput } from "./workspace";
import * as vscode from "vscode";
import { readAdminSession, readExtensionSession, issueRunDelegation } from "./device-auth";

export type EntitlementState = { checked: boolean; allowed: boolean; plan?: string | null; message?: string; cached?: boolean };

// ---------------------------------------------------------------------------
// Server API client (the canonical /v1 contract)
// ---------------------------------------------------------------------------

/**
 * Server base resolution order matches the CLI (`src/cli/commands/server-config.js`):
 *   1. minitok_server_url env var (lower-case, the canonical subprocess contract)
 *   2. MINITOK_SERVER_URL env var (upper-case, shells/CI)
 *   3. Default: https://api.minitok.dev
 *
 * Keep the default in lock-step with the CLI's DEFAULT_SERVER_URL. The previous
 * default pointed at `http://localhost:3000`, so a fresh install that had never
 * configured a server sent activation/status/refresh calls to a localhost that
 * nothing was listening on while the CLI talked to production.
 */
const DEFAULT_ENTITLEMENT_SERVER = "https://api.minitok.dev";

export function entitlementServerUrl(): string {
  const fromEnv = process.env.minitok_server_url || process.env.MINITOK_SERVER_URL;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim().replace(/\/+$/, "");
  return DEFAULT_ENTITLEMENT_SERVER;
}

function trimBase(base: string): string { return base.replace(/\/+$/, ""); }

async function parseJsonBody(res: Response): Promise<any> {
  try { return JSON.parse(await res.text()); } catch { return undefined; }
}

/**
 * GET /v1/account — the signed-in customer's account view.
 *
 * [2026-10-22 F1단계] This replaces the retired Phase 1 "me" route, which the
 * server answered with `404 Route ... not found` — so the extension's
 * auth-first entitlement check could never resolve and the sidebar fell
 * through to a cache the server no longer issued.
 *
 * The canonical account view carries the same facts the retired route did — the
 * customer's subscriptions, their installations and their entitlements — under
 * `/v1/account`, which the server does serve. It answers with the customer
 * bearer token, the same credential the retired route used.
 */
export async function accountEntitlementState(authToken?: string): Promise<{ ok: boolean; status: number; active?: boolean; plan?: string; error?: string }> {
  const token = authToken ?? (extensionContext ? (await readExtensionSession(extensionContext))?.access_token : undefined);
  if (!token) return { ok: false, status: 0, error: "Not signed in." };
  try {
    const res = await fetch(`${trimBase(entitlementServerUrl())}/v1/account`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    });
    const body = await parseJsonBody(res);
    if (!res.ok) {
      return { ok: false, status: res.status, error: typeof body?.error === "string" ? body.error : undefined };
    }
    const subscriptions = Array.isArray(body?.subscriptions) ? body.subscriptions : [];
    const installations = Array.isArray(body?.installations) ? body.installations : [];
    const entitlements = Array.isArray(body?.entitlements) ? body.entitlements : [];
    // `paid` is the server's own answer to "does this subscription grant access
    // right now" — it folds the status and the billing period together, so the
    // extension must not re-derive it from the two fields separately.
    const paid = subscriptions.find((s: any) => s?.paid === true);
    const activeInstallation = installations.find((i: any) => i?.status === "active");
    const activeEntitlement = entitlements.find((e: any) => e?.status === "active");
    const plan = paid?.plan_id || activeEntitlement?.plan_id || undefined;
    const active = Boolean(paid || activeInstallation || activeEntitlement);
    return { ok: true, status: res.status, active, plan, error: undefined };
  } catch (error) {
    return { ok: false, status: 0, error: error instanceof Error ? error.message : String(error) };
  }
}

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
 *
 * [2026-10-22 F1단계] This is the only activation path the extension has. The
 * direct-HTTP Phase 1 activation was removed because the server retired that
 * route, and because a plan permits exactly one installation: the CLI owns the
 * installation identity, so an activation that minted its own would occupy a
 * second device slot and fail with 409.
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

/**
 * The entitlement decision.
 *
 * [2026-10-22 F1단계] The CLI owns the installation identity and the signed
 * entitlement artifact, and its `status --json` validates that artifact against
 * the canonical `POST /v1/validate` route and honours the offline grace window.
 * It is therefore the single source of truth, and the extension makes exactly
 * one server call of its own: `GET /v1/account`, which says whether the
 * signed-in account has a plan.
 *
 * The Phase 1 server-session cache (a 24h JWT in SecretStorage) is gone with
 * the route that issued it. A route that answers 404 is not a plan, and a
 * decision derived from a 404 is indistinguishable from a missing plan.
 */
export async function requireEntitlement(): Promise<EntitlementState> {
  if (await isAdminSessionActive()) return { checked: true, allowed: true, plan: "admin", message: undefined };
  const entitlement = await checkEntitlement();
  if (entitlement.allowed) return entitlement;
  // The CLI denied. The account view separates "this account has no plan" from
  // "the server is unreachable", so an outage is not reported as a missing plan
  // and a missing plan is not reported as an outage.
  const account = await accountEntitlementState();
  if (account.status >= 500) {
    return { checked: true, allowed: false, plan: null, message: `Entitlement server error: ${account.error || account.status}` };
  }
  if (account.ok && account.active) {
    return { checked: true, allowed: true, plan: account.plan || null, message: undefined };
  }
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
      // A failed kill leaves the child running; it only drops the output, so
      // stop watching rather than throw out of the timer.
    }
    settle({ checked: true, allowed: false, message: "Entitlement check timed out" }, false);
  }, 30000);
  child.stdout.on("data", chunk => { stdout = appendBoundedOutput(stdout, chunk.toString()); });
  child.stderr.on("data", chunk => { stderr = appendBoundedOutput(stderr, chunk.toString()); });
  child.on("error", error => { clearTimeout(timer); settle({ checked: true, allowed: false, message: stderr || error.message }, false); return; });
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
