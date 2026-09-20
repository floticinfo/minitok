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
  assert.ok(start.options.some(option => option.long === "--mode"));
  assert.ok(start.options.some(option => option.long === "--capabilities"));
  assert.ok(start.options.some(option => option.long === "--capability"));
  assert.ok(start.options.some(option => option.long === "--confirm-unrestricted"));
  assert.ok(start.options.some(option => option.long === "--explicit-confirmation"));
  assert.ok(start.options.some(option => option.long === "--auto-accept"));
});

test("CLI accepts repeated capabilities and preserves the legacy comma-list", () => {
  const { Command } = require("commander");
  const program = new Command();
  require("../src/cli/commands/goal").register(program);
  const goal = program.commands.find(command => command.name() === "goal");
  const start = goal.commands.find(command => command.name() === "start");
  start.parseOptions(["--capabilities", "read,verify", "--capability", "workspace_write", "--capability", "publish"]);
  const { capabilityOptions } = require("../src/cli/commands/goal");
  assert.deepEqual(capabilityOptions({ capabilities: "read,verify", capability: ["workspace_write", "publish"] }), ["read", "verify", "workspace_write", "publish"]);
});

test("CLI unrestricted start requires the dedicated confirmation flag", async () => {
  const repo = root();
  try {
    const { cmdGoalStart } = require("../src/cli/commands/goal");
    const code = await cmdGoalStart("goal", { repo, mode: "unrestricted", capabilities: ["workspace_write"], autoAccept: true, json: true, goalSpec: spec("cli-unrestricted") });
    assert.equal(code, 1);
    assert.equal(fs.existsSync(path.join(repo, ".minitok", "goals")), false);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test("CLI rejects invalid capabilities before creating a session", async () => {
  const repo = root();
  try {
    const { cmdGoalStart } = require("../src/cli/commands/goal");
    const code = await cmdGoalStart("goal", { repo, mode: "unrestricted", confirmUnrestricted: true, autoAccept: true, capabilities: ["not_a_capability"], json: true, goalSpec: spec("cli-invalid-capability") });
    assert.equal(code, 1);
    assert.equal(fs.existsSync(path.join(repo, ".minitok", "goals")), false);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test("CLI JSON session response exposes policy fields and deterministic audit id", () => {
  const { sessionResponse } = require("../src/cli/commands/goal");
  const repo = root();
  try {
    const session = createGoalSession({ workspaceRoot: repo, goalSpec: spec("cli-json-policy") });
    session.state.execution_policy = { mode: "unrestricted", allowed: true, capabilities: ["workspace_write"], denied_capabilities: [], approval_required: false };
    const response = sessionResponse(session);
    for (const field of ["execution_mode", "requested_capabilities", "granted_capabilities", "denied_capabilities", "policy_decision", "audit_id"]) assert.ok(Object.prototype.hasOwnProperty.call(response, field), field);
    assert.equal(response.execution_mode, "unrestricted");
    assert.match(response.audit_id, /^audit-[a-f0-9]{16}$/);
    releaseGoalSessionLock(session);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test("CLI continue/resume do not inherit unrestricted mode without a new request", async () => {
  const repo = root();
  try {
    const session = createGoalSession({ workspaceRoot: repo, goalSpec: spec("cli-resume-policy") });
    session.state.execution_policy = { mode: "unrestricted", allowed: true, capabilities: ["workspace_write"], denied_capabilities: [], approval_required: false };
    saveGoalSession(session);
    releaseGoalSessionLock(session);
    const { cmdGoalContinue } = require("../src/cli/commands/goal");
    const code = await cmdGoalContinue("cli-resume-policy", { repo, json: true });
    assert.equal(code, 1);
    const loaded = require("../src/goal/session").loadGoalSession(repo, "cli-resume-policy", { lock: false });
    assert.equal(loaded.state.execution_policy.mode, "unrestricted");
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test("CLI goal registration includes start/status/continue/resume", () => {
  const { Command } = require("commander");
  const program = new Command();
  require("../src/cli/commands/goal").register(program);
  const goal = program.commands.find(command => command.name() === "goal");
  assert.ok(goal);
  assert.deepEqual(goal.commands.map(command => command.name()).sort(), ["continue", "resume", "start", "status"]);
});
