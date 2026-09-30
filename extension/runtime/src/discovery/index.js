"use strict";

const fs = require("fs");
const path = require("path");
const { WorkspaceManager } = require("../workspace/manager");
const { loadConfig, resolveProviderName } = require("../config/loader");
const { normalizeProvider } = require("../auth/aliases");
const { TokenStore } = require("../auth/token-store");
const { verifyCredentials } = require("../llm/provider");

const PROJECT_MARKERS = [".git", "package.json", "pyproject.toml", "setup.py", "Cargo.toml", "go.mod", "pom.xml", "build.gradle", "pubspec.yaml", "composer.json"];
const BUILTIN_PROVIDERS = ["anthropic", "openai", "google"];
const ENV_BY_PROVIDER = { anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY", google: "GOOGLE_API_KEY", gemini: "GEMINI_API_KEY" };

function realDirectory(value) {
  const resolved = path.resolve(value || process.cwd());
  try {
    const real = fs.realpathSync.native(resolved);
    if (!fs.statSync(real).isDirectory()) throw new Error("not a directory");
    return real;
  } catch (error) {
    throw Object.assign(new Error(`Workspace path is not a readable directory: ${resolved}`), { code: "WORKSPACE_NOT_FOUND", cause: error });
  }
}

function isUnder(child, parent) {
  const c = path.resolve(child);
  const p = path.resolve(parent);
  return c === p || c.startsWith(p + path.sep);
}

function hasMarker(directory) {
  return PROJECT_MARKERS.some(marker => fs.existsSync(path.join(directory, marker)));
}

function projectType(directory) {
  if (fs.existsSync(path.join(directory, "package.json"))) return "node";
  if (["pyproject.toml", "setup.py"].some(name => fs.existsSync(path.join(directory, name)))) return "python";
  if (fs.existsSync(path.join(directory, "Cargo.toml"))) return "rust";
  if (fs.existsSync(path.join(directory, "go.mod"))) return "go";
  if (["pom.xml", "build.gradle"].some(name => fs.existsSync(path.join(directory, name)))) return "java";
  return "generic";
}

function markerCandidates(cwd) {
  const candidates = [];
  let current = realDirectory(cwd);
  while (true) {
    if (hasMarker(current)) {
      candidates.push({ name: path.basename(current) || current, repository_root: current, workspace_directory: path.join(current, ".minitok"), project_type: projectType(current), source: "filesystem" });
      // A Git root is authoritative. Do not turn package markers in its parents
      // into additional candidates.
      if (fs.existsSync(path.join(current, ".git"))) break;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return candidates;
}

function uniqueCandidates(candidates) {
  const byRoot = new Map();
  for (const candidate of candidates) {
    const root = path.resolve(candidate.repository_root);
    const existing = byRoot.get(root);
    if (!existing || candidate.source === "registered") byRoot.set(root, { ...candidate, repository_root: root });
  }
  return [...byRoot.values()];
}

function discoverWorkspace(options = {}) {
  const manager = options.manager || new WorkspaceManager(options.minitokHome);
  if (options.explicitName) {
    const workspace = manager.get(options.explicitName);
    const selected = { ...workspace, source: "explicit-name" };
    return { status: "selected", candidates: [selected], selected, reason: "explicit workspace name" };
  }
  if (options.explicitRepo) {
    const root = realDirectory(options.explicitRepo);
    const registered = Object.values(manager.listAll()).find(ws => {
      try { return fs.realpathSync.native(ws.repository_root) === root; } catch { return false; }
    });
    const selected = registered ? { ...registered, source: "explicit-repo" } : { name: path.basename(root) || root, repository_root: root, workspace_directory: path.join(root, ".minitok"), project_type: projectType(root), last_used: null, source: "explicit-repo" };
    return { status: "selected", candidates: [selected], selected, reason: "explicit repository path" };
  }
  const cwd = realDirectory(options.cwd || process.cwd());
  const registered = Object.values(manager.listAll()).flatMap(ws => {
    try { const root = fs.realpathSync.native(ws.repository_root); return isUnder(cwd, root) ? [{ ...ws, repository_root: root, source: "registered" }] : []; } catch { return []; }
  });
  let candidates = uniqueCandidates([...registered, ...markerCandidates(cwd)]);
  if (!candidates.length) {
    const current = manager.currentWorkspace();
    if (current) candidates = [{ ...current, source: "current" }];
    else if (Object.values(manager.listAll()).length === 1) candidates = [{ ...Object.values(manager.listAll())[0], source: "single-registered" }];
  }
  if (candidates.length === 1) return { status: "candidate", candidates, selected: candidates[0], reason: "one workspace candidate found" };
  if (candidates.length > 1) return { status: "approval_required", candidates, selected: null, reason: "multiple workspace candidates found; user selection is required" };
  return { status: "unavailable", candidates: [], selected: null, reason: "no repository marker or registered workspace found" };
}


function tokenStatus(provider, tokenStore) {
  try {
    const token = tokenStore.load(provider);
    if (!token || !token.access_token) return null;
    const expiresAt = token.expires_at || null;
    const expired = expiresAt ? Date.now() >= new Date(expiresAt).getTime() - 60000 : false;
    return { source: "token-store", authenticated: !expired, expired, expires_at: expiresAt };
  } catch { return null; }
}

function envCredential(provider, config) {
  const auth = config?.auth;
  if (auth?.type === "none") return { source: "none", authenticated: true, expired: false, expires_at: null };
  const configuredEnv = typeof config?.api_key_env === "string" ? config.api_key_env : "";
  const authKey = typeof auth?.key === "string" ? auth.key : "";
  const authEnv = authKey.match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/)?.[1] || "";
  const envName = configuredEnv || authEnv || ENV_BY_PROVIDER[provider] || "";
  if (envName && process.env[envName]) return { source: "environment", authenticated: true, expired: false, expires_at: null };
  if (config?.api_key || (authKey && !authEnv)) return { source: "configuration", authenticated: true, expired: false, expires_at: null };
  if (auth?.type === "service_account" && process.env.GOOGLE_APPLICATION_CREDENTIALS && fs.existsSync(process.env.GOOGLE_APPLICATION_CREDENTIALS)) return { source: "service-account", authenticated: true, expired: false, expires_at: null };
  return null;
}

function providerConfigFor(config, canonical) {
  return Object.entries(config?.providers || {}).find(([name]) => normalizeProvider(name) === canonical)?.[1] || {};
}

async function discoverProviders(options = {}) {
  const config = options.config || loadConfig(options.repoRoot ? path.join(options.repoRoot, "minitok.yml") : undefined, { repoRoot: options.repoRoot });
  const tokenStore = options.tokenStore || new TokenStore(options.tokensDir);
  const configured = Object.keys(config.providers || {}).map(normalizeProvider);
  const tokenProviders = tokenStore.list().map(item => normalizeProvider(item.provider));
  const names = [...new Set([...configured, ...BUILTIN_PROVIDERS, ...tokenProviders])];
  const candidates = [];
  for (const name of names) {
    const providerConfig = providerConfigFor(config, name);
    const credential = envCredential(name, providerConfig) || tokenStatus(name, tokenStore);
    const role = Object.keys(config.roles || {}).find(key => normalizeProvider(resolveProviderName(config, key)) === name) || null;
    const health = options.verify && credential?.authenticated ? (await verifyCredentials(name, providerConfig)).status : "not_checked";
    candidates.push({ provider: name, canonical_name: name, configured: configured.includes(name), selected_by_config: normalizeProvider(config.default_provider || "") === name || Boolean(role), authenticated: Boolean(credential?.authenticated), source: credential?.source || null, expired: credential?.expired || false, expires_at: credential?.expires_at || null, health, role });
  }
  const authenticated = candidates.filter(candidate => candidate.authenticated && (!options.verify || ["ok", "skipped", "not_checked"].includes(candidate.health)));
  let status = "unavailable", selected = null, reason = "no authenticated provider was found";
  if (options.explicitProvider) {
    const name = normalizeProvider(options.explicitProvider);
    selected = candidates.find(candidate => candidate.provider === name) || { provider: name, canonical_name: name, authenticated: false, configured: false, source: null, expired: false, expires_at: null, health: "not_checked", role: null };
    status = selected.authenticated ? "selected" : "unavailable";
    reason = selected.authenticated ? "explicit provider override" : `provider '${name}' is not authenticated`;
  } else if (authenticated.length === 1) { status = "candidate"; selected = authenticated[0]; reason = "exactly one authenticated provider was found"; }
  else if (authenticated.length > 1) { status = "approval_required"; reason = "multiple authenticated providers found; user approval is required"; }
  return { status, candidates, selected, reason, authenticated_count: authenticated.length, verify: options.verify === true };
}

async function discover(options = {}) {
  const workspace = discoverWorkspace(options);
  const repoRoot = workspace.selected?.repository_root || options.repoRoot || null;
  let providers;
  try { providers = await discoverProviders({ ...options, repoRoot }); }
  catch (error) { providers = { status: "unavailable", candidates: [], selected: null, reason: `provider discovery failed: ${error.message}`, authenticated_count: 0, verify: options.verify === true }; }
  return { schema_version: 1, workspace, providers };
}

module.exports = { PROJECT_MARKERS, BUILTIN_PROVIDERS, discover, discoverWorkspace, discoverProviders, markerCandidates, realDirectory, tokenStatus, envCredential, providerConfigFor };
