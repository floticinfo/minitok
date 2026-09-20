"use strict";

const SCHEMA_VERSION = 1;
const VERIFIER_TYPES = Object.freeze(["command", "file", "test", "custom"]);
const EXECUTION_MODES = Object.freeze(["safe", "supervised", "authorized_external", "unrestricted", "workspace", "autonomous"]);
const DEFAULT_CONSTRAINTS = Object.freeze({
  allowed_paths: [],
  blocked_paths: [],
  max_cycles: 30,
  max_tokens: 0,
  timeout_ms: 0,
  stagnation_limit: 3,
  max_changed_files: 20,
  same_task_limit: 2,
  same_failure_limit: 2,
  requires_approval_for: [],
  repository_odd: { allowed_paths: [], protected_paths: [], required_checks: ["git_status", "git_diff", "changed_files", "protected_paths"], allow_external: false },
});
const DEFAULT_EXECUTION_POLICY = Object.freeze({ mode: "safe" });

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (isPlainObject(value)) {
    const result = {};
    for (const [key, child] of Object.entries(value)) Object.defineProperty(result, key, { value: clone(child), enumerable: true, writable: true, configurable: true });
    return result;
  }
  return value;
}

function createGoalSpec(input = {}) {
  if (!isPlainObject(input)) throw new TypeError("GoalSpec must be an object");
  const value = clone(input);
  if (!Object.prototype.hasOwnProperty.call(value, "schema_version")) value.schema_version = SCHEMA_VERSION;
  if (!Object.prototype.hasOwnProperty.call(value, "constraints")) value.constraints = clone(DEFAULT_CONSTRAINTS);
  if (!Object.prototype.hasOwnProperty.call(value, "execution_policy")) value.execution_policy = clone(DEFAULT_EXECUTION_POLICY);
  return value;
}

function serializeGoalSpec(spec) {
  if (!isPlainObject(spec)) throw new TypeError("GoalSpec must be an object");
  return JSON.stringify(spec);
}

function deserializeGoalSpec(serialized) {
  if (typeof serialized !== "string" || serialized.trim() === "") throw new TypeError("Serialized GoalSpec must be a non-empty JSON string");
  let parsed;
  try {
    parsed = JSON.parse(serialized);
  } catch (error) {
    throw new TypeError(`Serialized GoalSpec is invalid JSON: ${error.message}`, { cause: error });
  }
  if (!isPlainObject(parsed)) throw new TypeError("Serialized GoalSpec must contain an object");
  return parsed;
}

module.exports = {
  SCHEMA_VERSION,
  VERIFIER_TYPES,
  EXECUTION_MODES,
  DEFAULT_CONSTRAINTS,
  DEFAULT_EXECUTION_POLICY,
  isPlainObject,
  createGoalSpec,
  serializeGoalSpec,
  deserializeGoalSpec,
};
