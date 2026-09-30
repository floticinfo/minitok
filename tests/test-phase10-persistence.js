"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { interpretNaturalLanguageGoal } = require("../src/goal/intent");
const { runGeneralGoalLoop } = require("../src/goal/general_loop");
const { createGoalSpec } = require("../src/goal/spec");
const { createGoalSession, loadGoalSession, releaseGoalSessionLock, resumeGoalSession, recordRollback, rollbackMutation, normalizeExternalTarget, goalSessionPaths } = require("../src/goal/session");
function box() { const root = fs.mkdtempSync(path.join(os.tmpdir(), "minitok-phase10-")); return { root, clean: () => fs.rmSync(root, { recursive: true, force: true }) }; }
function goal(id) { return createGoalSpec({ schema_version: 1, goal_id: id, objective: "Persist general autonomy", success_criteria: [{ id: "done", description: "verified completion", required: true, verifier: { type: "custom", id: "done", config: {} } }], constraints: { allowed_paths: [], blocked_paths: [".git"], max_cycles: 3, max_tokens: 0, timeout_ms: 0, stagnation_limit: 2, max_changed_files: 5, same_task_limit: 2, same_failure_limit: 2, requires_approval_for: [] }, execution_policy: { mode: "safe" } }); }
function plan() { return { plan_version: 1, status: "ready", steps: [{ id: "work", description: "perform work", depends_on: [], target_criteria: ["done"], status: "proposed" }] }; }
function close(session) { session?.lock?.release?.(); }
test("general loop persists intent, plans, observations, evidence, and outcome", async () => {
  const b = box(); const g = goal("phase10-general-loop"); const session = createGoalSession({ workspaceRoot: b.root, goalSpec: g, rawObjective: "Use token=secret only as a redaction test" });
  try {
    const result = await runGeneralGoalLoop(interpretNaturalLanguageGoal("Use token=secret only as a redaction test"), { session, max_cycles: 2, plan: async () => plan(), observeEnvironment: async () => ({ repository: { dirty: false }, password: "hidden" }), execute: async () => ({ status: "passed", executed: true, verification: { status: "passed", valid: true, evidence: { evidence_id: "step-evidence", valid: true, executed: true } } }), verify: async () => ({ completed: true, evidence: [{ evidence_id: "final-evidence", valid: true, executed: true }] }) });
    assert.equal(result.state, "completed"); close(session);
    const loaded = loadGoalSession(b.root, g.goal_id, { lock: false });
    assert.equal(loaded.state.general_loop.state, "completed"); assert.equal(loaded.state.goal_plan_versions.length >= 1, true); assert.equal(loaded.state.tool_observations.length >= 1, true); assert.equal(loaded.state.final_outcome.completed, true);
    assert.doesNotMatch(fs.readFileSync(loaded.paths.state, "utf8"), /token=secret|password.*hidden/i); assert.match(fs.readFileSync(loaded.paths.events, "utf8"), /general_plan_created/);
  } finally { b.clean(); }
});
test("pause and resume preserve checkpoint and provenance", async () => {
  const b = box(); const g = goal("phase10-pause-resume"); const session = createGoalSession({ workspaceRoot: b.root, goalSpec: g });
  try { const paused = await runGeneralGoalLoop(interpretNaturalLanguageGoal("pause safely"), { session, pause: true }); assert.equal(paused.state, "paused"); assert.equal(paused.checkpoints.length, 1); releaseGoalSessionLock(session); const resumed = resumeGoalSession(b.root, g.goal_id, { lock: false }); assert.equal(resumed.state.status, "running"); assert.equal(resumed.state.resume_provenance.length, 1); assert.equal(resumed.state.resumed_from.checkpoint_id, paused.checkpoints[0].checkpoint_id); } finally { b.clean(); }
});
test("crash recovery persists fail-closed state", async () => {
  const b = box(); const g = goal("phase10-crash"); const session = createGoalSession({ workspaceRoot: b.root, goalSpec: g });
  try { const result = await runGeneralGoalLoop(interpretNaturalLanguageGoal("crash recovery"), { session, plan: async () => plan(), execute: async () => { throw new Error("password=secret adapter crash"); } }); assert.equal(result.state, "blocked"); close(session); const loaded = loadGoalSession(b.root, g.goal_id, { lock: false }); assert.equal(loaded.state.crash_recovery.required, true); assert.doesNotMatch(JSON.stringify(loaded.state), /password=secret/i); } finally { b.clean(); }
});

test("rollback success and failure persist mutation metadata", async () => {
  const b = box(); const g = goal("phase10-rollback"); const session = createGoalSession({ workspaceRoot: b.root, goalSpec: g });
  try {
    const record = recordRollback(session, { step_id: "write", operation: "workspace_write", pre_state: { value: "old" }, post_state: { value: "new" }, rollback_adapter: "restore", rollback_conditions: ["verification_failed"], external_target: "https://user:secret@example.test/api?token=hidden", policy_allowed: true, policy_evidence: { policy_decision: "allowed" } });
    assert.equal(normalizeExternalTarget("https://user:secret@example.test/api?token=hidden").hostname, "example.test");
    const restored = await rollbackMutation(session, record.rollback_id, { rollbackAdapters: { restore: async () => ({ success: true, evidence: [{ valid: true, executed: true }] }) } }); assert.equal(restored.success, true);
    const failedRecord = recordRollback(session, { step_id: "publish", operation: "publish", irreversible: true, irreversibility_reason: "external publish cannot be undone", policy_allowed: true }); const failed = await rollbackMutation(session, failedRecord.rollback_id, { rollbackAdapters: {} }); assert.equal(failed.success, false); assert.equal(failed.record.rollback_status, "unavailable"); close(session); const loaded = loadGoalSession(b.root, g.goal_id, { lock: false }); assert.equal(loaded.state.rollback_records.length, 2); assert.doesNotMatch(fs.readFileSync(loaded.paths.state, "utf8"), /secret|hidden/i);
  } finally { b.clean(); }
});
test("resume plan invalidation and external drift require verification", () => {
  const b = box(); const g = goal("phase10-drift"); const session = createGoalSession({ workspaceRoot: b.root, goalSpec: g });
  try { session.state.general_loop = { plan: { plan_version: 4 } }; require("../src/goal/session").saveGoalSession(session); close(session); const first = resumeGoalSession(b.root, g.goal_id, { lock: false, plan_version: 4, external_state: { revision: 1 } }); assert.equal(first.state.status, "running"); close(first); const second = resumeGoalSession(b.root, g.goal_id, { lock: false, plan_version: 3, external_state: { revision: 2 }, resumePolicy: { allowed: false, reason: "approval changed" } }); assert.equal(second.state.status, "verification_required"); assert.equal(second.state.external_state_drift.length >= 1, true); assert.equal(second.state.resume_check.requires_verification, true); close(second); } finally { b.clean(); }
});
test("corrupt persisted general state remains fail-closed", () => {
  const b = box(); const g = goal("phase10-corrupt"); const session = createGoalSession({ workspaceRoot: b.root, goalSpec: g }); const paths = goalSessionPaths(b.root, g.goal_id);
  try { close(session); fs.writeFileSync(paths.state, "{broken"); assert.throws(() => loadGoalSession(b.root, g.goal_id), /corrupt/i); } finally { b.clean(); }
});
