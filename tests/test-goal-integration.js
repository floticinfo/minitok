"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createGoalSpec } = require("../src/goal/spec");
const { createGoalPlan, validateGoalPlan } = require("../src/goal/plan");
const { prepareGoalExecution } = require("../src/goal/integration");

function spec(objective = "Fix the bug in src/parser.js", id = "integration-goal", criteria = [{ id: "fix", description: "The bug is fixed", required: true, verifier: { type: "custom", id: "verify-fix", config: {} } }], mode = "safe") {
  return createGoalSpec({ schema_version: 1, goal_id: id, objective, success_criteria: criteria, constraints: { allowed_paths: [], blocked_paths: [".git", ".env"], max_cycles: 3, max_tokens: 0, timeout_ms: 0, stagnation_limit: 3, max_changed_files: 10, same_task_limit: 2, same_failure_limit: 2, requires_approval_for: [] }, execution_policy: { mode } });
}
function odd(allowed_paths = ["src", "tests"]) { return { repository_odd: { allowed_paths, blocked_paths: [".git", ".env"], protected_paths: ["VERIFY_CMD.mjs"], allow_external: false } }; }
function existingPlan() {
  return createGoalPlan({ objective: "Fix the bug in src/parser.js", explicit_steps: [], inferred_steps: [{ id: "existing-fix", description: "Use the existing fix plan", required: true, target_criteria: ["fix"], rationale: "The persisted plan already defines the required fix.", verification: { type: "custom", id: "existing-check", config: {} }, status: "proposed" }], dependencies: [], success_criteria: [{ id: "fix", description: "The bug is fixed", required: true }], scope_boundary: { allowed_paths: ["src"], blocked_paths: [".git"], protected_paths: ["VERIFY_CMD.mjs"], allow_external: false }, risk_level: "low", approval_requirements: [], assumptions: [], execution_policy: "safe" });
}

for (const relative of ["src/cli/commands/goal.js", "src/mcp/goal-tools.js", "extension/runtime/src/mcp/goal-tools.js"]) {
  test(`goal entry point imports shared integration: ${relative}`, () => {
    const source = fs.readFileSync(path.join(__dirname, "..", relative), "utf8");
    assert.match(source, /goal\/integration/);
    assert.match(source, /prepareGoalExecution/);
  });
}

test("reuses an existing valid GoalPlan without re-expanding", () => {
  const plan = existingPlan();
  const result = prepareGoalExecution({ goal_spec: spec(), existing_goal_plan: plan, mode: "safe" });
  assert.equal(result.status, "ready");
  assert.equal(result.goal_plan, plan);
  assert.equal(result.expansion.already_expanded, true);
  assert.deepEqual(result.inferred_steps.map(step => step.id), ["existing-fix"]);
});

test("automatically expands a GoalSpec and creates a validated GoalPlan", () => {
  const result = prepareGoalExecution({ goal_spec: spec(), repository_context: odd(["src"]) });
  assert.equal(result.status, "ready");
  assert.ok(result.goal_plan);
  assert.equal(validateGoalPlan(result.goal_plan).valid, true);
  assert.equal(result.inferred_steps[0].target_criteria.includes("fix"), true);
  assert.equal(result.goal_plan.inferred_steps[0].source, "inferred");
});

test("missing success criteria returns clarification_required without inventing a verifier", () => {
  const result = prepareGoalExecution({ objective: "Improve the architecture", success_criteria: [] });
  assert.equal(result.status, "clarification_required");
  assert.ok(result.questions.length >= 1);
  assert.equal(result.goal_plan, null);
});

test("release objectives create required inferred steps and separate optional follow-up", () => {
  const result = prepareGoalExecution({ goal_spec: spec("Prepare a release with version bump, tests, and package verification", "release-goal", [{ id: "release", description: "The release is verified", required: true, verifier: { type: "custom", id: "verify-release", config: {} } }]), repository_context: odd(["src", "tests"]) });
  assert.equal(result.status, "ready");
  assert.deepEqual(result.inferred_steps.slice(0, 3).map(step => step.id), ["release-version", "release-tests", "release-package"]);
  assert.ok(result.optional_steps.every(step => step.required === false));
  assert.ok(result.optional_steps.every(step => step.status === "deferred"));
});

test("simple file goals do not add release or deploy work", () => {
  const result = prepareGoalExecution({ goal_spec: spec("Fix the bug in src/parser.js"), repository_context: odd(["src"]) });
  assert.deepEqual(result.inferred_steps.map(step => step.id), ["goal-change"]);
  assert.equal(result.inferred_steps.some(step => /release|deploy|publish/i.test(step.description)), false);
});

test("scope-out inferred work is excluded and reported", () => {
  const result = prepareGoalExecution({ goal_spec: spec("Fix the bug in outside/secret.js"), repository_context: odd(["src"]) });
  assert.equal(result.status, "clarification_required");
  assert.equal(result.goal_plan, null);
  assert.equal(result.inferred_steps?.length || 0, 0);
  assert.equal(result.out_of_scope_candidates[0].status, "not_added");
});

test("safe mode denies required workspace capability without granting it", () => {
  const result = prepareGoalExecution({ goal_spec: spec(), repository_context: odd(["src"]), mode: "safe" });
  assert.equal(result.status, "ready");
  assert.equal(result.requested_capabilities.includes("workspace_write"), true);
  assert.equal(result.granted_capabilities.includes("workspace_write"), false);
  assert.equal(result.denied_capabilities.includes("workspace_write"), true);
  assert.equal(result.execution_policy.mode, "safe");
  assert.equal(result.requires_user_confirmation, true);
});

test("unrestricted mode still requires configured authorization and preserves allowlisted capability", () => {
  const result = prepareGoalExecution({ goal_spec: spec("Fix the bug in src/parser.js", "unrestricted-goal", undefined, "unrestricted"), repository_context: odd(["src"]), mode: "unrestricted", explicit_confirmation: true, auto_accept: true, config: { goal: { unrestricted: { enabled: true, capabilities: ["workspace_write"], require_explicit_confirmation: true, require_auto_accept: true } } } });
  assert.equal(result.status, "ready");
  assert.equal(result.execution_policy.allowed, true);
  assert.deepEqual(result.denied_capabilities, []);
  assert.deepEqual(result.granted_capabilities, ["workspace_write"]);
});

test("invalid existing GoalPlan fails closed", () => {
  const invalidPlan = { objective: "Fix the bug in src/parser.js", inferred_steps: [{ id: "unrelated", description: "unrelated", required: true, target_criteria: [], verification: {} }] };
  const result = prepareGoalExecution({ goal_spec: spec(), existing_goal_plan: invalidPlan });
  assert.equal(result.status, "invalid");
  assert.equal(result.goal_plan, null);
  assert.ok(result.errors.some(error => error.code === "INVALID_LIST" || error.code === "UNRELATED_STEP"));
});
