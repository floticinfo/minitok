"use strict";

/**
 * Entitlement Gate — deterministic runtime authorization.
 *
 * Loads the local entitlement, verifies it cryptographically,
 * checks expiration, offline grace, and clock rollback.
 * Returns a structured allow/block result independent of any LLM.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const { EntitlementStore } = require("./store");
const { verifyEntitlement, EntitlementState } = require("./verify");
const { setOwnerOnlyPermissions } = require("../utils/file-permissions");

// Offline grace: after a successful online validation, the signed local
// entitlement keeps working if the validation server becomes unreachable
// (outage, travel, firewall). Bounded to 7 days so a lapsed subscription
// cannot be ridden indefinitely by staying offline.
const OFFLINE_GRACE_DAYS = 7;
const OFFLINE_GRACE_MS = OFFLINE_GRACE_DAYS * 24 * 60 * 60 * 1000;
// P3-02: Reduced from 5 minutes to 30 seconds to minimize bypass window.
// Legitimate clock corrections (NTP, manual) are typically < 10 seconds.
const CLOCK_ROLLBACK_THRESHOLD_MS = 30 * 1000;

const GateState = Object.freeze({
  ALLOWED: "ALLOWED",
  MISSING: "MISSING",
  MALFORMED: "MALFORMED",
  INVALID_SIGNATURE: "INVALID_SIGNATURE",
  EXPIRED: "EXPIRED",
  OFFLINE_GRACE: "OFFLINE_GRACE",
  CLOCK_ROLLBACK: "CLOCK_ROLLBACK",
  INSTALLATION_MISMATCH: "INSTALLATION_MISMATCH",
  LEGACY_UNBOUND: "LEGACY_UNBOUND",
  SERVER_REJECTED: "SERVER_REJECTED",
  SERVER_UNREACHABLE: "SERVER_UNREACHABLE",
});

const GateMessages = Object.freeze({
  [GateState.ALLOWED]: "Entitlement verified. minitok is authorized.",
  [GateState.MISSING]: "minitok requires an active entitlement. Run 'minitok activate <your-license-key>' to activate.",
  [GateState.MALFORMED]: "Your local entitlement is corrupted or invalid. Run 'minitok activate <your-license-key>' to re-activate.",
  [GateState.INVALID_SIGNATURE]: "Your local entitlement is invalid. Run 'minitok activate <your-license-key>' to re-activate.",
  [GateState.EXPIRED]: "Your minitok entitlement has expired. Renew your subscription to continue.",
  [GateState.OFFLINE_GRACE]: "minitok is operating in offline grace mode.",
  [GateState.CLOCK_ROLLBACK]: "System clock appears to have been set back. Please correct your system clock.",
  [GateState.INSTALLATION_MISMATCH]: "This entitlement was issued for a different installation. Run 'minitok activate <your-license-key>' to activate on this machine.",
  [GateState.LEGACY_UNBOUND]: "This legacy entitlement is not bound to an installation. Re-activate online to continue.",
  [GateState.SERVER_REJECTED]: "The entitlement server rejected this installation. Access is blocked until the subscription is active.",
  [GateState.SERVER_UNREACHABLE]: "The entitlement server could not be reached. Offline access is limited to the signed entitlement expiry.",
});

function _defaultEntitlementDir() {
  return path.join(os.homedir(), ".minitok", "entitlement");
}

function _stateFilePath(entitlementDir) {
  return path.join(entitlementDir || _defaultEntitlementDir(), "gate-state.json");
}

function loadGateState(entitlementDir) {
  const fp = _stateFilePath(entitlementDir);
  try {
    const data = fs.readFileSync(fp, "utf-8");
    const parsed = JSON.parse(data);
    return {
      latest_observed_at: typeof parsed.latest_observed_at === "number" ? parsed.latest_observed_at : 0,
      last_validated_at: typeof parsed.last_validated_at === "string" ? parsed.last_validated_at : null,
    };
  } catch {
    return { latest_observed_at: 0, last_validated_at: null };
  }
}

function saveGateState(state, entitlementDir) {
  const fp = _stateFilePath(entitlementDir);
  const dir = path.dirname(fp);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${fp}.tmp.${process.pid}.${Date.now()}.${require("crypto").randomBytes(8).toString("hex")}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { encoding: "utf-8", flag: "wx", mode: 0o600 });
    try {
      // rename() replaces the destination atomically on every platform (Windows
      // MOVEFILE_REPLACE_EXISTING). This used to unlink the target first on
      // win32, which opened a window with no gate state on disk and threw EPERM
      // whenever another handle held the file — aborting the entitlement check
      // itself. Same pattern as entitlement/store.js.
      fs.renameSync(tmp, fp);
    } catch (error) {
      if (process.platform !== "win32") throw error;
      // Windows can refuse to replace a file another handle has open; clear the
      // target instead of failing the write.
      try { fs.unlinkSync(fp); } catch (unlinkError) { if (unlinkError.code !== "ENOENT") throw unlinkError; }
      fs.renameSync(tmp, fp);
    }
    setOwnerOnlyPermissions(fp);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch {}
    throw error;
  }
}

function detectClockRollback(currentTimeMs, gateState) {
  return gateState.latest_observed_at > 0 && currentTimeMs < gateState.latest_observed_at - CLOCK_ROLLBACK_THRESHOLD_MS;
}

function updateMonotonicState(currentTimeMs, now, gateState) {
  const updated = { ...gateState };
  if (currentTimeMs > updated.latest_observed_at) updated.latest_observed_at = currentTimeMs;
  // NOTE: last_validated_at is reserved for ONLINE validation successes
  // (see online.js) — it must not be bumped by purely local checks, or the
  // offline grace window would be silently renewed by offline runs.
  return updated;
}

/**
 * Run the entitlement gate check.
 * @param {object} [options]
 * @param {string} [options.entitlementDir] - Override entitlement storage dir
 * @param {Date} [options.now] - Override current time (for testing)
 * @param {Function} [options._loadArtifact] - Override artifact loading (for testing)
 * @param {Function} [options._saveGateState] - Override state persistence (for testing)
 * @param {Function} [options._loadGateState] - Override state loading (for testing)
 * @param {string} [options.installationId] - Installation identity for binding checks
 * @returns {{ allowed: boolean, state: string, message: string, entitlement?: object, graceDaysRemaining?: number }}
 */
function checkEntitlement(options = {}) {
  const now = options.now || new Date();
  const currentTimeMs = now.getTime();
  const entitlementDir = options.entitlementDir;

  const loadState = options._loadGateState || (() => loadGateState(entitlementDir));
  const gateState = loadState();

  // Clock rollback detection
  if (detectClockRollback(currentTimeMs, gateState)) {
    return { allowed: false, state: GateState.CLOCK_ROLLBACK, message: GateMessages[GateState.CLOCK_ROLLBACK] };
  }

  // Load entitlement artifact
  const store = new EntitlementStore(entitlementDir);
  const artifact = options._loadArtifact ? options._loadArtifact() : store.load();

  // Cryptographic verification (includes installation binding for PHASE 13)
  const verification = verifyEntitlement(artifact, now, { entitlementDir, installationId: options.installationId });

  if (verification.state === EntitlementState.MISSING) {
    return { allowed: false, state: GateState.MISSING, message: GateMessages[GateState.MISSING] };
  }
  if (verification.state === EntitlementState.MALFORMED) {
    return { allowed: false, state: GateState.MALFORMED, message: GateMessages[GateState.MALFORMED] };
  }
  if (verification.state === EntitlementState.INVALID_SIGNATURE) {
    return { allowed: false, state: GateState.INVALID_SIGNATURE, message: GateMessages[GateState.INVALID_SIGNATURE] };
  }
  if (verification.state === EntitlementState.INSTALLATION_MISMATCH) {
    return { allowed: false, state: GateState.INSTALLATION_MISMATCH, message: GateMessages[GateState.INSTALLATION_MISMATCH] };
  }
  if (verification.legacy) {
    return { allowed: false, state: GateState.LEGACY_UNBOUND, message: GateMessages[GateState.LEGACY_UNBOUND] };
  }
  if (verification.state === EntitlementState.EXPIRED) {
    return { allowed: false, state: GateState.EXPIRED, message: GateMessages[GateState.EXPIRED] };
  }
  if (verification.state === EntitlementState.VALID) {
    const saveState = options._saveGateState || ((s) => saveGateState(s, entitlementDir));
    const updated = updateMonotonicState(currentTimeMs, now, gateState);
    saveState(updated);
    return { allowed: true, state: GateState.ALLOWED, message: GateMessages[GateState.ALLOWED], entitlement: verification.entitlement };
  }

  // Even for non-terminal invalid states (MISSING, MALFORMED, etc.) the clock
  // must still be observed: without bumping latest_observed_at, a local run
  // that happens to execute while the entitlement is temporarily missing (file
  // deleted, mid-rewrite) would freeze the timestamp and trigger a false
  // clock-rollback detection on the next valid run after the file is restored.
  const updated = updateMonotonicState(currentTimeMs, now, gateState);
  const saveState = options._saveGateState || ((s) => saveGateState(s, entitlementDir));
  saveState(updated);

  // Unknown state — fail closed
  return { allowed: false, state: GateState.MALFORMED, message: GateMessages[GateState.MALFORMED] };
}

module.exports = {
  checkEntitlement, GateState, GateMessages,
  OFFLINE_GRACE_DAYS, OFFLINE_GRACE_MS, CLOCK_ROLLBACK_THRESHOLD_MS,
  loadGateState, saveGateState, detectClockRollback, updateMonotonicState,
};
