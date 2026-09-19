"use strict";

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const { createGoalSpec } = require("./spec");
const { GoalController, runGoal } = require("./controller");
const { runTask } = require("./task_executor");
const { createGoalSession, loadGoalSession } = require("./session");
const fs = require("fs");
const os = require("os");
const path = require("path");

function criterion(id, required = true) { return { id, description: id, required, verifier: { type: "custom", id: `v-${id}`, config: {} } }; }
function spec(criteria, overrides = {}) {
  return createGoalSpec({ schema_version: 1, goal_id: "goal-controller-test", objective: "controller test", success_criteria: criteria,
    constraints: { allowed_paths: [], blocked_paths: [], max_cycles: 3, max_tokens: 0, timeout_ms: 0, stagnation_limit: 3, max_changed_files: 20, same_task_limit: 2, same_failure_limit: 2, requires_approval_for: [], ...overrides }, execution_policy: { mode: "safe" } });
}
function evaluatorSequence(results) { let index = 0; return async () => results[Math.min(index++, results.length - 1)]; }
function result(goalId, statuses, extra = {}) { const criteria = statuses.map(([id, status]) => ({ id, status, evidence_ids: [`e-${id}-${status}`], reason: status })); return { goal_id: goalId, completed: criteria.every(item => item.status === "passed"), criteria, evidence: criteria.map(item => ({ evidence_id: item.evidence_ids[0], valid: item.status === "passed", executed: true, execution: { executed: true } })), remaining_criteria: criteria.filter(item => item.status !== "passed").map(item => item.id), unknown_criteria: criteria.filter(item => item.status === "unknown").map(item => item.id), state_version: 3, ...extra }; }
function baseOptions(evaluator, executor, proposer) { return { evaluator, taskExecutor: executor, taskProposer: proposer, now: (() => { let i = 0; return () => `2026-01-01T00:00:0${i++}.000Z`; })() }; }

describe("GoalController", () => {
  test("completes after one cycle", async () => {
    const calls = [];
    const controller = new GoalController(spec([criterion("a")]), baseOptions(async () => result("goal-controller-test", [["a", "passed"]]), async task => { calls.push(task); return { success: true, status: "success", task_id: "t1", tokens: { input: 1, output: 1 }, duration_ms: 1, evidence: [] }; }, async () => ({ next_task: "do a", target_criteria: ["a"] })));
    const output = await controller.run();
    assert.equal(output.completed, true);
    assert.equal(output.state, "completed");
    assert.equal(output.terminal_status, "completed");
    assert.equal(output.failure_stage, null);
    assert.equal(output.human_escalation_required, false);
    assert.equal(calls.length, 0);
  });

  test("completes after two cycles and selects remaining criteria", async () => {
    const calls = [];
    const evaluator = evaluatorSequence([result("goal-controller-test", [["a", "failed"], ["b", "unknown"]]), result("goal-controller-test", [["a", "passed"], ["b", "unknown"]]), result("goal-controller-test", [["a", "passed"], ["b", "passed"]])]);
    const controller = new GoalController(spec([criterion("a"), criterion("b")]), baseOptions(evaluator, async task => { calls.push(task); return { success: true, status: "success", task_id: `t${calls.length}`, tokens: { input: 2, output: 3 }, duration_ms: 1, evidence: [] }; }, async (_goal, remaining) => ({ next_task: `do ${remaining[0].id}`, target_criteria: [remaining[0].id] })));
    const output = await controller.run();
    assert.equal(output.completed, true);
    assert.equal(output.cycle_count, 2);
    assert.deepEqual(calls, ["do a", "do b"]);
  });

  test("does not complete when model says done but evaluator has remaining criteria", async () => {
    const controller = new GoalController(spec([criterion("a")], { max_cycles: 1 }), baseOptions(async () => result("goal-controller-test", [["a", "failed"]]), async () => ({ success: true, status: "success", tokens: {} }), async () => ({ done: true, next_task: "do a", summary: "done" })));
    const output = await controller.run();
    assert.equal(output.completed, false);
    assert.equal(output.state, "max_cycles");
  });


  test("recovers from a failed task when a later task passes", async () => {
    let count = 0;
    const controller = new GoalController(spec([criterion("a")]), baseOptions(evaluatorSequence([result("goal-controller-test", [["a", "failed"]]), result("goal-controller-test", [["a", "passed"]])]), async () => ({ success: ++count > 1, status: count > 1 ? "success" : "failure", tokens: { input: 1, output: 1 } }), async () => ({ next_task: "repair a", target_criteria: ["a"] })));
    const output = await controller.run();
    assert.equal(output.completed, true);
    assert.equal(output.task_history[0].status, "failure");
  });

  test("stops on timeout, stagnation, repeated task, and token limits", async () => {
    const make = (constraints, now) => new GoalController(spec([criterion("a")], constraints), { ...baseOptions(async () => result("goal-controller-test", [["a", "failed"]]), async () => ({ success: false, status: "failure", tokens: { input: 10, output: 10 } }), async () => ({ next_task: "same", target_criteria: ["a"] })), now, recoveryEnabled: false });
    assert.equal((await make({ max_cycles: 5, stagnation_limit: 1, same_failure_limit: 99 }, () => "2026-01-01T00:00:00.000Z").run()).state, "stagnation");
    assert.equal((await make({ max_cycles: 5, same_task_limit: 1, same_failure_limit: 99 }, (() => { let i = 0; return () => `2026-01-01T00:00:0${i++}.000Z`; })()).run()).state, "repetition");
    assert.equal((await make({ max_cycles: 5, max_tokens: 1, same_failure_limit: 99 }, (() => { let i = 0; return () => `2026-01-01T00:00:0${i++}.000Z`; })()).run()).state, "token_limit");
    assert.equal((await make({ max_cycles: 5, timeout_ms: 1, same_failure_limit: 99 }, (() => { let i = 0; return () => i++ === 0 ? "2020-01-01T00:00:00.000Z" : "2020-01-01T00:00:00.010Z"; })()).run()).state, "timeout");
  });

  test("records task executor exceptions and escalates instead of treating them as success", async () => {
    const controller = new GoalController(spec([criterion("a")], { max_cycles: 2 }), baseOptions(async () => result("goal-controller-test", [["a", "failed"]]), async () => { throw new Error("executor unavailable"); }, async () => ({ next_task: "repair a", target_criteria: ["a"] })));
    const output = await controller.run();
    assert.equal(output.completed, false);
    assert.equal(output.state, "recover");
    assert.match(output.task_history[0].error, /executor unavailable/);
  });

  test("blocks a successful task that exceeds changed-file limit", async () => {
    const controller = new GoalController(spec([criterion("a")], { max_changed_files: 1 }), baseOptions(async () => result("goal-controller-test", [["a", "failed"]]), async () => ({ success: true, status: "success", changes: { changed_files: ["a.js", "b.js"] }, tokens: {} }), async () => ({ next_task: "do a", target_criteria: ["a"] })));
    const output = await controller.run();
    assert.equal(output.completed, false);
    assert.equal(output.state, "blocked");
    assert.equal(output.task_history[0].status, "blocked");
  });

  test("blocks a task that changes a path outside the allowed set", async () => {
    const controller = new GoalController(spec([criterion("a")], { allowed_paths: ["src"], blocked_paths: ["src/secrets"] }), baseOptions(async () => result("goal-controller-test", [["a", "failed"]]), async () => ({ success: true, status: "success", changes: { changed_files: ["src/secrets/key.js"] }, tokens: {} }), async () => ({ next_task: "do a", target_criteria: ["a"] })));
    const output = await controller.run();
    assert.equal(output.state, "blocked");
    assert.match(output.task_history[0].result.error, /path violates/);
  });

  test("switches to a stronger recovery model after repeated failure and records routing", async () => {
    const goal = spec([criterion("a")], { max_cycles: 3, same_failure_limit: 1 });
    const controller = new GoalController(goal, { models: [
      { provider: "weak", model: "weak-model", capabilities: { structured_output: true, code_editing: "low", error_recovery: "low", repository_navigation: "low", long_horizon: "low", tool_calling: false } },
      { provider: "strong", model: "strong-model", capabilities: { structured_output: true, code_editing: "high", error_recovery: "high", repository_navigation: "high", long_horizon: "high", tool_calling: true } },
    ], evaluator: async () => result(goal.goal_id, [["a", "failed"]]), taskExecutor: async () => ({ success: false, status: "failure", error: "verification assertion failed", tokens: {} }), taskProposer: async () => ({ next_task: "fix a", target_criteria: ["a"] }), model: "weak-model", provider: "weak" });
    const output = await controller.run();
    assert.equal(output.completed, false);
    assert.equal(output.state, "escalate");
    assert.equal(output.action_history.some(item => item.recovery_action === "switch_model"), true);
    assert.equal(controller.options.model, "strong-model");
  });

  test("escalates when repeated failure has no capable fallback", async () => {
    const goal = spec([criterion("a")], { max_cycles: 3, same_failure_limit: 1 });
    const controller = new GoalController(goal, { models: [{ provider: "weak", model: "weak-model", capabilities: { error_recovery: "low", code_editing: "low" } }], evaluator: async () => result(goal.goal_id, [["a", "failed"]]), taskExecutor: async () => ({ success: false, status: "failure", error: "verification assertion failed", tokens: {} }), taskProposer: async () => ({ next_task: "fix a", target_criteria: ["a"] }), model: "weak-model" });
    const output = await controller.run();
    assert.equal(output.state, "escalate");
    assert.equal(output.completed, false);
  });

  test("runTask wraps the existing runPipeline contract", async () => {
    const output = await runTask("legacy task", { pipeline: async () => ({ success: true, cycles: [], totalTokens: { input: 2, output: 3 } }) });
    assert.equal(output.success, true);
    assert.equal(output.status, "success");
    assert.equal(output.tokens.input, 2);
    assert.equal(output.task_id.length > 0, true);
  });
});

test("persists controller state when an explicit goal session is supplied", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "minitok-controller-session-"));
  try {
    const goal = spec([criterion("a")]);
    const session = createGoalSession({ workspaceRoot: root, goalSpec: goal, model: "model-a", provider: "provider-a" });
    const controller = new GoalController(goal, { session, evaluator: async () => result(goal.goal_id, [["a", "passed"]]), taskExecutor: async () => ({ success: true, status: "success", tokens: {} }), taskProposer: async () => ({ next_task: "unused" }) });
    const output = await controller.run();
    session.lock.release();
    const loaded = loadGoalSession(root, goal.goal_id);
    assert.equal(output.completed, true);
    assert.equal(loaded.state.status, "completed");
    assert.equal(loaded.state.evaluator_results.length, 1);
    loaded.lock.release();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("runGoal is a compatibility function over GoalController", async () => {
  const output = await runGoal(spec([criterion("a")]), { evaluator: async () => result("goal-controller-test", [["a", "passed"]]), taskExecutor: async () => ({ success: true, status: "success", tokens: {} }), taskProposer: async () => ({ next_task: "a" }) });
  assert.equal(output.completed, true);
});

test("restores repeated task history after a controller restart", async () => {
  const goal = spec([criterion("a")], { max_cycles: 5, same_task_limit: 2 });
  let executed = 0;
  const controller = new GoalController(goal, {
    initialState: { status: "running", task_history: [{ task: "repeat", status: "failure", success: false }, { task: "repeat", status: "failure", success: false }], evaluator_results: [result(goal.goal_id, [["a", "failed"]])] },
    evaluator: async () => result(goal.goal_id, [["a", "failed"]]),
    taskExecutor: async () => { executed += 1; return { success: true, status: "success", tokens: {} }; },
    taskProposer: async () => ({ next_task: "repeat", target_criteria: ["a"] }),
    recoveryEnabled: false,
  });
  const output = await controller.run();
  assert.equal(output.state, "repetition");
  assert.equal(executed, 0);
});

test("restores repeated failure signatures after a controller restart", async () => {
  const goal = spec([criterion("a")], { max_cycles: 5, same_task_limit: 99, same_failure_limit: 2, stagnation_limit: 99 });
  const controller = new GoalController(goal, {
    initialState: {
      status: "running",
      task_history: [{ task: "repair", status: "failure", success: false }],
      failure_history: [{ task: "repair", status: "failure", failure_category: "verification_failure", verifier_id: "v-a", error: "verification assertion failed" }],
      evaluator_results: [result(goal.goal_id, [["a", "failed"]])],
    },
    evaluator: async () => result(goal.goal_id, [["a", "failed"]]),
    taskExecutor: async () => ({ success: false, status: "failure", error: "verification assertion failed", tokens: {} }),
    taskProposer: async () => ({ next_task: "repair", target_criteria: ["a"], expected_verification: ["v-a"] }),
    recoveryEnabled: false,
  });
  const output = await controller.run();
  assert.equal(output.state, "repeated_failure");
  assert.equal(output.failure_history.length, 2);
});

test("restores patch stagnation state after a controller restart", async () => {
  const goal = spec([criterion("a")], { max_cycles: 5, stagnation_limit: 2, same_task_limit: 99, same_failure_limit: 99 });
  const patchResult = { success: true, status: "success", changes: { changed_files: ["src/a.js"] }, tokens: {} };
  const controller = new GoalController(goal, {
    initialState: {
      status: "running",
      task_history: [{ task: "first strategy", status: "success", success: true, result: patchResult }],
      evaluator_results: [result(goal.goal_id, [["a", "failed"]])],
      progress_state: { stagnant_cycles: 1, current_progress: 0, previous_progress: 0 },
    },
    evaluator: async () => result(goal.goal_id, [["a", "failed"]]),
    taskExecutor: async () => patchResult,
    taskProposer: async () => ({ next_task: "second strategy", target_criteria: ["a"] }),
    recoveryEnabled: false,
  });
  const output = await controller.run();
  assert.equal(output.state, "stagnation");
  assert.equal(output.task_history.every(item => typeof item.patch_signature === "string" && item.patch_signature.length > 0), true);
});

test("resumes normally when persisted history is below repetition limits", async () => {
  const goal = spec([criterion("a")]);
  const output = await new GoalController(goal, {
    initialState: { status: "running", task_history: [{ task: "prior", status: "failure", success: false }], evaluator_results: [result(goal.goal_id, [["a", "failed"]])] },
    evaluator: async () => result(goal.goal_id, [["a", "passed"]]),
    taskExecutor: async () => ({ success: true, status: "success", tokens: {} }),
    taskProposer: async () => ({ next_task: "unused", target_criteria: ["a"] }),
  }).run();
  assert.equal(output.completed, true);
});

test("revalidates a persisted completed state through the evaluator", async () => {
  const goal = spec([criterion("a")]);
  let evaluations = 0;
  const controller = new GoalController(goal, {
    initialState: { status: "completed", evaluator_results: [] },
    evaluator: async () => { evaluations += 1; return result(goal.goal_id, [["a", "passed"]]); },
    taskExecutor: async () => ({ success: true, status: "success", tokens: {} }),
    taskProposer: async () => ({ next_task: "unused" }),
  });
  const output = await controller.run();
  assert.equal(evaluations, 1);
  assert.equal(output.completed, true);
});

test("does not trust forged completed or APPROVE metadata without valid required evidence", async () => {
  const goal = spec([criterion("a")]);
  const output = await runGoal(goal, {
    evaluator: async () => ({ goal_id: goal.goal_id, completed: true, done: true, review: { verdict: "APPROVE" }, criteria: [{ id: "a", status: "passed", evidence_ids: ["missing-evidence"] }], evidence: [], remaining_criteria: [], unknown_criteria: [] }),
    taskExecutor: async () => ({ success: true, status: "success", tokens: {} }),
    taskProposer: async () => ({ next_task: "should not complete" }),
  });
  assert.equal(output.completed, false);
  assert.notEqual(output.state, "completed");
});


test("GoalController re-invokes the task executor for controller recovery and records distinct history", async () => {
  const goal = spec([criterion("a")], { max_cycles: 3, same_failure_limit: 3 });
  const evaluations = [result(goal.goal_id, [["a", "failed"]]), result(goal.goal_id, [["a", "failed"]]), result(goal.goal_id, [["a", "passed"]])];
  let evaluationIndex = 0;
  const calls = [];
  const controller = new GoalController(goal, {
    evaluator: async () => evaluations[Math.min(evaluationIndex++, evaluations.length - 1)],
    taskProposer: async (_goal, remaining) => ({ next_task: remaining[0].id === "a" ? "initial task" : "unused", target_criteria: ["a"] }),
    taskExecutor: async task => {
      calls.push(task);
      return calls.length === 1
        ? { success: false, status: "failure", error: "verification assertion failed", changes: { changes: [{ file: "src/a.js", action: "modify", content: "wrong" }] }, tokens: {} }
        : { success: true, status: "success", changes: { changes: [{ file: "src/a.js", action: "modify", content: "correct" }] }, tokens: {} };
    },
    model: "model-before",
    provider: "provider-before",
  });
  const output = await controller.run();
  assert.equal(calls.length, 2, "controller recovery must re-invoke taskExecutor");
  assert.equal(output.completed, true);
  assert.equal(output.recovery_history.length, 1);
  const recovery = output.recovery_history[0];
  assert.equal(recovery.controller_recovery, true);
  assert.equal(recovery.pipeline_internal_recovery, false);
  assert.equal(recovery.status, "completed");
  assert.equal(recovery.previous_task, "initial task");
  assert.equal(recovery.previous_patch_signature !== undefined, true);
  assert.match(recovery.recovery_task, /different implementation strategy|recovery/i);
});

test("GoalController rejects a repeated recovery patch", async () => {
  const goal = spec([criterion("a")], { max_cycles: 3, same_failure_limit: 3 });
  let evaluationIndex = 0;
  let calls = 0;
  const controller = new GoalController(goal, {
    evaluator: async () => result(goal.goal_id, [["a", evaluationIndex++ > 1 ? "passed" : "failed"]]),
    taskProposer: async () => ({ next_task: "same strategy", target_criteria: ["a"] }),
    taskExecutor: async () => { calls += 1; return { success: calls > 1, status: calls > 1 ? "success" : "failure", error: calls === 1 ? "verification failed" : undefined, changes: { changes: [{ file: "src/a.js", action: "modify", content: "same patch" }] }, tokens: {} }; },
  });
  const output = await controller.run();
  assert.equal(calls, 2);
  assert.equal(output.completed, false);
  assert.equal(output.recovery_history.some(item => item.same_patch_repeated === true && item.same_patch_rejected === true && item.recovery_status === "failed" && item.status === "failed"), true);
});

test("GoalController does not create recovery when recovery is disabled", async () => {
  const goal = spec([criterion("a")], { max_cycles: 2 });
  const controller = new GoalController(goal, {
    recoveryEnabled: false,
    evaluator: async () => result(goal.goal_id, [["a", "failed"]]),
    taskProposer: async () => ({ next_task: "repair", target_criteria: ["a"] }),
    taskExecutor: async () => ({ success: false, status: "failure", error: "verification assertion failed", changes: { changes: [{ file: "src/a.js", action: "modify", content: "wrong" }] }, tokens: {} }),
  });
  const output = await controller.run();
  assert.equal(output.recovery_history.length, 0);
  assert.equal(output.completed, false);
});

test("GoalController records model routing and escalation distinction", async () => {
  const goal = spec([criterion("a")], { max_cycles: 3, same_failure_limit: 1 });
  const controller = new GoalController(goal, {
    models: [
      { provider: "strong-provider", model: "strong-model", capabilities: { error_recovery: "high", code_editing: "high", structured_output: true, repository_navigation: "high", long_horizon: "high", tool_calling: true } },
    ],
    model: "weak-model",
    provider: "weak-provider",
    evaluator: async () => result(goal.goal_id, [["a", "failed"]]),
    taskProposer: async () => ({ next_task: "repair", target_criteria: ["a"] }),
    taskExecutor: async () => ({ success: false, status: "failure", error: "verification assertion failed", changes: { changes: [{ file: "src/a.js", action: "modify", content: "wrong" }] }, tokens: {} }),
  });
  const output = await controller.run();
  assert.equal(output.model_routing.length >= 1, true);
  assert.equal(output.recovery_history.some(item => item.model_before === "weak-model" && item.model_after === "strong-model"), true);
  assert.notEqual(output.terminal_status, "completed");
});

test("GoalController persists structured recovery history", async () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "minitok-controller-recovery-"));
  const goal = spec([criterion("a")]);
  let index = 0;
  const session = createGoalSession({ workspaceRoot, goalSpec: goal, model: "m1", provider: "p1" });
  try {
    const controller = new GoalController(goal, {
      session,
      evaluator: async () => result(goal.goal_id, [["a", index++ > 1 ? "passed" : "failed"]]),
      taskProposer: async () => ({ next_task: "repair", target_criteria: ["a"] }),
      taskExecutor: async () => ({ success: index > 1, status: index > 1 ? "success" : "failure", error: index > 1 ? undefined : "verification failed", changes: { changes: [{ file: "src/a.js", action: "modify", content: String(index) }] }, tokens: {} }),
    });
    const output = await controller.run();
    session.lock?.release?.();
    const loaded = loadGoalSession(workspaceRoot, goal.goal_id);
    assert.equal(output.recovery_history.length > 0, true);
    const recovery = output.recovery_history[0];
    for (const field of ["failure_category", "recovery_action", "recovery_task", "previous_task", "previous_patch_signature", "recovery_patch_signature", "model_before", "model_after", "recovery_status"]) assert.ok(Object.prototype.hasOwnProperty.call(recovery, field), `missing recovery field: ${field}`);
    assert.equal(recovery.failure_category, "verification_failure");
    assert.equal(recovery.recovery_action, "alternative_strategy");
    assert.equal(recovery.previous_task, "repair");
    assert.equal(typeof recovery.previous_patch_signature, "string");
    assert.equal(typeof recovery.recovery_patch_signature, "string");
    assert.notEqual(recovery.previous_patch_signature, recovery.recovery_patch_signature);
    assert.equal(recovery.model_before, "m1");
    assert.equal(recovery.model_after, "m1");
    assert.equal(recovery.recovery_status, "completed");
    assert.equal(recovery.status, "completed");
    assert.equal(loaded.state.recovery_history.length > 0, true);
    assert.deepEqual(loaded.state.recovery_history[0], recovery);
    assert.equal(loaded.state.recovery_history[0].controller_recovery, true);
  } finally {
    session.lock?.release?.();
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});



test("GoalController distinguishes pipeline internal recovery from controller recovery", async () => {
  const goal = spec([criterion("a")], { max_cycles: 3, same_failure_limit: 3 });
  let calls = 0;
  const controller = new GoalController(goal, {
    evaluator: async () => result(goal.goal_id, [["a", calls > 1 ? "passed" : "failed"]]),
    taskProposer: async () => ({ next_task: "repair", target_criteria: ["a"] }),
    taskExecutor: async () => {
      calls += 1;
      return calls === 1
        ? { success: false, status: "failure", error: "pipeline verifier failed", recovery: { scheduled: true, task_generated: true }, cycles: [{ status: "VERIFICATION_FAILED" }, { status: "APPROVE" }], changes: { changes: [{ file: "src/a.js", action: "modify", content: "wrong" }] }, tokens: {} }
        : { success: true, status: "success", recovery: { scheduled: false }, changes: { changes: [{ file: "src/a.js", action: "modify", content: "correct" }] }, tokens: {} };
    },
  });
  const output = await controller.run();
  assert.equal(output.recovery_history[0].pipeline_internal_recovery, true);
  assert.equal(output.recovery_history[0].controller_recovery, true);
  assert.equal(output.recovery_history[0].status, "completed");
});


test("GoalController releases an owned session lock after an executor exception", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "minitok-controller-lock-error-"));
  const goal = spec([criterion("a")]);
  const session = createGoalSession({ workspaceRoot: root, goalSpec: goal, model: "m", provider: "p" });
  try {
    const controller = new GoalController(goal, { session, releaseSessionOnExit: true, evaluator: async () => { throw new Error("evaluator failed"); }, taskExecutor: async () => ({ success: true, tokens: {} }), taskProposer: async () => ({ next_task: "unused" }) });
    await assert.rejects(() => controller.run(), /evaluator failed/);
    assert.equal(session.lock, null);
    const resumed = require("./session").resumeGoalSession(root, goal.goal_id);
    assert.equal(resumed.state.status, "running");
    resumed.lock?.release?.();
  } finally { session.lock?.release?.(); fs.rmSync(root, { recursive: true, force: true }); }
});