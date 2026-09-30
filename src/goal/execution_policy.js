"use strict";

const {
  EXECUTION_CAPABILITIES,
  GENERAL_CAPABILITIES,
  ALWAYS_BLOCKED_OPERATIONS,
  validateCapabilities,
  isAlwaysBlockedCapability,
} = require("./capabilities");

const EXECUTION_POLICY_MODES = Object.freeze(["safe", "supervised", "authorized_external", "unrestricted", "unrestricted_general", "always_blocked"]);
const LEGACY_MODE_ALIASES = Object.freeze({ workspace: "supervised", autonomous: "supervised", never_autonomous: "always_blocked" });
const SAFE_CAPABILITIES = Object.freeze(["read", "inspect", "verify"]);
const EXTERNAL_CAPABILITIES = Object.freeze(["external_call", "credential_use", "publish", "deploy", "database_mutation", "force_push", "tag_overwrite"]);
const MUTATION_CAPABILITIES = Object.freeze(["workspace_write", "local_mutation"]);
const SIDE_EFFECT_CAPABILITY_MAP = Object.freeze({
  file_change: "workspace_write",
  external_call: "external_call",
  publish: "publish",
  deploy: "deploy",
  credential: "credential_use",
  database_mutation: "database_mutation",
});
const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const SOURCES = new Set(["cli", "mcp", "internal"]);

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function hasDangerousKey(value, path = "input") {
  if (Array.isArray(value)) return value.some((item, index) => hasDangerousKey(item, `${path}[${index}]`));
  if (!value || typeof value !== "object") return false;
  if (!isPlainObject(value)) return true;
  return Object.entries(value).some(([key, child]) => DANGEROUS_KEYS.has(key) || hasDangerousKey(child, `${path}.${key}`));
}
function normalizeMode(value) {
  if (value === undefined || value === null || value === "") return { mode: "safe", legacy: false, invalid: false };
  if (EXECUTION_POLICY_MODES.includes(value)) return { mode: value, legacy: false, invalid: false };
  if (LEGACY_MODE_ALIASES[value]) return { mode: LEGACY_MODE_ALIASES[value], legacy: true, invalid: false, requested: value };
  return { mode: "safe", legacy: false, invalid: true, requested: value };
}
function capabilityNames(value) {
  if (value === undefined) return [...SAFE_CAPABILITIES];
  return Array.isArray(value) ? [...new Set(value)] : value;
}
function capabilitiesForSideEffects(sideEffects = []) {
  const result = new Set();
  for (const effect of Array.isArray(sideEffects) ? sideEffects : []) {
    const capability = SIDE_EFFECT_CAPABILITY_MAP[effect];
    if (capability) result.add(capability);
  }
  return [...result];
}
function auditContext(input, normalized) {
  const actor = isPlainObject(input.actor) ? input.actor : {};
  return {
    source: SOURCES.has(input.source) ? input.source : "internal",
    requested_mode: typeof input.mode === "string" ? input.mode : null,
    effective_mode: normalized.mode,
    explicit_confirmation: input.explicit_confirmation === true,
    auto_accept: input.auto_accept === true,
    actor_present: Object.keys(actor).length > 0,
    credential_present: actor.credential_present === true,
    runtime_permission: input.runtime_permission === true,
    audit_persisted: input.audit_persisted === true,
    integrity_preflight: input.integrity_preflight === true,
  };
}
function baseDecision(mode, capabilities, context) {
  return { mode, allowed: true, capabilities, approval_required: false, denied_capabilities: [], always_blocked_capabilities: [], reason: "capabilities are allowed by the current execution policy", audit_context: context };
}
function configuredGoalPolicy(config) {
  const goal = config && typeof config === "object" && config.goal && typeof config.goal === "object" ? config.goal : null;
  const unrestricted = goal?.unrestricted && typeof goal.unrestricted === "object" ? goal.unrestricted : null;
  const unrestricted_general = goal?.unrestricted_general && typeof goal.unrestricted_general === "object" ? goal.unrestricted_general : null;
  return { goal, unrestricted, unrestricted_general };
}
function resolveExecutionPolicy(input = {}) {
  const configured = configuredGoalPolicy(input.config);
  const configuredDefaultMode = ["unrestricted", "unrestricted_general"].includes(configured.goal?.default_mode) ? "safe" : configured.goal?.default_mode;
  const requestedMode = input.mode === undefined ? configuredDefaultMode : input.mode;
  const configuredPolicy = input.mode === "unrestricted_general" ? configured.unrestricted_general : configured.unrestricted;
  const configuredCapabilities = Array.isArray(configuredPolicy?.capabilities) ? configuredPolicy.capabilities : undefined;
  const requested = ["unrestricted", "unrestricted_general"].includes(input.mode) && input.capabilities === undefined && configuredCapabilities ? [...configuredCapabilities] : capabilityNames(input.capabilities);
  const normalized = normalizeMode(requestedMode);
  const context = auditContext(input, normalized);
  if (hasDangerousKey(input)) return { ...baseDecision(normalized.mode, [], context), allowed: false, denied_capabilities: ["invalid_input"], reason: "dangerous object key or non-plain policy input was rejected" };
  if (normalized.invalid) return { ...baseDecision("safe", [], context), allowed: false, denied_capabilities: ["invalid_mode"], reason: "unknown execution mode was rejected" };
  if (!Array.isArray(requested)) return { ...baseDecision(normalized.mode, [], context), allowed: false, denied_capabilities: ["invalid_capabilities"], reason: "capabilities must be an array" };
  const validation = validateCapabilities(requested, { allow_general: normalized.mode === "unrestricted_general" });
  const unknown = validation.errors.filter(error => error.code === "UNKNOWN_CAPABILITY").map(error => requested[Number(error.path.match(/\[(\d+)\]/)?.[1])]);
  const alwaysBlocked = requested.filter(capability => isAlwaysBlockedCapability(capability));
  const invalid = validation.errors.filter(error => !["UNKNOWN_CAPABILITY", "ALWAYS_BLOCKED_CAPABILITY"].includes(error.code));
  if (unknown.length || invalid.length || alwaysBlocked.length) {
    return { ...baseDecision(normalized.mode, requested.filter(capability => EXECUTION_CAPABILITIES.includes(capability) || GENERAL_CAPABILITIES.includes(capability)), context), allowed: false, denied_capabilities: [...unknown, ...invalid.map(error => error.code)], always_blocked_capabilities: [...alwaysBlocked, ...Object.keys(ALWAYS_BLOCKED_OPERATIONS).filter(operation => requested.includes(operation))], reason: alwaysBlocked.length ? "one or more capabilities are always blocked" : unknown.length ? "unknown capability was rejected" : "invalid capability input was rejected" };
  }
  if (normalized.mode === "always_blocked") return { ...baseDecision(normalized.mode, requested, context), allowed: false, always_blocked_capabilities: requested, reason: "always_blocked policy rejects every capability" };
  if (normalized.mode === "unrestricted_general" && !configuredPolicy) return { ...baseDecision(normalized.mode, requested, context), allowed: false, denied_capabilities: ["unrestricted_general_disabled"], reason: "unrestricted_general mode requires an explicit configuration" };
  if (["unrestricted", "unrestricted_general"].includes(normalized.mode) && configuredPolicy) {
    if (configuredPolicy.enabled !== true) return { ...baseDecision(normalized.mode, requested, context), allowed: false, denied_capabilities: [normalized.mode === "unrestricted_general" ? "unrestricted_general_disabled" : "unrestricted_disabled"], reason: `${normalized.mode} mode is disabled by configuration` };
    const allowlist = Array.isArray(configuredPolicy.capabilities) ? configuredPolicy.capabilities : [];
    const outsideAllowlist = requested.filter(capability => !allowlist.includes(capability) && !SAFE_CAPABILITIES.includes(capability));
    if (outsideAllowlist.length) return { ...baseDecision(normalized.mode, requested, context), allowed: false, denied_capabilities: outsideAllowlist, reason: "one or more capabilities are outside the configured allowlist" };
    if (configuredPolicy.require_explicit_confirmation !== false && input.explicit_confirmation !== true) return { ...baseDecision(normalized.mode, requested, context), allowed: false, denied_capabilities: ["explicit_confirmation"], reason: "explicit confirmation is required by configuration" };
    if (configuredPolicy.require_auto_accept !== false && input.auto_accept !== true) return { ...baseDecision(normalized.mode, requested, context), allowed: false, denied_capabilities: ["auto_accept"], reason: "auto_accept is required by configuration" };
    if (normalized.mode === "unrestricted_general") {
      if (input.runtime_permission !== true) return { ...baseDecision(normalized.mode, requested, context), allowed: false, denied_capabilities: ["unrestricted_general_permission"], reason: "unrestricted_general runtime permission is required" };
      if (input.audit_persisted !== true) return { ...baseDecision(normalized.mode, requested, context), allowed: false, denied_capabilities: ["audit_persistence"], reason: "persisted audit is required before unrestricted_general execution" };
      if (input.integrity_preflight !== true) return { ...baseDecision(normalized.mode, requested, context), allowed: false, denied_capabilities: ["integrity_preflight"], reason: "integrity preflight is required" };
      if (requested.includes("goal_inference") && configuredPolicy.allow_goal_inference !== true) return { ...baseDecision(normalized.mode, requested, context), allowed: false, denied_capabilities: ["goal_inference"], reason: "goal inference is disabled by configuration" };
      if (requested.includes("criteria_inference") && configuredPolicy.allow_provisional_criteria !== true) return { ...baseDecision(normalized.mode, requested, context), allowed: false, denied_capabilities: ["criteria_inference"], reason: "provisional criteria inference is disabled by configuration" };
      if (requested.includes("replanning") && configuredPolicy.allow_replanning !== true) return { ...baseDecision(normalized.mode, requested, context), allowed: false, denied_capabilities: ["replanning"], reason: "replanning is disabled by configuration" };
      if (requested.includes("tool_discovery") && configuredPolicy.allow_tool_discovery !== true) return { ...baseDecision(normalized.mode, requested, context), allowed: false, denied_capabilities: ["tool_discovery"], reason: "tool discovery is disabled by configuration" };
      if (requested.some(capability => EXTERNAL_CAPABILITIES.includes(capability)) && configuredPolicy.allow_external_adapters !== true) return { ...baseDecision(normalized.mode, requested, context), allowed: false, denied_capabilities: requested.filter(capability => EXTERNAL_CAPABILITIES.includes(capability)), reason: "external adapters are disabled by configuration" };
      const maxPlanDepth = input.max_plan_depth ?? configuredPolicy.max_plan_depth;
      const maxReplanCount = input.max_replan_count ?? configuredPolicy.max_replan_count;
      const maxAssumptionCount = input.max_assumption_count ?? configuredPolicy.max_assumption_count;
      if (!Number.isSafeInteger(maxPlanDepth) || maxPlanDepth < 1 || !Number.isSafeInteger(maxReplanCount) || maxReplanCount < 0 || !Number.isSafeInteger(maxAssumptionCount) || maxAssumptionCount < 1) return { ...baseDecision(normalized.mode, requested, context), allowed: false, denied_capabilities: ["budget_limits"], reason: "unrestricted_general budget limits are required" };
    }
  }
  const denied = [];
  const approval = [];
  if (normalized.mode === "safe") {
    for (const capability of requested) if (!SAFE_CAPABILITIES.includes(capability)) denied.push(capability);
  } else if (normalized.mode === "supervised") {
    for (const capability of requested) if (!SAFE_CAPABILITIES.includes(capability) && !MUTATION_CAPABILITIES.includes(capability)) approval.push(capability);
    if (input.explicit_confirmation !== true) for (const capability of requested) if (MUTATION_CAPABILITIES.includes(capability)) approval.push(capability);
  } else if (normalized.mode === "authorized_external") {
    for (const capability of requested) if (!SAFE_CAPABILITIES.includes(capability) && !MUTATION_CAPABILITIES.includes(capability) && !EXTERNAL_CAPABILITIES.includes(capability)) denied.push(capability);
    if (input.explicit_confirmation !== true) approval.push(...requested.filter(capability => MUTATION_CAPABILITIES.includes(capability) || EXTERNAL_CAPABILITIES.includes(capability)));
    if (requested.includes("credential_use") && input.actor?.credential_present !== true) denied.push("credential_use");
  } else if (["unrestricted", "unrestricted_general"].includes(normalized.mode)) {
    if (input.explicit_confirmation !== true) denied.push("explicit_confirmation");
    if (input.auto_accept !== true) denied.push("auto_accept");
    if (input.actor && !isPlainObject(input.actor)) denied.push("actor");
    if (requested.includes("credential_use") && input.actor?.credential_present !== true) denied.push("credential_use");
  }
  const uniqueDenied = [...new Set(denied)];
  const uniqueApproval = [...new Set(approval)].filter(capability => !uniqueDenied.includes(capability));
  const allowed = uniqueDenied.length === 0 && uniqueApproval.length === 0;
  return { ...baseDecision(normalized.mode, requested, context), allowed, approval_required: uniqueApproval.length > 0, denied_capabilities: uniqueDenied, always_blocked_capabilities: [], reason: allowed ? (["unrestricted", "unrestricted_general"].includes(normalized.mode) ? `explicit ${normalized.mode} authorization allows the requested capabilities` : "capabilities are allowed by the current execution policy") : uniqueApproval.length ? "explicit approval is required for one or more capabilities" : "one or more capabilities are denied by the current execution policy" };
}
function assertExecutionAllowed(input = {}) {
  const decision = resolveExecutionPolicy(input);
  if (!decision.allowed) {
    const error = Object.assign(new Error(decision.reason), { code: decision.always_blocked_capabilities.length ? "ALWAYS_BLOCKED" : decision.approval_required ? "APPROVAL_REQUIRED" : "EXECUTION_POLICY_DENIED", policy: decision });
    throw error;
  }
  return decision;
}
module.exports = { EXECUTION_POLICY_MODES, GENERAL_CAPABILITIES, LEGACY_MODE_ALIASES, SAFE_CAPABILITIES, EXTERNAL_CAPABILITIES, MUTATION_CAPABILITIES, SIDE_EFFECT_CAPABILITY_MAP, normalizeMode, capabilitiesForSideEffects, resolveExecutionPolicy, assertExecutionAllowed };
