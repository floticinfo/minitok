"use strict";

const fs = require("node:fs");
const path = require("node:path");

const CACHE_VERSION = 1;
const DEFAULT_MAX_ENTRIES = 24;

/**
 * Small local cache for deterministic stage outputs. Keys must include the
 * repository fingerprint, task epoch, provider/model and policy settings.
 * No prompt or repository source text is persisted here.
 */
class StageCache {
  constructor(filePath, options = {}) {
    this.filePath = filePath;
    this.maxEntries = Math.max(1, Number(options.maxEntries) || DEFAULT_MAX_ENTRIES);
    this.entries = this._load();
  }

  _load() {
    if (!this.filePath) return {};
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      if (parsed?.version !== CACHE_VERSION || !parsed.entries || typeof parsed.entries !== "object") return {};
      return parsed.entries;
    } catch {
      return {};
    }
  }

  get(key) {
    const entry = this.entries[key];
    if (!entry || !entry.value || entry.version !== CACHE_VERSION) return null;
    return entry.value;
  }

  set(key, value, metadata = {}) {
    if (!key || !value || typeof value !== "object") return;
    this.entries[key] = { version: CACHE_VERSION, saved_at: new Date().toISOString(), metadata, value };
    const keys = Object.keys(this.entries);
    if (keys.length > this.maxEntries) {
      keys.sort((a, b) => String(this.entries[a].saved_at).localeCompare(String(this.entries[b].saved_at)));
      for (const oldKey of keys.slice(0, keys.length - this.maxEntries)) delete this.entries[oldKey];
    }
    this._save();
  }

  invalidate(key) {
    if (!Object.prototype.hasOwnProperty.call(this.entries, key)) return false;
    delete this.entries[key];
    this._save();
    return true;
  }

  clear() {
    this.entries = {};
    this._save();
  }

  _save() {
    if (!this.filePath) return;
    const directory = path.dirname(this.filePath);
    const temporary = `${this.filePath}.tmp.${process.pid}.${Date.now()}`;
    try {
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(temporary, `${JSON.stringify({ version: CACHE_VERSION, entries: this.entries }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      fs.renameSync(temporary, this.filePath);
    } catch {
      try { fs.rmSync(temporary, { force: true }); } catch {}
    }
  }
}

module.exports = { StageCache, CACHE_VERSION, DEFAULT_MAX_ENTRIES };
