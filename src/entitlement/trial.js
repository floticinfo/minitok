"use strict";

/**
 * Server-issued trial entitlement contract.
 *
 * A trial is not a free plan. It is a short-lived, installation-bound
 * entitlement issued by the licensing server. The server remains authoritative
 * for quota consumption; the client only validates the signed limits and
 * reports the server's current usage.
 */

const TRIAL_PLAN_ID = "trial";
const TRIAL_MAX_DAYS = 14;
const TRIAL_MAX_RUNS = 5;
const TRIAL_TELEMETRY_MODE = "off";

function parseTimestamp(value) {
  const time = typeof value === "string" ? new Date(value).getTime() : NaN;
  return Number.isFinite(time) ? time : null;
}

function validateTrialEntitlement(payload, now = new Date()) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { valid: false, reason: "Trial entitlement must be an object" };
  }
  if (payload.plan_id !== TRIAL_PLAN_ID) {
    return { valid: false, reason: "Trial entitlement must use plan_id 'trial'" };
  }
  if (!Array.isArray(payload.features) || payload.features.some((feature) => typeof feature !== "string")) {
    return { valid: false, reason: "Trial features must be an array of strings" };
  }
  if (payload.features.includes("evolution_upload") || payload.features.includes("aggregate_telemetry")) {
    return { valid: false, reason: "Trial entitlements cannot grant telemetry upload features" };
  }
  if (payload.telemetry_mode !== TRIAL_TELEMETRY_MODE) {
    return { valid: false, reason: "Trial telemetry_mode must be 'off'" };
  }
  if (!Number.isInteger(payload.run_quota) || payload.run_quota < 1 || payload.run_quota > TRIAL_MAX_RUNS) {
    return { valid: false, reason: `Trial run_quota must be an integer from 1 to ${TRIAL_MAX_RUNS}` };
  }
  if (!Number.isInteger(payload.runs_used) || payload.runs_used < 0 || payload.runs_used > payload.run_quota) {
    return { valid: false, reason: "Trial runs_used must be between zero and run_quota" };
  }
  const issuedAt = parseTimestamp(payload.issued_at);
  const expiresAt = parseTimestamp(payload.expires_at);
  if (issuedAt === null || expiresAt === null || expiresAt <= issuedAt) {
    return { valid: false, reason: "Trial issued_at/expires_at timestamps are invalid" };
  }
  if (expiresAt - issuedAt > TRIAL_MAX_DAYS * 24 * 60 * 60 * 1000) {
    return { valid: false, reason: `Trial duration cannot exceed ${TRIAL_MAX_DAYS} days` };
  }
  if (now.getTime() >= expiresAt) {
    return { valid: false, reason: "Trial entitlement has expired", state: "EXPIRED" };
  }
  return {
    valid: true,
    remainingRuns: payload.run_quota - payload.runs_used,
    telemetryMode: TRIAL_TELEMETRY_MODE,
  };
}

function isTrialEntitlement(payload) {
  return payload?.plan_id === TRIAL_PLAN_ID;
}

module.exports = {
  TRIAL_PLAN_ID,
  TRIAL_MAX_DAYS,
  TRIAL_MAX_RUNS,
  TRIAL_TELEMETRY_MODE,
  validateTrialEntitlement,
  isTrialEntitlement,
};
