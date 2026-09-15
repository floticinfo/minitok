"use strict";

const { WorkspaceManager } = require("../../workspace/manager");
const { loadConfig, resolveProviderName } = require("../../config/loader");
const { detectAvailableProviders } = require("../../llm/provider");
const { minitokVersion } = require("../../core/version");
const git = require("../../git/operations");
const path = require("path");
const { authorizeEntitlement } = require("../../entitlement/policy");
const { resolveServerUrl } = require("./server-config");
const { EvolutionOptIn } = require("../../evolution/optin");

async function cmdStatusHuman(options = {}) {
  console.log(`minitok ${minitokVersion}\n`);

  // --- Entitlement section ---
  try {
    const gate = await authorizeEntitlement({ serverUrl: resolveServerUrl({ cliServer: options.server }) });
    console.log(`Entitlement: ${gate.state}`);
    // checkEntitlement returns the verified payload directly on gate.entitlement.
    const payload = gate.entitlement && gate.entitlement.payload ? gate.entitlement.payload : gate.entitlement;
    if (payload) {
      if (payload.plan_id) console.log(`  Plan:       ${payload.plan_id}`);
      if (payload.expires_at) console.log(`  Expires:    ${payload.expires_at}`);
      if (payload.max_devices) console.log(`  Max Devices: ${payload.max_devices}`);
    }
    if (gate.graceDaysRemaining) {
      console.log(`  Grace:      ${gate.graceDaysRemaining} day(s) remaining`);
    }
    console.log(`  Server:     ${resolveServerUrl({ cliServer: options.server })}`);
    // M11: Evolution upload status
    try {
      const evoOptIn = new EvolutionOptIn();
      const evoEnabled = evoOptIn.isEnabled();
      const hasFeature = gate.entitlement?.features?.includes("evolution_upload") || false;
      if (evoEnabled && hasFeature) {
        console.log(`  Evolution:  upload ENABLED`);
      } else if (evoEnabled && !hasFeature) {
        console.log(`  Evolution:  opt-in ON but feature unavailable`);
      } else {
        console.log(`  Evolution:  upload OFF (local evolution active)`);
      }
    } catch {
      console.log(`  Evolution:  upload OFF`);
    }
    console.log("");
  } catch {
    console.log("Entitlement: UNKNOWN (error reading entitlement)\n");
  }

  // --- Workspace section ---
  const wm = new WorkspaceManager();
  let ws;
  try {
    ws = options.repo ? { name: path.basename(path.resolve(options.repo)), repository_root: path.resolve(options.repo), project_type: "repository", last_used: null } : options.workspace ? wm.resolve(options.workspace) : wm.currentWorkspace();
  } catch (error) {
    console.error(`Workspace error: ${error.message}`);
    return 1;
  }

  if (!ws) {
    console.log("No workspace set.\nRun: minitok workspace add .");
    return 0;
  }

  console.log(`Workspace:  ${ws.name}`);
  console.log(`Repository: ${ws.repository_root}`);
  console.log(`Type:       ${ws.project_type}`);
  console.log(`Last used:  ${ws.last_used || "never"}`);

  if (git.isGitRepo(ws.repository_root)) {
    console.log(`\nGit:`);
    console.log(`  Branch:   ${git.currentBranch(ws.repository_root) || "detached"}`);
    console.log(`  Commit:   ${git.headCommit(ws.repository_root) || "unknown"}`);
    console.log(`  Files:    ${git.fileCount(ws.repository_root)}`);
    const statusOutput = git.status(ws.repository_root);
    if (statusOutput) {
      const lines = statusOutput.split("\n").filter(Boolean);
      console.log(`  Changes:  ${lines.length} uncommitted`);
    } else {
      console.log(`  Changes:  clean`);
    }
  }

  const config = loadConfig(path.join(ws.repository_root, "minitok.yml"));
  const providers = await detectAvailableProviders(config);
  console.log(`\nProviders: ${providers.length > 0 ? providers.join(", ") : "none detected"}`);
  const configPath = path.join(ws.repository_root, "minitok.yml");
  console.log(`Config:    ${require("fs").existsSync(configPath) ? configPath : "missing — run: minitok migrate"}`);
  console.log(`Roles:`);
  for (const [role] of Object.entries(config.roles)) {
    console.log(`  ${role.padEnd(8)} → ${resolveProviderName(config, role) || "unset"}`);
  }

  return 0;
}

async function cmdStatus(options = {}) {
  if (options.json) {
    const ws = new WorkspaceManager();
    let workspace = null;
    let workspaceError = null;
    // The human path below reports an unreadable registry as a message and keeps
    // going; the JSON path used to re-throw, so a script asking for
    // machine-readable status got a stack trace (or empty stdout) exactly when the
    // diagnostic mattered. Every section now degrades to a reported value.
    try {
      workspace = options.repo ? { name: path.basename(path.resolve(options.repo)), repository_root: path.resolve(options.repo), project_type: "repository", last_used: null } : options.workspace ? ws.resolve(options.workspace) : ws.currentWorkspace();
    } catch (error) {
      workspaceError = error.message;
    }
    let gate;
    try {
      gate = await authorizeEntitlement({ serverUrl: resolveServerUrl({ cliServer: options.server }) });
    } catch (error) {
      gate = { state: "UNKNOWN", allowed: false, entitlement: null, error: error.message };
    }
    let config = null;
    let configError = null;
    const configPath = workspace ? path.join(workspace.repository_root, "minitok.yml") : null;
    if (workspace) {
      try { config = loadConfig(configPath); } catch (error) { configError = error.message; }
    }
    const providers = config ? await detectAvailableProviders(config) : [];
    const payload = gate.entitlement?.payload || gate.entitlement;
    return { version: minitokVersion, server: resolveServerUrl({ cliServer: options.server }), entitlement: { state: gate.state, allowed: gate.allowed === true, plan: payload?.plan_id || null, expires_at: payload?.expires_at || null, ...(gate.error ? { error: gate.error } : {}) }, workspace, ...(workspaceError ? { workspace_error: workspaceError } : {}), ...(configError ? { config_error: { path: configPath, message: configError } } : {}), providers, roles: config ? Object.fromEntries(Object.keys(config.roles).map(role => [role, resolveProviderName(config, role) || null])) : {} };
  }
  return cmdStatusHuman(options);
}

module.exports = { cmdStatus };
