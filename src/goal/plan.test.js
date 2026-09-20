"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createGoalSpec } = require("./spec");
const { validateGoalSpec } = require("./validator");
const {
  createGoalPlan,
  validateGoalPlan,
  serializeGoalPlan,
  deserializeGoalPlan,
} = require("./plan");

function planInput(overrides = {}) {
  return {
    objective: "Make the repository checks pass",
    explicit_steps: [{
      id: "implement",
      description: "Implement the requested change",
      required: true,
      target_criteria: ["tests"],
      verification: { command: "npm test" },
      status: "proposed",
    }],
    inferred_steps: [{
      id: "verify",
      description: "Run the repository test suite",
      required: true,
      depends_on: ["implement"],
      target_criteria: ["tests"],
      rationale: "The requested change is only complete when its repository tests pass.",
      verification: { command: "npm test" },
      status: "proposed",
    }],
    dependencies: [{ step_id: "verify", depends_on: ["implement"] }],
    success_criteria: [{ id: "tests", description: "Tests pass", required: true }],
    scope_boundary: { allowed_paths: ["src", "tests"], blocked_paths: [".git"], protected_paths: ["VERIFY_CMD.mjs"], allow_external: false },
    risk_level: "low",
    approval_requirements: [],
    assumptions: ["The repository test command is available"],
    ...overrides,
  };
}

test("creates and validates a GoalPlan without changing GoalSpec", () => {
  const plan = createGoalPlan(planInput());
  assert.equal(plan.plan_version, 1);
  assert.equal(plan.explicit_steps[0].source, "explicit");
  assert.equal(plan.inferred_steps[0].source, "inferred");
  assert.equal(validateGoalPlan(plan).valid, true);

  const spec = createGoalSpec({
    schema_version: 1,
    goal_id: "goal-plan-compat",
    objective: "Run tests",
    success_criteria: [{ id: "tests", description: "Tests pass", required: true, verifier: { type: "custom", id: "tests", config: {} } }],
    constraints: { allowed_paths: [], blocked_paths: [], max_cycles: 1, max_tokens: 0, timeout_ms: 0, stagnation_limit: 1, max_changed_files: 1, same_task_limit: 1, same_failure_limit: 1, requires_approval_for: [] },
    execution_policy: { mode: "safe" },
  });
  assert.equal(validateGoalSpec(spec).valid, true);
});

test("automatically requires approval for side-effecting steps", () => {
  const plan = createGoalPlan(planInput({
    explicit_steps: [{ id: "publish", description: "Publish the package to the npm registry", required: true, target_criteria: ["tests"], verification: { command: "npm test" }, status: "proposed" }],
    inferred_steps: [],
  }));
  assert.ok(plan.approval_requirements.includes("publish"));
  assert.ok(plan.approval_requirements.includes("external_call"));
  assert.equal(plan.execution_policy, "authorized_external");
  assert.equal(plan.explicit_steps[0].execution_policy, "authorized_external");
  assert.ok(plan.explicit_steps[0].side_effects.includes("publish"));
});

test("promotes forbidden operations to never_autonomous regardless of requested policy", () => {
  const plan = createGoalPlan(planInput({
    explicit_steps: [{ id: "forbidden", description: "Force push and overwrite tag; expose private key", required: true, target_criteria: ["tests"], verification: { command: "local check" }, execution_policy: "supervised", status: "proposed" }],
    inferred_steps: [],
  }));
  assert.equal(plan.explicit_steps[0].execution_policy, "never_autonomous");
  assert.equal(plan.execution_policy, "never_autonomous");
});

test("keeps workspace mutation supervised and local verification safe", () => {
  const plan = createGoalPlan(planInput({
    explicit_steps: [
      { id: "edit", description: "Modify a workspace file", required: true, target_criteria: ["tests"], verification: { command: "npm test" }, status: "proposed" },
      { id: "check", description: "Run local lint and typecheck", required: true, target_criteria: ["tests"], verification: { command: "npm run lint" }, status: "proposed" },
    ],
    inferred_steps: [],
  }));
  assert.equal(plan.explicit_steps[0].execution_policy, "supervised");
  assert.equal(plan.explicit_steps[1].execution_policy, "safe");
});

test("requires rationale and a goal relationship for inferred steps", () => {
  const missingRationale = createGoalPlan(planInput({ inferred_steps: [{ id: "inferred", description: "Do unrelated work", required: true, verification: {}, status: "proposed" }] }));
  const result = validateGoalPlan(missingRationale);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(error => error.code === "RATIONALE_REQUIRED"));
  assert.ok(result.errors.some(error => error.code === "UNRELATED_STEP"));
});

test("rejects unsafe paths, unknown fields, dangerous fields, and external scope", () => {
  const unsafeInput = planInput({
    scope_boundary: { allowed_paths: ["../outside"], blocked_paths: [], protected_paths: [], allow_external: true },
    unexpected: true,
  });
  const unsafe = createGoalPlan(unsafeInput);
  const result = validateGoalPlan({ ...unsafe, unexpected: true });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(error => error.code === "UNKNOWN_FIELD"));
  assert.ok(result.errors.some(error => error.code === "INVALID_PATH"));
  assert.ok(result.errors.some(error => error.code === "EXTERNAL_ACCESS_DISABLED"));

  const dangerous = JSON.parse('{"objective":"goal","explicit_steps":[],"inferred_steps":[],"dependencies":[],"success_criteria":[{"id":"tests"}],"scope_boundary":{"allowed_paths":[],"blocked_paths":[],"protected_paths":[],"allow_external":false},"risk_level":"low","approval_requirements":[],"assumptions":[],"plan_version":1,"execution_policy":"safe","__proto__":{"polluted":true}}');
  assert.equal(validateGoalPlan(dangerous).valid, false);
});

test("serializes, deserializes, and redacts sensitive values", () => {
  const plan = createGoalPlan(planInput({ assumptions: ["token=must-not-be-recorded"] }));
  const serialized = serializeGoalPlan(plan);
  assert.match(serialized, /\[REDACTED\]/);
  assert.doesNotMatch(serialized, /must-not-be-recorded/);
  const restored = deserializeGoalPlan(serialized);
  assert.equal(validateGoalPlan(restored).valid, true);
  assert.throws(() => deserializeGoalPlan("not-json"), /invalid JSON/i);
});
