"use strict";

/**
 * Online catalog updater ??refreshes the curated model catalog from the
 * minitok GitHub repository once per day and overlays it on the built-in
 * CATALOG so shipped binaries see new provider models without a release.
 *
 * Resolution order: built-in CATALOG -> cached remote (24 h TTL) -> fresh
 * remote fetch from CATALOG_URL. Remote doc is repo-root catalog.json:
 *   { "version": <int>, "updated_at": "YYYY-MM-DD", "models": [...] }
 * Entries use the same schema as CATALOG in ./models.js. Remote entries with
 * a matching id override built-ins; new ids append. Built-ins are never
 * removed. `offline: true` config and any failure fall back silently.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");

const CATALOG_URL = process.env.MINITOK_CATALOG_URL ||
  "https://raw.githubusercontent.com/floticinfo/minitok/master/catalog.json";
const TTL_MS = 24 * 60 * 60 * 1000; // daily refresh
const MAX_BYTES = 1024 * 1024;

function catalogDir() {
  const xdg = String(process.env.XDG_CONFIG_HOME || "").trim();
  if (xdg) return path.join(xdg, "minitok");
  if (process.platform === "win32" && process.env.APPDATA) return path.join(process.env.APPDATA, "minitok");
  return path.join(os.homedir(), ".config", "minitok");
}

function cachePath() {
  return path.join(catalogDir(), "catalog-cache.json");
}

function validEntry(m) {
  if (!m || typeof m !== "object" || Array.isArray(m)) return false;
  if (typeof m.id !== "string" || !m.id.trim()) return false;
  if (typeof m.provider !== "string" || !m.provider.trim()) return false;
  if (m.context_window !== undefined && !(Number.isFinite(m.context_window) && m.context_window > 0)) return false;
  if (m.max_output !== undefined && m.max_output !== null && !(Number.isFinite(m.max_output) && m.max_output > 0)) return false;
  if (m.tier !== undefined && typeof m.tier !== "string") return false;
  return true;
}

function normalizeEntry(m) {
  return {
    id: m.id.trim(),
    display: typeof m.display === "string" && m.display.trim() ? m.display.trim() : m.id.trim(),
    provider: m.provider.trim().toLowerCase(),
    tier: typeof m.tier === "string" ? m.tier : "custom",
    context_window: Number.isFinite(m.context_window) ? m.context_window : 128000,
    max_output: Number.isFinite(m.max_output) ? m.max_output : null,
    release_date: typeof m.release_date === "string" ? m.release_date : null,
    reasoning: m.reasoning && typeof m.reasoning === "object"
      ? { supported: m.reasoning.supported === true, ...(m.reasoning.param ? { param: m.reasoning.param } : {}), ...(Array.isArray(m.reasoning.values) ? { values: m.reasoning.values } : {}), ...(m.reasoning.effort_param ? { effort_param: m.reasoning.effort_param } : {}), ...(Array.isArray(m.reasoning.effort_values) ? { effort_values: m.reasoning.effort_values } : {}) }
      : { supported: false },
  };
}

function readCache() {
  try {
    const raw = fs.readFileSync(cachePath(), "utf8");
    const data = JSON.parse(raw);
    if (!data || !Array.isArray(data.models) || !Number.isFinite(data.fetched_at)) return null;
    const models = data.models.filter(validEntry).map(normalizeEntry);
    if (models.length === 0) return null;
    return { models, fetched_at: data.fetched_at, updated_at: typeof data.updated_at === "string" ? data.updated_at : null };
  } catch { return null; }
}

function writeCache(models, updated_at) {
  try {
    fs.mkdirSync(catalogDir(), { recursive: true });
    fs.writeFileSync(cachePath(), JSON.stringify({ fetched_at: Date.now(), updated_at, models }), "utf8");
  } catch { /* cache is best-effort */ }
}

async function fetchRemoteCatalog() {
  const { fetchWithTimeout, readCappedResponse } = require("../core/http");
  try {
    const res = await fetchWithTimeout(CATALOG_URL, { headers: { "User-Agent": "minitok-catalog-updater" } }, 10000);
    if (!res.ok) return null;
    const raw = await readCappedResponse(res, MAX_BYTES);
    const data = JSON.parse(raw);
    if (!data || !Array.isArray(data.models)) return null;
    const models = data.models.filter(validEntry).map(normalizeEntry);
    if (models.length === 0) return null;
    return { models, updated_at: typeof data.updated_at === "string" ? data.updated_at : null };
  } catch { return null; }
}

/**
 * Refresh the cache once per day. Fresh cache => no-op; otherwise fetch the
 * remote catalog. Never throws ??offline configs keep built-ins, failures
 * keep the previous cache.
 * @param {{ offline?: boolean }} [config]
 * @returns {Promise<{ updated: boolean, source: string, updated_at: string|null }>}
 */
async function ensureFreshCatalog(config) {
  if (config && config.offline === true) return { updated: false, source: "offline", updated_at: null };
  const cache = readCache();
  if (cache && Date.now() - cache.fetched_at < TTL_MS) {
    return { updated: false, source: "cache", updated_at: cache.updated_at };
  }
  const remote = await fetchRemoteCatalog();
  if (remote) {
    writeCache(remote.models, remote.updated_at);
    return { updated: true, source: "remote", updated_at: remote.updated_at };
  }
  if (cache) return { updated: false, source: "cache", updated_at: cache.updated_at };
  return { updated: false, source: "builtin", updated_at: null };
}

/**
 * Effective catalog: built-ins overlaid with cached/remote entries (remote
 * wins on id collision, new ids append). Never mutates the built-in array.
 * @param {Array} builtinCatalog - CATALOG from ./models.js
 * @returns {{ models: Array, updated_at: string|null }}
 */
function getCatalog(builtinCatalog) {
  const cache = readCache();
  if (!cache) return { models: [...builtinCatalog], updated_at: null };
  const byId = new Map(builtinCatalog.map(m => [m.id, m]));
  for (const m of cache.models) byId.set(m.id, m);
  return { models: [...byId.values()], updated_at: cache.updated_at };
}

module.exports = { ensureFreshCatalog, getCatalog, catalogDir, cachePath, CATALOG_URL, TTL_MS };
