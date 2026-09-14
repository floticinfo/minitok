"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const { postJson } = require("../core/http");
const { checkEntitlement, loadGateState, saveGateState, GateState, OFFLINE_GRACE_MS, OFFLINE_GRACE_DAYS } = require("./gate");

const DEFAULT_ENTITLEMENT_DIR = path.join(os.homedir(), ".minitok", "entitlement");
const INSTALLATION_TOKEN_FILE = "installation-token.json";

function loadInstallationRecord(entitlementDir) {
  const file = path.join(entitlementDir || DEFAULT_ENTITLEMENT_DIR, INSTALLATION_TOKEN_FILE);
  try {
    const record = JSON.parse(fs.readFileSync(file, "utf-8"));
    if (!record || typeof record.token !== "string" || typeof record.installation_id !== "string") return null;
    return record;
  } catch {
    return null;
  }
}

// Proxy-aware JSON POST (HTTPS_PROXY/NO_PROXY honored via core/http).
function postValidation(urlString, body, timeoutMs = 10000) {
  return postJson(urlString, JSON.stringify(body), timeoutMs);
}

async function checkEntitlementOnline(options = {}) {
  // Always allow local gate state to be saved: suppressing it when a server is
  // configured broke offline grace, because `last_validated_at` was never set
  // by local checks and the online path only saved on success.
  const local = checkEntitlement(options);
  if (!local.allowed) return local;

  const record = loadInstallationRecord(options.entitlementDir);
  const serverUrl = options.serverUrl;
  const shouldValidate = Boolean(serverUrl && (record || options._validate));
  if (!shouldValidate) {
    return { ...local, offline: true, offlineSemantics: "valid-signed-entitlement-until-expires_at" };
  }

  try {
    const response = await (options._validate || postValidation)(`${serverUrl.replace(/\/$/, "")}/v1/validate`, {
      token: record?.token,
      entitlement: options._loadArtifact ? options._loadArtifact() : undefined,
    });
    if (!response.ok || !response.body || response.body.valid !== true) {
      return { allowed: false, state: GateState.SERVER_REJECTED, message: response.body?.error || "Server did not authorize this installation.", serverRejected: true };
    }
    // Record the successful validation timestamp so offline grace can be
    // measured if the server later becomes unreachable.
    try {
      const dir = options.entitlementDir;
      const state = loadGateState(dir);
      saveGateState({ ...state, last_validated_at: new Date().toISOString() }, dir);
    } catch {}
    return { ...local, serverValidated: true, subscription: response.body.subscription };
  } catch (error) {
    if (error?.name === "AbortError" || error?.code === "ERR_INVALID_URL") {
      return { allowed: false, state: GateState.SERVER_REJECTED, message: "Entitlement validation response was invalid.", serverRejected: true };
    }
    // Server unreachable — allow bounded offline grace if the entitlement was
    // recently validated online; otherwise fail closed.
    const state = options._loadGateState ? options._loadGateState() : loadGateState(options.entitlementDir);
    const lastValidated = state.last_validated_at ? new Date(state.last_validated_at).getTime() : 0;
    if (lastValidated > 0 && Date.now() - lastValidated <= OFFLINE_GRACE_MS) {
      const graceDaysRemaining = Math.max(1, Math.ceil((lastValidated + OFFLINE_GRACE_MS - Date.now()) / 86400000));
      return {
        ...local,
        state: GateState.OFFLINE_GRACE,
        message: `The entitlement server could not be reached. Offline grace mode: ${graceDaysRemaining} day(s) remaining (max ${OFFLINE_GRACE_DAYS}).`,
        offline: true,
        graceDaysRemaining,
      };
    }
    return {
      allowed: false,
      state: GateState.SERVER_UNREACHABLE,
      message: `The entitlement server could not be reached${lastValidated ? ` and the ${OFFLINE_GRACE_DAYS}-day offline grace period has elapsed` : " (no prior successful validation on this machine)"}. Reconnect to the internet to continue.`,
    };
  }
}

module.exports = { checkEntitlementOnline, loadInstallationRecord, postValidation };
