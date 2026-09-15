"use strict";

/**
 * Server URL Configuration — single canonical resolver.
 *
 * Precedence:
 *   1. CLI --server flag (highest)
 *   2. minitok_server_url env var
 *   3. ~/.minitok/config.json (persistent)
 *   4. Default: https://api.minitok.dev
 */

const fs = require("fs");
const path = require("path");
const os = require("os");

const DEFAULT_SERVER_URL = "https://api.minitok.dev";
const CONFIG_DIR = path.join(os.homedir(), ".minitok");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

function _loadLocalConfig() {
  try {
    const data = fs.readFileSync(CONFIG_FILE, "utf-8");
    const parsed = JSON.parse(data);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function _saveLocalConfig(patch) {
  const dir = path.dirname(CONFIG_FILE);
  fs.mkdirSync(dir, { recursive: true });
  let current = {};
  try {
    current = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
  } catch {}
  const merged = { ...current, ...patch };
  const tmp = CONFIG_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(merged, null, 2), "utf-8");
  fs.renameSync(tmp, CONFIG_FILE);
}

/**
 * Resolve the server URL from all sources.
 * @param {object} [options]
 * @param {string} [options.cliServer] - --server CLI flag value
 * @returns {string} Normalized server URL
 */
function resolveServerUrl(options = {}) {
  // 1. CLI flag
  if (options.cliServer !== undefined && options.cliServer !== null) {
    return _normalizeUrl(options.cliServer);
  }

  // 2. Environment variable. Keep the lower-case name as the canonical
  // subprocess contract, but accept the conventional upper-case spelling for
  // shells and CI configurations.
  const serverUrl = process.env.minitok_server_url || process.env.MINITOK_SERVER_URL;
  if (serverUrl) {
    return _normalizeUrl(serverUrl);
  }

  // 3. Persistent config
  const config = _loadLocalConfig();
  if (Object.prototype.hasOwnProperty.call(config, "server_url")) {
    return _normalizeUrl(config.server_url);
  }

  // 4. Default
  return DEFAULT_SERVER_URL;
}

/**
 * Save server URL to persistent config.
 */
function saveServerUrl(url) {
  _saveLocalConfig({ server_url: _normalizeUrl(url) });
}

/**
 * Normalize URL: trim, remove trailing slash, validate.
 */
function _normalizeUrl(raw) {
  if (typeof raw !== "string" || !raw.trim()) throw new Error("Server URL must be a non-empty string");
  const value = raw.trim().replace(/\/+$/, "");
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Server URL is invalid");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("Server URL must use http or https");
  if (parsed.username || parsed.password) throw new Error("Server URL must not contain credentials");
  if (parsed.hash) throw new Error("Server URL must not contain a fragment");
  if (parsed.protocol === "http:" && !["localhost", "127.0.0.1", "::1"].includes(parsed.hostname.toLowerCase())) {
    throw new Error("Remote http server URLs are not allowed");
  }
  return parsed.origin + parsed.pathname.replace(/\/+$/, "");
}

module.exports = { resolveServerUrl, saveServerUrl, DEFAULT_SERVER_URL };
