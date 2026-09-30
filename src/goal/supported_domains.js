"use strict";

const DOMAIN_STATUSES = Object.freeze(["supported", "approval_required", "clarification_required", "unsupported"]);
const EXECUTION_BOUNDARIES = Object.freeze(["local_bounded", "authorized_external", "clarification_only", "unsupported"]);
const DOMAIN_PROFILES = Object.freeze({
  repository_local: Object.freeze({ domain: "repository_local", goal_types: Object.freeze(["file_change", "feature_addition", "bug_fix", "test_addition", "documentation", "refactoring"]), status: "supported", execution_boundary: "local_bounded", capabilities: Object.freeze(["read", "inspect", "verify", "workspace_write"]) }),
  repository_improvement: Object.freeze({ domain: "repository_improvement", goal_types: Object.freeze(["abstract_improvement"]), status: "clarification_required", execution_boundary: "clarification_only", capabilities: Object.freeze(["read", "inspect", "verify"]) }),
  external_operation: Object.freeze({ domain: "external_operation", goal_types: Object.freeze(["external_operation", "release", "deployment"]), status: "approval_required", execution_boundary: "authorized_external", capabilities: Object.freeze(["read", "inspect", "verify", "external_call", "publish", "deploy"]) }),
  unknown: Object.freeze({ domain: "unknown", goal_types: Object.freeze(["ambiguous"]), status: "clarification_required", execution_boundary: "clarification_only", capabilities: Object.freeze(["read", "inspect", "verify"]) }),
});
const DOMAIN_BY_GOAL_TYPE = Object.freeze(Object.fromEntries(Object.values(DOMAIN_PROFILES).flatMap(profile => profile.goal_types.map(goalType => [goalType, profile.domain]))));
function profileForGoalType(goalType) { return DOMAIN_PROFILES[DOMAIN_BY_GOAL_TYPE[goalType] || "unknown"]; }
function candidateGoalTypes(goalType, objective = "") {
  if (goalType === "abstract_improvement") return ["abstract_improvement", "refactoring", "feature_addition"];
  if (goalType !== "ambiguous") return [goalType];
  const text = String(objective).toLowerCase();
  if (/improve|better|stabilize|modernize|optimi[sz]e/.test(text)) return ["abstract_improvement", "refactoring", "feature_addition"];
  if (/service|system|workflow|process/.test(text)) return ["feature_addition", "refactoring", "external_operation"];
  return ["file_change", "feature_addition", "abstract_improvement"];
}
function assessGoalSupport(input = {}) {
  const goalType = input.goal_type || "ambiguous";
  const profile = profileForGoalType(goalType);
  const confidence = typeof input.confidence === "number" ? Math.max(0, Math.min(1, input.confidence)) : 0;
  const unsafe = input.unsafe === true;
  if (unsafe) return { status: "unsupported", domain: "unknown", execution_boundary: "unsupported", reasons: ["Always-blocked integrity operation detected", "unsafe_intent", "always_blocked_or_sensitive_request"], capabilities: [] };
  if (goalType === "ambiguous" || confidence < 0.4) return { status: "clarification_required", domain: profile.domain, execution_boundary: "clarification_only", reasons: [goalType === "ambiguous" ? "goal_type_ambiguous" : "confidence_too_low"], capabilities: profile.capabilities };
  if (profile.status === "approval_required") return { status: "approval_required", domain: profile.domain, execution_boundary: profile.execution_boundary, reasons: ["external_authorization_required"], capabilities: profile.capabilities };
  if (profile.status === "clarification_required" || confidence < 0.6) return { status: "clarification_required", domain: profile.domain, execution_boundary: "clarification_only", reasons: [confidence < 0.6 ? "confidence_requires_clarification" : "domain_requires_acceptance_boundary"], capabilities: profile.capabilities };
  return { status: profile.status, domain: profile.domain, execution_boundary: profile.execution_boundary, reasons: [], capabilities: profile.capabilities };
}
function supportedDomainNames() { return Object.keys(DOMAIN_PROFILES); }
module.exports = { DOMAIN_STATUSES, EXECUTION_BOUNDARIES, DOMAIN_PROFILES, DOMAIN_BY_GOAL_TYPE, profileForGoalType, candidateGoalTypes, assessGoalSupport, supportedDomainNames };
