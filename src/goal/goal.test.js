"use strict";

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const { createGoalSpec, serializeGoalSpec, deserializeGoalSpec } = require("./spec");
const { validateGoalSpec, assertValidGoalSpec } = require("./validator");
const { compileGoal, compileModelGoal, adaptTaskToGoalSpec } = require("./compiler");

function validSpec(overrides = {}) {
  return createGoalSpec({
    schema_version: 1,
    goal_id: "goal-baseline-1",
    objective: "Ensure the project test suite passes",
    success_criteria: [{
      id: "tests-pass",
      description: "The project test suite exits successfully",
      required: true,
      verifier: { type: "command", id: "npm-test", config: { command: "npm", args: ["test"] } },
    }],
    constraints: {
      allowed_paths: ["src", "tests"],
      blocked_paths: [".git", ".env"],
      max_cycles: 30,
      timeout_ms: 0,
      requires_approval_for: ["file-write"],
    },
    execution_policy: { mode: "safe" },
    ...overrides,
  });
}

describe("GoalSpec", () => {
  test("accepts a valid GoalSpec", () => {
    const result = validateGoalSpec(validSpec());
    assert.equal(result.valid, true);
    assert.deepEqual(result.errors, []);
    assert.doesNotThrow(() => assertValidGoalSpec(validSpec()));
  });

  test("rejects missing required fields", () => {
    const result = validateGoalSpec({ schema_version: 1, goal_id: "goal-1" });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(error => error.path === "objective"));
    assert.ok(result.errors.some(error => error.path === "success_criteria"));
  });

  test("rejects malformed goal ids and empty objectives", () => {
    const result = validateGoalSpec(validSpec({ goal_id: "../escape", objective: "  " }));
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(error => error.path === "goal_id"));
    assert.ok(result.errors.some(error => error.path === "objective"));
  });

  test("rejects duplicate criterion ids and missing required criteria", () => {
    const duplicate = validSpec({ success_criteria: [
      { id: "same", description: "one", required: false, verifier: { type: "custom", id: "one", config: {} } },
      { id: "same", description: "two", required: true, verifier: { type: "custom", id: "two", config: {} } },
    ] });
    const noRequired = validSpec({ success_criteria: [{
      id: "optional", description: "optional", required: false,
      verifier: { type: "custom", id: "optional", config: {} },
    }] });
    assert.equal(validateGoalSpec(duplicate).valid, false);
    assert.ok(validateGoalSpec(duplicate).errors.some(error => error.code === "DUPLICATE_CRITERION_ID"));
    assert.ok(validateGoalSpec(noRequired).errors.some(error => error.code === "REQUIRED_CRITERION_MISSING"));
  });

  test("rejects unsupported verifier types, paths, and numeric values", () => {
    const result = validateGoalSpec(validSpec({
      success_criteria: [{ id: "bad", description: "bad", required: true, verifier: { type: "shell", id: "x", config: {} } }],
      constraints: { allowed_paths: ["../outside"], blocked_paths: ["C:\\secret"], max_cycles: 0, timeout_ms: -1, requires_approval_for: [] },
    }));
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(error => error.path === "success_criteria[0].verifier.type"));
    assert.ok(result.errors.some(error => error.path === "constraints.allowed_paths[0]"));
    assert.ok(result.errors.some(error => error.path === "constraints.blocked_paths[0]"));
    assert.ok(result.errors.some(error => error.path === "constraints.max_cycles"));
    assert.ok(result.errors.some(error => error.path === "constraints.timeout_ms"));
  });

  test("rejects unknown and prototype-pollution fields", () => {
    const unknown = validSpec({ unexpected: true });
    const dangerous = JSON.parse(JSON.stringify(validSpec()));
    dangerous.constraints.__proto__ = { polluted: true };
    assert.ok(validateGoalSpec(unknown).errors.some(error => error.code === "UNKNOWN_FIELD"));
    assert.equal(validateGoalSpec(dangerous).valid, false);
  });

  test("serializes and deserializes without changing the validated shape", () => {
    const original = validSpec();
    const roundTrip = deserializeGoalSpec(serializeGoalSpec(original));
    assert.deepEqual(roundTrip, original);
    assert.equal(validateGoalSpec(roundTrip).valid, true);
  });
});


describe("Goal compiler", () => {
  test("compiles an explicit command goal", () => {
    const result = compileGoal("Ensure npm test passes");
    assert.equal(result.status, "ready");
    assert.equal(validateGoalSpec(result.spec).valid, true);
    assert.equal(result.spec.success_criteria[0].verifier.type, "command");
    assert.deepEqual(result.spec.success_criteria[0].verifier.config, { command: "npm", args: ["test"] });
  });

  test("requires clarification instead of inventing criteria for an ambiguous goal", () => {
    const result = compileGoal("Improve the architecture and make it production ready");
    assert.equal(result.status, "clarification_required");
    assert.equal(result.goal_kind, "ambiguous");
    assert.equal(result.spec, undefined);
    assert.ok(result.question_details.length >= 2);
  });

  test("classifies feature, bug, test, API, documentation, refactoring, and file goals without inventing verifiers", () => {
    const cases = [
      ["Add a feature for saved searches", "feature_addition"],
      ["Fix the login bug", "bug_fix"],
      ["Add tests for login failure", "test_addition"],
      ["Add an API endpoint for users", "api_endpoint"],
      ["Update the documentation", "documentation"],
      ["Refactor the authentication module", "refactoring"],
      ["Change the src/auth module", "file_or_module_change"],
    ];
    for (const [objective, kind] of cases) {
      const result = compileGoal(objective);
      assert.equal(result.status, "clarification_required", objective);
      assert.equal(result.goal_kind, kind);
      assert.equal(result.spec, undefined);
      assert.ok(result.question_details.every(item => item.id && item.question && item.reason));
    }
  });

  test("compiles repository convention checks as ready GoalSpecs", () => {
    for (const [objective, args] of [["Run lint", ["run-script", "lint"]], ["Run typecheck", ["run-script", "typecheck"]]]) {
      const result = compileGoal(objective);
      assert.equal(result.status, "ready");
      assert.deepEqual(result.spec.success_criteria[0].verifier.config, { command: "npm", args });
    }
  });

  test("requires concrete clarification for missing success conditions", () => {
    const result = compileGoal("Improve performance");
    assert.equal(result.status, "clarification_required");
    assert.equal(result.missing.includes("acceptance"), true);
    assert.equal(result.missing.includes("verifier"), true);
    assert.match(result.questions[0], /observable result/i);
  });

  test("distinguishes unsupported external goals", () => {
    const result = compileGoal("Deploy this service to production");
    assert.equal(result.status, "unsupported");
    assert.equal(result.goal_kind, "ambiguous");
  });

  test("rejects a model draft without criteria and ignores done/completed", () => {
    const result = compileModelGoal({ objective: "Do the work", done: true, completed: true });
    assert.equal(result.status, "clarification_required");
    assert.equal(result.completed, undefined);

    const invalid = compileModelGoal({
      schema_version: 1,
      goal_id: "model-goal",
      objective: "Do the work",
      success_criteria: [{ id: "x", description: "x", required: true, verifier: { type: "shell", id: "x", config: {} } }],
    });
    assert.equal(invalid.status, "invalid");
    assert.ok(invalid.errors.length > 0);

    const dangerousDraft = JSON.parse('{"schema_version":1,"goal_id":"model-danger","objective":"Do work","success_criteria":[{"id":"x","description":"x","required":true,"verifier":{"type":"custom","id":"x","config":{"__proto__":{"polluted":true}}}}],"done":true,"completed":true}');
    const dangerous = compileModelGoal(dangerousDraft);
    assert.equal(dangerous.status, "invalid");
    assert.ok(dangerous.errors.some(error => error.code === "DANGEROUS_FIELD"));
  });

  test("wraps a legacy task without changing the existing pipeline API", () => {
    const result = adaptTaskToGoalSpec("Fix the login bug", { goalId: "legacy-login" });
    assert.equal(result.status, "ready");
    assert.equal(result.spec.goal_id, "legacy-login");
    assert.equal(result.spec.success_criteria[0].verifier.type, "custom");
    assert.equal(result.spec.success_criteria[0].verifier.id, "legacy-minitok-run");
    assert.equal(result.spec.success_criteria[0].verifier.config.task, "Fix the login bug");
  });
});
