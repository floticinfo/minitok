"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createGoalSpec } = require("../src/goal/spec");
const { createGoalSession, saveGoalSession, releaseGoalSessionLock } = require("../src/goal/session");
const { sessionResponse, cmdGoalStatus } = require("../src/cli/commands/goal");

function root() { return fs.mkdtempSync(path.join(os.tmpdir(), "minitok-cli-goal-")); }
function spec(id = "cli-goal") { return createGoalSpec({ schema_version: 1, goal_id: id, objective: "CLI goal", success_criteria: [{ id: "a", description: "a", required: true, verifier: { type: "custom", id: "a", config: {} } }], constraints: { allowed_paths: [], blocked_paths: [".git"], max_cycles: 2, max_tokens: 0, timeout_ms: 0, stagnation_limit: 2, max_changed_files: 5, same_task_limit: 2, same_failure_limit: 2, requires_approval_for: [] }, execution_policy: { mode: "safe" } }); }

test("CLI goal status exposes additive blocker and resume fields", () => {
  const repo = root();
  try {
    const session = createGoalSession({ workspaceRoot: repo, goalSpec: spec() });
    session.state.blockers = [{ category: "permission_blocked", recommended_alternative: "user-approval", requires_user_decision: true }];
    session.state.alternatives = [{ alternative_id: "user-approval", status: "approval_required", approval_request: { approval_required: true } }];
    session.state.final_outcome = { state: "escalated", completed: false };
    saveGoalSession(session);
    releaseGoalSessionLock(session);
    const status = cmdGoalStatus("cli-goal", { repo, json: true });
    assert.equal(status, 0);
    const response = sessionResponse(require("../src/goal/session").loadGoalSession(repo, "cli-goal", { lock: false }));
    assert.equal(response.state, "running");
    assert.equal(response.approval_required, true);
    assert.equal(response.verification_required, false);
    assert.equal(response.resume_check.requires_verification, false);
    assert.equal(response.recommended_action, "user-approval");
    assert.match(response.resume_action, /goal resume/);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test("CLI goal registration exposes explicit policy controls", () => {
  const { Command } = require("commander");
  const program = new Command();
  require("../src/cli/commands/goal").register(program);
  const start = program.commands.find(command => command.name() === "goal").commands.find(command => command.name() === "start");
  assert.ok(start.options.some(option => option.long === "--capabilities"));
  assert.ok(start.options.some(option => option.long === "--explicit-confirmation"));
  assert.ok(start.options.some(option => option.long === "--auto-accept"));
});

test("CLI goal registration includes start/status/continue/resume", () => {
  const { Command } = require("commander");
  const program = new Command();
  require("../src/cli/commands/goal").register(program);
  const goal = program.commands.find(command => command.name() === "goal");
  assert.ok(goal);
  assert.deepEqual(goal.commands.map(command => command.name()).sort(), ["continue", "resume", "start", "status"]);
});
