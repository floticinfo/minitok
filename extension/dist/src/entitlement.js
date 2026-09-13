"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.requireEntitlement = requireEntitlement;
exports.checkEntitlement = checkEntitlement;
const node_child_process_1 = require("node:child_process");
const workspace_1 = require("./workspace");
async function requireEntitlement() {
    const entitlement = await checkEntitlement();
    if (!entitlement.allowed)
        throw new Error(entitlement.message || "An active paid minitok plan is required.");
    return entitlement;
}
function checkEntitlement() {
    return new Promise(resolve => {
        try {
            (0, workspace_1.requireTrustedWorkspace)((0, workspace_1.workspacePath)());
        }
        catch (error) {
            resolve({ checked: true, allowed: false, message: error instanceof Error ? error.message : String(error) });
            return;
        }
        const spec = (0, workspace_1.spawnSpec)((0, workspace_1.cliPath)(), ["status", "--json"]);
        const child = (0, node_child_process_1.spawn)(spec.command, spec.args, { cwd: (0, workspace_1.workspacePath)(), shell: spec.shell, windowsHide: true });
        let stdout = "";
        let stderr = "";
        const timer = setTimeout(() => { child.kill(); resolve({ checked: true, allowed: false, message: "Entitlement check timed out" }); }, 30000);
        child.stdout.on("data", chunk => { stdout += chunk.toString(); });
        child.stderr.on("data", chunk => { stderr += chunk.toString(); });
        child.on("error", error => { clearTimeout(timer); resolve({ checked: true, allowed: false, message: stderr || error.message }); });
        child.on("close", code => {
            clearTimeout(timer);
            if (code !== 0) {
                resolve({ checked: true, allowed: false, message: stderr || `minitok exited with code ${code}` });
                return;
            }
            try {
                const result = JSON.parse(stdout);
                const entitlement = result.entitlement || {};
                const allowed = entitlement.allowed === true && typeof entitlement.plan === "string" && entitlement.plan.length > 0;
                resolve({ checked: true, allowed, plan: entitlement.plan || null, message: allowed ? undefined : "An active paid minitok plan is required." });
            }
            catch (parseError) {
                resolve({ checked: true, allowed: false, message: `Could not verify minitok entitlement: ${parseError instanceof Error ? parseError.message : String(parseError)}` });
            }
        });
    });
}
