"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createGoalSpec } = require("../src/goal/spec");
const { createGoalPlan } = require("../src/goal/plan");
const { GoalController } = require("../src/goal/controller");
const { createGoalSession, loadGoalSession, saveGoalSession, releaseGoalSessionLock } = require("../src/goal/session");
const { cmdGoalStart, cmdGoalContinue, cmdGoalResume, sessionResponse } = require("../src/cli/commands/goal");

function root() { return fs.mkdtempSync(path.join(os.tmpdir(), "minitok-cli-nunchi-")); }
function goalSpec(objective = "Fix the bug in src/parser.js", id = "cli-nunchi") {
  return createGoalSpec({ schema_version: 1, goal_id: id, objective, success_criteria: [{ id: "fix", description: "The bug is fixed", required: true, verifier: { type: "custom", id: "verify-fix", config: {} } }], constraints: { allowed_paths: [], blocked_paths: [".git", ".env"], max_cycles: 2, max_tokens: 0, timeout_ms: 0, stagnation_limit: 2, max_changed_files: 5, same_task_limit: 2, same_failure_limit: 2, requires_approval_for: [] }, execution_policy: { mode: "safe" } });
}
function releaseSpec(id = "cli-release") {
  return createGoalSpec({ schema_version: 1, goal_id: id, objective: "Prepare a release with version bump, tests, and package verification", success_criteria: [{ id: "release", description: "The release is verified", required: true, verifier: { type: "custom", id: "verify-release", config: {} } }], constraints: { allowed_paths: ["src", "tests"], blocked_paths: [".git", ".env"], max_cycles: 3, max_tokens: 0, timeout_ms: 0, stagnation_limit: 2, max_changed_files: 10, same_task_limit: 2, same_failure_limit: 2, requires_approval_for: [] }, execution_policy: { mode: "unrestricted" } });
}
function plan() {
  return createGoalPlan({ objective: "Fix the bug in src/parser.js", explicit_steps: [], inferred_steps: [{ id: "persisted-fix", description: "Use the persisted required fix", required: true, target_criteria: ["fix"], rationale: "The existing plan is authoritative for this session.", verification: { type: "custom", id: "persisted-check", config: {} }, status: "proposed" }], dependencies: [], success_criteria: [{ id: "fix", description: "The bug is fixed", required: true }], scope_boundary: { allowed_paths: ["src"], blocked_paths: [".git"], protected_paths: [], allow_external: false }, risk_level: "low", approval_requirements: [], assumptions: [], execution_policy: "safe" });
}
function unrestrictedConfig() { return { goal: { unrestricted: { enabled: true, capabilities: ["workspace_write"], require_explicit_confirmation: true, require_auto_accept: true } } }; }
function unrestrictedGeneralConfig() { return { goal: { unrestricted_general: { enabled: true, capabilities: ["workspace_write"], require_explicit_confirmation: true, require_auto_accept: true, allow_goal_inference: true, allow_provisional_criteria: true, allow_replanning: true, allow_tool_discovery: true, allow_external_adapters: false, max_plan_depth: 50, max_replan_count: 20, max_assumption_count: 100 } } }; }
function captureRun(result = { completed: true, state: "completed" }) { const calls = []; return { calls, runGoal: async (spec, options) => { calls.push({ spec, options }); return result; } }; }


test("CLI start prepares and persists the inferred plan before runGoal", async () => {
  const repo = root();
  try {
    const captured = captureRun();
    const code = await cmdGoalStart("Fix the bug in src/parser.js", { repo, goalSpec: goalSpec(), mode: "supervised", explicitConfirmation: true, json: true, runGoal: captured.runGoal });
    assert.equal(code, 0);
    assert.equal(captured.calls.length, 1);
    assert.equal(captured.calls[0].options.goalPlan.inferred_steps[0].id, "goal-change");
    assert.equal(captured.calls[0].options.goalExpansion.inferred_steps[0].target_criteria[0], "fix");
    const stored = loadGoalSession(repo, "cli-nunchi", { lock: false });
    assert.equal(stored.state.goal_plan.inferred_steps[0].id, "goal-change");
    assert.equal(stored.state.inferred_steps[0].target_criteria[0], "fix");
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test("CLI forwarded goalExpansion causes GoalController to execute the required inferred step", async () => {
  const repo = root();
  try {
    const captured = captureRun();
    const code = await cmdGoalStart("Fix the bug in src/parser.js", { repo, goalSpec: goalSpec("Fix the bug in src/parser.js", "cli-controller-execution"), mode: "supervised", explicitConfirmation: true, json: true, runGoal: async (goal, options) => {
      let executedTask = null;
      const controller = new GoalController(goal, { ...options, evaluator: async () => ({ goal_id: goal.goal_id, completed: executedTask !== null, criteria: [{ id: "fix", status: executedTask ? "passed" : "failed", evidence_ids: executedTask ? ["e-fix"] : [], reason: executedTask ? "passed" : "pending" }], evidence: executedTask ? [{ evidence_id: "e-fix", valid: true, executed: true, execution: { executed: true } }] : [], remaining_criteria: executedTask ? [] : ["fix"], unknown_criteria: [] }), taskExecutor: async task => { executedTask = task; return { success: true, status: "success", tokens: {} }; }, releaseSessionOnExit: true });
      const result = await controller.run();
      captured.calls.push({ goal, options, executedTask });
      return result;
    } });
    assert.equal(code, 0);
    assert.equal(captured.calls.at(-1).executedTask, "Fix the bug in src/parser.js");
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test("CLI expansion capability is included in safe policy and blocks executor", async () => {
  const repo = root();
  try {
    let called = false;
    const code = await cmdGoalStart("Fix the bug in src/parser.js", { repo, goalSpec: goalSpec("Fix the bug in src/parser.js", "cli-safe-regression"), json: true, runGoal: async () => { called = true; return { completed: true }; } });
    assert.equal(code, 1);
    assert.equal(called, false);
    assert.equal(fs.existsSync(path.join(repo, ".minitok", "goals")), false);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test("ambiguous CLI goal returns clarification without creating a session", async () => {
  const repo = root();
  try {
    let called = false;
    const code = await cmdGoalStart("Improve the architecture", { repo, json: true, runGoal: async () => { called = true; return { completed: true }; } });
    assert.equal(code, 2);
    assert.equal(called, false);
    assert.equal(fs.existsSync(path.join(repo, ".minitok", "goals")), false);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test("CLI release goal does not execute optional external work in safe mode", async () => {
  const repo = root();
  try {
    const captured = captureRun();
    const code = await cmdGoalStart("Prepare a release with version bump, tests, and package verification", { repo, goalSpec: releaseSpec(), json: true, runGoal: captured.runGoal });
    assert.equal(code, 1);
    assert.equal(captured.calls.length, 0);
    assert.equal(fs.existsSync(path.join(repo, ".minitok", "goals")), false);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test("CLI continue reuses the stored GoalPlan and expansion context", async () => {
  const repo = root();
  try {
    const session = createGoalSession({ workspaceRoot: repo, goalSpec: goalSpec("Fix the bug in src/parser.js", "cli-continue") });
    session.state.goal_plan = plan();
    session.state.inferred_steps = session.state.goal_plan.inferred_steps;
    session.state.optional_steps = [];
    saveGoalSession(session);
    releaseGoalSessionLock(session);
    const captured = captureRun();
    const code = await cmdGoalContinue("cli-continue", { repo, mode: "supervised", explicitConfirmation: true, json: true, runGoal: captured.runGoal });
    assert.equal(code, 0);
    assert.equal(captured.calls.length, 1);
    assert.equal(captured.calls[0].options.goalPlan.inferred_steps[0].id, "persisted-fix");
    const loaded = loadGoalSession(repo, "cli-continue", { lock: false });
    assert.equal(loaded.state.goal_plan.inferred_steps[0].id, "persisted-fix");
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test("CLI unrestricted resume requires explicit mode, confirmation, auto_accept, and capability", async () => {
  const repo = root();
  try {
    fs.writeFileSync(path.join(repo, "minitok.yml"), "goal:\n  unrestricted:\n    enabled: true\n    capabilities: [workspace_write]\n    require_explicit_confirmation: true\n    require_auto_accept: true\n");
    const session = createGoalSession({ workspaceRoot: repo, goalSpec: goalSpec("Fix the bug in src/parser.js", "cli-unrestricted-resume") });
    session.state.execution_policy = { mode: "unrestricted", allowed: true, capabilities: ["workspace_write"], denied_capabilities: [], approval_required: false };
    saveGoalSession(session);
    releaseGoalSessionLock(session);
    const denied = await cmdGoalResume("cli-unrestricted-resume", { repo, json: true, runGoal: async () => ({ completed: true }) });
    assert.equal(denied, 1);
    const allowed = captureRun();
    const resumed = await cmdGoalResume("cli-unrestricted-resume", { repo, mode: "unrestricted", confirmUnrestricted: true, autoAccept: true, capabilities: ["workspace_write"], config: unrestrictedConfig(), json: true, runGoal: allowed.runGoal });
    assert.equal(resumed, 0);
    assert.equal(allowed.calls.length, 1);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test("CLI unrestricted_general resume requires mode, confirmation, runtime permission, and preflight", async () => {
  const repo = root();
  try {
    fs.writeFileSync(path.join(repo, "minitok.yml"), "goal:\n  unrestricted_general:\n    enabled: true\n    capabilities: [workspace_write]\n    require_explicit_confirmation: true\n    require_auto_accept: true\n    allow_goal_inference: true\n    allow_provisional_criteria: true\n    allow_replanning: true\n    allow_tool_discovery: true\n    allow_external_adapters: false\n    max_plan_depth: 50\n    max_replan_count: 20\n    max_assumption_count: 100\n");
    const session = createGoalSession({ workspaceRoot: repo, goalSpec: goalSpec("Fix the bug in src/parser.js", "cli-general-resume") });
    session.state.execution_policy = { mode: "unrestricted_general", allowed: true, capabilities: ["workspace_write"], denied_capabilities: [], approval_required: false };
    saveGoalSession(session);
    releaseGoalSessionLock(session);
    const deniedMode = await cmdGoalResume("cli-general-resume", { repo, json: true, config: unrestrictedGeneralConfig(), runGoal: async () => ({ completed: true }) });
    assert.equal(deniedMode, 1);
    const deniedPermission = await cmdGoalResume("cli-general-resume", { repo, mode: "unrestricted_general", confirmUnrestricted: true, autoAccept: true, config: unrestrictedGeneralConfig(), json: true, runGoal: async () => ({ completed: true }) });
    assert.equal(deniedPermission, 1);
    const allowed = captureRun();
    const resumed = await cmdGoalResume("cli-general-resume", { repo, mode: "unrestricted_general", confirmUnrestricted: true, autoAccept: true, allowUnrestrictedGeneral: true, auditPersisted: true, integrityPreflight: true, capabilities: ["workspace_write"], config: unrestrictedGeneralConfig(), json: true, runGoal: allowed.runGoal });
    assert.equal(resumed, 0);
    assert.equal(allowed.calls.length, 1);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test("CLI sessionResponse exposes required additive nunchi fields", () => {
  const repo = root();
  try {
    const session = createGoalSession({ workspaceRoot: repo, goalSpec: goalSpec("Fix the bug in src/parser.js", "cli-response") });
    session.state.goal_plan = plan();
    session.state.inferred_steps = session.state.goal_plan.inferred_steps;
    session.state.optional_steps = [{ id: "optional", required: false, status: "deferred" }];
    session.state.missing_information = ["none"];
    session.state.out_of_scope_candidates = [{ step_id: "outside", status: "not_added" }];
    session.state.expansion_confidence = 0.82;
    session.state.requires_user_confirmation = true;
    session.state.questions = ["Confirm the persisted plan"];
    const response = sessionResponse(session);
    for (const field of ["goal_plan", "inferred_steps", "optional_steps", "requested_capabilities", "granted_capabilities", "denied_capabilities", "execution_mode", "policy_decision", "questions", "missing_information", "requires_user_confirmation", "out_of_scope_candidates", "blocker", "alternatives", "recommended_action", "resume_action", "execution_audits"]) assert.ok(Object.prototype.hasOwnProperty.call(response, field), field);
    assert.equal(response.goal_plan.inferred_steps[0].id, "persisted-fix");
    assert.equal(response.optional_steps[0].status, "deferred");
    releaseGoalSessionLock(session);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});
