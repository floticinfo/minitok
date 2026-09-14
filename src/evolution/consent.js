"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const { setOwnerOnlyPermissions } = require("../utils/file-permissions");

const DEFAULT_CONSENT_PATH = path.join(os.homedir(), ".minitok", "evolution", "consent.json");
const SCOPES = ["metrics", "project_knowledge", "retrieval", "tenant_training", "global_training"];

class KnowledgeConsent {
  constructor(filePath = DEFAULT_CONSENT_PATH) { this._file = filePath; }
  _load() {
    try {
      const value = JSON.parse(fs.readFileSync(this._file, "utf8"));
      return Object.fromEntries(SCOPES.map(scope => [scope, value?.[scope] === true]));
    } catch { return Object.fromEntries(SCOPES.map(scope => [scope, false])); }
  }
  _save(value) {
    fs.mkdirSync(path.dirname(this._file), { recursive: true });
    const tmp = `${this._file}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify({ ...value, updated_at: new Date().toISOString() }, null, 2), "utf8");
    setOwnerOnlyPermissions(tmp); fs.renameSync(tmp, this._file); setOwnerOnlyPermissions(this._file);
  }
  status() { return this._load(); }
  isEnabled(scope) { return SCOPES.includes(scope) && this._load()[scope] === true; }
  enable(scope) { if (!SCOPES.includes(scope)) throw new Error(`Unknown consent scope: ${scope}`); const value = this._load(); value[scope] = true; this._save(value); }
  disable(scope) { if (!SCOPES.includes(scope)) throw new Error(`Unknown consent scope: ${scope}`); const value = this._load(); value[scope] = false; this._save(value); }
  disableAll() { this._save(Object.fromEntries(SCOPES.map(scope => [scope, false]))); }
}

module.exports = { KnowledgeConsent, DEFAULT_CONSENT_PATH, KNOWLEDGE_CONSENT_SCOPES: SCOPES };
