"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { runGeneralGoalLoop } = require("../src/goal/general_loop");
const { createDynamicVerifier, evaluateDynamicVerifier, detectVerifierTampering, invalidateVerifierEvidence } = require("../src/goal/dynamic_verifier");

function runWith(result, criterion = {}) {
  return runGeneralGoalLoop({ raw_objective: "phase 4", normalized_objective: "phase 4" }, {
    mode: "unrestricted_general", explicit_confirmation: true, allow_general: true, max_cycles: 1,
    plan: async () => ({ plan_version: 1, status: "ready", steps: [], success_criteria: [{ id: "criterion", description: "Observable outcome", required: true, ...criterion }] }),
    observe: async () => ({}), verify: async () => result,
  });
}

test("completes only when every required dynamic verifier has valid executed evidence", async () => {
  const result = await runWith({ completed: true, evidence: [{ evidence_id: "e1", valid: true, executed: true }] });
  assert.equal(result.state, "completed");
  assert.equal(result.verifier_results.at(-1).status, "passed");
  assert.ok(result.verifier_results.at(-1).verifier_fingerprint);
});

test("unknown, failed, not-executed, and timeout verifier results never complete", async () => {
  for (const value of [{ status: "unknown", executed: true }, { status: "failed", executed: true }, { status: "not_executed", executed: false }, { completed: false }]) {
    const result = await runWith(value);
    assert.notEqual(result.state, "completed", value.status || "timeout");
  }
  const verifier = createDynamicVerifier({ criterion_id: "timeout", type: "custom_adapter", description: "timeout", timeout_ms: 5 });
  const timeout = await evaluateDynamicVerifier(verifier, { observe: () => new Promise(() => {}) });
  assert.equal(timeout.status, "unknown");
  assert.equal(timeout.evidence.execution.timed_out, true);
});

test("conflicting verifier results and model self-report never complete", async () => {
  const result = await runWith({ results: [{ status: "passed", valid: true, executed: true, evidence: { valid: true, executed: true } }, { status: "failed", valid: false, executed: true, evidence: { valid: false, executed: true } }] });
  assert.notEqual(result.state, "completed");
  const selfReport = await runWith({ completed: true, model_self_report: true, evidence: [{ valid: true, executed: true }] });
  assert.notEqual(selfReport.state, "completed");
});

test("verifier fingerprint tampering invalidates prior evidence", async () => {
  const original = createDynamicVerifier({ criterion_id: "criterion", type: "custom_adapter", description: "original" });
  const changed = { ...original, description: "changed" };
  const tamper = detectVerifierTampering(changed, original.verifier_fingerprint);
  assert.equal(tamper.tampered, true);
  const invalidated = invalidateVerifierEvidence([{ valid: true, executed: true }], { ...changed, verifier_fingerprint: original.verifier_fingerprint }, "definition changed");
  assert.equal(invalidated[0].valid, false);
  assert.equal(invalidated[0].invalidated, true);
});

test("provisional and human-confirmation criteria remain non-automatic", async () => {
  const result = await runWith({ completed: true, evidence: [{ valid: true, executed: true }] }, { provisional: true, verifier: { type: "human_confirmation" } });
  assert.notEqual(result.state, "completed");
  assert.equal(result.verifier_results.at(-1).verifier_type, "human_confirmation");
});

test("source and extension Phase 4 loop implementations remain identical", () => {
  const read = file => fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  assert.equal(read(path.join(__dirname, "..", "src", "goal", "general_loop.js")), read(path.join(__dirname, "..", "extension", "runtime", "src", "goal", "general_loop.js")));
});
