"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { cmdGoalStart, cmdGoalContinue } = require("../src/cli/commands/goal");
const { createGoalSession, saveGoalSession, releaseGoalSessionLock } = require("../src/goal/session");

function configText() { return `goal:\n  unrestricted_general:\n    enabled: true\n    capabilities: [goal_inference, criteria_inference, plan_expansion, replanning, workspace_write]\n    require_explicit_confirmation: true\n    require_auto_accept: true\n    allow_goal_inference: true\n    allow_provisional_criteria: true\n    allow_replanning: true\n    allow_tool_discovery: true\n    allow_external_adapters: false\n    max_plan_depth: 50\n    max_replan_count: 20\n    max_assumption_count: 100\n`; }
function box() { const root = fs.mkdtempSync(path.join(os.tmpdir(), "minitok-cli-general-")); fs.writeFileSync(path.join(root, "minitok.yml"), configText()); return { root, clean: () => fs.rmSync(root, { recursive: true, force: true }) }; }

async function start(root, extra = {}) {
  let received;
  const code = await cmdGoalStart("Make the service production-ready", { repo: root, mode: "unrestricted-general", confirmUnrestrictedGeneral: true, allowUnrestrictedGeneral: true, autoAccept: true, capabilities: "goal_inference,criteria_inference,plan_expansion,replanning,workspace_write", json: true, runGoal: async (spec, options) => { received = { spec, options }; return { completed: false, state: "running" }; }, ...extra });
  return { code, received };
}

test("CLI interprets abstract natural language without explicit criteria in unrestricted_general", async () => {
  const b = box();
  try {
    const result = await start(b.root);
    assert.equal(result.code, 1);
    assert.equal(result.received.spec.objective, "Make the service production-ready");
    assert.ok(result.received.options.goalPlan.inferred_steps.length >= 2);
    assert.ok(result.received.options.goalExpansion.candidate_criteria.some(item => item.provisional === true));
    assert.equal(result.received.options.policyDecision.mode, "unrestricted_general");
  } finally { b.clean(); }
});

test("CLI safe mode preserves clarification for abstract goals", async () => {
  const b = box();
  try {
    let called = false;
    const code = await cmdGoalStart("Make the service production-ready", { repo: b.root, mode: "safe", json: true, runGoal: async () => { called = true; return { completed: true }; } });
    assert.equal(code, 2);
    assert.equal(called, false);
  } finally { b.clean(); }
});

test("CLI general resume requires explicit reauthorization instead of trusting stored mode", async () => {
  const b = box();
  const session = createGoalSession({ workspaceRoot: b.root, goalSpec: { schema_version: 1, goal_id: "cli-general-resume", objective: "Make the service production-ready", success_criteria: [{ id: "done", description: "verified", required: true, verifier: { type: "custom", id: "done", config: {} } }], constraints: { allowed_paths: [], blocked_paths: [".git"], max_cycles: 2, max_tokens: 0, timeout_ms: 0, stagnation_limit: 2, max_changed_files: 5, same_task_limit: 2, same_failure_limit: 2, requires_approval_for: [] }, execution_policy: { mode: "unrestricted_general" } } });
  try {
    session.state.execution_policy = { mode: "unrestricted_general", allowed: true, capabilities: [], denied_capabilities: [] };
    saveGoalSession(session); releaseGoalSessionLock(session);
    assert.equal(await cmdGoalContinue("cli-general-resume", { repo: b.root, json: true }), 1);
  } finally { b.clean(); }
});
