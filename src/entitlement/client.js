"use strict";

/**
 * Entitlement Server Client — HTTP API for the local entitlement server.
 *
 * Talks to the Phase 1 server (default http://localhost:3000). The server URL
 * is resolved through server-config (MINITOK_SERVER_URL env, --server flag,
 * ~/.minitok/config.json, or the built-in default).
 */

const { postJson, fetchWithTimeout } = require("../core/http");
const { loadInstallationRecord } = require("./online");

const DEFAULT_LOCAL_SERVER = "http://localhost:3000";

function resolveApiBase(serverUrl) {
  const base = serverUrl || DEFAULT_LOCAL_SERVER;
  return base.replace(/\/+$/, "");
}

/**
 * POST /api/entitlement/activate
 * @param {string} key - activation key
 * @param {object} [opts]
 * @param {string} [opts.serverUrl] - override server URL
 * @returns {Promise<{ ok: boolean, status: number, body: object }>}
 */
async function activate(key, opts = {}) {
  const url = `${resolveApiBase(opts.serverUrl)}/api/entitlement/activate`;
  // Send installation_id when known so the server can bind the entitlement to
  // this machine (matches the /v1/activate contract expected by stage2-parity).
  const body = { key };
  const record = opts.entitlementDir ? loadInstallationRecord(opts.entitlementDir) : loadInstallationRecord();
  if (record && typeof record.installation_id === "string") body.installation_id = record.installation_id;
  return postJson(url, body, 30000);
}

/**
 * GET /api/entitlement/status
 * @param {string} token - JWT Bearer token
 * @param {object} [opts]
 * @param {string} [opts.serverUrl]
 * @returns {Promise<{ ok: boolean, status: number, body: object }>}
 */
async function status(token, opts = {}) {
  const url = `${resolveApiBase(opts.serverUrl)}/api/entitlement/status`;
  const res = await fetchWithTimeout(url, {
    headers: { Authorization: `Bearer ${token}` },
  }, 15000);
  let body = null;
  try { body = JSON.parse(await res.text()); } catch {}
  return { ok: res.status >= 200 && res.status < 300, status: res.status, body };
}

/**
 * POST /api/entitlement/refresh
 * @param {string} token - current JWT (may be expired)
 * @param {object} [opts]
 * @param {string} [opts.serverUrl]
 * @returns {Promise<{ ok: boolean, status: number, body: object }>}
 */
async function refresh(token, opts = {}) {
  const url = `${resolveApiBase(opts.serverUrl)}/api/entitlement/refresh`;
  return postJson(url, {}, 15000, { Authorization: `Bearer ${token}` });
}

/**
 * DELETE /api/entitlement
 * @param {string} token - JWT Bearer token
 * @param {object} [opts]
 * @param {string} [opts.serverUrl]
 * @returns {Promise<{ ok: boolean, status: number, body: object }>}
 */
async function deactivate(token, opts = {}) {
  const url = `${resolveApiBase(opts.serverUrl)}/api/entitlement`;
  const res = await fetchWithTimeout(url, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  }, 15000);
  let body = null;
  try { body = JSON.parse(await res.text()); } catch {}
  return { ok: res.status >= 200 && res.status < 300, status: res.status, body };
}

module.exports = { activate, status, refresh, deactivate, resolveApiBase, DEFAULT_LOCAL_SERVER };
