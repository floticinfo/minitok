"use strict";

const STRATEGIES = Object.freeze({
  model_output_invalid: { action: "structured_retry", role: "plan", detail: "Request the same intent using strict structured output" },
  planning_error: { action: "replan", role: "plan", detail: "Rebuild the plan from the failure evidence" },
  implementation_error: { action: "repair_task", role: "work", detail: "Create a repair task from implementation logs" },
  verification_failure: { action: "alternative_strategy", role: "work", detail: "Use an alternative implementation strategy using verifier evidence" },
  environment_failure: { action: "reobserve_environment", role: "intel", detail: "Re-observe workspace and environment before retrying" },
  permission_blocked: { action: "escalate_approval", role: "recovery", detail: "Request human approval or escalate" },
  timeout: { action: "reduce_scope", role: "recovery", detail: "Reduce task scope before retrying" },
  repeated_failure: { action: "switch_model", role: "recovery", detail: "Switch to a model with stronger recovery capability" },
  scope_violation: { action: "replan_scope", role: "plan", detail: "Discard the out-of-scope patch and replan" },
  unknown: { action: "escalate", role: "recovery", detail: "Failure cause is unknown; require escalation" },
});
function recoveryFor(category) { return STRATEGIES[category] || STRATEGIES.unknown; }
function buildRecoveryTask(failure, context = {}) {
  const strategy = recoveryFor(failure.failure_category || "unknown");
  const priorTasks = new Set(context.previous_tasks || []);
  const priorPatches = new Set(context.previous_patch_signatures || []);
  const base = `${strategy.action}: ${failure.task || "current task"}`;
  const suffix = priorTasks.has(base) || (failure.patch_signature && priorPatches.has(failure.patch_signature)) ? " Use a different implementation strategy and do not repeat the previous patch." : "";
  return `${base}. ${strategy.detail}. Failure: ${String(failure.error || "unknown").slice(0, 500)}${suffix}`;
}
module.exports = { STRATEGIES, recoveryFor, buildRecoveryTask };
