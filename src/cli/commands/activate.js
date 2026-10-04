"use strict";

/**
 * minitok activate <key> — Client-side activation flow.
 *
 * Calls POST /api/entitlement/activate on the minitok server, stores the
 * returned JWT session token locally, and updates the entitlement cache.
 *
 * Flow:
 *   1. Resolve server URL (MINITOK_SERVER_URL env, --server flag, or default)
 *   2. POST /api/entitlement/activate { key }
 *   3. Store JWT in ~/.minitok/entitlement/session.json via EntitlementCache
 *   4. Display success with plan details
 */

const { EntitlementCache } = require("../../entitlement/cache");
const client = require("../../entitlement/client");
const { postJson } = require("../../core/http");
const { resolveServerUrl } = require("./server-config");

/** Shared request helper (same implementation as activation-key). */
function _httpPost(urlString, body, headers) {
  return postJson(urlString, body, 30000, headers);
}

async function cmdActivate(key, opts) {
  const envName = opts?.keyEnv;
  if (!key && envName && /^[A-Z_][A-Z0-9_]*$/i.test(envName)) key = process.env[envName];
  if (!key || typeof key !== "string") {
    console.error("Error: Activation key required.\n\nUsage: minitok activate <key> or minitok activate --key-env MINITOK_ACTIVATION_KEY");
    return 1;
  }

  // 1. Resolve server URL
  const serverUrl = resolveServerUrl({ cliServer: opts?.server });
  console.log(`Activating against ${serverUrl}...`);

  // 2. Call POST /api/entitlement/activate
  let result;
  try {
    result = await client.activate(key, { serverUrl });
  } catch (err) {
    console.error(`Error: Cannot connect to server at ${serverUrl}\n${err.message}`);
    return 1;
  }

  if (!result.ok) {
    const errMsg = result.body?.error || `Activation failed (HTTP ${result.status})`;
    console.error(`Error: ${errMsg}`);
    return 1;
  }

  const { token, entitlement } = result.body || {};
  if (!token || !entitlement) {
    console.error("Error: Server returned incomplete activation response.");
    return 1;
  }

  // 3. Store JWT in local cache
  try {
    const cache = new EntitlementCache();
    // Decode the payload from the JWT (without verifying — the server already did).
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
    cache.save(token, payload);
  } catch (err) {
    console.error(`Error: Failed to store session token: ${err.message}`);
    return 1;
  }

  // 4. Display success
  console.log("\n[ok] Activation successful.\n");
  console.log(`  Plan:       ${entitlement.plan || "unknown"}`);
  console.log(`  Expires:    ${entitlement.expires_at || "unknown"}`);
  console.log(`  Installation: ${entitlement.installation_id || "unknown"}`);
  console.log(`  Server:     ${serverUrl}`);
  console.log("");

  return 0;
}

module.exports = { cmdActivate, _httpPost };
