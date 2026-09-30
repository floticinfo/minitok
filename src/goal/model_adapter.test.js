"use strict";

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const { generateGoalSpecFromModel, GOAL_SPECIFICATION_ROLE } = require("./model_adapter");
const { evaluateGoal } = require("./evaluator");

const capabilities = { structured_output: true, repository_navigation: "medium" };
function provider(text, extra = {}) { return { name: "mock-goal-provider", capabilities, isAvailable: async () => true, complete: async (_messages, options) => ({ text, model: "mock-goal-model", tokens: { input: 1, output: 1 }, ...extra, role: options.role }) }; }
function draft(overrides = {}) { return JSON.stringify({ objective: "Ensure the project test suite passes", success_criteria: [{ id: "tests-pass", description: "npm test exits with code 0", required: true, verifier: { type: "command", id: "npm-test", config: { command: "npm", args: ["test"] } } }], constraints: {}, clarification_questions: [], ...overrides }); }

describe("Goal specification model adapter", () => {
  test("creates a validated GoalSpec draft through the goal_specification role", async () => {
    const result = await generateGoalSpecFromModel("Make the tests pass", { provider: provider(draft()), goalId: "model-goal" });
    assert.equal(result.status, "ready");
    assert.equal(result.role, GOAL_SPECIFICATION_ROLE);
    assert.equal(result.spec.goal_id, "model-goal");
    assert.equal(result.spec.success_criteria[0].verifier.config.command, "npm");
  });

  test("strips model completion metadata and never treats it as authority", async () => {
    const result = await generateGoalSpecFromModel("Make the tests pass", { provider: provider(draft({ done: true, completed: true, success: true, approved: true, confidence: 1 })) });
    assert.equal(result.status, "ready");
    assert.deepEqual(result.metadata.stripped_fields.sort(), ["approved", "completed", "confidence", "done", "success"]);
    assert.equal(result.completed, undefined);
    assert.equal(result.spec.completed, undefined);
  });

  test("rejects malformed and truncated JSON without retrying", async () => {
    let calls = 0;
    const malformed = await generateGoalSpecFromModel("x", { provider: { ...provider("not json"), complete: async () => { calls += 1; return { text: "not json" }; } } });
    const truncated = await generateGoalSpecFromModel("x", { provider: provider('{"objective":"x"', { truncated: true }) });
    assert.equal(malformed.status, "invalid");
    assert.equal(malformed.reason, "invalid_json");
    assert.equal(truncated.status, "invalid");
    assert.equal(truncated.reason, "truncated_json");
    assert.equal(calls, 1);
  });

  test("returns clarification when success criteria are missing and preserves model questions", async () => {
    const result = await generateGoalSpecFromModel("Add a feature", { provider: provider(JSON.stringify({ objective: "Add a feature", success_criteria: [], clarification_questions: ["What observable behavior should the feature provide?"] })) });
    assert.equal(result.status, "clarification_required");
    assert.equal(result.metadata.reason, "missing_success_criteria");
    assert.deepEqual(result.questions, ["What observable behavior should the feature provide?"]);
  });

  test("rejects unsafe paths, unsupported verifiers, and abstract criteria", async () => {
    const unsafe = await generateGoalSpecFromModel("Change a file", { provider: provider(draft({ success_criteria: [{ id: "file", description: "The file exists", required: true, verifier: { type: "file", id: "file", config: { path: "../secret.txt", exists: true } } }] })) });
    const unsupported = await generateGoalSpecFromModel("Check it", { provider: provider(draft({ success_criteria: [{ id: "x", description: "npm test exits with code 0", required: true, verifier: { type: "shell", id: "x", config: {} } }] })) });
    const abstract = await generateGoalSpecFromModel("Fix login", { provider: provider(draft({ success_criteria: [{ id: "x", description: "Login works correctly", required: true, verifier: { type: "command", id: "x", config: { command: "npm", args: ["test"] } } }] })) });
    assert.equal(unsafe.status, "invalid");
    assert.equal(unsafe.errors.some(error => error.code === "INVALID_PATH"), true);
    assert.equal(unsupported.status, "invalid");
    assert.equal(unsupported.errors.some(error => error.code === "UNSUPPORTED_VERIFIER"), true);
    assert.equal(abstract.status, "invalid");
    assert.equal(abstract.errors.some(error => error.code === "ABSTRACT_CRITERION"), true);
  });

  test("returns unavailable clarification for missing provider, capability, and availability", async () => {
    const missing = await generateGoalSpecFromModel("x");
    const weak = await generateGoalSpecFromModel("x", { provider: provider(draft(),), modelCapabilities: { structured_output: false, repository_navigation: "high" } });
    const unavailable = await generateGoalSpecFromModel("x", { provider: { capabilities, isAvailable: async () => false, complete: async () => { throw new Error("must not call"); } } });
    for (const result of [missing, weak, unavailable]) {
      assert.equal(result.status, "clarification_required");
      assert.equal(result.reason, "goal_specification_unavailable");
      assert.equal(result.metadata.unavailable, true);
    }
  });

  test("does not turn model completion claims into evaluator completion", async () => {
    const result = await generateGoalSpecFromModel("Make tests pass", { provider: provider(draft({ done: true, completed: true })) });
    const evaluation = await evaluateGoal(result.spec, { commandRunner: async () => ({ status: "failed", exit_code: 1, output: "test failed" }) });
    assert.equal(result.status, "ready");
    assert.equal(result.completed, undefined);
    assert.equal(evaluation.completed, false);
    assert.equal(evaluation.criteria[0].status, "failed");
  });
});
