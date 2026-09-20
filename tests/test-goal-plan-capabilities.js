"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createGoalPlan, validateGoalPlan, serializeGoalPlan, deserializeGoalPlan, capabilitiesForSteps } = require("../src/goal/plan");
const { expandGoal } = require("../src/goal/expansion");

function base(overrides = {}) {
  return {
    objective: "Prepare the requested release", explicit_steps: [],
    inferred_steps: [{ id: "publish", description: "Publish package to registry", required: true, target_criteria: ["done"], rationale: "The requested release requires publication.", verification: { type: "publication_check" }, status: "proposed" }],
    dependencies: [], success_criteria: [{ id: "done", description: "Release is verified", required: true }],
    scope_boundary: { allowed_paths: [], blocked_paths: [".git"], protected_paths: ["VERIFY_CMD.mjs"], allow_external: true },
    risk_level: "critical", approval_requirements: [], assumptions: [], execution_policy: "unrestricted",
    requested_capabilities: ["publish", "external_call"], granted_capabilities: ["publish", "external_call"], denied_capabilities: [],
    requires_explicit_confirmation: true, always_blocked_actions: [], ...overrides,
  };
}

test("creates and serializes an unrestricted GoalPlan with capability fields", () => {
  const plan = createGoalPlan(base());
  assert.equal(plan.execution_policy, "unrestricted");
  assert.deepEqual(plan.requested_capabilities, ["publish", "external_call"]);
  assert.deepEqual(plan.granted_capabilities, ["publish", "external_call"]);
  assert.deepEqual(plan.denied_capabilities, []);
  assert.equal(plan.requires_explicit_confirmation, true);
  assert.equal(validateGoalPlan(plan).valid, true);
  const restored = deserializeGoalPlan(serializeGoalPlan(plan));
  assert.deepEqual(restored.requested_capabilities, plan.requested_capabilities);
  assert.equal(validateGoalPlan(restored).valid, true);
});

test("preserves old GoalPlan serialization by applying additive defaults", () => {
  const legacy = createGoalPlan({ objective: "Run tests", explicit_steps: [], inferred_steps: [], dependencies: [], success_criteria: [{ id: "done" }], scope_boundary: { allowed_paths: [], blocked_paths: [], protected_paths: [], allow_external: false }, risk_level: "low", approval_requirements: [], assumptions: [], execution_policy: "safe" });
  const parsed = JSON.parse(serializeGoalPlan(legacy));
  for (const field of ["requested_capabilities", "granted_capabilities", "denied_capabilities", "requires_explicit_confirmation", "always_blocked_actions"]) delete parsed[field];
  const restored = deserializeGoalPlan(JSON.stringify(parsed));
  assert.deepEqual(restored.requested_capabilities, []);
  assert.deepEqual(restored.granted_capabilities, []);
  assert.deepEqual(restored.denied_capabilities, []);
  assert.equal(restored.requires_explicit_confirmation, false);
  assert.deepEqual(restored.always_blocked_actions, []);
});

test("derives capabilities from inferred side effects and dangerous operation text", () => {
  const steps = [
    { description: "Modify workspace file", side_effects: ["file_change"] },
    { description: "Publish and force push, overwrite tag", side_effects: ["publish", "external_call"] },
    { description: "Run database migration", side_effects: ["database_mutation"] },
  ];
  assert.deepEqual(capabilitiesForSteps(steps), ["workspace_write", "publish", "external_call", "force_push", "tag_overwrite", "database_mutation"]);
});

test("rejects missing requested capabilities and scope conflicts", () => {
  const missing = createGoalPlan(base());
  missing.requested_capabilities = ["publish"];
  missing.granted_capabilities = ["publish"];
  const missingResult = validateGoalPlan(missing);
  assert.equal(missingResult.valid, false);
  assert.ok(missingResult.errors.some(error => error.code === "CAPABILITY_REQUIRED"));
  const scopeConflict = createGoalPlan(base({ granted_capabilities: ["publish", "external_call"], scope_boundary: { allowed_paths: ["src"], blocked_paths: [], protected_paths: [], allow_external: false } }));
  const scopeResult = validateGoalPlan(scopeConflict);
  assert.equal(scopeResult.valid, false);
  assert.ok(scopeResult.errors.some(error => error.code === "EXTERNAL_ACCESS_DISABLED" || error.code === "CAPABILITY_SCOPE_CONFLICT"));
});

test("unrestricted plans cannot omit explicit confirmation or include blocked actions", () => {
  const noConfirmation = validateGoalPlan(createGoalPlan(base({ requires_explicit_confirmation: false })));
  assert.equal(noConfirmation.valid, false);
  assert.ok(noConfirmation.errors.some(error => error.code === "CONFIRMATION_REQUIRED"));
  const blocked = validateGoalPlan(createGoalPlan(base({ always_blocked_actions: ["private-key-output"] })));
  assert.equal(blocked.valid, false);
  assert.ok(blocked.errors.some(error => error.code === "ALWAYS_BLOCKED_ACTION"));
});

test("expansion reports requested/granted/denied capabilities and preserves optional policy", () => {
  const result = expandGoal({ objective: "Prepare a release with version bump and publication", success_criteria: [{ id: "release", description: "Release verified", required: true }], repository_context: { repository_odd: { allowed_paths: ["src"], blocked_paths: [".git"], protected_paths: ["VERIFY_CMD.mjs"], allow_external: true } }, execution_policy: "unrestricted" });
  assert.ok(result.goal_plan);
  assert.ok(result.requested_capabilities.includes("workspace_write"));
  assert.ok(result.requested_capabilities.includes("publish"));
  assert.deepEqual(result.granted_capabilities, []);
  assert.ok(result.denied_capabilities.includes("publish"));
  assert.equal(result.requires_explicit_confirmation, true);
  assert.ok(result.optional_steps.every(step => ["unrestricted_eligible", "always_blocked", "approval_required", "safe"].includes(step.capability_status)));
});

test("safe expansion remains local and does not add unrelated capabilities", () => {
  const result = expandGoal({ objective: "Fix the bug in src/parser.js", success_criteria: [{ id: "fix", description: "Bug fixed", required: true }], repository_context: { repository_odd: { allowed_paths: ["src"], blocked_paths: [".git"], protected_paths: ["VERIFY_CMD.mjs"], allow_external: false } }, execution_policy: "safe" });
  assert.deepEqual(result.inferred_steps.map(step => step.id), ["goal-change"]);
  assert.deepEqual(result.requested_capabilities, ["workspace_write"]);
  assert.equal(result.inferred_steps.some(step => /publish|deploy|database|force push/i.test(step.description)), false);
});
