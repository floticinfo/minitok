"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { recoveryFor, selectBlockerRecovery, buildRecoveryTask } = require("./recovery");
const { createBlockerReport } = require("./blocker");

test("selects separated recovery strategies by failure category", () => {
  assert.equal(recoveryFor("model_output_invalid").action, "structured_retry");
  assert.equal(recoveryFor("implementation_error").action, "repair_task");
  assert.equal(recoveryFor("verification_failure").action, "alternative_strategy");
  assert.equal(recoveryFor("environment_failure").action, "reobserve_environment");
  assert.equal(recoveryFor("permission_blocked").action, "escalate_approval");
  assert.equal(recoveryFor("repeated_failure").action, "switch_model");
});

test("selects blocker recovery through the existing recovery boundary", () => {
  const report = createBlockerReport({ category: "network_failure", stage: "verify", cause: "connection reset", affected_step: "check" });
  const selected = selectBlockerRecovery(report, { execution_policy: "safe" });
  assert.equal(selected.status, "selected");
  assert.equal(selected.alternative.alternative_id, "retry-backoff");
});

test("does not repeat the same patch in a recovery task", () => {
  const task = buildRecoveryTask({ task: "fix login", failure_category: "verification_failure", error: "assertion failed", patch_signature: "p1" }, { previous_tasks: ["fix login"], previous_patch_signatures: ["p1"] });
  assert.notEqual(task, "fix login");
  assert.match(task, /repair|alternative|verification/i);
});
