"use strict";

/**
 * In-memory entitlement store.
 *
 * This is intentionally a plain Map-backed repository so it can be swapped
 * for a real database adapter later without touching the route layer — every
 * method returns a copy of the stored record so callers cannot mutate shared
 * state by accident.
 *
 * Record shape:
 * {
 *   key:            string   — activation key as presented by the client
 *   installationId: string   — UUID generated at first activation
 *   planId:         string   — "level1" | "trial" (see src/entitlement/model.js)
 *   features:       string[] — entitlements granted by the plan
 *   maxDevices:     number
 *   activatedAt:    string   — ISO 8601
 *   expiresAt:      string   — ISO 8601
 *   revokedAt:      string|null — set when the entitlement is revoked
 * }
 */

const PLAN_DEFAULTS = {
  // Mirrors VALID_PLAN_IDS in src/entitlement/model.js.
  level1: { features: ["run", "goal", "mcp"], maxDevices: 3, durationDays: 30 },
  trial: { features: ["run"], maxDevices: 1, durationDays: 14, runQuota: 5 },
};

// Key validation. Production keys come from MINITOK_ACCEPTED_KEYS as a
// comma-separated list, optionally with a plan suffix: "KEY1:level1,KEY2:trial".
// The literal "test" is accepted only when MINITOK_ALLOW_TEST_KEY=true (never
// enable it in production). A real billing backend can replace validateKey
// without touching the route layer.
const ACCEPTED_KEYS = new Map(); // key → planId
for (const entry of String(process.env.MINITOK_ACCEPTED_KEYS || "").split(",")) {
  const trimmed = entry.trim();
  if (!trimmed) continue;
  const colon = trimmed.lastIndexOf(":");
  if (colon > 0 && PLAN_DEFAULTS[trimmed.slice(colon + 1)]) {
    ACCEPTED_KEYS.set(trimmed.slice(0, colon), trimmed.slice(colon + 1));
  } else {
    ACCEPTED_KEYS.set(trimmed, "level1");
  }
}
if (process.env.MINITOK_ALLOW_TEST_KEY === "true") ACCEPTED_KEYS.set("test", "level1");

function validateKey(key) {
  if (typeof key !== "string" || key.trim().length === 0) {
    return { valid: false, reason: "An activation key is required." };
  }
  const trimmed = key.trim();
  const planId = ACCEPTED_KEYS.get(trimmed);
  if (!planId) {
    return { valid: false, reason: "The activation key is not recognized." };
  }
  return { valid: true, key: trimmed, planId };
}

// ── Persistence ────────────────────────────────────────────────────────────
// Set MINITOK_STORE_FILE to persist the store as JSON (e.g. /data/entitlements.json
// mounted into the container). Writes are debounced and atomic (tmp + rename).
// Without it the store is in-memory only — a restart wipes all entitlements.

const fs = require("fs");
const path = require("path");

const STORE_FILE = process.env.MINITOK_STORE_FILE || null;

const store = new Map();

function _loadFromDisk() {
  if (!STORE_FILE) return;
  try {
    const parsed = JSON.parse(fs.readFileSync(STORE_FILE, "utf-8"));
    if (parsed && typeof parsed === "object") {
      for (const [key, record] of Object.entries(parsed)) store.set(key, record);
    }
  } catch (error) {
    if (error.code !== "ENOENT") console.error(`Failed to load entitlement store from ${STORE_FILE}:`, error.message);
  }
}

let _saveTimer = null;
function _saveToDisk() {
  if (!STORE_FILE || _saveTimer) return;
  _saveTimer = setTimeout(() => {
    _saveTimer = null;
    try {
      fs.mkdirSync(path.dirname(STORE_FILE), { recursive: true });
      const tmp = `${STORE_FILE}.tmp.${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(store), null, 2), "utf-8");
      try {
        fs.renameSync(tmp, STORE_FILE);
      } catch (error) {
        // Windows cannot atomically rename over an existing target.
        if (process.platform !== "win32") throw error;
        try { fs.unlinkSync(STORE_FILE); } catch (e) { if (e.code !== "ENOENT") throw e; }
        fs.renameSync(tmp, STORE_FILE);
      }
    } catch (error) {
      console.error(`Failed to persist entitlement store to ${STORE_FILE}:`, error.message);
    }
  }, 100);
  // Keep the process alive semantics unchanged; persist on clean exit too.
  _saveTimer.unref();
}

_loadFromDisk();

function findByKey(key) {
  const record = store.get(key);
  return record ? { ...record } : null;
}

function findByInstallationId(installationId) {
  for (const record of store.values()) {
    if (record.installationId === installationId) return { ...record };
  }
  return null;
}

function create({ key, installationId, planId }) {
  const defaults = PLAN_DEFAULTS[planId] || PLAN_DEFAULTS.level1;
  const now = new Date();
  const expires = new Date(now.getTime() + defaults.durationDays * 86400000);
  const record = {
    key,
    installationId,
    planId,
    features: [...defaults.features],
    maxDevices: defaults.maxDevices,
    activatedAt: now.toISOString(),
    expiresAt: expires.toISOString(),
    revokedAt: null,
    deviceName: null,
    lastSeenAt: null,
  };
  store.set(key, record);
  _saveToDisk();
  return { ...record };
}

function revoke(key) {
  const record = store.get(key);
  if (!record) return null;
  record.revokedAt = new Date().toISOString();
  _saveToDisk();
  return { ...record };
}

function isActive(record) {
  if (!record) return false;
  if (record.revokedAt) return false;
  return new Date(record.expiresAt).getTime() > Date.now();
}

function listAll() {
  return [...store.values()].map(record => ({ ...record }));
}

/** Last time this installation touched the server (status/refresh). */
function touchInstallation(installationId) {
  for (const record of store.values()) {
    if (record.installationId === installationId) {
      record.lastSeenAt = new Date().toISOString();
      _saveToDisk();
      return { ...record };
    }
  }
  return null;
}

/** Test hook: wipe the store between test runs. */
function _reset() {
  store.clear();
}

module.exports = {
  validateKey,
  findByKey,
  findByInstallationId,
  create,
  revoke,
  isActive,
  listAll,
  touchInstallation,
  PLAN_DEFAULTS,
  _reset,
};
