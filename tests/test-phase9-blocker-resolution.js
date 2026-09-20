"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { BLOCKER_CATEGORIES, createBlockerReport, normalizeAlternative, selectAlternative, synthesizeAlternatives } = require("../src/goal/blocker");
const { runGeneralGoalLoop } = require("../src/goal/general_loop");
const { recoveryFor } = require("../src/goal/recovery");

const safeAlternative = (id, source, extra = {}) => ({ alternative_id: id, source, description: `${source} ${id} read-only verification`, rationale: "preserve the goal without unsafe side effects", expected_benefit: "retain progress", risk_level: "low", side_effects: [], required_permissions: [], required_capabilities: [], estimated_cost: "low", reversible: true, verification_plan: { type: "local_recheck" }, rollback_plan: { type: "restore_checkpoint" }, applicable: true, ...extra });

test("maps every general blocker category to a bounded recovery strategy", () => {
  for (const category of ["novel_blocker", "assumption_failure", "goal_ambiguity", "missing_capability", "tool_unavailable", "external_state_conflict", "insufficient_evidence", "verification_conflict"]) assert.notEqual(recoveryFor(category).action, "escalate");
});

test("classifies all general blocker categories", () => {
  for (const category of ["novel_blocker", "assumption_failure", "goal_ambiguity", "missing_capability", "tool_unavailable", "external_state_conflict", "insufficient_evidence", "verification_conflict"]) {
    const report = createBlockerReport({ category, stage: "execute", cause: category, affected_step: "step", alternatives: [] });
    assert.equal(report.category, category);
    assert.equal(report.evidence_complete, false);
  }
  assert.equal(BLOCKER_CATEGORIES.includes("novel_blocker"), true);
});

test("synthesizes catalog, planner, environment, local, reduced, deferred, and user alternatives", () => {
  const alternatives = synthesizeAlternatives("novel_blocker", {
    planner_alternatives: [safeAlternative("planner", "planner", { patch_signature: "same-patch" })],
    environment_workarounds: [safeAlternative("environment", "environment")],
    local_fallbacks: [safeAlternative("local", "local_fallback", { patch_signature: "local-patch" })],
    reduced_scope_alternatives: [safeAlternative("reduced", "reduced_scope")],
    deferred_alternatives: [safeAlternative("deferred", "deferred")],
    user_decision_alternatives: [safeAlternative("approval", "user_decision", { approval_required: true, side_effects: ["external_call"], execution_policy: "authorized_external" })],
  });
  assert.deepEqual(alternatives.map(item => item.source), ["catalog", "planner", "environment", "local_fallback", "reduced_scope", "deferred", "user_decision"]);
  assert.equal(alternatives.filter(item => item.patch_signature === "same-patch").length, 1);
  assert.equal(alternatives.find(item => item.alternative_id === "local").source, "local_fallback");
  assert.equal(alternatives.find(item => item.alternative_id === "planner").source, "planner");
});

test("selects safe local or reduced scope before external approval and blocks always-blocked", () => {
  const report = createBlockerReport({ category: "novel_blocker", alternatives: [
    safeAlternative("external", "user_decision", { approval_required: true, side_effects: ["external_call"], execution_policy: "authorized_external" }),
    safeAlternative("reduced", "reduced_scope"),
  ] });
  assert.equal(selectAlternative(report, { execution_policy: "unrestricted_general", explicit_confirmation: true, auto_accept: true, runtime_permission: true, audit_persisted: true, integrity_preflight: true }).alternative.alternative_id, "reduced");
  const blocked = normalizeAlternative({ ...safeAlternative("blocked", "catalog"), description: "force push", execution_policy: "always_blocked", side_effects: ["external_call"], risk_level: "critical" });
  assert.equal(selectAlternative({ alternatives: [blocked] }, { execution_policy: "unrestricted_general", explicit_confirmation: true, auto_accept: true, runtime_permission: true, audit_persisted: true, integrity_preflight: true }).status, "escalate");
});

test("reports exhaustion, rollback failure, and complete terminal resolution without secrets", () => {
  const report = createBlockerReport({ category: "verification_conflict", cause: "token=hidden", affected_step: "verify", evidence: [{ valid: true, executed: true, stderr: "api_key=hidden" }], alternatives: [safeAlternative("one", "local_fallback", { patch_signature: "p1" })], attempted_alternatives: ["one"], rollback_failure: true, required_external_action: "operator review", resume_conditions: "new verifier evidence", next_user_action: "approve a replacement" });
  assert.equal(report.alternative_exhausted, true);
  assert.equal(report.rollback_failure, true);
  assert.equal(report.evidence_complete, true);
  assert.doesNotMatch(JSON.stringify(report), /hidden/);
  assert.equal(report.terminal_reason, null);
});

test("general loop uses canonical blocker resolution and does not claim false completion", async () => {
  const result = await runGeneralGoalLoop({ raw_objective: "verify goal", normalized_objective: "verify goal" }, {
    mode: "safe", max_cycles: 2,
    plan: async () => ({ plan: { plan_version: 1, steps: [{ id: "step", description: "step", depends_on: [], status: "proposed", target_criteria: ["goal"], verification: {} }] } }),
    execute: async () => ({ status: "failed", executed: true }),
    verify: async () => ({ status: "failed", valid: false, reason: "insufficient evidence", evidence: [{ valid: false, executed: true }] }),
  });
  assert.equal(result.state, "escalated");
  assert.equal(result.blocker_reports[0].category, "insufficient_evidence");
  assert.equal(result.terminal_resolution.blocker.category, "insufficient_evidence");
  assert.equal(result.state === "completed", false);
});

 test("legacy blocker reports without additive Phase 9 fields remain valid", () => {
  const legacy = { blocker_id: "b", category: "unknown", stage: "x", cause: "y", affected_step: "z", evidence: [], retryable: false, requires_permission: false, requires_external_access: false, requires_user_decision: false, alternatives: [], recommended_alternative: null };
  assert.equal(require("../src/goal/blocker").validateBlockerReport(legacy).valid, true);
});
