"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RUN_DELEGATION_ENV = void 0;
exports.adminRunDelegationEnv = adminRunDelegationEnv;
exports.activateEntitlement = activateEntitlement;
exports.setEntitlementContext = setEntitlementContext;
exports.invalidateEntitlementCache = invalidateEntitlementCache;
exports.requireEntitlement = requireEntitlement;
exports.checkEntitlement = checkEntitlement;
const node_child_process_1 = require("node:child_process");
const workspace_1 = require("./workspace");
const device_auth_1 = require("./device-auth");
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
        const timer = setTimeout(() => { child.kill(); settle({ ok: false, message: "Activation timed out." }); }, 60000);
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
    const entitlement = await checkEntitlement();
    if (!entitlement.allowed)
        throw new Error(entitlement.message || "An active paid minitok plan is required.");
    return entitlement;
}
function checkEntitlement() {
    const now = Date.now();
    // The admin bypass is async (secret storage read), so it resolves before the
    // CLI spawn: an admin session authorizes every gated command without a plan.
    return isAdminSessionActive().then(admin => new Promise(resolve => {
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
        const settle = (state) => { if (settled)
            return; settled = true; cachedDecision = { at: Date.now(), state }; resolve(state); };
        const spec = (0, workspace_1.spawnSpec)((0, workspace_1.cliPath)(), ["status", "--json"]);
        let child;
        try {
            child = (0, node_child_process_1.spawn)(spec.command, spec.args, (0, workspace_1.spawnOptionsFor)(spec, { cwd: (0, workspace_1.workspacePath)() }));
        }
        catch (error) {
            settle({ checked: true, allowed: false, message: error instanceof Error ? error.message : String(error) });
            return;
        }
        let stdout = "";
        let stderr = "";
        const timer = setTimeout(() => { child.kill(); settle({ checked: true, allowed: false, message: "Entitlement check timed out" }); }, 30000);
        child.stdout.on("data", chunk => { stdout = (0, workspace_1.appendBoundedOutput)(stdout, chunk.toString()); });
        child.stderr.on("data", chunk => { stderr = (0, workspace_1.appendBoundedOutput)(stderr, chunk.toString()); });
        child.on("error", error => { clearTimeout(timer); settle({ checked: true, allowed: false, message: stderr || error.message }); });
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
    }));
}
