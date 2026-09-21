"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { cmdGoalStart, cmdGoalContinue } = require("../src/cli/commands/goal");
const { executeGoal } = require("../src/goal/general_execution");
const { createGoalSession, saveGoalSession, releaseGoalSessionLock } = require("../src/goal/session");
const { getToolHandler } = require("../src/mcp/tools");
function configText() { return `goal:\n  unrestricted_general:\n    enabled: true\n    capabilities: [goal_inference, criteria_inference, plan_expansion, replanning, workspace_write]\n    require_explicit_confirmation: true\n    require_auto_accept: true\n    allow_goal_inference: true\n    allow_provisional_criteria: true\n    allow_replanning: true\n    allow_tool_discovery: true\n    allow_external_adapters: false\n    max_plan_depth: 50\n    max_replan_count: 20\n    max_assumption_count: 100\n`;
}
function box() { const root = fs.mkdtempSync(path.join(os.tmpdir(), "minitok-phase1-general-")); fs.writeFileSync(path.join(root, "minitok.yml"), configText()); return { root, clean: () => fs.rmSync(root, { recursive: true, force: true }) }; }
function plan() { return { plan_version: 1, status: "ready", steps: [{ id: "general-step", description: "Inspect and verify the requested outcome", depends_on: [], target_criteria: ["general-placeholder"], status: "proposed" }] }; }
function policy() { return { mode: "unrestricted_general", allowed: true, capabilities: ["goal_inference", "criteria_inference", "plan_expansion", "replanning"], denied_capabilities: [], approval_required: false, audit_context: { explicit_confirmation: true, auto_accept: true, runtime_permission: true, audit_persisted: true, integrity_preflight: true } }; }
function payload(result) { return JSON.parse(result.content[0].text); }

test("CLI general start routes the default execution through runGeneralGoalLoop", async () => {
  const b = box();
  try {
    let received;
    const code = await cmdGoalStart("Make the service production-ready", { repo: b.root, mode: "unrestricted_general", confirmUnrestrictedGeneral: true, allowUnrestrictedGeneral: true, autoAccept: true, capabilities: "goal_inference,criteria_inference,plan_expansion,replanning", json: true, generalLoop: async (intent, options) => { received = { intent, options }; return { state: "blocked", completed: false, final_reason: "test loop" }; } });
    assert.equal(code, 1);
    assert.equal(received.options.mode, "unrestricted_general");
    assert.equal(received.options.session.state.general_execution, true);
    assert.ok(received.options.goalPlan);
    assert.ok(received.options.hypotheses.length >= 1);
    assert.ok(received.options.assumptions.length >= 1);
  } finally { b.clean(); }
});

test("CLI continue routes a persisted general session through the loop", async () => {
  const b = box();
  const spec = { schema_version: 1, goal_id: "phase1-cli-continue", objective: "Make the service production-ready", success_criteria: [{ id: "done", description: "The outcome is verified", required: true, verifier: { type: "custom", id: "done", config: {} } }], constraints: { allowed_paths: [], blocked_paths: [".git"], max_cycles: 2, max_tokens: 0, timeout_ms: 0, stagnation_limit: 2, max_changed_files: 5, same_task_limit: 2, same_failure_limit: 2, requires_approval_for: [] }, execution_policy: { mode: "unrestricted_general" } };
  const session = createGoalSession({ workspaceRoot: b.root, goalSpec: spec, generalExecution: true });
  session.state.execution_policy = policy(); session.state.goal_plan = null; saveGoalSession(session); releaseGoalSessionLock(session);
  try {
    let called = false;
    const code = await cmdGoalContinue(spec.goal_id, { repo: b.root, mode: "unrestricted_general", confirmUnrestrictedGeneral: true, allowUnrestrictedGeneral: true, autoAccept: true, capabilities: ["goal_inference", "criteria_inference", "plan_expansion", "replanning"], json: true, generalLoop: async () => { called = true; return { state: "blocked", completed: false }; } });
    assert.equal(code, 1);
    assert.equal(called, true);
  } finally { b.clean(); }
});

test("MCP general start routes through the injected general loop and carries policy context", async () => {
  const b = box();
  const services = { entitlement: { status: async () => ({ allowed: true, state: "ALLOWED" }) } };
  let called = false;
  try {
    const result = await getToolHandler("minitok_goal_start", { goal: "Make the service production-ready", repo: b.root, mode: "unrestricted_general", confirm_unrestricted_general: true, capabilities: ["goal_inference", "criteria_inference", "plan_expansion", "replanning"] }, services, { workspaceRoot: b.root, permissions: new Set(["read", "write", "verify_exec", "auto_accept", "unrestricted_general_autonomous"]), safeResult: true, generalLoop: async (_intent, options) => { called = options.mode === "unrestricted_general" && options.policyDecision?.mode === "unrestricted_general"; return { state: "blocked", completed: false }; } });
    assert.equal(result.isError || false, false);
    assert.equal(called, true);
    assert.equal(payload(result).state, "running");
  } finally { b.clean(); }
});

test("MCP continue routes a persisted general session through the loop", async () => {
  const b = box();
  const spec = { schema_version: 1, goal_id: "phase1-mcp-continue", objective: "Make the service production-ready", success_criteria: [{ id: "done", description: "The outcome is verified", required: true, verifier: { type: "custom", id: "done", config: {} } }], constraints: { allowed_paths: [], blocked_paths: [".git"], max_cycles: 2, max_tokens: 0, timeout_ms: 0, stagnation_limit: 2, max_changed_files: 5, same_task_limit: 2, same_failure_limit: 2, requires_approval_for: [] }, execution_policy: { mode: "unrestricted_general" } };
  const session = createGoalSession({ workspaceRoot: b.root, goalSpec: spec, generalExecution: true });
  session.state.execution_policy = policy(); saveGoalSession(session); releaseGoalSessionLock(session);
  const services = { entitlement: { status: async () => ({ allowed: true, state: "ALLOWED" }) } };
  try {
    let called = false;
    const result = await getToolHandler("minitok_goal_continue", { goal_id: spec.goal_id, repo: b.root, mode: "unrestricted_general", confirm_unrestricted_general: true, capabilities: ["goal_inference", "criteria_inference", "plan_expansion", "replanning"] }, services, { workspaceRoot: b.root, permissions: new Set(["read", "write", "verify_exec", "auto_accept", "unrestricted_general_autonomous"]), safeResult: true, generalLoop: async () => { called = true; return { state: "blocked", completed: false }; } });
    assert.equal(result.isError || false, false);
    assert.equal(called, true);
  } finally { b.clean(); }
});

test("explicit GoalSpec and legacy unrestricted do not route to the general loop", async () => {
  let generalCalled = false;
  const spec = { schema_version: 1, goal_id: "phase1-explicit", objective: "Fix the bug in src/parser.js", success_criteria: [{ id: "fix", description: "The bug is fixed", required: true, verifier: { type: "custom", id: "fix", config: {} } }], constraints: { allowed_paths: [], blocked_paths: [".git"], max_cycles: 1, max_tokens: 0, timeout_ms: 0, stagnation_limit: 1, max_changed_files: 5, same_task_limit: 2, same_failure_limit: 2, requires_approval_for: [] }, execution_policy: { mode: "unrestricted" } };
  const result = await executeGoal(spec, { mode: "unrestricted", general_inference: false, generalLoop: async () => { generalCalled = true; return { completed: true }; }, runGoal: async () => ({ completed: false, state: "running" }) });
  assert.equal(result.state, "running");
  assert.equal(generalCalled, false);
});

test("general loop rejects completion without valid executed evidence", async () => {
  const result = await executeGoal({ objective: "verify", constraints: { max_cycles: 1, max_tokens: 0, timeout_ms: 0, stagnation_limit: 1 }, success_criteria: [] }, { mode: "unrestricted_general", general_inference: true, general_execution: true, explicit_confirmation: true, runtime_permission: true, audit_persisted: true, integrity_preflight: true, generalLoop: async (_intent, options) => ({ state: options.allow_general ? "blocked" : "blocked", completed: false }) });
  assert.equal(result.completed, false);
  assert.equal(result.state, "blocked");
});

test("source and extension runtime entrypoint files remain in parity", () => {
  for (const relative of ["goal/general_execution.js", "goal/general_loop.js", "goal/session.js", "cli/commands/goal.js", "mcp/goal-tools.js"]) {
    const source = fs.readFileSync(path.join(__dirname, "..", "src", relative), "utf8").replace(/\r\n/g, "\n");
    const runtime = fs.readFileSync(path.join(__dirname, "..", "extension", "runtime", "src", relative), "utf8").replace(/\r\n/g, "\n");
    assert.equal(runtime, source, relative);
  }
});
