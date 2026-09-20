"use strict";

const { redactValue } = require("./evidence");
const { EXECUTION_CAPABILITIES, CAPABILITY_METADATA, ALWAYS_BLOCKED_OPERATIONS, validateCapabilities, assertValidCapabilities, getCapabilityMetadata, isAlwaysBlockedCapability, validateCapabilityContract } = require("./capabilities");

const PLAN_VERSION = 1;
const STEP_SOURCES = Object.freeze(["explicit", "inferred", "recovery"]);
const STEP_RISKS = Object.freeze(["low", "medium", "high", "critical"]);
const STEP_STATUSES = Object.freeze(["proposed", "ready", "blocked", "pending", "running", "completed", "failed", "skipped", "deferred"]);
const EXECUTION_POLICIES = Object.freeze(["safe", "supervised", "authorized_external", "unrestricted", "unrestricted_general", "never_autonomous", "always_blocked"]);
const SIDE_EFFECTS = Object.freeze(["file_change", "external_call", "publish", "deploy", "credential", "database_mutation"]);
const APPROVAL_REQUIREMENTS = Object.freeze([...SIDE_EFFECTS]);
const PLAN_FIELDS = new Set(["objective", "explicit_steps", "inferred_steps", "dependencies", "success_criteria", "scope_boundary", "risk_level", "approval_requirements", "assumptions", "plan_version", "execution_policy", "requested_capabilities", "granted_capabilities", "denied_capabilities", "requires_explicit_confirmation", "always_blocked_actions"]);
const STEP_FIELDS = new Set(["id", "description", "source", "required", "depends_on", "target_criteria", "risk", "side_effects", "verification", "status", "rationale", "execution_policy"]);
const SCOPE_FIELDS = new Set(["allowed_paths", "blocked_paths", "protected_paths", "allow_external"]);
const DEPENDENCY_FIELDS = new Set(["step_id", "depends_on"]);
const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function issue(path, code, message) { return { path, code, message }; }
function nonEmptyString(value) { return typeof value === "string" && value.trim() !== ""; }
function unknownFields(value, allowed, path, errors) {
  if (!isPlainObject(value)) return;
  for (const key of Object.keys(value)) {
    if (DANGEROUS_KEYS.has(key)) errors.push(issue(`${path}.${key}`, "DANGEROUS_FIELD", "Dangerous object key is not allowed"));
    else if (!allowed.has(key)) errors.push(issue(`${path}.${key}`, "UNKNOWN_FIELD", "Unknown GoalPlan field is not allowed"));
  }
}
function validateRelativePath(value, path, errors) {
  if (!nonEmptyString(value)) { errors.push(issue(path, "INVALID_PATH", "Path must be a non-empty relative string")); return; }
  const normalized = value.replace(/\\/g, "/");
  if (normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized) || normalized.split("/").includes("..")) errors.push(issue(path, "INVALID_PATH", "Path must remain inside the workspace and cannot traverse upward"));
}
function validateSafeValue(value, path, errors) {
  if (Array.isArray(value)) { value.forEach((item, index) => validateSafeValue(item, `${path}[${index}]`, errors)); return; }
  if (!value || typeof value !== "object") return;
  if (!isPlainObject(value)) { errors.push(issue(path, "INVALID_OBJECT", "Nested plan values must be plain objects")); return; }
  for (const [key, child] of Object.entries(value)) {
    if (DANGEROUS_KEYS.has(key)) errors.push(issue(`${path}.${key}`, "DANGEROUS_FIELD", "Dangerous object key is not allowed"));
    else validateSafeValue(child, `${path}.${key}`, errors);
  }
}
function criterionIds(criteria) { return new Set(criteria.map(item => typeof item === "string" ? item : item?.id).filter(nonEmptyString)); }
function validateCriteria(value, errors) {
  if (!Array.isArray(value) || value.length === 0) { errors.push(issue("success_criteria", "INVALID_CRITERIA", "success_criteria must be a non-empty array")); return; }
  const ids = new Set();
  value.forEach((criterion, index) => {
    const path = `success_criteria[${index}]`;
    const id = typeof criterion === "string" ? criterion : criterion?.id;
    if (!nonEmptyString(id)) errors.push(issue(`${path}.id`, "INVALID_CRITERION_ID", "Criterion id must be a non-empty string"));
    else if (ids.has(id)) errors.push(issue(`${path}.id`, "DUPLICATE_CRITERION_ID", "Criterion ids must be unique"));
    else ids.add(id);
    if (criterion && typeof criterion === "object") validateSafeValue(criterion, path, errors);
  });
}

function detectSideEffects(step) {
  const text = `${step.description || ""} ${step.rationale || ""} ${typeof step.verification === "string" ? step.verification : JSON.stringify(step.verification || {})}`.toLowerCase();
  const detected = new Set(Array.isArray(step.side_effects) ? step.side_effects : []);
  if (/\b(file|files|write|writes|modify|create|delete|remove|patch|edit)\b/.test(text)) detected.add("file_change");
  if (/\b(external|outside|http|https|network|remote|api|mcp)\b/.test(text)) detected.add("external_call");
  if (/\b(publish|npm\s+publish|registry)\b/.test(text)) { detected.add("publish"); detected.add("external_call"); }
  if (/\b(deploy|deployment|staging|production)\b/.test(text)) { detected.add("deploy"); detected.add("external_call"); }
  if (/\b(credential|token|password|secret|api[_ -]?key|private\s+key|auth)\b/.test(text)) detected.add("credential");
  if (/\b(database|db|sql|migration|mutation|insert|update|delete\s+from)\b/.test(text)) detected.add("database_mutation");
  return [...detected];
}
function approvalRequirementsFor(sideEffects) { return sideEffects.filter(effect => APPROVAL_REQUIREMENTS.includes(effect)); }
const CAPABILITY_BY_SIDE_EFFECT = Object.freeze({ file_change: "workspace_write", external_call: "external_call", publish: "publish", deploy: "deploy", credential: "credential_use", database_mutation: "database_mutation" });
function capabilitiesForSideEffects(sideEffects = []) { return [...new Set(sideEffects.map(effect => CAPABILITY_BY_SIDE_EFFECT[effect]).filter(Boolean))]; }
function capabilitiesForStep(step = {}) {
  const text = `${step.description || ""} ${step.rationale || ""}`.toLowerCase();
  const capabilities = new Set(capabilitiesForSideEffects(step.side_effects));
  if (/\bforce\s+push\b/.test(text)) capabilities.add("force_push");
  if (/\b(?:tag\s+overwrite|overwrite\s+tag)\b/.test(text)) capabilities.add("tag_overwrite");
  return [...capabilities];
}
function capabilitiesForSteps(steps = []) { return [...new Set(steps.flatMap(step => capabilitiesForStep(step)))]; }
function normalizedCapabilityList(value) { return Array.isArray(value) ? [...new Set(value.filter(nonEmptyString))] : []; }
const NEVER_AUTONOMOUS_PATTERN = /(?:private\s+key|secret\s+(?:output|export|extract|reveal)|extract(?:ing)?\s+(?:a\s+)?private\s+key|force\s+push|tag\s+overwrite|overwrite\s+tag|approval\s+bypass|bypass\s+approval|destructive\s+(?:database|db)|drop\s+(?:database|table)|delete\s+from)/i;
function policyFor(sideEffects, requested, text = "") {
  if (requested === "always_blocked" || requested === "never_autonomous" || NEVER_AUTONOMOUS_PATTERN.test(text)) return requested === "always_blocked" ? "always_blocked" : "never_autonomous";
  if (requested === "unrestricted") return "unrestricted";
  if (sideEffects.some(effect => ["publish", "deploy", "credential", "database_mutation", "external_call"].includes(effect))) return "authorized_external";
  if (requested === "authorized_external") return requested;
  if (requested === "supervised" || sideEffects.includes("file_change")) return "supervised";
  return "safe";
}
function normalizeStep(step, source) {
  const value = redactValue(step || {});
  const sideEffects = detectSideEffects(value);
  const policyText = `${value.description || ""} ${value.rationale || ""} ${typeof value.verification === "string" ? value.verification : JSON.stringify(value.verification || {})}`;
  return { id: value.id, description: value.description, source, required: value.required !== false, depends_on: Array.isArray(value.depends_on) ? [...value.depends_on] : [], target_criteria: Array.isArray(value.target_criteria) ? [...value.target_criteria] : [], risk: value.risk || (sideEffects.length ? "medium" : "low"), side_effects: sideEffects, verification: value.verification === undefined ? {} : value.verification, status: value.status || "proposed", rationale: value.rationale, execution_policy: policyFor(sideEffects, value.execution_policy, policyText) };
}
function createGoalPlan(input = {}) {
  if (!isPlainObject(input)) throw new TypeError("GoalPlan must be an object");
  const value = redactValue(input);
  const explicit = Array.isArray(value.explicit_steps) ? value.explicit_steps.map(step => normalizeStep(step, "explicit")) : [];
  const inferred = Array.isArray(value.inferred_steps) ? value.inferred_steps.map(step => normalizeStep(step, step?.source === "recovery" ? "recovery" : "inferred")) : [];
  const steps = [...explicit, ...inferred];
  const approvals = new Set(Array.isArray(value.approval_requirements) ? value.approval_requirements : []);
  steps.forEach(step => approvalRequirementsFor(step.side_effects).forEach(item => approvals.add(item)));
  const scope = value.scope_boundary || {};
  const sideEffectCapabilities = capabilitiesForSteps(steps);
  const requestedCapabilities = [...new Set([...normalizedCapabilityList(value.requested_capabilities), ...sideEffectCapabilities])];
  const alwaysBlockedActions = [...new Set([...normalizedCapabilityList(value.always_blocked_actions), ...steps.filter(step => ["never_autonomous", "always_blocked"].includes(step.execution_policy)).map(step => step.id)])];
  const executionPolicy = steps.some(step => step.execution_policy === "always_blocked") ? "always_blocked" : steps.some(step => step.execution_policy === "never_autonomous") ? "never_autonomous" : value.execution_policy === "unrestricted" || steps.some(step => step.execution_policy === "unrestricted") ? "unrestricted" : steps.some(step => step.execution_policy === "authorized_external") ? "authorized_external" : policyFor(steps.flatMap(step => step.side_effects), value.execution_policy);
  const grantedCapabilities = normalizedCapabilityList(value.granted_capabilities).length ? normalizedCapabilityList(value.granted_capabilities) : (executionPolicy === "unrestricted" ? [] : requestedCapabilities.filter(capability => ["read", "inspect", "verify"].includes(capability)));
  const deniedCapabilities = [...new Set([...normalizedCapabilityList(value.denied_capabilities), ...requestedCapabilities.filter(capability => !grantedCapabilities.includes(capability))])];
  const requiresExplicitConfirmation = value.requires_explicit_confirmation === undefined ? requestedCapabilities.some(capability => !["read", "inspect", "verify"].includes(capability)) || executionPolicy === "unrestricted" : value.requires_explicit_confirmation === true;
  return { plan_version: value.plan_version === undefined ? PLAN_VERSION : value.plan_version, objective: value.objective, explicit_steps: explicit, inferred_steps: inferred, dependencies: Array.isArray(value.dependencies) ? value.dependencies : [], success_criteria: Array.isArray(value.success_criteria) ? value.success_criteria : [], scope_boundary: { allowed_paths: scope.allowed_paths || [], blocked_paths: scope.blocked_paths || [], protected_paths: scope.protected_paths || [], allow_external: scope.allow_external === true }, risk_level: value.risk_level || "low", approval_requirements: [...approvals], assumptions: Array.isArray(value.assumptions) ? value.assumptions : [], execution_policy: executionPolicy, requested_capabilities: requestedCapabilities, granted_capabilities: grantedCapabilities, denied_capabilities: deniedCapabilities, requires_explicit_confirmation: requiresExplicitConfirmation, always_blocked_actions: alwaysBlockedActions };
}

function validateScope(value, errors, executionPolicy = "safe") {
  if (!isPlainObject(value)) { errors.push(issue("scope_boundary", "INVALID_SCOPE", "scope_boundary must be an object")); return; }
  unknownFields(value, SCOPE_FIELDS, "scope_boundary", errors);
  for (const field of ["allowed_paths", "blocked_paths", "protected_paths"]) {
    if (!Array.isArray(value[field])) errors.push(issue(`scope_boundary.${field}`, "INVALID_PATHS", `${field} must be an array`));
    else value[field].forEach((item, index) => validateRelativePath(item, `scope_boundary.${field}[${index}]`, errors));
  }
  if (value.allow_external === undefined) value.allow_external = false;
  else if (typeof value.allow_external !== "boolean") errors.push(issue("scope_boundary.allow_external", "INVALID_BOOLEAN", "allow_external must be boolean"));
  if (value.allow_external === true && executionPolicy !== "unrestricted") errors.push(issue("scope_boundary.allow_external", "EXTERNAL_ACCESS_DISABLED", "External access is disabled unless the GoalPlan execution policy is unrestricted"));
}
function pathMatchesScope(file, prefix) { const item = String(file || "").replace(/\\/g, "/").replace(/^\.\//, ""); const base = String(prefix || "").replace(/\\/g, "/").replace(/^\.\//, ""); return item === base || item.startsWith(`${base}/`); }
function pathAllowedByScope(file, scope) {
  const candidate = String(file || "").replace(/\\/g, "/").replace(/^\.\//, "");
  if (!candidate || candidate.split("/").includes("..") || candidate.startsWith("/")) return false;
  if (scope.blocked_paths.some(prefix => pathMatchesScope(candidate, prefix))) return false;
  if (scope.protected_paths.some(prefix => pathMatchesScope(candidate, prefix))) return false;
  return scope.allowed_paths.length === 0 || scope.allowed_paths.some(prefix => pathMatchesScope(candidate, prefix));
}
function stepVerificationPaths(step) { const verification = step?.verification; return [...new Set([...(Array.isArray(verification?.paths) ? verification.paths : []), ...(typeof verification?.path === "string" ? [verification.path] : [])].filter(nonEmptyString))]; }
function validateDependency(value, path, stepIds, errors) {
  if (typeof value === "string") { if (!stepIds.has(value)) errors.push(issue(path, "UNKNOWN_STEP", "Dependency references an unknown step")); return; }
  if (!isPlainObject(value)) { errors.push(issue(path, "INVALID_DEPENDENCY", "Dependency must be a step id or object")); return; }
  unknownFields(value, DEPENDENCY_FIELDS, path, errors);
  if (!nonEmptyString(value.step_id) || !stepIds.has(value.step_id)) errors.push(issue(`${path}.step_id`, "UNKNOWN_STEP", "Dependency step_id must reference a known step"));
  if (!Array.isArray(value.depends_on)) errors.push(issue(`${path}.depends_on`, "INVALID_DEPENDENCY_LIST", "Dependency depends_on must be an array"));
  else value.depends_on.forEach((id, index) => { if (!nonEmptyString(id) || !stepIds.has(id)) errors.push(issue(`${path}.depends_on[${index}]`, "UNKNOWN_STEP", "Dependency references an unknown step")); });
}
function validateStep(step, path, expectedSource, stepIds, criterionSet, errors) {
  if (!isPlainObject(step)) { errors.push(issue(path, "INVALID_STEP", "Step must be a plain object")); return; }
  unknownFields(step, STEP_FIELDS, path, errors);
  for (const field of ["id", "description"]) if (!nonEmptyString(step[field])) errors.push(issue(`${path}.${field}`, "INVALID_STRING", `${field} must be a non-empty string`));
  if (step.source !== expectedSource) errors.push(issue(`${path}.source`, "INVALID_STEP_SOURCE", `Step source must be ${expectedSource}`));
  if (!STEP_SOURCES.includes(step.source)) errors.push(issue(`${path}.source`, "INVALID_STEP_SOURCE", `source must be one of: ${STEP_SOURCES.join(", ")}`));
  if (typeof step.required !== "boolean") errors.push(issue(`${path}.required`, "INVALID_REQUIRED", "required must be boolean"));
  for (const field of ["depends_on", "target_criteria", "side_effects"]) if (!Array.isArray(step[field])) errors.push(issue(`${path}.${field}`, "INVALID_LIST", `${field} must be an array`));
  if (Array.isArray(step.depends_on)) step.depends_on.forEach((id, index) => { if (!nonEmptyString(id) || !stepIds.has(id) || id === step.id) errors.push(issue(`${path}.depends_on[${index}]`, "INVALID_DEPENDENCY", "depends_on must reference another known step")); });
  if (Array.isArray(step.target_criteria)) step.target_criteria.forEach((id, index) => { if (!nonEmptyString(id) || !criterionSet.has(id)) errors.push(issue(`${path}.target_criteria[${index}]`, "UNKNOWN_CRITERION", "target_criteria must reference a known success criterion")); });
  if (Array.isArray(step.side_effects)) step.side_effects.forEach((effect, index) => { if (!SIDE_EFFECTS.includes(effect)) errors.push(issue(`${path}.side_effects[${index}]`, "INVALID_SIDE_EFFECT", `side_effects must be one of: ${SIDE_EFFECTS.join(", ")}`)); });
  if (!STEP_RISKS.includes(step.risk)) errors.push(issue(`${path}.risk`, "INVALID_RISK", `risk must be one of: ${STEP_RISKS.join(", ")}`));
  if (!STEP_STATUSES.includes(step.status)) errors.push(issue(`${path}.status`, "INVALID_STATUS", `status must be one of: ${STEP_STATUSES.join(", ")}`));
  if (step.rationale !== undefined && !nonEmptyString(step.rationale)) errors.push(issue(`${path}.rationale`, "INVALID_RATIONALE", "rationale must be a non-empty string when provided"));
  if (expectedSource === "inferred" && !nonEmptyString(step.rationale)) errors.push(issue(`${path}.rationale`, "RATIONALE_REQUIRED", "Inferred steps require a non-empty rationale"));
  if ((expectedSource === "inferred" || expectedSource === "recovery") && (!step.target_criteria?.length && !step.depends_on?.length)) errors.push(issue(path, "UNRELATED_STEP", "Inferred or recovery steps must target a criterion or depend on another step"));
  if (step.execution_policy !== undefined && !EXECUTION_POLICIES.includes(step.execution_policy)) errors.push(issue(`${path}.execution_policy`, "INVALID_EXECUTION_POLICY", `execution_policy must be one of: ${EXECUTION_POLICIES.join(", ")}`));
  if (!Object.prototype.hasOwnProperty.call(step, "verification")) errors.push(issue(`${path}.verification`, "VERIFICATION_REQUIRED", "Every step requires a verification field"));
  else validateSafeValue(step.verification, `${path}.verification`, errors);
}


function validateGoalPlan(plan) {
  const errors = [];
  if (!isPlainObject(plan)) return { valid: false, errors: [issue("$", "INVALID_OBJECT", "GoalPlan must be a plain object")] };
  unknownFields(plan, PLAN_FIELDS, "$", errors);
  if (plan.plan_version !== PLAN_VERSION) errors.push(issue("plan_version", "UNSUPPORTED_PLAN_VERSION", `plan_version must be ${PLAN_VERSION}`));
  if (!nonEmptyString(plan.objective)) errors.push(issue("objective", "INVALID_STRING", "objective must be a non-empty string"));
  for (const field of ["explicit_steps", "inferred_steps", "dependencies", "success_criteria", "approval_requirements", "assumptions"]) if (!Array.isArray(plan[field])) errors.push(issue(field, "INVALID_LIST", `${field} must be an array`));
  for (const field of ["requested_capabilities", "granted_capabilities", "denied_capabilities", "always_blocked_actions"]) if (plan[field] !== undefined && !Array.isArray(plan[field])) errors.push(issue(field, "INVALID_LIST", `${field} must be an array`));
  if (plan.requires_explicit_confirmation !== undefined && typeof plan.requires_explicit_confirmation !== "boolean") errors.push(issue("requires_explicit_confirmation", "INVALID_BOOLEAN", "requires_explicit_confirmation must be boolean"));
  if (!STEP_RISKS.includes(plan.risk_level)) errors.push(issue("risk_level", "INVALID_RISK", `risk_level must be one of: ${STEP_RISKS.join(", ")}`));
  if (!EXECUTION_POLICIES.includes(plan.execution_policy)) errors.push(issue("execution_policy", "INVALID_EXECUTION_POLICY", `execution_policy must be one of: ${EXECUTION_POLICIES.join(", ")}`));
  for (const field of ["requested_capabilities", "granted_capabilities", "denied_capabilities"]) {
    if (plan[field] === undefined) continue;
    const result = validateCapabilities(Array.isArray(plan[field]) ? plan[field] : []);
    if (!result.valid) errors.push(...result.errors.map(error => ({ ...error, path: `${field}.${error.path}` })));
  }
  if (Array.isArray(plan.always_blocked_actions)) plan.always_blocked_actions.forEach((action, index) => { if (!nonEmptyString(action)) errors.push(issue(`always_blocked_actions[${index}]`, "INVALID_ACTION", "always_blocked_actions entries must be non-empty strings")); });
  validateCriteria(plan.success_criteria, errors);
  validateScope(plan.scope_boundary, errors, plan.execution_policy);
  const explicit = Array.isArray(plan.explicit_steps) ? plan.explicit_steps : [];
  const inferred = Array.isArray(plan.inferred_steps) ? plan.inferred_steps : [];
  const steps = [...explicit, ...inferred];
  const stepIds = new Set();
  steps.forEach((step, index) => { if (isPlainObject(step) && nonEmptyString(step.id)) { if (stepIds.has(step.id)) errors.push(issue(`steps[${index}].id`, "DUPLICATE_STEP_ID", "Step ids must be unique")); stepIds.add(step.id); } });
  const criteria = criterionIds(Array.isArray(plan.success_criteria) ? plan.success_criteria : []);
  explicit.forEach((step, index) => validateStep(step, `explicit_steps[${index}]`, "explicit", stepIds, criteria, errors));
  inferred.forEach((step, index) => validateStep(step, `inferred_steps[${index}]`, isPlainObject(step) && step.source === "recovery" ? "recovery" : "inferred", stepIds, criteria, errors));
  if (Array.isArray(plan.dependencies)) plan.dependencies.forEach((dependency, index) => validateDependency(dependency, `dependencies[${index}]`, stepIds, errors));
  const requiredCapabilities = new Set(capabilitiesForSteps(steps));
  const requestedCapabilities = new Set(Array.isArray(plan.requested_capabilities) ? plan.requested_capabilities : []);
  const grantedCapabilities = new Set(Array.isArray(plan.granted_capabilities) ? plan.granted_capabilities : []);
  const deniedCapabilities = new Set(Array.isArray(plan.denied_capabilities) ? plan.denied_capabilities : []);
  const hasCapabilityFields = ["requested_capabilities", "granted_capabilities", "denied_capabilities"].some(field => plan[field] !== undefined);
  if (hasCapabilityFields) for (const capability of requiredCapabilities) if (!requestedCapabilities.has(capability)) errors.push(issue("requested_capabilities", "CAPABILITY_REQUIRED", `Inferred or explicit side effects require capability: ${capability}`));
  for (const capability of grantedCapabilities) if (!requestedCapabilities.has(capability)) errors.push(issue("granted_capabilities", "CAPABILITY_NOT_REQUESTED", `Granted capability was not requested: ${capability}`));
  for (const capability of deniedCapabilities) if (!requestedCapabilities.has(capability)) errors.push(issue("denied_capabilities", "CAPABILITY_NOT_REQUESTED", `Denied capability was not requested: ${capability}`));
  if (grantedCapabilities.has("workspace_write")) for (const step of steps) for (const file of stepVerificationPaths(step)) if (!pathAllowedByScope(file, plan.scope_boundary)) errors.push(issue("scope_boundary", "CAPABILITY_SCOPE_CONFLICT", `Workspace capability path is outside the allowed scope: ${file}`));
  if (grantedCapabilities.has("external_call") && plan.scope_boundary?.allow_external !== true) errors.push(issue("scope_boundary.allow_external", "CAPABILITY_SCOPE_CONFLICT", "Granted external capability requires allow_external: true"));
  if (hasCapabilityFields && plan.execution_policy === "unrestricted" && plan.requires_explicit_confirmation !== true) errors.push(issue("requires_explicit_confirmation", "CONFIRMATION_REQUIRED", "Unrestricted plans require explicit confirmation"));
  if (hasCapabilityFields && Array.isArray(plan.always_blocked_actions) && plan.always_blocked_actions.length && plan.execution_policy === "unrestricted") errors.push(issue("always_blocked_actions", "ALWAYS_BLOCKED_ACTION", "Unrestricted plans cannot contain always-blocked actions"));
  const requiredApprovals = new Set();
  for (const step of steps) for (const effect of Array.isArray(step.side_effects) ? step.side_effects : []) requiredApprovals.add(effect);
  if (Array.isArray(plan.approval_requirements)) {
    plan.approval_requirements.forEach((requirement, index) => { if (!APPROVAL_REQUIREMENTS.includes(requirement)) errors.push(issue(`approval_requirements[${index}]`, "INVALID_APPROVAL_REQUIREMENT", `approval_requirements must be one of: ${APPROVAL_REQUIREMENTS.join(", ")}`)); });
    for (const requirement of requiredApprovals) if (!plan.approval_requirements.includes(requirement)) errors.push(issue("approval_requirements", "APPROVAL_REQUIRED", `Approval requirement ${requirement} is required by a step side effect`));
  }
  if (Array.isArray(plan.assumptions)) plan.assumptions.forEach((item, index) => { if (!nonEmptyString(item)) errors.push(issue(`assumptions[${index}]`, "INVALID_ASSUMPTION", "Assumptions must be non-empty strings")); });
  return { valid: errors.length === 0, errors };
}
function assertValidGoalPlan(plan) {
  const result = validateGoalPlan(plan);
  if (!result.valid) throw new TypeError(`Invalid GoalPlan: ${result.errors.map(item => `${item.path}: ${item.message}`).join("; ")}`);
  return plan;
}
function serializeGoalPlan(plan) { assertValidGoalPlan(plan); return JSON.stringify(redactValue(plan)); }
function deserializeGoalPlan(serialized) {
  if (typeof serialized !== "string" || serialized.trim() === "") throw new TypeError("Serialized GoalPlan must be a non-empty JSON string");
  let parsed;
  try { parsed = JSON.parse(serialized); } catch (error) { throw new TypeError(`Serialized GoalPlan is invalid JSON: ${error.message}`, { cause: error }); }
  const redacted = redactValue(parsed);
  const legacySteps = [...(Array.isArray(redacted.explicit_steps) ? redacted.explicit_steps : []), ...(Array.isArray(redacted.inferred_steps) ? redacted.inferred_steps : [])];
  const legacyCapabilities = capabilitiesForSteps(legacySteps);
  const migrated = { requested_capabilities: legacyCapabilities, granted_capabilities: [], denied_capabilities: legacyCapabilities, requires_explicit_confirmation: legacyCapabilities.some(capability => !["read", "inspect", "verify"].includes(capability)), always_blocked_actions: [], ...redacted };
  assertValidGoalPlan(migrated);
  return migrated;
}
module.exports = { PLAN_VERSION, STEP_SOURCES, STEP_RISKS, STEP_STATUSES, EXECUTION_POLICIES, SIDE_EFFECTS, APPROVAL_REQUIREMENTS, EXECUTION_CAPABILITIES, CAPABILITY_METADATA, ALWAYS_BLOCKED_OPERATIONS, validateCapabilities, assertValidCapabilities, getCapabilityMetadata, isAlwaysBlockedCapability, validateCapabilityContract, capabilitiesForSideEffects, capabilitiesForSteps, createGoalPlan, validateGoalPlan, assertValidGoalPlan, serializeGoalPlan, deserializeGoalPlan, detectSideEffects };
