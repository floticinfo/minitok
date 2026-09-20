"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  BLOCKER_CATEGORIES,
  classifyBlocker,
  createBlockerReport,
  validateBlockerReport,
  serializeBlockerReport,
  deserializeBlockerReport,
  normalizeAlternative,
  selectAlternative,
  buildApprovalRequest,
} = require("./blocker");

test("classifies supported blocker categories and creates structured alternatives", () => {
  for (const category of BLOCKER_CATEGORIES) {
    const report = createBlockerReport({ category, stage: "verify", cause: `${category} observed`, affected_step: "step-1", evidence: [{ kind: "local", status: "failed" }] });
    assert.equal(report.category, category);
    assert.equal(report.blocker_id.startsWith("blocker_"), true);
    assert.ok(Array.isArray(report.alternatives));
    assert.ok(report.alternatives.every(item => item.alternative_id && item.description && item.rationale && item.verification_plan));
  }
  assert.equal(classifyBlocker({ error: "connection refused" }), "network_failure");
  assert.equal(classifyBlocker({ error: "version metadata mismatch" }), "metadata_mismatch");
  assert.equal(classifyBlocker({ error: "permission denied" }), "permission_blocked");
});

test("requires approval for external, credential, and permission alternatives", () => {
  const report = createBlockerReport({ category: "authentication_failure", stage: "implement", cause: "provider authentication failed", affected_step: "work" });
  const credential = report.alternatives.find(item => item.alternative_id === "approval-credential");
  assert.ok(credential);
  assert.equal(credential.approval_required, true);
  assert.equal(report.requires_user_decision, true);
  assert.equal(report.requires_external_access, true);
  assert.ok(credential.side_effects.includes("credential"));
});

test("supports retry, dry-run, alternate strategy, dependency, and metadata alternatives", () => {
  assert.ok(createBlockerReport({ category: "network_failure", cause: "connection reset", stage: "verify", affected_step: "remote-check" }).alternatives.some(item => item.alternative_id === "retry-backoff"));
  assert.ok(createBlockerReport({ category: "verification_failure", cause: "test failed", stage: "verify", affected_step: "tests" }).alternatives.some(item => item.alternative_id === "dry-run"));
  assert.ok(createBlockerReport({ category: "verification_failure", cause: "test failed", stage: "verify", affected_step: "tests" }).alternatives.some(item => item.alternative_id === "alternate-strategy"));
  assert.ok(createBlockerReport({ category: "dependency_failure", cause: "module not found", stage: "implement", affected_step: "work" }).alternatives.some(item => item.alternative_id === "dependency-preparation"));
  assert.ok(createBlockerReport({ category: "metadata_mismatch", cause: "manifest mismatch", stage: "verify", affected_step: "parity" }).alternatives.some(item => item.alternative_id === "metadata-sync"));
});

test("records a non-failure terminal reason when no alternative is applicable", () => {
  const report = createBlockerReport({ category: "unknown", stage: "implement", cause: "unclassified blocker", affected_step: "step-unknown", alternatives: [], required_external_action: "Operator must inspect the environment", user_command: "node --version", resume_conditions: "Re-run local verification after inspection" });
  assert.deepEqual(report.alternatives, []);
  assert.equal(report.recommended_alternative, null);
  assert.match(report.terminal_reason.why, /No safe applicable alternative/);
  assert.equal(report.terminal_reason.user_command, "node --version");
  assert.match(report.terminal_reason.resume_conditions, /Re-run/);
});

test("validates invalid fields and blocks external alternatives without approval", () => {
  const base = createBlockerReport({ category: "timeout", stage: "verify", cause: "timed out", affected_step: "step" });
  const invalid = { ...base, category: "not-a-category", unexpected: true };
  const result = validateBlockerReport(invalid);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(error => error.code === "INVALID_CATEGORY"));
  assert.ok(result.errors.some(error => error.code === "UNKNOWN_FIELD"));
  const external = normalizeAlternative({ alternative_id: "bad", description: "publish", rationale: "publish", expected_benefit: "publish", risk_level: "high", side_effects: ["publish"], required_permissions: [], estimated_cost: "high", reversible: false, verification_plan: {}, approval_required: false, applicable: true });
  assert.equal(external.approval_required, true);
  assert.equal(validateBlockerReport({ ...base, alternatives: [external], recommended_alternative: "bad" }).valid, true);
});

test("serializes and redacts blocker evidence and commands", () => {
  const report = createBlockerReport({ category: "authentication_failure", stage: "work", cause: "token=do-not-record", affected_step: "provider", evidence: [{ stderr: "api_key=do-not-record" }] });
  const serialized = serializeBlockerReport(report);
  assert.doesNotMatch(serialized, /do-not-record/);
  const restored = deserializeBlockerReport(serialized);
  assert.equal(validateBlockerReport(restored).valid, true);
  assert.throws(() => deserializeBlockerReport("not-json"), /invalid JSON/i);
});

test("selects only safe alternatives under the current policy", () => {
  const report = createBlockerReport({ category: "network_failure", stage: "verify", cause: "connection reset", affected_step: "remote-check" });
  const selected = selectAlternative(report, { execution_policy: "safe" });
  assert.equal(selected.status, "selected");
  assert.equal(selected.alternative.alternative_id, "retry-backoff");
  const denied = selectAlternative(createBlockerReport({ category: "authentication_failure", stage: "work", cause: "authentication failed", affected_step: "provider" }), { execution_policy: "safe" });
  assert.equal(denied.status, "selected");
  assert.equal(denied.alternative.alternative_id, "local-validation");
  assert.notEqual(denied.alternative.alternative_id, "approval-credential");
});

test("assigns explicit execution policies and creates redacted approval requests", () => {
  const file = normalizeAlternative({ alternative_id: "file", description: "Change a workspace file", rationale: "required", expected_benefit: "local change", side_effects: ["file_change"], risk_level: "medium", required_permissions: ["write"], estimated_cost: "low", reversible: true, verification_plan: {}, applicable: true });
  assert.equal(file.execution_policy, "supervised");
  assert.equal(file.approval_required, true);
  const external = normalizeAlternative({ alternative_id: "external", description: "Publish package", rationale: "release", expected_benefit: "publish", side_effects: ["publish"], risk_level: "critical", required_permissions: ["approval"], estimated_cost: "high", reversible: false, verification_plan: {}, applicable: true });
  assert.equal(external.execution_policy, "authorized_external");
  assert.equal(external.approval_required, true);
  const never = normalizeAlternative({ alternative_id: "never", description: "Force push or expose a private key", rationale: "forbidden", expected_benefit: "none", side_effects: ["external_call"], execution_policy: "never_autonomous", risk_level: "critical", required_permissions: [], estimated_cost: "unknown", reversible: false, verification_plan: {}, applicable: true });
  assert.equal(never.applicable, false);
  assert.equal(buildApprovalRequest({ blocker_id: "b" }, external).credential_presence_confirmation_required, false);
  assert.equal(buildApprovalRequest({ blocker_id: "b" }, never), null);
});

test("does not repeat an alternative or patch signature", () => {
  const report = createBlockerReport({ category: "verification_failure", stage: "verify", cause: "test failed", affected_step: "tests" });
  const selected = selectAlternative(report, { execution_policy: "safe", used_alternative_ids: ["alternate-strategy", "dry-run"] });
  assert.equal(selected.status, "escalate");
  assert.equal(selected.alternative, null);
});
