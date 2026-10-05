"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RUN_DELEGATION_ENV = void 0;
exports.entitlementServerUrl = entitlementServerUrl;
exports.activateEntitlementSession = activateEntitlementSession;
exports.meEntitlementSession = meEntitlementSession;
exports.bindLicenseToAccount = bindLicenseToAccount;
exports.statusEntitlementSession = statusEntitlementSession;
exports.refreshEntitlementSession = refreshEntitlementSession;
exports.deactivateEntitlementSession = deactivateEntitlementSession;
exports.activateWithServer = activateWithServer;
exports.adminRunDelegationEnv = adminRunDelegationEnv;
exports.activateEntitlement = activateEntitlement;
exports.setEntitlementContext = setEntitlementContext;
exports.invalidateEntitlementCache = invalidateEntitlementCache;
exports.requireEntitlement = requireEntitlement;
exports.checkServerEntitlement = checkServerEntitlement;
exports.checkEntitlement = checkEntitlement;
const node_child_process_1 = require("node:child_process");
const workspace_1 = require("./workspace");
const device_auth_1 = require("./device-auth");
const entitlement_cache_1 = require("./entitlement-cache");
// ---------------------------------------------------------------------------
// Phase 3: Server API client (mirrors src/entitlement/client.js in the CLI)
// ---------------------------------------------------------------------------
/** Server base resolution order matches the CLI: env → config → default. */
const DEFAULT_ENTITLEMENT_SERVER = "http://localhost:3000";
function entitlementServerUrl() {
    const fromEnv = process.env.MINITOK_SERVER_URL;
    if (fromEnv && fromEnv.trim())
        return fromEnv.trim().replace(/\/+$/, "");
    return DEFAULT_ENTITLEMENT_SERVER;
}
function trimBase(base) { return base.replace(/\/+$/, ""); }
async function parseJsonBody(res) {
    try {
        return JSON.parse(await res.text());
    }
    catch {
        return undefined;
    }
}
/** POST /api/entitlement/activate — validate a key, receive a JWT. */
async function activateEntitlementSession(key, base = entitlementServerUrl()) {
    const trimmed = typeof key === "string" ? key.trim() : "";
    if (!trimmed)
        return { ok: false, status: 0, error: "An activation key is required." };
    try {
        const res = await fetch(`${trimBase(base)}/api/entitlement/activate`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ key: trimmed }),
            signal: AbortSignal.timeout(30_000),
        });
        const body = await parseJsonBody(res);
        const entitlement = body?.entitlement || {};
        return {
            ok: res.ok && typeof body?.token === "string",
            status: res.status,
            token: typeof body?.token === "string" ? body.token : undefined,
            plan: typeof entitlement.plan === "string" ? entitlement.plan : undefined,
            error: typeof body?.error === "string" ? body.error : undefined,
        };
    }
    catch (error) {
        return { ok: false, status: 0, error: error instanceof Error ? error.message : String(error) };
    }
}
/** GET /api/entitlement/me — resolve entitlement from an auth-server JWT. */
async function meEntitlementSession(authToken, base = entitlementServerUrl()) {
    try {
        const res = await fetch(`${trimBase(base)}/api/entitlement/me`, {
            headers: { Authorization: `Bearer ${authToken}` },
            signal: AbortSignal.timeout(15_000),
        });
        const body = await parseJsonBody(res);
        return {
            ok: res.ok && body?.active === true,
            status: res.status,
            active: body?.active === true,
            plan: typeof body?.plan === "string" ? body.plan : undefined,
            error: typeof body?.error === "string" ? body.error : undefined,
        };
    }
    catch (error) {
        return { ok: false, status: 0, error: error instanceof Error ? error.message : String(error) };
    }
}
/**
 * POST /api/entitlement/bind — link a license key to the signed-in account.
 *
 * Migration path for customers holding a key that was activated before the
 * OAuth entitlement flow: the key authorizes the binding and the verified
 * auth token supplies the customer_id, so after this succeeds GET /me resolves.
 */
async function bindLicenseToAccount(key, authToken, base = entitlementServerUrl()) {
    const trimmed = typeof key === "string" ? key.trim() : "";
    if (!trimmed)
        return { ok: false, status: 0, error: "An activation key is required." };
    try {
        const res = await fetch(`${trimBase(base)}/api/entitlement/bind`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ key: trimmed, auth_token: authToken }),
            signal: AbortSignal.timeout(15_000),
        });
        const body = await parseJsonBody(res);
        const entitlement = body?.entitlement || {};
        return {
            ok: res.ok && body?.bound === true,
            status: res.status,
            plan: typeof entitlement.plan === "string" ? entitlement.plan : undefined,
            error: typeof body?.error === "string" ? body.error : undefined,
        };
    }
    catch (error) {
        return { ok: false, status: 0, error: error instanceof Error ? error.message : String(error) };
    }
}
/** GET /api/entitlement/status — validate a JWT, return current state. */
async function statusEntitlementSession(token, base = entitlementServerUrl()) {
    try {
        const res = await fetch(`${trimBase(base)}/api/entitlement/status`, {
            headers: { Authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(15_000),
        });
        const body = await parseJsonBody(res);
        return {
            ok: res.ok && body?.active === true,
            status: res.status,
            active: body?.active === true,
            plan: typeof body?.plan === "string" ? body.plan : undefined,
            expiresAt: typeof body?.expires_at === "string" ? body.expires_at : undefined,
            error: typeof body?.error === "string" ? body.error : undefined,
        };
    }
    catch (error) {
        return { ok: false, status: 0, error: error instanceof Error ? error.message : String(error) };
    }
}
/** POST /api/entitlement/refresh — renew a (possibly expired) JWT. */
async function refreshEntitlementSession(token, base = entitlementServerUrl()) {
    try {
        const res = await fetch(`${trimBase(base)}/api/entitlement/refresh`, {
            method: "POST",
            headers: { Authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(15_000),
        });
        const body = await parseJsonBody(res);
        return {
            ok: res.ok && typeof body?.token === "string",
            status: res.status,
            token: typeof body?.token === "string" ? body.token : undefined,
            error: typeof body?.error === "string" ? body.error : undefined,
        };
    }
    catch (error) {
        return { ok: false, status: 0, error: error instanceof Error ? error.message : String(error) };
    }
}
/** DELETE /api/entitlement — revoke the JWT. */
async function deactivateEntitlementSession(token, base = entitlementServerUrl()) {
    try {
        const res = await fetch(`${trimBase(base)}/api/entitlement`, {
            method: "DELETE",
            headers: { Authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(15_000),
        });
        const body = await parseJsonBody(res);
        return { ok: res.ok, status: res.status, error: typeof body?.error === "string" ? body.error : undefined };
    }
    catch (error) {
        return { ok: false, status: 0, error: error instanceof Error ? error.message : String(error) };
    }
}
/**
 * Phase 3 server-validated activation: activate against the server, then
 * persist the JWT in SecretStorage. Also runs the CLI activation so the
 * on-disk artifact stays in sync for CLI runs outside the extension.
 */
async function activateWithServer(context, key) {
    const result = await activateEntitlementSession(key);
    if (!result.ok || !result.token) {
        return { ok: false, message: result.error || `Activation failed (HTTP ${result.status}).` };
    }
    const cache = new entitlement_cache_1.EntitlementCache(context.secrets);
    await cache.save(result.token);
    invalidateEntitlementCache();
    const payload = (0, entitlement_cache_1.decodeJwtPayload)(result.token);
    return { ok: true, message: "Activation successful.", plan: result.plan || payload?.plan || null };
}
/** Environment variable that carries the activation key to the CLI child. */
const ACTIVATION_KEY_ENV = "MINITOK_ACTIVATION_KEY";
/** Environment variable that carries the one-time run delegation token. */
exports.RUN_DELEGATION_ENV = "MINITOK_RUN_DELEGATION";
/**
 * Environment for a delegated admin run: a one-time token bound to this runId,
 * issued by the server with the admin credential that stays in the extension
 * host. Passed by environment only — never argv — and scrubbed by the CLI as
 * soon as it is read, so neither the admin token nor the delegation token
 * outlives the child's entitlement gate.
 */
async function adminRunDelegationEnv(context, runId) {
    if (!(await isAdminSessionActive()))
        return {};
    const token = await (0, device_auth_1.issueRunDelegation)(context, runId);
    return { [exports.RUN_DELEGATION_ENV]: token };
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
function activateEntitlement(key) {
    return new Promise(resolve => {
        const trimmed = typeof key === "string" ? key.trim() : "";
        if (!trimmed) {
            resolve({ ok: false, message: "An activation key is required." });
            return;
        }
        let settled = false;
        const settle = (result) => { if (!settled) {
            settled = true;
            resolve(result);
        } };
        const env = { [ACTIVATION_KEY_ENV]: trimmed };
        const spec = (0, workspace_1.spawnSpec)((0, workspace_1.cliPath)(), ["activate", "--key-env", ACTIVATION_KEY_ENV]);
        let child;
        try {
            child = (0, node_child_process_1.spawn)(spec.command, spec.args, (0, workspace_1.spawnOptionsFor)(spec, { cwd: (0, workspace_1.workspacePath)(), env }));
        }
        catch (error) {
            settle({ ok: false, message: error instanceof Error ? error.message : String(error) });
            return;
        }
        let stdout = "";
        let stderr = "";
        // Activation is one HTTP round trip; a minute covers a slow or proxied link
        // without leaving the webview waiting on a dead child.
        const timer = setTimeout(() => {
            try {
                child.kill();
            }
            catch {
                // A failed kill leaves the child and its stream listeners alive; the
                // settle guard already dropped the result, so just stop watching.
            }
            settle({ ok: false, message: "Activation timed out." });
        }, 60000);
        child.stdout.on("data", chunk => { stdout = (0, workspace_1.appendBoundedOutput)(stdout, chunk.toString()); });
        child.stderr.on("data", chunk => { stderr = (0, workspace_1.appendBoundedOutput)(stderr, chunk.toString()); });
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
let cachedDecision;
// Module-scoped extension context: requireEntitlement() callers do not have one.
let extensionContext;
/** Register the context used to look up the admin session for entitlement bypass. */
function setEntitlementContext(context) {
    extensionContext = context;
}
/** True while an admin session is stored: admin operations are never plan-gated. */
async function isAdminSessionActive() {
    if (!extensionContext)
        return false;
    const session = await (0, device_auth_1.readAdminSession)(extensionContext);
    return Boolean(session?.token);
}
/** Drop the cached decision after a login, a logout, or a plan change. */
function invalidateEntitlementCache() {
    cachedDecision = undefined;
}
async function requireEntitlement() {
    if (await isAdminSessionActive())
        return { checked: true, allowed: true, plan: "admin", message: undefined };
    // Phase 3: prefer the server-validated session stored in SecretStorage.
    // When the server is unreachable, an unexpired cached `exp` is the fallback.
    if (extensionContext) {
        const serverState = await checkServerEntitlement(extensionContext);
        if (serverState.checked)
            return serverState;
    }
    const entitlement = await checkEntitlement();
    if (!entitlement.allowed)
        throw new Error(entitlement.message || "An active paid minitok plan is required.");
    return entitlement;
}
/**
 * Server-validated entitlement check with local cache fallback.
 *
 * Auth-first: when an OAuth session exists, resolve entitlement via
 * GET /api/entitlement/me with the auth token. Falls back to the
 * SecretStorage-cached entitlement JWT, then to the offline `exp` claim.
 *
 * Returns { checked: true, ... } when the server (or the offline fallback)
 * produced a decision, and { checked: false } when neither is available so
 * the caller can fall back to the CLI-based gate.
 */
async function checkServerEntitlement(context) {
    // Auth-first: OAuth session → /api/entitlement/me
    const authSession = await (0, device_auth_1.readExtensionSession)(context);
    if (authSession?.access_token) {
        const me = await meEntitlementSession(authSession.access_token);
        if (me.ok) {
            invalidateEntitlementCache();
            return { checked: true, allowed: true, plan: me.plan || null, message: undefined };
        }
        if (me.status === 404) {
            return { checked: true, allowed: false, plan: null, message: "No active plan found for this account." };
        }
        // 401/403: auth token issue — fall through to cached entitlement token.
    }
    // Fallback: SecretStorage-cached entitlement JWT (legacy key-based flow).
    const cache = new entitlement_cache_1.EntitlementCache(context.secrets);
    const session = await cache.load();
    if (!session)
        return { checked: false, allowed: false };
    const status = await statusEntitlementSession(session.token);
    if (status.ok) {
        invalidateEntitlementCache();
        return { checked: true, allowed: true, plan: status.plan || session.payload.plan || null, message: undefined };
    }
    // 401/403: the token is revoked or expired on the server. Try a refresh
    // before falling back to the local `exp` so a near-expiry session survives.
    if (status.status === 401 || status.status === 403) {
        const refreshed = await refreshEntitlementSession(session.token);
        if (refreshed.ok && refreshed.token) {
            await cache.save(refreshed.token);
            invalidateEntitlementCache();
            const payload = (0, entitlement_cache_1.decodeJwtPayload)(refreshed.token);
            return { checked: true, allowed: true, plan: payload?.plan || null, message: undefined };
        }
        // A definite server-side rejection: do not honor the offline fallback.
        if (refreshed.status !== 0) {
            await cache.clear();
            return { checked: true, allowed: false, plan: null, message: status.error || refreshed.error || "Your minitok plan is no longer active." };
        }
    }
    // Network failure (status 0): offline fallback via the `exp` claim.
    const offline = await cache.loadValidOffline();
    if (offline)
        return { checked: true, allowed: true, plan: offline.payload.plan || null, message: undefined, cached: true };
    return { checked: false, allowed: false };
}
function checkEntitlement() {
    // The admin bypass is async (secret storage read), so it resolves before the
    // CLI spawn: an admin session authorizes every gated command without a plan.
    return isAdminSessionActive().then(admin => {
        // Capture the cache window after the async admin check, not before the await:
        // a timestamp taken up front is stale by however long the secret read took.
        const now = Date.now();
        return new Promise(resolve => {
            if (admin) {
                cachedDecision = undefined;
                resolve({ checked: true, allowed: true, plan: "admin", message: undefined });
                return;
            }
            if (cachedDecision && now - cachedDecision.at < (cachedDecision.state.allowed ? ALLOWED_CACHE_MS : DENIED_CACHE_MS)) {
                resolve({ ...cachedDecision.state, cached: true });
                return;
            }
            let settled = false;
            const settle = (state, cacheable = true) => {
                if (settled)
                    return;
                settled = true;
                // Only a decision the CLI actually reached is worth caching. A local spawn
                // failure (ENOENT — CLI not installed yet) or a killed timeout says nothing
                // about the plan, and caching it locked a just-installed user out for the
                // denial window.
                if (cacheable)
                    cachedDecision = { at: Date.now(), state };
                resolve(state);
            };
            const spec = (0, workspace_1.spawnSpec)((0, workspace_1.cliPath)(), ["status", "--json"]);
            let child;
            try {
                child = (0, node_child_process_1.spawn)(spec.command, spec.args, (0, workspace_1.spawnOptionsFor)(spec, { cwd: (0, workspace_1.workspacePath)() }));
            }
            catch (error) {
                settle({ checked: true, allowed: false, message: error instanceof Error ? error.message : String(error) }, false);
                return;
            }
            let stdout = "";
            let stderr = "";
            const timer = setTimeout(() => {
                try {
                    child.kill();
                }
                catch {
                    // A failed kill leaves the child running; the settle guard drops its
                    // output, so stop watching rather than throw out of the timer.
                }
                settle({ checked: true, allowed: false, message: "Entitlement check timed out" }, false);
            }, 30000);
            child.stdout.on("data", chunk => { stdout = (0, workspace_1.appendBoundedOutput)(stdout, chunk.toString()); });
            child.stderr.on("data", chunk => { stderr = (0, workspace_1.appendBoundedOutput)(stderr, chunk.toString()); });
            child.on("error", error => { clearTimeout(timer); settle({ checked: true, allowed: false, message: stderr || error.message }, false); });
            child.on("close", code => {
                clearTimeout(timer);
                if (code !== 0) {
                    settle({ checked: true, allowed: false, message: stderr || `minitok exited with code ${code}` });
                    return;
                }
                try {
                    const result = JSON.parse(stdout);
                    const entitlement = result.entitlement || {};
                    const allowed = entitlement.allowed === true && typeof entitlement.plan === "string" && entitlement.plan.length > 0;
                    settle({ checked: true, allowed, plan: entitlement.plan || null, message: allowed ? undefined : "An active paid minitok plan is required." });
                }
                catch (parseError) {
                    settle({ checked: true, allowed: false, message: `Could not verify minitok entitlement: ${parseError instanceof Error ? parseError.message : String(parseError)}` });
                }
            });
        });
    });
}
