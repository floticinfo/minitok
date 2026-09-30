"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createGoalSpec } = require("./spec");
const { validateGoalSpec } = require("./validator");
const { collectRepositoryEvidence, evaluateRepositoryCheck, compareRepositoryScope, requiredProgress } = require("./odd");

function oddSpec(overrides = {}) {
  return createGoalSpec({ schema_version: 1, goal_id: "odd-test", objective: "Keep repository safe", success_criteria: [{ id: "odd", description: "ODD checks pass", required: true, verifier: { type: "custom", id: "odd", config: { repository_check: { kind: "protected_paths" } } } }], constraints: { allowed_paths: ["src", "tests"], blocked_paths: [".git"], max_cycles: 2, max_tokens: 0, timeout_ms: 1000, stagnation_limit: 2, max_changed_files: 5, same_task_limit: 2, same_failure_limit: 2, requires_approval_for: [], repository_odd: { allowed_paths: ["src", "tests"], protected_paths: ["VERIFY_CMD.mjs", "minitok.yml"], required_checks: ["git_status", "git_diff", "changed_files", "protected_paths"], allow_external: false, ...overrides } }, execution_policy: { mode: "safe" } });
}

test("validates repository ODD constraints", () => {
  assert.equal(validateGoalSpec(oddSpec()).valid, true);
  assert.equal(validateGoalSpec(oddSpec({ allow_external: true })).valid, false);
  assert.ok(validateGoalSpec(oddSpec({ required_checks: ["external_api"] })).errors.some(error => error.code === "INVALID_ODD_CHECK"));
});

test("collects git/status/diff/changed/protected evidence without external access", async () => {
  const calls = [];
  const evidence = await collectRepositoryEvidence("C:\\repo", {
    runCommand: async (command, args) => { calls.push([command, args]); return { status: "passed", exit_code: 0, stdout: "", stderr: "", duration_ms: 1 }; },
    changedFiles: ["src/app.js"],
    odd: oddSpec().constraints.repository_odd,
  });
  assert.ok(evidence.some(item => item.kind === "git_status"));
  assert.ok(evidence.some(item => item.kind === "git_diff"));
  assert.ok(evidence.some(item => item.kind === "changed_files"));
  assert.ok(evidence.some(item => item.kind === "protected_paths"));
  assert.ok(calls.every(([command]) => command === "git"));
});

test("rejects scope violations and protected file changes", () => {
  const result = compareRepositoryScope({ changedFiles: ["src/app.js", "package.json"], allowedPaths: ["src"], protectedPaths: ["package.json"] });
  assert.equal(result.valid, false);
  assert.deepEqual(result.outside_allowed, ["package.json"]);
  assert.deepEqual(result.protected_changed, ["package.json"]);
});

test("local verifier reports not executed, timeout, failure, and pass distinctly", async () => {
  const missing = await evaluateRepositoryCheck("C:\\repo", { kind: "local_command", command: "npm", args: ["test"] }, { runCommand: null });
  assert.equal(missing.status, "unknown");
  const timeout = await evaluateRepositoryCheck("C:\\repo", { kind: "local_command", command: "npm", args: ["test"] }, { runCommand: async () => ({ status: "failed", timed_out: true, exit_code: null, duration_ms: 10 }) });
  assert.equal(timeout.status, "unknown");
  const failed = await evaluateRepositoryCheck("C:\\repo", { kind: "local_command", command: "npm", args: ["test"] }, { runCommand: async () => ({ status: "failed", exit_code: 1, duration_ms: 1 }) });
  assert.equal(failed.status, "failed");
  const passed = await evaluateRepositoryCheck("C:\\repo", { kind: "local_command", command: "npm", args: ["test"] }, { runCommand: async () => ({ status: "passed", exit_code: 0, duration_ms: 1 }) });
  assert.equal(passed.status, "passed");
});

test("progress summary counts required criteria and never treats unknown as passed", () => {
  assert.deepEqual(requiredProgress([{ required: true, status: "passed" }, { required: true, status: "unknown" }, { required: false, status: "failed" }]), { required_total: 2, passed: 1, failed: 0, unknown: 1, progress_ratio: 0.5 });
});
