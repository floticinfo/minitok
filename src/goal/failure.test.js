"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { FAILURE_CATEGORIES, TERMINAL_STATUSES, classifyFailure, terminalStatusFor, createTerminalResult, failureSignature, patchSignature, detectStagnation } = require("./failure");

test("classifies failures into stable categories", () => {
  assert.equal(classifyFailure({ stage: "plan", error: "planner failed to build a plan" }), "planning_error");
  assert.equal(classifyFailure({ stage: "plan", error: "invalid JSON", invalid: true }), "model_output_invalid");
  assert.equal(classifyFailure({ stage: "implement", error: "write rejected" }), "implementation_error");
  assert.equal(classifyFailure({ stage: "verify", status: "failed", error: "assertion failed" }), "verification_failure");
  assert.equal(classifyFailure({ code: "ETIMEDOUT", error: "timeout" }), "timeout");
  assert.equal(classifyFailure({ code: "EACCES", error: "permission denied" }), "permission_blocked");
  assert.equal(classifyFailure({ error: "scope violation: path outside workspace" }), "scope_violation");
  assert.ok(FAILURE_CATEGORIES.includes(classifyFailure({ error: "unclassified" })));
});

test("failure and patch signatures are stable and secret-free", () => {
  const failure = { category: "verification_failure", task: "fix bug", error: "token=secret assertion failed", verifier_id: "test" };
  assert.equal(failureSignature(failure), failureSignature({ ...failure, recorded_at: "later" }));
  assert.notEqual(patchSignature({ changes: [{ file: "a.js", content: "secret" }] }), patchSignature({ changes: [{ file: "a.js", content: "different" }] }));
});

test("classifies all Part 2 terminal states without treating unknown as complete", () => {
  assert.ok(TERMINAL_STATUSES.includes("planning_failed"));
  const cases = [
    [{ plan: { valid: false, error: "Invalid JSON" } }, "model_output_invalid", "plan"],
    [{ implementation: { changes_valid: false } }, "implementation_invalid", "implement"],
    [{ implementation: { change_count: 1, applied_count: 0 } }, "implementation_apply_failed", "apply"],
    [{ implementation: { change_count: 1, applied_count: 1 }, verification: { status: "failed", exit_code: 1 } }, "verification_failed", "verify"],
    [{ implementation: { change_count: 1, applied_count: 1 }, verification: { status: "passed" }, review: { verdict: "REJECT" } }, "review_rejected", "review"],
    [{ isolation: { merge: { applied: false } } }, "merge_failed", "merge"],
    [{ verifier_unknown: true }, "unknown", "environment"],
    [{ state: "timeout" }, "timeout", "environment"],
    [{ state: "token_limit" }, "token_limit", "environment"],
    [{ state: "stagnation" }, "stagnation", "environment"],
    [{ state: "repetition" }, "repetition", "environment"],
  ];
  for (const [input, status, stage] of cases) {
    const result = createTerminalResult(input);
    assert.equal(result.terminal_status, status);
    assert.equal(result.failure_stage, stage);
  }
  assert.equal(terminalStatusFor({ state: "completed", completed: true }, { valid_evidence: false }), "unknown");
  assert.equal(terminalStatusFor({ state: "completed", completed: true }, { valid_evidence: true }), "completed");
});

test("detects repeated tasks, verifier failures, unchanged state, and missing progress", () => {
  const result = detectStagnation({
    taskHistory: [
      { task: "same", status: "failure", failure_category: "verification_failure", patch_signature: "p1", evidence_ids: ["e1"], progress: 0 },
      { task: "same", status: "failure", failure_category: "verification_failure", patch_signature: "p1", evidence_ids: ["e1"], progress: 0 },
    ],
    currentProgress: 0,
    previousProgress: 0,
    limit: 2,
  });
  assert.equal(result.same_task, true);
  assert.equal(result.same_verifier_failure, true);
  assert.equal(result.same_patch, true);
  assert.equal(result.no_new_evidence, true);
  assert.equal(result.no_progress, true);
  assert.equal(result.stagnant, true);
});
