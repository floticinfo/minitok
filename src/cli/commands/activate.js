"use strict";

/**
 * minitok activate <key> — Client-side activation flow.
 *
 * Calls POST /v1/activate on the minitok server, stores the returned
 * entitlement + installation_token locally, enabling the entitlement gate.
 *
 * Flow:
 *   1. Resolve server URL
 *   2. Generate installation_id (UUID)
 *   3. POST /v1/activate { key, installation_id }
 *   4. Store entitlement artifact in ~/.minitok/entitlement/
 *   5. Store installation token in ~/.minitok/entitlement/installation-token.json
 *   6. Update gate-state.json for offline grace baseline
 */

const { randomUUID } = require("crypto");
const { EntitlementStore, DEFAULT_ENTITLEMENT_DIR } = require("../../entitlement/store");
const { saveGateState } = require("../../entitlement/gate");
const { resolveServerUrl } = require("./server-config");
const { setOwnerOnlyPermissions } = require("../../utils/file-permissions");
const { postJson } = require("../../core/http");

const INSTALLATION_TOKEN_FILE = "installation-token.json";

async function cmdActivate(key, opts) {
  const envName = opts?.keyEnv;
  if (!key && envName && /^[A-Z_][A-Z0-9_]*$/i.test(envName)) key = process.env[envName];
  if (!key || typeof key !== "string") {
    console.error("Error: Activation key required.\n\nUsage: minitok activate <key> or minitok activate --key-env MINITOK_ACTIVATION_KEY");
    return 1;
  }

  // 1. Resolve server URL
  const serverUrl = resolveServerUrl({ cliServer: opts?.server });

  // 2. Generate installation identity
  const installationId = randomUUID();
  console.log(`Activating against ${serverUrl}...`);

  // 3. Call POST /v1/activate
  let result;
  try {
    result = await _httpPost(`${serverUrl}/v1/activate`, {
      key,
      installation_id: installationId,
    });
  } catch (err) {
    console.error(`Error: Cannot connect to server at ${serverUrl}\n${err.message}`);
    return 1;
  }

  if (!result.ok) {
    const errMsg = result.body?.error || result.statusText || "Activation failed";
    console.error(`Error: ${errMsg}`);
    return 1;
  }

  const { entitlement, installation_token } = result.body;
  if (!entitlement || !installation_token) {
    console.error("Error: Server returned incomplete activation response.");
    return 1;
  }

  // 4. Store entitlement artifact
  try {
    const store = new EntitlementStore();
    store.save(entitlement);
  } catch (err) {
    console.error(`Error: Failed to store entitlement: ${err.message}`);
    return 1;
  }

  // 5. Store installation token
  try {
    const tokenDir = DEFAULT_ENTITLEMENT_DIR;
    const fs = require("fs");
    const path = require("path");
    fs.mkdirSync(tokenDir, { recursive: true });
    const tokenFile = path.join(tokenDir, INSTALLATION_TOKEN_FILE);
    const record = {
      token: installation_token,
      installation_id: installationId,
      saved_at: new Date().toISOString(),
    };
    // flag: "wx" prevents concurrent activation from overwriting in-flight:
    // two parallel `minitok activate` calls would otherwise race on the
    // installation-token.json, leaving one caller with a truncated record.
    const crypto = require("crypto");
    const tmp = `${tokenFile}.tmp.${process.pid}.${crypto.randomBytes(6).toString("hex")}`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(record, null, 2), { encoding: "utf-8", flag: "wx", mode: 0o600 });
      setOwnerOnlyPermissions(tmp);
      fs.renameSync(tmp, tokenFile);
      setOwnerOnlyPermissions(tokenFile);
    } catch (error) {
      try { fs.unlinkSync(tmp); } catch {}
      throw error;
    }
  } catch (err) {
    console.error(`Error: Failed to store installation token: ${err.message}`);
    return 1;
  }

  // 6. Initialize gate state baseline
  try {
    const now = new Date();
    saveGateState({
      latest_observed_at: now.getTime(),
      last_validated_at: now.toISOString(),
    });
  } catch {}

  // 7. Display success
  const payload = entitlement.payload || {};
  console.log("\n[ok] Activation successful.\n");
  console.log(`  Plan:       ${payload.plan_id || "unknown"}`);
  console.log(`  Expires:    ${payload.expires_at || "unknown"}`);
  console.log(`  Installation: ${installationId}`);
  console.log(`  Server:     ${serverUrl}`);
  console.log("");

  return 0;
}

function _httpPost(urlString, body) {
  return postJson(urlString, body, 30000);
}

module.exports = { cmdActivate, _httpPost };
