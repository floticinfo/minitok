"use strict";

const { EXECUTION_MODES, SCHEMA_VERSION, VERIFIER_TYPES, isPlainObject } = require("./spec");
const ODD_CHECKS = new Set(["git_status", "git_diff", "test", "build", "typecheck", "lint", "changed_files", "protected_paths"]);

const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const FIELDS = {
  root: new Set(["schema_version", "goal_id", "objective", "success_criteria", "constraints", "execution_policy"]),
  criterion: new Set(["id", "description", "required", "verifier"]),
  verifier: new Set(["type", "id", "config"]),
  constraints: new Set(["allowed_paths", "blocked_paths", "max_cycles", "max_tokens", "timeout_ms", "stagnation_limit", "max_changed_files", "same_task_limit", "same_failure_limit", "requires_approval_for", "repository_odd"]),
  policy: new Set(["mode"]),
};

function issue(path, code, message) { return { path, code, message }; }
function requireString(value, path, errors) {
  if (typeof value !== "string" || value.trim() === "") {
    errors.push(issue(path, "INVALID_STRING", "Expected a non-empty string"));
    return false;
  }
  return true;
}
function unknownFields(value, allowed, path, errors) {
  if (!isPlainObject(value)) return;
  for (const key of Object.keys(value)) {
    if (DANGEROUS_KEYS.has(key)) errors.push(issue(`${path}.${key}`, "DANGEROUS_FIELD", "Dangerous object key is not allowed"));
    else if (!allowed.has(key)) errors.push(issue(`${path}.${key}`, "UNKNOWN_FIELD", "Unknown GoalSpec field is not allowed"));
  }
}
function validateRelativePath(value, path, errors) {
  if (typeof value !== "string" || value.trim() === "") {
    errors.push(issue(path, "INVALID_PATH", "Path must be a non-empty relative string"));
    return;
  }
  const normalized = value.replace(/\\/g, "/");
  if (normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized) || normalized.split("/").includes("..")) {
    errors.push(issue(path, "INVALID_PATH", "Path must remain inside the workspace and cannot traverse upward"));
  }
}
function validateSafeObject(value, path, errors) {
  for (const [key, child] of Object.entries(value)) {
    if (DANGEROUS_KEYS.has(key)) errors.push(issue(`${path}.${key}`, "DANGEROUS_FIELD", "Dangerous object key is not allowed"));
    else if (child && typeof child === "object") {
      if (Array.isArray(child)) child.forEach((item, index) => { if (item && typeof item === "object") validateSafeObject(item, `${path}.${key}[${index}]`, errors); });
      else if (isPlainObject(child)) validateSafeObject(child, `${path}.${key}`, errors);
      else errors.push(issue(`${path}.${key}`, "INVALID_CONFIG_VALUE", "Verifier config objects must be plain objects"));
    }
  }
}
function validateVerifier(value, path, errors) {
  if (!isPlainObject(value)) {
    errors.push(issue(path, "INVALID_VERIFIER", "verifier must be an object"));
    return;
  }
  unknownFields(value, FIELDS.verifier, path, errors);
  if (!VERIFIER_TYPES.includes(value.type)) errors.push(issue(`${path}.type`, "INVALID_VERIFIER_TYPE", `verifier.type must be one of: ${VERIFIER_TYPES.join(", ")}`));
  requireString(value.id, `${path}.id`, errors);
  if (!isPlainObject(value.config)) errors.push(issue(`${path}.config`, "INVALID_VERIFIER_CONFIG", "verifier.config must be an object"));
  else validateSafeObject(value.config, `${path}.config`, errors);
}


function validateRepositoryOdd(value, errors) {
  if (value === undefined) return;
  if (!isPlainObject(value)) { errors.push(issue("constraints.repository_odd", "INVALID_ODD", "repository_odd must be an object")); return; }
  const fields = new Set(["allowed_paths", "protected_paths", "required_checks", "allow_external"]);
  unknownFields(value, fields, "constraints.repository_odd", errors);
  for (const field of ["allowed_paths", "protected_paths"]) {
    if (!Array.isArray(value[field])) errors.push(issue(`constraints.repository_odd.${field}`, "INVALID_ODD_PATHS", `${field} must be an array`));
    else value[field].forEach((item, index) => validateRelativePath(item, `constraints.repository_odd.${field}[${index}]`, errors));
  }
  if (!Array.isArray(value.required_checks) || value.required_checks.some(check => !ODD_CHECKS.has(check))) errors.push(issue("constraints.repository_odd.required_checks", "INVALID_ODD_CHECK", "required_checks contains an unsupported repository check"));
  if (value.allow_external !== false) errors.push(issue("constraints.repository_odd.allow_external", "EXTERNAL_ACCESS_DISABLED", "External access is disabled in repository ODD"));
}
function validateConstraints(value, errors) {
  if (!isPlainObject(value)) {
    errors.push(issue("constraints", "INVALID_CONSTRAINTS", "constraints must be an object"));
    return;
  }
  unknownFields(value, FIELDS.constraints, "constraints", errors);
  validateRepositoryOdd(value.repository_odd, errors);
  for (const field of ["allowed_paths", "blocked_paths", "requires_approval_for"]) {
    if (!Array.isArray(value[field])) errors.push(issue(`constraints.${field}`, "INVALID_CONSTRAINT_LIST", `${field} must be an array`));
    else value[field].forEach((item, index) => {
      const itemPath = `constraints.${field}[${index}]`;
      if (field === "requires_approval_for") requireString(item, itemPath, errors);
      else validateRelativePath(item, itemPath, errors);
    });
  }
  if (!Number.isSafeInteger(value.max_cycles) || value.max_cycles < 1 || value.max_cycles > 10000) errors.push(issue("constraints.max_cycles", "INVALID_MAX_CYCLES", "max_cycles must be an integer from 1 to 10000"));
  for (const field of ["max_tokens", "max_changed_files", "same_task_limit", "same_failure_limit"]) {
    if (value[field] !== undefined && (!Number.isSafeInteger(value[field]) || value[field] < 0 || value[field] > 2000000)) errors.push(issue(`constraints.${field}`, "INVALID_CONSTRAINT_NUMBER", `${field} must be a non-negative safe integer`));
  }
  if (value.stagnation_limit !== undefined && (!Number.isSafeInteger(value.stagnation_limit) || value.stagnation_limit < 1 || value.stagnation_limit > 10000)) errors.push(issue("constraints.stagnation_limit", "INVALID_STAGNATION_LIMIT", "stagnation_limit must be an integer from 1 to 10000"));
  if (!Number.isSafeInteger(value.timeout_ms) || value.timeout_ms < 0 || value.timeout_ms > 2147483647) errors.push(issue("constraints.timeout_ms", "INVALID_TIMEOUT", "timeout_ms must be an integer from 0 to 2147483647"));
}

function validateExecutionPolicy(value, errors) {
  if (!isPlainObject(value)) {
    errors.push(issue("execution_policy", "INVALID_EXECUTION_POLICY", "execution_policy must be an object"));
    return;
  }
  unknownFields(value, FIELDS.policy, "execution_policy", errors);
  if (!EXECUTION_MODES.includes(value.mode)) errors.push(issue("execution_policy.mode", "INVALID_EXECUTION_MODE", `mode must be one of: ${EXECUTION_MODES.join(", ")}`));
}

function validateGoalSpec(spec) {
  const errors = [];
  if (!isPlainObject(spec)) return { valid: false, errors: [issue("$", "INVALID_OBJECT", "GoalSpec must be a plain object")] };
  unknownFields(spec, FIELDS.root, "$", errors);
  if (spec.schema_version !== SCHEMA_VERSION) errors.push(issue("schema_version", "UNSUPPORTED_SCHEMA_VERSION", `schema_version must be ${SCHEMA_VERSION}`));
  if (requireString(spec.goal_id, "goal_id", errors) && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(spec.goal_id)) errors.push(issue("goal_id", "INVALID_GOAL_ID", "goal_id must be a safe identifier of at most 128 characters"));
  requireString(spec.objective, "objective", errors);

  if (!Array.isArray(spec.success_criteria)) errors.push(issue("success_criteria", "INVALID_CRITERIA", "success_criteria must be an array"));
  else {
    const ids = new Set();
    let requiredCount = 0;
    spec.success_criteria.forEach((criterion, index) => {
      const path = `success_criteria[${index}]`;
      if (!isPlainObject(criterion)) {
        errors.push(issue(path, "INVALID_CRITERION", "Criterion must be an object"));
        return;
      }
      unknownFields(criterion, FIELDS.criterion, path, errors);
      if (requireString(criterion.id, `${path}.id`, errors)) {
        if (ids.has(criterion.id)) errors.push(issue(`${path}.id`, "DUPLICATE_CRITERION_ID", "Criterion ids must be unique"));
        ids.add(criterion.id);
      }
      requireString(criterion.description, `${path}.description`, errors);
      if (typeof criterion.required !== "boolean") errors.push(issue(`${path}.required`, "INVALID_REQUIRED", "required must be boolean"));
      else if (criterion.required) requiredCount += 1;
      validateVerifier(criterion.verifier, `${path}.verifier`, errors);
    });
    if (spec.success_criteria.length === 0) errors.push(issue("success_criteria", "CRITERIA_REQUIRED", "At least one success criterion is required"));
    if (requiredCount === 0) errors.push(issue("success_criteria", "REQUIRED_CRITERION_MISSING", "At least one criterion must be required"));
  }
  validateConstraints(spec.constraints, errors);
  validateExecutionPolicy(spec.execution_policy, errors);
  return { valid: errors.length === 0, errors };
}

function assertValidGoalSpec(spec) {
  const result = validateGoalSpec(spec);
  if (!result.valid) throw new TypeError(`Invalid GoalSpec: ${result.errors.map(item => `${item.path}: ${item.message}`).join("; ")}`);
  return spec;
}

module.exports = { validateGoalSpec, assertValidGoalSpec, validateRelativePath };
