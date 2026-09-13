"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.invalidateEntitlementCache = invalidateEntitlementCache;
exports.requireEntitlement = requireEntitlement;
exports.checkEntitlement = checkEntitlement;
const node_child_process_1 = require("node:child_process");
const workspace_1 = require("./workspace");
// Every check spawns the CLI and pays a Node start plus the entitlement lookup.
// Activation, each sidebar command, and the panel all asked the same question, so
// one session spawned several identical processes. A granted decision is reused
// for a minute, a denial for ten seconds so a fixed plan is picked up quickly.
const ALLOWED_CACHE_MS = 60_000;
const DENIED_CACHE_MS = 10_000;
let cachedDecision;
/** Drop the cached decision after a login, a logout, or a plan change. */
function invalidateEntitlementCache() {
    cachedDecision = undefined;
}
async function requireEntitlement() {
    const entitlement = await checkEntitlement();
    if (!entitlement.allowed)
        throw new Error(entitlement.message || "An active paid minitok plan is required.");
    return entitlement;
}
function checkEntitlement() {
    const now = Date.now();
    if (cachedDecision && now - cachedDecision.at < (cachedDecision.state.allowed ? ALLOWED_CACHE_MS : DENIED_CACHE_MS)) {
        return Promise.resolve({ ...cachedDecision.state, cached: true });
    }
    return new Promise(resolve => {
        const settle = (state) => { cachedDecision = { at: Date.now(), state }; resolve(state); };
        try {
            (0, workspace_1.requireTrustedWorkspace)((0, workspace_1.workspacePath)());
        }
        catch (error) {
            settle({ checked: true, allowed: false, message: error instanceof Error ? error.message : String(error) });
            return;
        }
        const spec = (0, workspace_1.spawnSpec)((0, workspace_1.cliPath)(), ["status", "--json"]);
        const child = (0, node_child_process_1.spawn)(spec.command, spec.args, (0, workspace_1.spawnOptionsFor)(spec, { cwd: (0, workspace_1.workspacePath)() }));
        let stdout = "";
        let stderr = "";
        const timer = setTimeout(() => { child.kill(); settle({ checked: true, allowed: false, message: "Entitlement check timed out" }); }, 30000);
        child.stdout.on("data", chunk => { stdout += chunk.toString(); });
        child.stderr.on("data", chunk => { stderr += chunk.toString(); });
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
    });
}
