"use strict";

/**
 * Entitlement Store — persists signed entitlement to disk.
 * Storage: ~/.minitok/entitlement/entitlement.json
 * Follows the same atomic-write + permission pattern as token-store.js.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");

const { setOwnerOnlyPermissions } = require("../utils/file-permissions");

const DEFAULT_ENTITLEMENT_DIR = path.join(os.homedir(), ".minitok", "entitlement");
const ENTITLEMENT_FILE = "entitlement.json";

class EntitlementStore {
  constructor(entitlementDir) {
    this._dir = entitlementDir || DEFAULT_ENTITLEMENT_DIR;
    this._filePath = path.join(this._dir, ENTITLEMENT_FILE);
  }

  _ensureDir() {
    fs.mkdirSync(this._dir, { recursive: true });
  }

  /**
   * Load the stored entitlement artifact.
   * @returns {object | null} The artifact { payload, signature, key_id } or null if not found/corrupt.
   */
  load() {
    try {
      const data = fs.readFileSync(this._filePath, "utf-8");
      const parsed = JSON.parse(data);
      // Basic structural check: must have payload, signature, key_id
      if (
        parsed === null ||
        typeof parsed !== "object" ||
        Array.isArray(parsed) ||
        !parsed.payload ||
        !parsed.signature ||
        !parsed.key_id
      ) {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  /**
   * Save an entitlement artifact to disk using atomic write.
   * @param {object} artifact - { payload, signature, key_id }
   */
  save(artifact) {
    this._ensureDir();
    const record = {
      ...artifact,
      saved_at: new Date().toISOString(),
    };
    const tmp = `${this._filePath}.tmp.${process.pid}.${Date.now()}.${require("node:crypto").randomBytes(8).toString("hex")}`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(record, null, 2), { encoding: "utf-8", flag: "wx", mode: 0o600 });
      try {
        // rename() replaces the destination atomically on every platform,
        // including Windows (MOVEFILE_REPLACE_EXISTING). Deleting the target
        // first — as this used to do on win32 — opened a window in which a crash
        // left the customer with no entitlement on disk at all.
        fs.renameSync(tmp, this._filePath);
      } catch (error) {
        if (process.platform !== "win32") throw error;
        // Windows can refuse to replace a file another handle has open; fall
        // back to clearing the target instead of failing the activation.
        try { fs.unlinkSync(this._filePath); } catch (unlinkError) { if (unlinkError.code !== "ENOENT") throw unlinkError; }
        fs.renameSync(tmp, this._filePath);
      }
      setOwnerOnlyPermissions(this._filePath);
    } catch (error) {
      try { fs.unlinkSync(tmp); } catch {}
      throw error;
    }
  }

  /**
   * Delete the stored entitlement.
   */
  clear() {
    try {
      fs.unlinkSync(this._filePath);
    } catch {
      // Ignore if not found
    }
  }

  /**
   * Check if an entitlement file exists on disk.
   * @returns {boolean}
   */
  exists() {
    try {
      fs.accessSync(this._filePath, fs.constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }
}

module.exports = { EntitlementStore, DEFAULT_ENTITLEMENT_DIR };
