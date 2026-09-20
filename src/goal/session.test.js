"use strict";

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createGoalSpec } = require("./spec");
const {
  createGoalSession, loadGoalSession, saveGoalSession, appendGoalEvent,
  createCheckpoint, restoreCheckpoint, pauseGoalSession, releaseGoalSessionLock, resumeGoalSession,
  markGoalCompleted, markGoalFailed, markGoalEscalated, goalSessionPaths,
} = require("./session");

function workspace() { return fs.mkdtempSync(path.join(os.tmpdir(), "minitok-goal-session-")); }
function clean(root) { fs.rmSync(root, { recursive: true, force: true }); }
function spec() { return createGoalSpec({ schema_version: 1, goal_id: "goal-session-test", objective: "Persist a goal", success_criteria: [{ id: "a", description: "criterion a", required: true, verifier: { type: "file", id: "file-a", config: { path: "a.txt", exists: true } } }], constraints: { allowed_paths: [], blocked_paths: [".git"], max_cycles: 3, max_tokens: 100, timeout_ms: 0, stagnation_limit: 3, max_changed_files: 20, same_task_limit: 2, same_failure_limit: 2, requires_approval_for: [] }, execution_policy: { mode: "safe" } }); }
function sessionOptions(root, extra = {}) { return { workspaceRoot: root, goalSpec: spec(), model: "model-a", provider: "provider-a", ...extra }; }
function validEvaluation() { const evidence = { evidence_id: "e-valid", valid: true, executed: true, execution: { executed: true } }; return { criteria: [{ id: "a", status: "passed", evidence_ids: [evidence.evidence_id] }], evidence: [evidence] }; }

function close(session) { session?.lock?.release?.(); }

describe("goal session persistence", () => {
  test("creates, saves, and loads a session", () => {
    const root = workspace();
    try {
      const created = createGoalSession(sessionOptions(root));
      created.state.task_history.push({ task: "first" });
      saveGoalSession(created);
      close(created);
      const loaded = loadGoalSession(root, "goal-session-test");
      assert.equal(loaded.goalSpec.goal_id, "goal-session-test");
      assert.deepEqual(loaded.state.task_history, [{ task: "first" }]);
      assert.deepEqual(loaded.state.progress_state, { last_fingerprint: "", stagnant_cycles: 0, current_progress: 0, previous_progress: 0 });
      assert.equal(loaded.state.cycle_count, 0);
      assert.equal(loaded.state.original_objective, "Persist a goal");
      assert.deepEqual(loaded.state.blockers, []);
      assert.deepEqual(loaded.state.approval_requests, []);
      assert.equal(fs.existsSync(goalSessionPaths(root, "goal-session-test").goal), true);
      close(loaded);
    } finally { clean(root); }
  });

  test("appends redacted events and stores structured model metadata", () => {
    const root = workspace();
    try {
      const session = createGoalSession(sessionOptions(root));
      appendGoalEvent(session, { type: "model_action", model: "model-b", token: "secret-token", data: { authorization: "Bearer abc" } });
      close(session);
      const events = fs.readFileSync(goalSessionPaths(root, "goal-session-test").events, "utf8");
      assert.equal(events.includes("secret-token"), false);
      assert.equal(events.includes("Bearer abc"), false);
      assert.match(events, /REDACTED/);
    } finally { clean(root); }
  });

  test("migrates old state with goal evidence defaults and preserves redaction", () => {
    const root = workspace();
    try {
      const session = createGoalSession(sessionOptions(root));
      session.state = { schema_version: 2, goal_id: session.goalSpec.goal_id, status: "paused", workspace_root: root, evaluator_results: [], blocker_reports: [{ cause: "token=hidden" }] };
      saveGoalSession(session);
      close(session);
      const loaded = loadGoalSession(root, "goal-session-test");
      assert.equal(loaded.state.original_objective, "Persist a goal");
      assert.deepEqual(loaded.state.blockers, [{ cause: "token=[REDACTED]" }]);
      assert.deepEqual(loaded.state.approval_requests, []);
      close(loaded);
      const stateText = fs.readFileSync(goalSessionPaths(root, "goal-session-test").state, "utf8");
      assert.doesNotMatch(stateText, /hidden/);
    } finally { clean(root); }
  });

  test("pause/resume stores resume provenance without secrets", () => {
    const root = workspace();
    try {
      const session = createGoalSession(sessionOptions(root));
      pauseGoalSession(session, "operator token=hidden pause");
      releaseGoalSessionLock(session);
      const resumed = resumeGoalSession(root, "goal-session-test");
      assert.ok(resumed.state.resumed_from);
      assert.doesNotMatch(JSON.stringify(resumed.state), /hidden/);
      releaseGoalSessionLock(resumed);
    } finally { clean(root); }
  });

  test("pause and resume validate the expected workspace and allow model replacement", () => {
    const root = workspace();
    try {
      const session = createGoalSession(sessionOptions(root));
      pauseGoalSession(session, "operator requested pause");
      close(session);
      const resumed = resumeGoalSession(root, "goal-session-test", { model: "model-b", provider: "provider-b" });
      assert.equal(resumed.state.status, "running");
      assert.equal(resumed.state.model, "model-b");
      assert.equal(resumed.state.provider, "provider-b");
      assert.equal(resumed.resumeCheck.safe_to_resume, true);
      resumed.state.evaluator_results = [validEvaluation()];
      resumed.state.evidence_refs = ["e-valid"];
      saveGoalSession(resumed);
      close(resumed);
      const replaced = loadGoalSession(root, "goal-session-test");
      assert.equal(replaced.state.model, "model-b");
      assert.deepEqual(replaced.state.evaluator_results, [validEvaluation()]);
      assert.deepEqual(replaced.state.evidence_refs, ["e-valid"]);
      close(replaced);
    } finally { clean(root); }
  });

  test("checkpoint restore returns prior state and detects changed tracked files", () => {
    const root = workspace();
    fs.writeFileSync(path.join(root, "a.txt"), "one");
    try {
      const session = createGoalSession(sessionOptions(root));
      session.state.current_task = "before";
      const checkpoint = createCheckpoint(session, { trackedPaths: ["a.txt"], label: "before-change" });
      session.state.current_task = "after";
      saveGoalSession(session);
      fs.writeFileSync(path.join(root, "a.txt"), "two");
      const restored = restoreCheckpoint(session, checkpoint.checkpoint_id);
      assert.equal(restored.state.current_task, "before");
      assert.equal(restored.workspace_changed, true);
      close(session);
    } finally { clean(root); }
  });

  test("resume requires re-verification after checkpoint files change", () => {
    const root = workspace();
    fs.writeFileSync(path.join(root, "a.txt"), "one");
    try {
      const session = createGoalSession(sessionOptions(root));
      createCheckpoint(session, { trackedPaths: ["a.txt"] });
      pauseGoalSession(session, "pause");
      close(session);
      fs.writeFileSync(path.join(root, "a.txt"), "changed");
      const resumed = resumeGoalSession(root, "goal-session-test");
      assert.equal(resumed.resumeCheck.checkpoint_changed, true);
      assert.equal(resumed.resumeCheck.requires_verification, true);
      assert.equal(resumed.resumeCheck.safe_to_resume, false);
      close(resumed);
    } finally { clean(root); }
  });


  test("downgrades a forged persisted completed state without valid evaluator evidence", () => {
    const root = workspace();
    try {
      const session = createGoalSession(sessionOptions(root));
      const paths = goalSessionPaths(root, "goal-session-test");
      close(session);
      const state = JSON.parse(fs.readFileSync(paths.state, "utf8"));
      state.status = "completed";
      state.evaluator_results = [];
      fs.writeFileSync(paths.state, JSON.stringify(state));
      const loaded = loadGoalSession(root, "goal-session-test");
      assert.equal(loaded.state.status, "blocked");
      assert.match(loaded.state.terminal_detail.reason, /valid evaluator evidence/i);
      close(loaded);
    } finally { clean(root); }
  });

  test("preserves a persisted completed state with valid evaluator evidence", () => {
    const root = workspace();
    try {
      const session = createGoalSession(sessionOptions(root));
      session.state.evaluator_results = [validEvaluation()];
      session.state.status = "completed";
      saveGoalSession(session);
      close(session);
      const loaded = loadGoalSession(root, "goal-session-test");
      assert.equal(loaded.state.status, "completed");
      close(loaded);
    } finally { clean(root); }
  });

  test("detects corrupt state and supports schema migration", () => {
    const root = workspace();
    try {
      const session = createGoalSession(sessionOptions(root));
      const paths = goalSessionPaths(root, "goal-session-test");
      close(session);
      fs.writeFileSync(paths.state, "{not-json");
      assert.throws(() => loadGoalSession(root, "goal-session-test"), /corrupt|invalid/i);
      fs.writeFileSync(paths.state, JSON.stringify({ schema_version: 1, goal_id: "goal-session-test", status: "paused", task_history: [], action_history: [], evaluator_results: [], evidence_refs: [], checkpoints: [], token_usage: { input: 0, output: 0 }, approval_state: "not_requested" }));
      const migrated = loadGoalSession(root, "goal-session-test", { migrate: true });
      assert.equal(migrated.state.schema_version, 2);
      assert.equal(migrated.state.goal_id, "goal-session-test");
      close(migrated);
    } finally { clean(root); }
  });

  test("rejects concurrent sessions for the same goal", () => {
    const root = workspace();
    try {
      const first = createGoalSession(sessionOptions(root));
      assert.throws(() => createGoalSession(sessionOptions(root)), /locked|progress/i);
      close(first);
      const second = createGoalSession(sessionOptions(root));
      close(second);
    } finally { clean(root); }
  });

  test("recovers a stale session lock before loading", () => {
    const root = workspace();
    try {
      const created = createGoalSession(sessionOptions(root));
      const paths = goalSessionPaths(root, "goal-session-test");
      close(created);
      fs.writeFileSync(paths.lock, JSON.stringify({ pid: Number.MAX_SAFE_INTEGER, host: os.hostname(), token: "stale", locked_at: new Date(0).toISOString() }));
      const loaded = loadGoalSession(root, "goal-session-test");
      assert.equal(loaded.state.goal_id, "goal-session-test");
      assert.equal(fs.existsSync(paths.lock), true);
      close(loaded);
      assert.equal(fs.existsSync(paths.lock), false);
    } finally { clean(root); }
  });

  test("handles Windows-style relative paths without escaping the workspace", () => {
    const root = workspace();
    try {
      const session = createGoalSession(sessionOptions(root));
      const paths = goalSessionPaths(root, "goal-session-test");
      assert.equal(paths.root.startsWith(path.resolve(root)), true);
      assert.equal(paths.root.includes(".."), false);
      close(session);
      assert.throws(() => goalSessionPaths(root, "../escape"), /goal_id|inside|invalid/i);
    } finally { clean(root); }
  });

  test("rejects direct completion without current valid evaluator evidence", () => {
    const root = workspace();
    try {
      const missing = createGoalSession(sessionOptions(root));
      assert.throws(() => markGoalCompleted(missing, { summary: "done", completed: true }), /valid evaluator evidence/i);
      assert.equal(missing.state.status, "running");
      assert.equal(missing.state.terminal_detail, undefined);
      close(missing);

      const forged = createGoalSession(sessionOptions(root, { goalSpec: createGoalSpec({ ...spec(), goal_id: "goal-forged-complete" }) }));
      forged.state.evaluator_results = [{ criteria: [{ id: "a", status: "passed", evidence_ids: ["fake"] }], evidence: [{ evidence_id: "fake", valid: true }] }];
      assert.throws(() => markGoalCompleted(forged), /valid evaluator evidence/i);
      assert.equal(forged.state.status, "running");
      close(forged);

      const stale = createGoalSession(sessionOptions(root, { goalSpec: createGoalSpec({ ...spec(), goal_id: "goal-stale-complete" }) }));
      stale.state.evaluator_results = [validEvaluation(), { criteria: [{ id: "a", status: "failed", evidence_ids: ["e-failed"] }], evidence: [{ evidence_id: "e-failed", valid: false, executed: true, execution: { executed: true } }] }];
      assert.throws(() => markGoalCompleted(stale), /valid evaluator evidence/i);
      assert.equal(stale.state.status, "running");
      close(stale);
    } finally { clean(root); }
  });

  test("records terminal lifecycle states", () => {
    const root = workspace();
    try {
      const completed = createGoalSession(sessionOptions(root));
      completed.state.evaluator_results = [validEvaluation()];
      markGoalCompleted(completed, { summary: "done" });
      assert.equal(completed.state.status, "completed");
      close(completed);
      const failed = createGoalSession(sessionOptions(root, { goalSpec: createGoalSpec({ ...spec(), goal_id: "goal-failed" }) }));
      markGoalFailed(failed, "verification failed");
      assert.equal(failed.state.status, "failed");
      close(failed);
      const escalated = createGoalSession(sessionOptions(root, { goalSpec: createGoalSpec({ ...spec(), goal_id: "goal-escalated" }) }));
      markGoalEscalated(escalated, "human review required");
      assert.equal(escalated.state.status, "escalated");
      close(escalated);
    } finally { clean(root); }
  });
});


describe("goal session official pause/release/resume lifecycle", () => {
  test("preserves state and history through pause, release, resume, and a new controller", async () => {
    const root = workspace();
    try {
      const created = createGoalSession(sessionOptions(root));
      created.state.task_history = [{ task: "initial", status: "success", success: true }];
      created.state.evaluator_results = [validEvaluation()];
      created.state.cycle_count = 1;
      pauseGoalSession(created, "operator pause");
      assert.equal(created.state.status, "paused");
      assert.equal(fs.existsSync(goalSessionPaths(root, "goal-session-test").lock), true);
      assert.equal(releaseGoalSessionLock(created), true);
      assert.equal(releaseGoalSessionLock(created), false);
      const resumed = resumeGoalSession(root, "goal-session-test", { model: "model-resumed", provider: "provider-resumed" });
      assert.equal(resumed.state.status, "running");
      assert.equal(resumed.state.model, "model-resumed");
      assert.equal(resumed.state.provider, "provider-resumed");
      assert.equal(resumed.state.task_history.length, 1);
      assert.equal(resumed.state.evaluator_results.length, 1);
      assert.equal(resumed.state.cycle_count, 1);
      assert.equal(resumed.resumeCheck.safe_to_resume, true);
      const { GoalController } = require("./controller");
      const controller = new GoalController(resumed.goalSpec, { session: resumed, evaluator: async () => validEvaluation(), taskExecutor: async () => ({ success: true, status: "success", tokens: {} }), taskProposer: async () => ({ next_task: "unused" }), releaseSessionOnExit: true });
      const output = await controller.run();
      assert.equal(output.completed, true);
      assert.equal(resumed.lock, null);
    } finally { clean(root); }
  });

  test("resume before explicit release is rejected as a concurrent lifecycle", () => {
    const root = workspace();
    try {
      const session = createGoalSession(sessionOptions(root));
      pauseGoalSession(session, "pause without release");
      assert.throws(() => resumeGoalSession(root, "goal-session-test"), error => error.code === "goal_session_locked");
      releaseGoalSessionLock(session);
      const resumed = resumeGoalSession(root, "goal-session-test");
      assert.equal(resumed.state.status, "running");
      releaseGoalSessionLock(resumed);
    } finally { clean(root); }
  });

  test("resume persists checkpoint change verification requirement", () => {
    const root = workspace();
    fs.writeFileSync(path.join(root, "a.txt"), "before");
    try {
      const session = createGoalSession(sessionOptions(root));
      createCheckpoint(session, { trackedPaths: ["a.txt"] });
      pauseGoalSession(session, "pause");
      releaseGoalSessionLock(session);
      fs.writeFileSync(path.join(root, "a.txt"), "after");
      const resumed = resumeGoalSession(root, "goal-session-test");
      assert.equal(resumed.resumeCheck.checkpoint_changed, true);
      assert.equal(resumed.resumeCheck.requires_verification, true);
      assert.equal(resumed.resumeCheck.safe_to_resume, false);
      assert.equal(resumed.state.resume_check.requires_verification, true);
      assert.equal(resumed.state.status, "verification_required");
      releaseGoalSessionLock(resumed);
    } finally { clean(root); }
  });
});
