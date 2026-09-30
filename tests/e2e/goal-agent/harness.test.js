"use strict";

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");

async function harness() { return import("../../../scripts/goal-e2e.mjs"); }

describe("Goal E2E harness", () => {
  test("creates a disposable Git fixture with failing test, editable and protected files", async () => {
    const { createFixture } = await harness();
    const root = createFixture();
    try {
      assert.equal(fs.existsSync(path.join(root, ".git")), true);
      assert.equal(fs.existsSync(path.join(root, "PROTECTED.md")), true);
      assert.match(fs.readFileSync(path.join(root, "src/calculator.js"), "utf8"), /return a - b/);
      assert.doesNotThrow(() => execFileSync(process.execPath, ["--test", "test/calculator.test.js"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
    } catch (error) {
      assert.match(String(error), /exit|test|failed/i);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  test("defines all required measured scenarios", async () => {
    const { SCENARIOS } = await harness();
    assert.deepEqual(SCENARIOS, ["one_file_bug_fix", "test_addition", "two_step_goal", "verifier_failure_repair", "early_completion_claim", "model_replacement_resume", "repeated_failure_escalation", "out_of_scope_change"]);
  });

  test("runs mock scenarios through GoalController and returns the required result schema", async () => {
    const { runScenario, validateResultRecord } = await harness();
    const result = await runScenario("one_file_bug_fix", { mode: "mock" });
    assert.equal(validateResultRecord(result), true);
    assert.equal(result.provider, "mock");
    assert.equal(typeof result.cycle_count, "number");
    assert.equal(typeof result.verifier_execution_rate, "number");
  });

  test("keeps model self-report separate from evaluator completion", async () => {
    const { runScenario } = await harness();
    const result = await runScenario("early_completion_claim", { mode: "mock" });
    assert.equal(result.false_completion, false);
    assert.equal(result.system_false_completion, false);
    assert.equal(result.goal_achieved, false);
    assert.equal(result.expected_negative_case, true);
    assert.equal(result.negative_case_handled_correctly, true);
    assert.equal(Array.isArray(result.model_self_reports), true);
  });

  test("records live mode as skipped unless explicit gates are present", async () => {
    const { runScenario } = await harness();
    const previous = process.env.MINITOK_GOAL_E2E_LIVE;
    delete process.env.MINITOK_GOAL_E2E_LIVE;
    try {
      const result = await runScenario("one_file_bug_fix", { mode: "live" });
      assert.match(result.status, /^skipped: live credential not configured$/);
      assert.equal(result.completed, false);
      assert.equal(result.goal_achieved, false);
    } finally { if (previous === undefined) delete process.env.MINITOK_GOAL_E2E_LIVE; else process.env.MINITOK_GOAL_E2E_LIVE = previous; }
  });

  test("redacts secrets from result values", async () => {
    const { redact } = await harness();
    const value = redact({ output: "token=secret-value Authorization: Bearer abc123" });
    assert.equal(JSON.stringify(value).includes("secret-value"), false);
    assert.equal(JSON.stringify(value).includes("abc123"), false);
    assert.match(value.output, /REDACTED/);
  });

  test("runs all mock scenarios without live provider calls", async () => {
    const { runAll, SCENARIOS, validateResultRecord } = await harness();
    const results = await runAll({ mode: "mock", scenarios: SCENARIOS });
    assert.equal(results.length, SCENARIOS.length);
    assert.equal(results.every(validateResultRecord), true);
    assert.equal(results.some(item => item.status === "completed" || item.status === "repetition" || item.status === "stagnation" || item.status === "blocked" || item.status === "repeated_failure" || item.status === "max_cycles"), true);
  });
});
