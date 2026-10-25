"use strict";

/**
 * Entitlement Cache — local persistence of the server-issued session token.
 *
 * Storage: ~/.minitok/entitlement/session.json
 *
 * The cache stores the JWT returned by the Phase 1 entitlement server along
 * with metadata needed for offline fallback: the plan, features, and expiry
 * are embedded in the JWT payload, so a cached token remains usable for
 * offline reads even when the server is unreachable.
 *
 * TTL: the cache entry is considered fresh for 24 hours from `cached_at`.
 * After that the client attempts a server refresh before failing closed.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const { setOwnerOnlyPermissions } = require("../utils/file-permissions");

const DEFAULT_CACHE_DIR = path.join(os.homedir(), ".minitok", "entitlement");
const SESSION_FILE = "session.json";
const TRIAL_FILE = "trial.json";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

class EntitlementCache {
  constructor(cacheDir) {
    this._dir = cacheDir || DEFAULT_CACHE_DIR;
    this._filePath = path.join(this._dir, SESSION_FILE);
  }

  /**
   * Load the cached session. Returns null when missing, corrupt, or stale.
   * @param {object} [opts]
   * @param {boolean} [opts.allowStale] - return even if past TTL (caller decides)
   * @returns {{ token: string, cached_at: string, expires_at: string, payload: object, stale: boolean } | null}
   */
  load(opts = {}) {
    try {
      const data = fs.readFileSync(this._filePath, "utf-8");
      const parsed = JSON.parse(data);
      if (!parsed || typeof parsed.token !== "string" || !parsed.cached_at || !parsed.payload) return null;
      const stale = Date.now() - new Date(parsed.cached_at).getTime() > CACHE_TTL_MS;
      if (stale && !opts.allowStale) return null;
      return { ...parsed, stale };
    } catch {
      return null;
    }
  }

  /**
   * Persist a server-issued token.
   * @param {string} token - JWT from the server
   * @param {object} payload - decoded JWT payload
   */
  save(token, payload) {
    fs.mkdirSync(this._dir, { recursive: true });
    const record = {
      token,
      cached_at: new Date().toISOString(),
      expires_at: payload.exp ? new Date(payload.exp * 1000).toISOString() : null,
      payload,
    };
    const tmp = `${this._filePath}.tmp.${process.pid}.${Date.now()}.${require("crypto").randomBytes(6).toString("hex")}`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(record, null, 2), { encoding: "utf-8", flag: "wx", mode: 0o600 });
      try {
        fs.renameSync(tmp, this._filePath);
      } catch (error) {
        if (process.platform !== "win32") throw error;
        try { fs.unlinkSync(this._filePath); } catch (e) { if (e.code !== "ENOENT") throw e; }
        fs.renameSync(tmp, this._filePath);
      }
      setOwnerOnlyPermissions(this._filePath);
    } catch (error) {
      try { fs.unlinkSync(tmp); } catch {}
      throw error;
    }
  }

  /** Remove the cached session. */
  clear() {
    try { fs.unlinkSync(this._filePath); } catch {}
  }

  /** Check whether a non-stale cached session exists. */
  exists() {
    return this.load() !== null;
  }

  /** Return the file path for diagnostics. */
  get filePath() { return this._filePath; }
}

/**
 * Trial Request Cache — local record of a successfully issued trial key.
 *
 * Storage: ~/.minitok/entitlement/trial.json
 *
 * Prevents duplicate trial requests from the same server on this installation.
 * Only a successful issuance is recorded; server rejections and network errors
 * are NOT cached so the caller can retry.
 */
class TrialCache {
  constructor(cacheDir) {
    this._dir = cacheDir || DEFAULT_CACHE_DIR;
    this._filePath = path.join(this._dir, TRIAL_FILE);
  }

  /**
   * Load the cached trial record. Returns null when missing, corrupt,
   * or when the trial has expired.
   * @returns {{ server_url: string, issued_at: string, expires_at: string|null, plan_id: string|null } | null}
   */
  load() {
    try {
      const data = fs.readFileSync(this._filePath, "utf-8");
      const parsed = JSON.parse(data);
      if (!parsed || typeof parsed.server_url !== "string" || !parsed.issued_at) return null;
      if (!parsed.expires_at || new Date(parsed.expires_at).getTime() < Date.now()) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  /**
   * Record a successful trial issuance.
   * @param {string} serverUrl - Normalized server URL
   * @param {object} body - Response body from POST /v1/trial/request
   */
  save(serverUrl, body) {
    const record = {
      server_url: serverUrl,
      issued_at: new Date().toISOString(),
      expires_at: body.expires_at || null,
      plan_id: body.plan_id || null,
    };
    fs.mkdirSync(this._dir, { recursive: true });
    const tmp = `${this._filePath}.tmp.${process.pid}.${Date.now()}.${require("crypto").randomBytes(6).toString("hex")}`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(record, null, 2), { encoding: "utf-8", flag: "wx", mode: 0o600 });
      try {
        fs.renameSync(tmp, this._filePath);
      } catch (error) {
        if (process.platform !== "win32") throw error;
        try { fs.unlinkSync(this._filePath); } catch (e) { if (e.code !== "ENOENT") throw e; }
        fs.renameSync(tmp, this._filePath);
      }
      setOwnerOnlyPermissions(this._filePath);
    } catch (error) {
      try { fs.unlinkSync(tmp); } catch {}
      throw error;
    }
  }

  /** Remove the trial cache. */
  clear() {
    try { fs.unlinkSync(this._filePath); } catch {}
  }

  /** Check whether a valid (non-expired) trial cache exists. */
  exists() {
    return this.load() !== null;
  }

  /** Return the file path for diagnostics. */
  get filePath() { return this._filePath; }
}

module.exports = { EntitlementCache, TrialCache, DEFAULT_CACHE_DIR, SESSION_FILE, TRIAL_FILE, CACHE_TTL_MS };
