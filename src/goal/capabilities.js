"use strict";

const LEVELS = Object.freeze({ low: 1, medium: 2, high: 3 });
const DEFAULT_CAPABILITIES = Object.freeze({ structured_output: false, tool_calling: false, repository_navigation: "low", code_editing: "low", error_recovery: "low", long_horizon: "low" });
const ROLE_REQUIREMENTS = Object.freeze({ intel: { repository_navigation: "low" }, plan: { repository_navigation: "high", long_horizon: "medium" }, work: { code_editing: "high", tool_calling: true }, review: { structured_output: true, repository_navigation: "medium" }, goal_evaluation: { structured_output: true, error_recovery: "medium" }, goal_specification: { structured_output: true, repository_navigation: "medium" }, specification: { structured_output: true, repository_navigation: "medium" }, recovery: { error_recovery: "high", code_editing: "medium" }, completion_authority: { structured_output: true } });
const OBSERVATION_DEFINITIONS = Object.freeze({ structured_output: { aliases: ["structured_json_output_success", "structured_output_success"], failure_key: "structured_output" }, tool_calling: { aliases: ["tool_action_proposal_success", "tool_calling_success"], failure_key: "tool_calling" }, repository_navigation: { aliases: ["repository_navigation_success"], failure_key: "repository_navigation" }, code_editing: { aliases: ["patch_application_success", "code_editing_success"], failure_key: "patch_application" }, error_recovery: { aliases: ["verifier_failure_recovery_success", "error_recovery_success"], failure_key: "verifier_failure_recovery" }, long_horizon: { aliases: ["long_horizon_completion_success"], failure_key: "long_horizon" }, completion_authority: { aliases: ["completion_authority_success"], failure_key: "false_completion", inverted_source: "false_completion" }, repeated_action_control: { aliases: ["repeated_action_avoided", "repeated_action_success"], failure_key: "repeated_action", inverted_source: "repeated_action" } });
function normalizeCapabilityContract(input = {}) {
  const declared = { ...DEFAULT_CAPABILITIES, ...(input.declared_capabilities || input.capabilities || {}) };
  return { provider: input.provider || "unknown", model: input.model || "unknown", capabilities: declared, declared_capabilities: declared, observed_capabilities: { ...(input.observed_capabilities || {}) }, observed_failures: { ...(input.observed_failures || {}) }, observation_counts: { ...(input.observation_counts || {}) }, confidence: input.confidence || { overall: "insufficient_observations", by_capability: {} }, last_measured_at: input.last_measured_at || null };
}
function capabilityScore(model, role) { const contract = normalizeCapabilityContract(model); const required = ROLE_REQUIREMENTS[role] || {}; return Object.entries(required).reduce((score, [key, value]) => score + (typeof value === "boolean" ? (contract.capabilities[key] === value ? 3 : -5) : LEVELS[contract.capabilities[key]] >= LEVELS[value] ? LEVELS[contract.capabilities[key]] : -2), 0); }
function meets(model, minimum = {}) { const c = normalizeCapabilityContract(model).capabilities; return Object.entries(minimum).every(([key, value]) => typeof value === "boolean" ? c[key] === value : LEVELS[c[key]] >= LEVELS[value]); }
function observationValue(record, definition) {
  const sources = [record?.behavior_observations, record?.observations, record?.behavior_metrics, record];
  for (const source of sources) {
    if (!source || typeof source !== "object") continue;
    if (definition.inverted_source && typeof source[definition.inverted_source] === "boolean") return !source[definition.inverted_source];
    for (const alias of definition.aliases) if (typeof source[alias] === "boolean") return source[alias];
  }
  return null;
}
function observeCapabilityProfile(model, records = [], options = {}) {
  const minObservations = Number.isSafeInteger(options.minObservations) && options.minObservations > 0 ? options.minObservations : 3;
  const threshold = typeof options.successThreshold === "number" ? options.successThreshold : 0.8;
  const modelKey = model.model || model.id;
  const matching = records.filter(record => record?.model_profile === modelKey || record?.model === modelKey || record?.model_id === modelKey);
  const observed_capabilities = {}; const observed_failures = {}; const observation_counts = {}; const by_capability = {};
  for (const [capability, definition] of Object.entries(OBSERVATION_DEFINITIONS)) {
    const values = matching.map(record => observationValue(record, definition)).filter(value => typeof value === "boolean");
    const failures = values.filter(value => value === false).length;
    observation_counts[capability] = values.length; observed_failures[definition.failure_key] = (observed_failures[definition.failure_key] || 0) + failures;
    if (values.length < minObservations) { observed_capabilities[capability] = null; by_capability[capability] = "insufficient_observations"; continue; }
    observed_capabilities[capability] = values.filter(Boolean).length / values.length >= threshold;
    by_capability[capability] = values.length >= minObservations * 2 ? "high" : "medium";
  }
  const sufficient = Object.values(observation_counts).some(count => count >= minObservations);
  return { provider: model.provider || "unknown", model: model.model || model.id || "unknown", declared_capabilities: { ...normalizeCapabilityContract(model).declared_capabilities }, observed_capabilities, observed_failures, observation_counts, confidence: { overall: sufficient ? "medium" : "insufficient_observations", by_capability }, last_measured_at: options.lastMeasuredAt || new Date().toISOString() };
}
function observeCapabilityProfiles(models = [], records = [], options = {}) { return models.map(model => ({ ...model, ...observeCapabilityProfile(model, records, options) })); }
const ROLE_OBSERVATION_KEYS = Object.freeze({ specification: "structured_output", goal_specification: "structured_output", recovery: "error_recovery", work: "tool_calling", completion_authority: "completion_authority" });
function isExcludedByObservedFailure(model, role, options = {}) {
  const contract = normalizeCapabilityContract(model); const key = ROLE_OBSERVATION_KEYS[role]; if (!key) return false;
  const count = Number(contract.observation_counts?.[key]) || 0; const minimum = Number.isSafeInteger(options.minObservations) && options.minObservations > 0 ? options.minObservations : 3; if (count < minimum) return false;
  const failureKey = OBSERVATION_DEFINITIONS[key]?.failure_key || key; const failures = Number(contract.observed_failures?.[failureKey]) || 0; const failureLimit = key === "completion_authority" ? 1 : (Number.isSafeInteger(options.minObservedFailures) && options.minObservedFailures > 0 ? options.minObservedFailures : 2);
  return failures >= failureLimit || contract.observed_capabilities?.[key] === false;
}
function selectModel(models, role, options = {}) { const excluded = new Set(options.exclude || []); const candidates = models.filter(model => !excluded.has(model.model) && !isExcludedByObservedFailure(model, role, options) && meets(model, options.minimum || {})); if (!candidates.length) throw new Error(`No model capability satisfies role '${role}'`); return candidates.sort((a, b) => capabilityScore(b, role) - capabilityScore(a, role))[0]; }
function routeRole(models, role, options = {}) {
  const minimum = { ...(ROLE_REQUIREMENTS[role] || {}), ...(options.minimum || {}) };
  const candidates = models.filter(model => !isExcludedByObservedFailure(model, role, options) && meets(model, minimum));
  if (!candidates.length) throw new Error(`No model capability satisfies role '${role}'`);
  if (role === "intel" && options.preferStrong !== true) return candidates.sort((a, b) => capabilityScore(a, role) - capabilityScore(b, role))[0];
  return selectModel(candidates, role, options);
}
const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const EXECUTION_CAPABILITIES = Object.freeze([
  "read", "inspect", "verify", "workspace_write", "local_mutation", "external_call",
  "credential_use", "publish", "deploy", "database_mutation", "force_push", "tag_overwrite",
  "protected_path_write",
]);
const CAPABILITY_METADATA = Object.freeze(Object.fromEntries([
  ["read", { side_effect: false, default_approval: false, default_execution_policy: "safe", unrestricted_allowed: true, always_blocked: false, verification_required: false }],
  ["inspect", { side_effect: false, default_approval: false, default_execution_policy: "safe", unrestricted_allowed: true, always_blocked: false, verification_required: false }],
  ["verify", { side_effect: false, default_approval: false, default_execution_policy: "safe", unrestricted_allowed: true, always_blocked: false, verification_required: true }],
  ["workspace_write", { side_effect: true, default_approval: true, default_execution_policy: "supervised", unrestricted_allowed: true, always_blocked: false, verification_required: true }],
  ["local_mutation", { side_effect: true, default_approval: true, default_execution_policy: "supervised", unrestricted_allowed: true, always_blocked: false, verification_required: true }],
  ["external_call", { side_effect: true, default_approval: true, default_execution_policy: "authorized_external", unrestricted_allowed: true, always_blocked: false, verification_required: true }],
  ["credential_use", { side_effect: true, default_approval: true, default_execution_policy: "authorized_external", unrestricted_allowed: true, always_blocked: false, verification_required: true }],
  ["publish", { side_effect: true, default_approval: true, default_execution_policy: "authorized_external", unrestricted_allowed: true, always_blocked: false, verification_required: true }],
  ["deploy", { side_effect: true, default_approval: true, default_execution_policy: "authorized_external", unrestricted_allowed: true, always_blocked: false, verification_required: true }],
  ["database_mutation", { side_effect: true, default_approval: true, default_execution_policy: "authorized_external", unrestricted_allowed: true, always_blocked: false, verification_required: true }],
  ["force_push", { side_effect: true, default_approval: true, default_execution_policy: "authorized_external", unrestricted_allowed: true, always_blocked: false, verification_required: true }],
  ["tag_overwrite", { side_effect: true, default_approval: true, default_execution_policy: "authorized_external", unrestricted_allowed: true, always_blocked: false, verification_required: true }],
  ["protected_path_write", { side_effect: true, default_approval: true, default_execution_policy: "always_blocked", unrestricted_allowed: false, always_blocked: true, verification_required: true }],
].map(([name, metadata]) => [name, Object.freeze(metadata)])));
const ALWAYS_BLOCKED_OPERATIONS = Object.freeze({
  private_key_exposure: "Private key material must never be exposed",
  credential_value_logging: "Credential values must never be logged or returned",
  authorization_header_logging: "Authorization headers must never be logged or returned",
  password_logging: "Passwords must never be logged or returned",
  token_logging: "Tokens must never be logged or returned",
  approval_bypass: "Approval controls must never be bypassed",
});
function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function capabilityIssue(path, code, message) { return { path, code, message }; }
function validateCapabilityList(value, path = "capabilities") {
  const errors = [];
  if (!Array.isArray(value)) return { valid: false, errors: [capabilityIssue(path, "INVALID_CAPABILITIES", "Capabilities must be an array")] };
  const seen = new Set();
  value.forEach((capability, index) => {
    const itemPath = `${path}[${index}]`;
    if (typeof capability !== "string" || capability.trim() === "") errors.push(capabilityIssue(itemPath, "INVALID_CAPABILITY", "Capability must be a non-empty string"));
    else if (!EXECUTION_CAPABILITIES.includes(capability)) errors.push(capabilityIssue(itemPath, "UNKNOWN_CAPABILITY", `Unknown capability: ${capability}`));
    else if (isAlwaysBlockedCapability(capability)) errors.push(capabilityIssue(itemPath, "ALWAYS_BLOCKED_CAPABILITY", `Capability is always blocked: ${capability}`));
    else if (seen.has(capability)) errors.push(capabilityIssue(itemPath, "DUPLICATE_CAPABILITY", `Duplicate capability: ${capability}`));
    else seen.add(capability);
  });
  return { valid: errors.length === 0, errors };
}

function validateCapabilities(value) {
  if (Array.isArray(value)) return validateCapabilityList(value);
  if (!isPlainObject(value)) return { valid: false, errors: [capabilityIssue("capabilities", "INVALID_CAPABILITIES", "Capabilities must be an array or { capabilities: [] }")] };
  const errors = [];
  for (const key of Object.keys(value)) {
    if (DANGEROUS_KEYS.has(key)) errors.push(capabilityIssue(`capabilities.${key}`, "DANGEROUS_FIELD", "Dangerous object key is not allowed"));
    else if (key !== "capabilities") errors.push(capabilityIssue(`capabilities.${key}`, "UNKNOWN_FIELD", "Unknown capability contract field is not allowed"));
  }
  if (Object.prototype.hasOwnProperty.call(value, "capabilities")) errors.push(...validateCapabilityList(value.capabilities).errors);
  else errors.push(capabilityIssue("capabilities", "INVALID_CAPABILITIES", "Capability contract must declare capabilities"));
  return { valid: errors.length === 0, errors };
}
function assertValidCapabilities(value) {
  const result = validateCapabilities(value);
  if (!result.valid) throw new TypeError(`Invalid capabilities: ${result.errors.map(item => `${item.path}: ${item.message}`).join("; ")}`);
  return value;
}
function getCapabilityMetadata(capability) { return CAPABILITY_METADATA[capability] || null; }
function isAlwaysBlockedCapability(capability) { return getCapabilityMetadata(capability)?.always_blocked === true; }
function validateCapabilityContract() {
  const errors = [];
  const requiredFields = ["side_effect", "default_approval", "default_execution_policy", "unrestricted_allowed", "always_blocked", "verification_required"];
  const names = Object.keys(CAPABILITY_METADATA);
  if (names.length !== EXECUTION_CAPABILITIES.length || names.some(name => !EXECUTION_CAPABILITIES.includes(name))) errors.push(capabilityIssue("metadata", "CAPABILITY_METADATA_MISMATCH", "Capability metadata must match the canonical capability list"));
  for (const capability of EXECUTION_CAPABILITIES) {
    const metadata = CAPABILITY_METADATA[capability];
    if (!metadata) { errors.push(capabilityIssue(`metadata.${capability}`, "MISSING_METADATA", "Capability metadata is required")); continue; }
    for (const field of requiredFields) if (!Object.prototype.hasOwnProperty.call(metadata, field)) errors.push(capabilityIssue(`metadata.${capability}.${field}`, "MISSING_METADATA_FIELD", "Capability metadata field is required"));
    if (typeof metadata.side_effect !== "boolean" || typeof metadata.default_approval !== "boolean" || typeof metadata.unrestricted_allowed !== "boolean" || typeof metadata.always_blocked !== "boolean" || typeof metadata.verification_required !== "boolean") errors.push(capabilityIssue(`metadata.${capability}`, "INVALID_METADATA", "Capability metadata boolean fields must be boolean"));
    if (typeof metadata.default_execution_policy !== "string" || !["safe", "supervised", "authorized_external", "always_blocked"].includes(metadata.default_execution_policy)) errors.push(capabilityIssue(`metadata.${capability}.default_execution_policy`, "INVALID_METADATA_POLICY", "Capability metadata has an invalid default execution policy"));
    if (metadata.always_blocked && (metadata.unrestricted_allowed || metadata.default_execution_policy !== "always_blocked")) errors.push(capabilityIssue(`metadata.${capability}`, "INCONSISTENT_BLOCKING_METADATA", "Always-blocked capability cannot be unrestricted or executable"));
  }
  return { valid: errors.length === 0, errors };
}

module.exports = {
  LEVELS, DEFAULT_CAPABILITIES, ROLE_REQUIREMENTS, OBSERVATION_DEFINITIONS, ROLE_OBSERVATION_KEYS,
  normalizeCapabilityContract, capabilityScore, selectModel, routeRole, observeCapabilityProfile,
  observeCapabilityProfiles, isExcludedByObservedFailure, EXECUTION_CAPABILITIES, CAPABILITY_METADATA,
  ALWAYS_BLOCKED_OPERATIONS, validateCapabilityList, validateCapabilities, assertValidCapabilities,
  getCapabilityMetadata, isAlwaysBlockedCapability, validateCapabilityContract,
};
