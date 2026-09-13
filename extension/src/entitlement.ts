import { spawn } from "node:child_process";
import { cliPath, workspacePath, requireTrustedWorkspace, spawnSpec, spawnOptionsFor } from "./workspace";

export type EntitlementState = { checked: boolean; allowed: boolean; plan?: string | null; message?: string };

export async function requireEntitlement(): Promise<EntitlementState> {
  const entitlement = await checkEntitlement();
  if (!entitlement.allowed) throw new Error(entitlement.message || "An active paid minitok plan is required.");
  return entitlement;
}

export function checkEntitlement(): Promise<EntitlementState> {
  return new Promise(resolve => {
    try { requireTrustedWorkspace(workspacePath()); } catch (error) { resolve({ checked: true, allowed: false, message: error instanceof Error ? error.message : String(error) }); return; }
    const spec = spawnSpec(cliPath(), ["status", "--json"]);
    const child = spawn(spec.command, spec.args, spawnOptionsFor(spec, { cwd: workspacePath() }));
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => { child.kill(); resolve({ checked: true, allowed: false, message: "Entitlement check timed out" }); }, 30000);
    child.stdout.on("data", chunk => { stdout += chunk.toString(); });
    child.stderr.on("data", chunk => { stderr += chunk.toString(); });
    child.on("error", error => { clearTimeout(timer); resolve({ checked: true, allowed: false, message: stderr || error.message }); });
    child.on("close", code => {
      clearTimeout(timer);
      if (code !== 0) { resolve({ checked: true, allowed: false, message: stderr || `minitok exited with code ${code}` }); return; }
      try {
        const result = JSON.parse(stdout);
        const entitlement = result.entitlement || {};
        const allowed = entitlement.allowed === true && typeof entitlement.plan === "string" && entitlement.plan.length > 0;
        resolve({ checked: true, allowed, plan: entitlement.plan || null, message: allowed ? undefined : "An active paid minitok plan is required." });
      } catch (parseError) {
        resolve({ checked: true, allowed: false, message: `Could not verify minitok entitlement: ${parseError instanceof Error ? parseError.message : String(parseError)}` });
      }
    });
  });
}
