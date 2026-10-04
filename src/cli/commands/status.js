"use strict";

const { WorkspaceManager } = require("../../workspace/manager");
const { loadConfig, resolveProviderName } = require("../../config/loader");
const { detectAvailableProviders } = require("../../llm/provider");
const { minitokVersion } = require("../../core/version");
const git = require("../../git/operations");
const path = require("path");
const { EntitlementCache } = require("../../entitlement/cache");
const client = require("../../entitlement/client");
const { resolveServerUrl } = require("./server-config");


/**
 * Resolve entitlement state from the server (or offline cache fallback).
 * Returns { active, plan, expires_at, source } where source is "server"|"cache"|"none".
 */
async function _resolveEntitlement(options = {}) {
  const serverUrl = resolveServerUrl({ cliServer: options.server });
  const cache = new EntitlementCache();
  const cached = cache.load({ allowStale: true });

  if (!cached || !cached.token) {
    return { active: false, plan: null, expires_at: null, source: "none", serverUrl };
  }

  // Try the server first.
  try {
    const result = await client.status(cached.token, { serverUrl });
    if (result.ok && result.body) {
      return { active: result.body.active === true, plan: result.body.plan || null, expires_at: result.body.expires_at || null, source: "server", serverUrl };
    }
    if (result.status === 401 || result.status === 403) {
      // Token invalid/revoked — clear the cache so we stop trying.
      cache.clear();
      return { active: false, plan: null, expires_at: null, source: "server", serverUrl };
    }
  } catch {
    // Server unreachable — fall through to cache.
  }

  // Offline fallback: use the cached payload if not expired.
  if (cached.payload && cached.payload.exp) {
    const expired = Date.now() >= cached.payload.exp * 1000;
    if (!expired) {
      return { active: true, plan: cached.payload.plan || null, expires_at: cached.expires_at || null, source: "cache", serverUrl, stale: cached.stale };
    }
  }
  return { active: false, plan: null, expires_at: null, source: "cache", serverUrl };
}

async function cmdStatusHuman(options = {}) {
  console.log(`minitok ${minitokVersion}\n`);

  // --- Entitlement section ---
  try {
    const ent = await _resolveEntitlement(options);
    if (ent.active) {
      console.log("Entitlement: ACTIVE");
    } else {
      console.log("Entitlement: INACTIVE");
    }
    if (ent.plan) console.log(`  Plan:       ${ent.plan}`);
    if (ent.expires_at) console.log(`  Expires:    ${ent.expires_at}`);
    if (ent.source === "cache") console.log(`  Source:     local cache (server unreachable)`);
    console.log(`  Server:     ${ent.serverUrl}`);
    console.log("");
  } catch {
    console.log("Entitlement: UNKNOWN (error reading entitlement)\n");
  }

  // --- Workspace section ---
  let wm;
  let ws;
  try {
    // Registry parsing happens in the constructor, so construct the manager inside
    // the same recovery boundary as workspace resolution. Human status should print
    // a useful diagnostic instead of throwing before it can explain the failure.
    wm = new WorkspaceManager(options.workspaceManagerHome);
    ws = options.repo ? { name: path.basename(path.resolve(options.repo)), repository_root: path.resolve(options.repo), project_type: "repository", last_used: null } : options.workspace ? wm.resolve(options.workspace) : wm.currentWorkspace();
  } catch (error) {
    console.error(`Workspace error: ${error.message}`);
    console.error("Recovery: repair or remove ~/.minitok/workspaces.json, then run `minitok workspace add .`.");
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

  const configPath = path.join(ws.repository_root, "minitok.yml");
  let config;
  try {
    config = loadConfig(configPath);
  } catch (error) {
    console.error(`Config error: ${error.message}`);
    console.error(`Recovery: repair or remove ${configPath}, then run \`minitok migrate\`.`);
    return 1;
  }
  const providers = await detectAvailableProviders(config);
  console.log(`\nProviders: ${providers.length > 0 ? providers.join(", ") : "none detected"}`);
  console.log(`Config:    ${require("fs").existsSync(configPath) ? configPath : "missing — run: minitok migrate"}`);
  console.log(`Roles:`);
  for (const [role, roleConfig] of Object.entries(config.roles)) {
    const resolved = resolveProviderName(config, role) || "unset";
    const model = roleConfig.model || config.model || "";
    console.log(`  ${role.padEnd(8)} → ${resolved}${model ? ` (${model})` : ""}`);
  }

  return 0;
}

async function cmdStatus(options = {}) {
  if (options.json) {
    // Construct the manager inside the guarded section: a malformed registry is
    // itself a diagnostic condition and must not prevent status --json from
    // returning machine-readable output.
    let ws = null;
    let workspace = null;
    let workspaceError = null;
    try { ws = new WorkspaceManager(options.workspaceManagerHome); } catch (error) { workspaceError = error.message; }
    // The human path below reports an unreadable registry as a message and keeps
    // going; the JSON path used to re-throw, so a script asking for
    // machine-readable status got a stack trace (or empty stdout) exactly when the
    // diagnostic mattered. Every section now degrades to a reported value.
    try {
      workspace = options.repo
        ? { name: path.basename(path.resolve(options.repo)), repository_root: path.resolve(options.repo), project_type: "repository", last_used: null }
        : ws
          ? (options.workspace ? ws.resolve(options.workspace) : ws.currentWorkspace())
          : null;
    } catch (error) {
      workspaceError = error.message;
    }
    let ent;
    try {
      ent = await _resolveEntitlement(options);
    } catch (error) {
      ent = { active: false, plan: null, expires_at: null, source: "error", serverUrl: resolveServerUrl({ cliServer: options.server }), error: error.message };
    }
    let config = null;
    let configError = null;
    const configPath = workspace ? path.join(workspace.repository_root, "minitok.yml") : null;
    if (workspace) {
      try { config = loadConfig(configPath); } catch (error) { configError = error.message; }
    }
    const providers = config ? await detectAvailableProviders(config) : [];
    return { version: minitokVersion, server: ent.serverUrl, entitlement: { state: ent.active ? "ACTIVE" : "INACTIVE", allowed: ent.active, plan: ent.plan || null, expires_at: ent.expires_at || null, source: ent.source, ...(ent.error ? { error: ent.error } : {}) }, workspace, ...(workspaceError ? { workspace_error: workspaceError } : {}), ...(configError ? { config_error: { path: configPath, message: configError } } : {}), providers, roles: config ? Object.fromEntries(Object.entries(config.roles).map(([role, roleConfig]) => [role, { provider: resolveProviderName(config, role) || null, model: roleConfig.model || config.model || null }])) : {} };
  }
  return cmdStatusHuman(options);
}

module.exports = { cmdStatus };
