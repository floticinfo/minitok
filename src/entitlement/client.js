"use strict";

/**
 * Entitlement Server Client — HTTP API for the minitok server.
 *
 * [2026-10-22 E단계] This module used to call the Phase 1 entitlement routes
 * under the retired `/api/...` prefix. The server no longer serves them:
 * production answered all of them with `404 Route ... not found`, which meant
 * `minitok activate` — the command the website tells a paying customer to run
 * after a completed payment — could not reach the server at all, and
 * `minitok status` and `minitok deactivate` could not either. The server
 * logged the misses.
 *
 * The retired route strings are deliberately not spelled out here: a literal
 * left in a comment is one copy-paste away from being called again, and
 * `tests/test-entitlement-api-contract.js` asserts that no client source
 * contains them at all.
 *
 * The canonical contract is the /v1 API:
 *   POST /v1/activate    { key, installation_id, hostname? } -> { entitlement, installation_token }
 *   POST /v1/validate    { token, entitlement? }              -> { valid, installation, subscription }
 *   POST /v1/deactivate  { token }                            -> { success, message, installation_id, status }
 *
 * The server URL is resolved through server-config (MINITOK_SERVER_URL env,
 * --server flag, ~/.minitok/config.json, or the built-in default).
 */

const { postJson } = require("../core/http");
const { ensureInstallationId, loadInstallationId } = require("../auth/installation");

const DEFAULT_LOCAL_SERVER = "http://localhost:3000";

function resolveApiBase(serverUrl) {
  const base = serverUrl || DEFAULT_LOCAL_SERVER;
  return base.replace(/\/+$/, "");
}

/**
 * POST /v1/activate
 *
 * The server binds the entitlement to the supplied installation id and allows
 * one active installation per subscription, so the id must be the machine's
 * stable identity rather than a fresh value per attempt.
 *
 * @param {string} key - activation key
 * @param {object} [opts]
 * @param {string} [opts.serverUrl] - override server URL
 * @param {string} [opts.installationId] - override installation id
 * @param {string} [opts.entitlementDir] - entitlement storage directory
 * @param {string} [opts.hostname] - optional hostname recorded by the server
 * @returns {Promise<{ ok: boolean, status: number, body: object }>}
 */
async function activate(key, opts = {}) {
  const url = `${resolveApiBase(opts.serverUrl)}/v1/activate`;
  const installationId =
    opts.installationId ||
    loadInstallationId(opts.entitlementDir) ||
    ensureInstallationId(opts.entitlementDir);
  const body = { key, installation_id: installationId };
  if (opts.hostname) body.hostname = opts.hostname;
  return postJson(url, body, 30000);
}

/**
 * POST /v1/validate
 *
 * @param {string} token - installation token
 * @param {object} [opts]
 * @param {string} [opts.serverUrl] - override server URL
 * @param {object} [opts.entitlement] - the signed entitlement artifact
 * @returns {Promise<{ ok: boolean, status: number, body: object }>}
 */
async function status(token, opts = {}) {
  const url = `${resolveApiBase(opts.serverUrl)}/v1/validate`;
  const body = { token };
  if (opts.entitlement) body.entitlement = opts.entitlement;
  return postJson(url, body, 15000);
}

/**
 * POST /v1/deactivate
 *
 * @param {string} token - installation token
 * @param {object} [opts]
 * @param {string} [opts.serverUrl] - override server URL
 * @returns {Promise<{ ok: boolean, status: number, body: object }>}
 */
async function deactivate(token, opts = {}) {
  const url = `${resolveApiBase(opts.serverUrl)}/v1/deactivate`;
  return postJson(url, { token }, 15000);
}

// The Phase 1 token-refresh route is gone and nothing called it, so it is not
// carried forward under a different name: a function called `refresh` that
// does something else is a trap for the next reader.
module.exports = { activate, status, deactivate, resolveApiBase, DEFAULT_LOCAL_SERVER };
