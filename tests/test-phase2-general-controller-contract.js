"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { runGeneralGoalLoop } = require("../src/goal/general_loop");
const { createGoalSpec } = require("../src/goal/spec");
const { createGoalSession, loadGoalSession, releaseGoalSessionLock } = require("../src/goal/session");
const { executeGoal } = require("../src/goal/general_execution");
function box() { const root = fs.mkdtempSync(path.join(os.tmpdir(), "minitok-phase2-general-")); return { root, clean: () => fs.rmSync(root, { recursive: true, force: true }) }; }
function goal(id = "phase2-general") { return createGoalSpec({ schema_version: 1, goal_id: id, objective: "canonical general execution", success_criteria: [{ id: "done", description: "The outcome is verified", required: true, verifier: { type: "custom", id: "done", config: {} } }], constraints: { allowed_paths: [], blocked_paths: [".git"], max_cycles: 4, max_tokens: 0, timeout_ms: 0, stagnation_limit: 2, max_changed_files: 5, same_task_limit: 2, same_failure_limit: 2, requires_approval_for: [] }, execution_policy: { mode: "unrestricted_general" } }); }
function plan() { return { plan_version: 1, status: "ready", steps: [{ id: "first", description: "first canonical task", depends_on: [], target_criteria: ["done"], status: "proposed" }, { id: "second", description: "second canonical task", depends_on: ["first"], target_criteria: ["done"], status: "proposed" }] }; }
function opts(extra = {}) { return { mode: "unrestricted_general", explicit_confirmation: true, allow_general: true, max_cycles: 4, plan: async () => ({ plan: plan(), status: "ready" }), observeEnvironment: async () => ({ repository: { dirty: false } }), ...extra }; }

test("general loop uses injected canonical executor in dependency order and persists controller-shaped records", async () => {
  const b = box(); const g = goal("phase2-task-history"); const session = createGoalSession({ workspaceRoot: b.root, goalSpec: g, generalExecution: true }); const calls = [];
  try {
    const result = await runGeneralGoalLoop({ raw_objective: g.objective, normalized_objective: g.objective }, opts({ session, execute: async step => { calls.push(step.id); return { status: "passed", success: true, executed: true, tokens: { input: 1, output: 2 }, verification: { status: "passed", valid: true, executed: true, evidence: { evidence_id: `e-${step.id}`, valid: true, executed: true, execution: { executed: true } } } }; }, replan: async previous => previous, verify: async () => ({ completed: calls.length === 2, evidence: calls.length === 2 ? [{ evidence_id: "final", valid: true, executed: true, execution: { executed: true } }] : [] }) }));
    assert.equal(result.state, "completed"); assert.deepEqual(calls, ["first", "second"]); assert.equal(result.task_history.length, 2); assert.equal(result.verification_results.length >= 2, true);
    releaseGoalSessionLock(session); const loaded = loadGoalSession(b.root, g.goal_id, { lock: false }); assert.deepEqual(loaded.state.completed_steps, ["first", "second"]); assert.equal(loaded.state.task_history.length, 2); assert.equal(loaded.state.evaluator_results.length >= 2, true); assert.equal(loaded.state.evidence_refs.includes("e-first"), true); assert.equal(loaded.state.evidence_refs.includes("e-second"), true);
  } finally { b.clean(); }
});

test("completed general steps are not re-executed", async () => {
  const calls = []; let plans = 0;
  const result = await runGeneralGoalLoop({ raw_objective: "no repeat", normalized_objective: "no repeat" }, opts({ max_cycles: 3, plan: async () => { plans += 1; return { plan: { plan_version: plans, status: "ready", steps: [{ id: "one", description: "one", depends_on: [], target_criteria: ["done"], status: plans > 1 ? "completed" : "proposed" }] }, status: "ready" }; }, execute: async step => { calls.push(step.id); return { status: "passed", success: true, executed: true, verification: { status: "passed", valid: true, executed: true, evidence: { evidence_id: "one-evidence", valid: true, executed: true, execution: { executed: true } } } }; }, verify: async () => ({ completed: calls.length === 1, evidence: calls.length === 1 ? [{ evidence_id: "done", valid: true, executed: true, execution: { executed: true } }] : [] }) }));
  assert.equal(result.state, "completed"); assert.deepEqual(calls, ["one"]);
});

test("unknown or model self-report verifier results require verification and never complete", async () => {
  const result = await runGeneralGoalLoop({ raw_objective: "unknown verifier", normalized_objective: "unknown verifier" }, opts({ max_cycles: 1, plan: async () => ({ plan: { plan_version: 1, status: "ready", steps: [{ id: "unknown", description: "unknown", depends_on: [], target_criteria: ["done"], status: "proposed" }] } }), execute: async () => ({ status: "unknown", success: true, executed: true, verification: { status: "unknown", valid: false, executed: true, evidence: { evidence_id: "unknown-e", valid: false, executed: true } } }), verify: async () => ({ completed: false, model_self_report: true, results: [{ status: "unknown", valid: false, evidence: { valid: false, executed: true } }] }) }));
  assert.notEqual(result.state, "completed"); assert.equal(result.verification_required, true); assert.equal(result.final_outcome?.completed, false);
});

test("general execution failure remains blocked and does not claim completion", async () => {
  const result = await executeGoal(goal("phase2-failure"), { mode: "unrestricted_general", general_inference: true, general_execution: true, explicit_confirmation: true, runtime_permission: true, audit_persisted: true, integrity_preflight: true, generalLoop: async () => ({ state: "blocked", completed: false, final_reason: "executor unavailable" }) });
  assert.equal(result.state, "blocked"); assert.equal(result.completed, false);
});

test("canonical general session persists timeout state", async () => {
  const b = box(); const g = goal("phase2-timeout"); const session = createGoalSession({ workspaceRoot: b.root, goalSpec: g, generalExecution: true });
  try { let tick = 0; const result = await runGeneralGoalLoop({ raw_objective: g.objective, normalized_objective: g.objective }, opts({ session, timeout_ms: 1, now: () => tick++ === 0 ? "2026-01-01T00:00:00.000Z" : "2026-01-01T00:00:10.000Z" })); assert.equal(result.state, "timeout"); releaseGoalSessionLock(session); const loaded = loadGoalSession(b.root, g.goal_id, { lock: false }); assert.equal(loaded.state.status, "timeout"); assert.equal(loaded.state.final_outcome.completed, false); } finally { b.clean(); }
});
