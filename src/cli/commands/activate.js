"use strict";

/**
 * minitok activate <key> — Client-side activation flow.
 *
 * Calls POST /v1/activate on the minitok server, stores the returned
 * installation token and the signed entitlement locally, and updates the
 * entitlement cache.
 *
 * Flow:
 *   1. Resolve server URL (MINITOK_SERVER_URL env, --server flag, or default)
 *   2. Resolve this machine's installation id (stable across attempts)
 *   3. POST /v1/activate { key, installation_id }
 *   4. Store the signed entitlement, the installation token and the session
 *   5. Display success with plan details
 */

const os = require("os");
const path = require("path");
const { EntitlementCache } = require("../../entitlement/cache");
const { EntitlementStore } = require("../../entitlement/store");
const { ensureInstallationId, writeInstallationRecord } = require("../../auth/installation");
const client = require("../../entitlement/client");
const { postJson } = require("../../core/http");
const { resolveServerUrl, isInsecureServerUrl } = require("./server-config");
const { printError } = require("../output");
const { redactSecrets } = require("../../goal/evidence");

const DEFAULT_ENTITLEMENT_DIR = path.join(os.homedir(), ".minitok", "entitlement");

/** Shared request helper (same implementation as activation-key). */
function _httpPost(urlString, body, headers) {
  return postJson(urlString, body, 30000, headers);
}

async function cmdActivate(key, opts) {
  const envName = opts?.keyEnv;
  if (!key && envName && /^[A-Z_][A-Z0-9_]*$/i.test(envName)) key = process.env[envName];
  if (!key || typeof key !== "string") {
    printError("Activation key required.\n\nUsage: minitok activate <key> or minitok activate --key-env MINITOK_ACTIVATION_KEY");
    return 1;
  }

  // Redact the activation key from process arguments so it does not remain
  // visible to other processes via process listings (ps, tasklist, /proc).
  for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i] === key) process.argv[i] = "[REDACTED]";
  }
  if (!opts?.keyEnv) {
    console.log("Tip: pass the key via --key-env MINITOK_ACTIVATION_KEY to keep it out of shell history.");
  }

  // 1. Resolve server URL
  const serverUrl = resolveServerUrl({ cliServer: opts?.server });
  console.log(`Activating against ${serverUrl}...`);
  if (isInsecureServerUrl(serverUrl)) {
    console.log("Warning: server URL is not HTTPS. Your activation key and session token will be sent in cleartext.");
  }

  const entitlementDir = opts?.entitlementDir || DEFAULT_ENTITLEMENT_DIR;

  // 2. Resolve this machine's installation id.
  //
  // The server binds the entitlement to this id and permits one active
  // installation per subscription, so the id is created and persisted BEFORE
  // the request: a failed attempt must not leave the next attempt presenting
  // a different id and occupying a second device slot.
  let installationId;
  try {
    installationId = ensureInstallationId(entitlementDir);
  } catch (err) {
    printError(`Could not resolve this machine's installation id: ${redactSecrets(err.message, key)}`);
    return 1;
  }

  // 3. Call POST /v1/activate
  let result;
  try {
    result = await client.activate(key, { serverUrl, installationId, entitlementDir });
  } catch (err) {
    printError(`Cannot connect to server at ${serverUrl}\n${redactSecrets(err.message, key)}`);
    return 1;
  }

  if (!result.ok) {
    const errMsg = result.body?.error || `Activation failed (HTTP ${result.status})`;
    printError(redactSecrets(errMsg, key));
    // The server's machine-readable identifier. The message text may change;
    // the reason is the part of the contract that is stable, and it is what
    // tells a retired plan apart from a missing key or a device limit.
    if (typeof result.body?.reason === "string" && result.body.reason) {
      console.error(`  Reason:     ${redactSecrets(result.body.reason, key)}`);
    }
    return 1;
  }

  // The canonical response carries the signed entitlement artifact and the
  // installation token. The Phase 1 response carried a flat `token` and a flat
  // entitlement, which the server no longer produces.
  const installationToken = result.body?.installation_token;
  const artifact = result.body?.entitlement;
  if (!installationToken || !artifact || !artifact.payload) {
    printError("Server returned incomplete activation response.");
    return 1;
  }

  // 4. Store the entitlement, the installation token and the session
  try {
    new EntitlementStore(entitlementDir).save(artifact);
    writeInstallationRecord(
      { token: installationToken, installation_id: artifact.payload.installation_id || installationId },
      entitlementDir,
    );
    const payload = JSON.parse(Buffer.from(installationToken.split(".")[1], "base64url").toString("utf8"));
    new EntitlementCache(entitlementDir).save(installationToken, payload);
  } catch (err) {
    printError(`Failed to store session token: ${redactSecrets(err.message, installationToken)}`);
    return 1;
  }

  // 5. Display success
  const plan = artifact.payload.plan_id || "unknown";
  console.log("\n[ok] Activation successful.\n");
  console.log(`  Plan:       ${plan}`);
  console.log(`  Expires:    ${artifact.payload.expires_at || "unknown"}`);
  console.log(`  Installation: ${artifact.payload.installation_id || installationId}`);
  console.log(`  Server:     ${serverUrl}`);
  console.log("");

  return 0;
}

module.exports = { cmdActivate, _httpPost };
