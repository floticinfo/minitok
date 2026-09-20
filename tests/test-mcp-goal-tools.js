"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { getToolDefinitions, getToolHandler, validateArgs, requiredScopeFor } = require("../src/mcp/tools");

const TOKEN = "goal-tool-token";
function validSpec(id = "goal-mcp-test") {
  return { schema_version: 1, goal_id: id, objective: "goal test", success_criteria: [{ id: "a", description: "criterion", required: true, verifier: { type: "custom", id: "custom-a", config: {} } }], constraints: { allowed_paths: [], blocked_paths: [".git"], max_cycles: 2, max_tokens: 0, timeout_ms: 0, stagnation_limit: 3, max_changed_files: 20, same_task_limit: 2, same_failure_limit: 2, requires_approval_for: [] }, execution_policy: { mode: "safe" } };
}
function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "minitok-goal-mcp-"));
  const services = { entitlement: { status: async () => ({ allowed: true, state: "ALLOWED" }) } };
  const runtime = { workspaceRoot: root, permissions: new Set(["read", "write", "verify_exec"]), services, model: "test-model", safeResult: true };
  const call = (name, args) => getToolHandler(name, args, services, runtime);
  return { root, runtime, call, clean: () => fs.rmSync(root, { recursive: true, force: true }) };
}
function payload(result) { return JSON.parse(result.content[0].text); }

for (const name of ["minitok_goal_start", "minitok_goal_status", "minitok_goal_continue", "minitok_goal_pause", "minitok_goal_resume", "minitok_goal_cancel"]) {
  test(`declares ${name} with explicit scope`, () => {
    assert.ok(getToolDefinitions().some(tool => tool.name === name));
    assert.equal(requiredScopeFor(name), name === "minitok_goal_status" ? "read" : "write");
  });
}

test("goal start returns clarification_required without creating a session", async () => {
  const box = sandbox();
  try {
    const response = await box.call("minitok_goal_start", { goal: "Improve the architecture", repo: box.root, mode: "safe" });
    const value = payload(response);
    assert.equal(value.state, "clarification_required");
    assert.ok(Array.isArray(value.questions));
    assert.equal(fs.existsSync(path.join(box.root, ".minitok", "goals")), false);
  } finally { box.clean(); }
});

test("goal start and status use persistent GoalState and evaluator completion", async () => {
  const box = sandbox();
  try {
    box.runtime.evaluator = async () => ({ goal_id: "goal-mcp-test", completed: true, criteria: [{ id: "a", status: "passed", evidence_ids: ["e1"], reason: "passed" }], evidence: [{ evidence_id: "e1", valid: true, executed: true, execution: { executed: true } }], remaining_criteria: [], unknown_criteria: [], state_version: 3 });
    box.runtime.taskExecutor = async () => ({ success: true, status: "success", tokens: {} });
    const started = payload(await box.call("minitok_goal_start", { goal: "goal test", repo: box.root, goal_spec: validSpec(), mode: "safe" }));
    assert.equal(started.state, "running");
    await new Promise(resolve => setTimeout(resolve, 50));
    const status = payload(await box.call("minitok_goal_status", { goal_id: "goal-mcp-test", repo: box.root }));
    assert.equal(status.state, "completed");
    assert.equal(status.criteria[0].status, "passed");
    assert.ok(Object.prototype.hasOwnProperty.call(status, "current_state"));
    assert.ok(Object.prototype.hasOwnProperty.call(status, "alternatives"));
    assert.ok(Object.prototype.hasOwnProperty.call(status, "approval_required"));
    assert.ok(Object.prototype.hasOwnProperty.call(status, "verification_required"));
    assert.ok(Object.prototype.hasOwnProperty.call(status, "resume_check"));
    assert.ok(Object.prototype.hasOwnProperty.call(status, "resume_action"));
  } finally { box.clean(); }
});

test("goal pause/resume/cancel preserve the session and distinguish states", async () => {
  const box = sandbox();
  try {
    box.runtime.evaluator = async () => ({ goal_id: "goal-pause", completed: false, criteria: [{ id: "a", status: "failed", evidence_ids: ["e1"], reason: "pending" }], evidence: [{ evidence_id: "e1", valid: true, executed: true, execution: { executed: true } }], remaining_criteria: ["a"], unknown_criteria: [], state_version: 3 });
    box.runtime.taskExecutor = async () => new Promise(resolve => setTimeout(() => resolve({ success: false, status: "failure", tokens: {} }), 500));
    const started = payload(await box.call("minitok_goal_start", { goal: "goal test", repo: box.root, goal_spec: validSpec("goal-pause"), mode: "safe" }));
    const paused = payload(await box.call("minitok_goal_pause", { goal_id: started.goal_id, repo: box.root, reason: "test" }));
    assert.equal(paused.state, "paused");
    const resumed = payload(await box.call("minitok_goal_resume", { goal_id: started.goal_id, repo: box.root, mode: "safe" }));
    assert.equal(resumed.state, "running");
    const cancelled = payload(await box.call("minitok_goal_cancel", { goal_id: started.goal_id, repo: box.root, reason: "test cancel" }));
    assert.equal(cancelled.state, "failed");
  } finally { box.clean(); }
});

test("autonomous goal mode requires explicit auto_accept permission", async () => {
  const box = sandbox();
  try {
    box.runtime.permissions = new Set(["read", "write", "verify_exec"]);
    const response = await box.call("minitok_goal_start", { goal: "goal test", repo: box.root, goal_spec: validSpec("goal-auto"), mode: "autonomous" });
    assert.equal(response.isError, true);
    assert.match(response.error.message, /auto_accept/);
  } finally { box.clean(); }
});

test("goal arguments reject unknown fields and unsafe repository paths", () => {
  assert.throws(() => validateArgs("minitok_goal_start", { goal: "x", repo: "C:\\repo", unknown: true }), /Unknown argument/);
});
