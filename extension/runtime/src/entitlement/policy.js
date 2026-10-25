"use strict";

const { checkEntitlementOnline } = require("./online");
const { GateState } = require("./gate");
const { CURRENT_PLAN_IDS, isLegacyPlanId } = require("./model");
const { isTrialEntitlement, validateTrialEntitlement } = require("./trial");
const { takeDelegationTokenFromEnv, verifyRunDelegation } = require("./delegation");

function applyEntitlementPolicy(result, feature) {
  if (!result || !result.allowed) return result || { allowed: false, state: GateState.MISSING, message: "Entitlement is unavailable." };
  const planId = result.entitlement?.plan_id;
  if (!CURRENT_PLAN_IDS.includes(planId)) {
    // A retired plan id is never a runtime entitlement. The legacy rows on
    // the server stay readable, and the migration path normalizes them, but
    // the entitlement itself is not usable. The message says which case it
    // is so the holder is not left guessing.
    if (isLegacyPlanId(planId)) {
      return { ...result, allowed: false, state: GateState.SERVER_REJECTED, message: "This entitlement is on a retired plan that is no longer sold. A current Level 1 entitlement is required." };
    }
    return { ...result, allowed: false, state: GateState.SERVER_REJECTED, message: "A paid or server-issued trial entitlement is required." };
  }
  if (isTrialEntitlement(result.entitlement)) {
    const trial = validateTrialEntitlement(result.entitlement);
    if (!trial.valid) {
      return { ...result, allowed: false, state: trial.state === "EXPIRED" ? GateState.EXPIRED : GateState.SERVER_REJECTED, message: trial.reason };
    }
    if (feature && !result.entitlement?.features?.includes(feature)) {
      return { ...result, allowed: false, state: GateState.SERVER_REJECTED, message: `Trial entitlement does not include '${feature}'.` };
    }
    return { ...result, trial: true, remainingRuns: trial.remainingRuns, telemetryMode: trial.telemetryMode };
  }
  if (feature && !result.entitlement?.features?.includes(feature)) {
    return { ...result, allowed: false, state: GateState.SERVER_REJECTED, message: `Required entitlement feature '${feature}' is unavailable.` };
  }
  return result;
}

async function authorizeEntitlement(options = {}) {
  // Run delegation: an admin session in the extension host cannot cross the
  // process boundary, so the extension obtains a one-time, runId-bound token
  // from the server and passes it in the child environment. The token is read
  // and scrubbed exactly once here, which serves both the `run` preflight and
  // the pipeline's second gate call.
  const delegationToken = takeDelegationTokenFromEnv();
  if (delegationToken) {
    const delegation = await verifyRunDelegation(delegationToken, {
      serverUrl: options.serverUrl,
      runIds: options.delegationRunIds,
      _verify: options._verify,
    });
    return delegation;
  }
  const result = await checkEntitlementOnline(options);
  return applyEntitlementPolicy(result, options.feature);
}

module.exports = { authorizeEntitlement, applyEntitlementPolicy };
