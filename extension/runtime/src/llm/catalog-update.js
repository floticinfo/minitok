"use strict";

/**
 * Online catalog updater ??refreshes the curated model catalog from the
 * minitok GitHub repository once per day and overlays it on the built-in
 * CATALOG so shipped binaries see new provider models without a release.
 *
 * Resolution order: built-in CATALOG -> cached remote (24 h TTL) -> fresh
 * remote merge of two public, key-free sources:
 *   - OpenRouter /api/v1/models (current model ids per vendor)
 *   - LiteLLM model_prices_and_context_window.json (context/output specs)
 * A legacy repo-root catalog.json remains the last-resort fallback:
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
const OPENROUTER_URL = "https://openrouter.ai/api/v1/models";
const LITELLM_URL = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const TTL_MS = 24 * 60 * 60 * 1000; // daily refresh
const MAX_BYTES = 4 * 1024 * 1024; // litellm doc is ~2 MB
const VENDORS = ["anthropic", "openai", "google"];

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
    const merged = await fetchOpenRouterAndLiteLLM(fetchWithTimeout, readCappedResponse);
    if (merged) return merged;
  } catch { /* fall through to legacy repo catalog */ }
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

/** Strip an OpenRouter vendor prefix ("openai/gpt-5" -> "gpt-5"). */
function stripVendorPrefix(id) {
  const slash = id.indexOf("/");
  return slash > 0 ? id.slice(slash + 1) : id;
}

/** OpenRouter ids worth showing: chat models only, no :batch/:free variants. */
function isChatModelId(id) {
  if (/:(batch|free|online|nano-round)$/.test(id)) return false;
  if (/(embed|whisper|tts|rerank|image|guard|moderation|deepseek-r1-distill)/i.test(id)) return false;
  return true;
}

async function fetchOpenRouterAndLiteLLM(fetchWithTimeout, readCappedResponse) {
  const headers = { "User-Agent": "minitok-catalog-updater" };
  // Ids first: OpenRouter is authoritative for "what exists right now".
  const orRes = await fetchWithTimeout(OPENROUTER_URL, { headers }, 10000);
  if (!orRes.ok) return null;
  const orData = JSON.parse(await readCappedResponse(orRes, MAX_BYTES));
  const ids = new Map(); // provider -> Set(id)
  for (const m of (orData && Array.isArray(orData.data) ? orData.data : [])) {
    if (!m || typeof m.id !== "string") continue;
    const bare = stripVendorPrefix(m.id).toLowerCase();
    if (!isChatModelId(bare)) continue;
    const provider = String(m.id).slice(0, String(m.id).indexOf("/")).toLowerCase();
    if (!VENDORS.includes(provider)) continue;
    if (!ids.has(provider)) ids.set(provider, new Set());
    ids.get(provider).add(bare);
  }
  if (!ids.size) return null;
  // Specs second: LiteLLM has max_input_tokens/max_output_tokens per model.
  const specs = new Map();
  try {
    const llRes = await fetchWithTimeout(LITELLM_URL, { headers }, 15000);
    if (llRes.ok) {
      const llData = JSON.parse(await readCappedResponse(llRes, MAX_BYTES));
      if (llData && typeof llData === "object") {
        for (const [key, v] of Object.entries(llData)) {
          if (!v || typeof v !== "object") continue;
          if (v.mode && v.mode !== "chat") continue; // drop embeddings/audio/image
          specs.set(key.toLowerCase(), {
            context_window: Number.isFinite(v.max_input_tokens) ? v.max_input_tokens : undefined,
            max_output: Number.isFinite(v.max_output_tokens) ? v.max_output_tokens : undefined,
            release_date: typeof v.release_date === "string" ? v.release_date : undefined,
          });
        }
      }
    }
  } catch { /* specs are best-effort; ids alone still produce a catalog */ }
  const models = [];
  for (const [provider, set] of ids) {
    for (const id of set) {
      const spec = specs.get(id) || {};
      const context = Number.isFinite(spec.context_window) && spec.context_window > 0 ? spec.context_window : 128000;
      models.push({
        id,
        display: id,
        provider,
        tier: "custom",
        context_window: context,
        max_output: Number.isFinite(spec.max_output) && spec.max_output > 0 ? spec.max_output : null,
        release_date: typeof spec.release_date === "string" ? spec.release_date : null,
        reasoning: { supported: false },
      });
    }
  }
  return { models, updated_at: new Date().toISOString().slice(0, 10) };
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
  for (const m of cache.models) {
    const builtin = byId.get(m.id);
    if (!builtin) { byId.set(m.id, m); continue; }
    // Same id: merge instead of replace. The remote sources only know
    // context/output specs, so curated metadata (reasoning, tier, display)
    // survives; remote wins only where it actually has a value.
    byId.set(m.id, {
      ...builtin,
      ...m,
      display: builtin.display || m.display,
      tier: builtin.tier,
      context_window: Number.isFinite(m.context_window) && m.context_window > 0 ? m.context_window : builtin.context_window,
      max_output: Number.isFinite(m.max_output) && m.max_output > 0 ? m.max_output : builtin.max_output,
      release_date: m.release_date || builtin.release_date,
      reasoning: builtin.reasoning && builtin.reasoning.supported ? builtin.reasoning : m.reasoning,
    });
  }
  return { models: [...byId.values()], updated_at: cache.updated_at };
}

module.exports = { ensureFreshCatalog, getCatalog, catalogDir, cachePath, CATALOG_URL, TTL_MS };
