"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { runGeneralGoalLoop } = require("../src/goal/general_loop");
const { createGoalSession, loadGoalSession, releaseGoalSessionLock } = require("../src/goal/session");
const { createGoalSpec } = require("../src/goal/spec");
const { replan, signature } = require("../src/goal/replanner");

function intent() { return { raw_objective: "Fix the local issue", normalized_objective: "Fix the local issue", candidate_success_criteria: [{ id: "done", description: "The local outcome is verified", required: true }] }; }
function plan() { return { plan_version: 1, status: "ready", success_criteria: [{ id: "done", description: "The local outcome is verified", required: true }], steps: [{ id: "work", description: "Work on the local issue", depends_on: [], target_criteria: ["done"], status: "proposed" }] }; }
function baseOptions(extra = {}) { return { mode: "unrestricted_general", explicit_confirmation: true, allow_general: true, max_cycles: 3, stagnation_limit: 2, plan: async () => plan(), observe: async () => ({}), ...extra }; }
function goalSpec(id = "phase5-session") { return createGoalSpec({ schema_version: 1, goal_id: id, objective: "Fix the local issue", success_criteria: [{ id: "done", description: "The local outcome is verified", required: true, verifier: { type: "custom", id: "done", config: {} } }], constraints: { allowed_paths: [], blocked_paths: [".git"], max_cycles: 4, max_tokens: 0, timeout_ms: 0, stagnation_limit: 2, max_changed_files: 5, same_task_limit: 2, same_failure_limit: 2, requires_approval_for: [] }, execution_policy: { mode: "unrestricted_general" } }); }

test("selects a bounded local fallback after a blocker and executes a recovery plan", async () => {
  let calls = 0;
  const result = await runGeneralGoalLoop(intent(), baseOptions({ execute: async () => { calls += 1; return calls === 1 ? { status: "failed", executed: true, patch_signature: "failed-patch", reason: "local verification blocked", verification: { status: "failed", valid: false, executed: true, evidence: { valid: false, executed: true } } } : { status: "passed", executed: true, verification: { status: "passed", valid: true, executed: true, evidence: { valid: true, executed: true } } }; }, verify: async () => ({ completed: calls > 1, evidence: calls > 1 ? [{ valid: true, executed: true }] : [] }) }));
  assert.equal(result.state, "completed"); assert.equal(calls, 2); assert.equal(result.alternative_history[0].status, "selected"); assert.ok(result.alternative_history[0].alternative_id); assert.ok(result.plan.steps.some(step => step.source === "replan")); assert.equal(result.replanning_traces[0].trigger, "blocker");
});

test("failed patch signatures are rejected and are not reused", () => {
  const failed = { id: "failed", description: "Apply failed patch", patch: "same patch" };
  const first = replan({ plan_id: "general-plan_1111111111111111", plan_version: 1, objective: "Fix local issue", status: "ready", steps: [], dependencies: [], hypotheses: [], assumptions: [], discarded_steps: [], new_steps: [], preserved_steps: [], confidence: .7, next_step: null, planning_trace: [], rejected_patch_signatures: [] }, { failed_steps: [failed.id], failed_patch_signatures: [signature(failed)], new_steps: [failed, { id: "different", description: "Use a different local repair", repair_strategy: true }] });
  assert.ok(first.rejected_patch_signatures.includes(signature(failed))); assert.equal(first.steps.some(step => step.id === "failed"), false); assert.equal(first.steps.some(step => step.id === "different"), true);
});


test("session persistence stores canonical replan trace and checkpoint reference", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "minitok-phase5-")); const spec = goalSpec(); const session = createGoalSession({ workspaceRoot: root, goalSpec: spec, generalExecution: true });
  try {
    const result = await runGeneralGoalLoop(intent(), baseOptions({ session, max_cycles: 1, execute: async () => ({ status: "failed", executed: true, reason: "blocked", verification: { status: "failed", valid: false, executed: true, evidence: { valid: false, executed: true } } }) }));
    assert.notEqual(result.state, "completed"); releaseGoalSessionLock(session);
    const loaded = loadGoalSession(root, spec.goal_id, { lock: false });
    assert.ok(loaded.state.replanning_traces.length > 0); assert.ok(loaded.state.replanning_traces[0].checkpoint_reference); assert.ok(loaded.state.general_loop.replanning_traces.length > 0);
  } finally { try { releaseGoalSessionLock(session); } catch {} fs.rmSync(root, { recursive: true, force: true }); }
});

test("source and extension Phase 5 replanning implementations remain identical", () => {
  const read = file => fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  for (const name of ["general_loop.js", "replanner.js", "session.js"]) assert.equal(read(path.join(__dirname, "..", "src", "goal", name)), read(path.join(__dirname, "..", "extension", "runtime", "src", "goal", name)), name);
});

test("assumption invalidation triggers a new plan and records the trigger", async () => {
  let cycle = 0; const traces = [];
  const result = await runGeneralGoalLoop(intent(), baseOptions({ max_cycles: 1, observeEnvironment: async () => ({ assumption_invalidated: cycle++ > 0 }), replan: async (previous, input) => { traces.push(input); return { ...previous, plan_version: previous.plan_version + 1, status: "ready" }; }, execute: async () => ({ status: "passed", executed: true, verification: { status: "passed", valid: true, executed: true, evidence: { valid: true, executed: true } } }), verify: async () => ({ completed: true, evidence: [{ valid: true, executed: true }] }) }));
  assert.notEqual(result.state, "completed"); assert.equal(traces.length, 0);
  const second = await runGeneralGoalLoop(intent(), baseOptions({ max_cycles: 2, observeEnvironment: async () => ({ assumption_invalidated: cycle++ > 0 }), replan: async (previous, input) => { traces.push(input); return { ...previous, plan_version: previous.plan_version + 1, status: "ready" }; }, execute: async () => ({ status: "passed", executed: true, verification: { status: "passed", valid: true, executed: true, evidence: { valid: true, executed: true } } }), verify: async () => ({ completed: false }) }));
  assert.ok(traces.some(input => input.assumption_invalidated === true)); assert.ok(second.replanning_traces.some(trace => trace.reason.includes("assumption_invalidated")));
});

test("repeated failures never produce false completion and end in a bounded terminal state", async () => {
  const result = await runGeneralGoalLoop(intent(), baseOptions({ max_cycles: 4, stagnation_limit: 1, execute: async () => ({ status: "failed", executed: true, reason: "repeated failure", verification: { status: "failed", valid: false, executed: true, evidence: { valid: false, executed: true } } }), verify: async () => ({ completed: true, evidence: [{ valid: true, executed: true }] }) }));
  assert.ok(["stagnated", "escalated", "paused"].includes(result.state)); assert.notEqual(result.state, "completed"); assert.ok(result.replanning_traces.length > 0);
});

test("unresolved blocker prevents completion even when the verifier callback claims success", async () => {
  const result = await runGeneralGoalLoop(intent(), baseOptions({ max_cycles: 1, execute: async () => ({ status: "failed", executed: true, reason: "blocked", verification: { status: "failed", valid: false, executed: true, evidence: { valid: false, executed: true } } }), verify: async () => ({ completed: true, evidence: [{ valid: true, executed: true }] }) }));
  assert.notEqual(result.state, "completed"); assert.ok(result.unresolved_blockers.length > 0);
});
