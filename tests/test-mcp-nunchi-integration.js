"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { getToolDefinitions, getToolHandler, validateArgs } = require("../src/mcp/tools");
const { loadGoalSession } = require("../src/goal/session");

function root() { return fs.mkdtempSync(path.join(os.tmpdir(), "minitok-mcp-nunchi-")); }
function spec(id = "mcp-nunchi", objective = "Fix the bug in src/parser.js") {
  return { schema_version: 1, goal_id: id, objective, success_criteria: [{ id: "fix", description: "The bug is fixed", required: true, verifier: { type: "custom", id: "verify-fix", config: {} } }], constraints: { allowed_paths: [], blocked_paths: [".git", ".env"], max_cycles: 3, max_tokens: 0, timeout_ms: 0, stagnation_limit: 2, max_changed_files: 10, same_task_limit: 2, same_failure_limit: 2, requires_approval_for: [] }, execution_policy: { mode: "safe" } };
}
function sandbox() {
  const repo = root();
  fs.writeFileSync(path.join(repo, "minitok.yml"), "goal:\n  default_mode: safe\n  unrestricted:\n    enabled: true\n    capabilities: [workspace_write]\n    require_explicit_confirmation: true\n    require_auto_accept: true\n");
  const services = { entitlement: { status: async () => ({ allowed: true, state: "ALLOWED" }) } };
  const runtime = { workspaceRoot: repo, permissions: new Set(["read", "write", "verify_exec"]), services, model: "test-model", safeResult: true };
  const call = (name, args) => getToolHandler(name, args, services, runtime);
  return { repo, runtime, call, clean: () => fs.rmSync(repo, { recursive: true, force: true }) };
}
function payload(result) { return JSON.parse(result.content[0].text); }
function wait(ms = 100) { return new Promise(resolve => setTimeout(resolve, ms)); }

for (const name of ["minitok_goal_start", "minitok_goal_continue", "minitok_goal_resume"]) {
  test(`MCP nunchi schema exposes planning inputs: ${name}`, () => {
    const schema = getToolDefinitions().find(tool => tool.name === name).inputSchema;
    for (const field of ["mode", "confirm_unrestricted", "capabilities", "success_criteria", "repository_context", "environment_state"]) assert.ok(schema.properties[field], `${name}.${field}`);
  });
}

test("MCP goal schemas expose unrestricted_general and its fail-closed policy inputs", () => {
  for (const name of ["minitok_goal_start", "minitok_goal_continue", "minitok_goal_resume"]) {
    const schema = getToolDefinitions().find(tool => tool.name === name).inputSchema;
    assert.ok(schema.properties.mode.enum.includes("unrestricted_general"));
    for (const field of ["audit_persisted", "integrity_preflight", "max_plan_depth", "max_replan_count", "max_assumption_count"]) assert.ok(schema.properties[field], `${name}.${field}`);
  }
});

test("MCP start prepares and persists GoalPlan/inferred step metadata", async () => {
  const box = sandbox();
  try {
    box.runtime.permissions.add("auto_accept");
    box.runtime.taskExecutor = async () => ({ success: true, status: "success", tokens: {} });
    box.runtime.evaluator = async () => ({ goal_id: "mcp-nunchi", completed: true, criteria: [{ id: "fix", status: "passed", evidence_ids: ["e-fix"] }], evidence: [{ evidence_id: "e-fix", valid: true, executed: true, execution: { executed: true } }], remaining_criteria: [], unknown_criteria: [] });

    const response = await box.call("minitok_goal_start", { goal: "Fix the bug in src/parser.js", repo: box.repo, goal_spec: spec(), mode: "supervised", explicit_confirmation: true });
    const value = payload(response);
    assert.equal(response.isError, false);
    assert.equal(value.state, "running");
    assert.equal(value.goal_plan.inferred_steps[0].id, "goal-change");
    assert.equal(value.inferred_steps[0].target_criteria[0], "fix");
    assert.equal(value.execution_mode, "supervised");
    assert.equal(value.policy_decision, "allowed");
    assert.ok(Object.prototype.hasOwnProperty.call(value, "optional_steps"));
    await wait(150);
    const stored = loadGoalSession(box.repo, "mcp-nunchi", { lock: false });
    assert.equal(stored.state.goal_plan.inferred_steps[0].id, "goal-change");
    assert.equal(stored.state.inferred_steps[0].target_criteria[0], "fix");
  } finally { box.clean(); }
});

test("MCP unrestricted_general requires a distinct runtime permission before confirmation", async () => {
  const box = sandbox();
  try {
    fs.writeFileSync(path.join(box.repo, "minitok.yml"), "goal:\n  default_mode: safe\n  unrestricted_general:\n    enabled: true\n    require_explicit_confirmation: true\n    require_auto_accept: true\n    allow_goal_inference: true\n    allow_provisional_criteria: true\n    allow_replanning: true\n    allow_tool_discovery: true\n    allow_external_adapters: false\n    capabilities: [goal_inference, criteria_inference, plan_expansion, replanning, tool_discovery, workspace_write]\n    max_plan_depth: 50\n    max_replan_count: 20\n    max_assumption_count: 100\n");
    const denied = await box.call("minitok_goal_start", { goal: "Fix the bug in src/parser.js", repo: box.repo, goal_spec: spec("mcp-general-permission"), mode: "unrestricted_general", capabilities: ["goal_inference"], confirm_unrestricted: true, audit_persisted: true, integrity_preflight: true });
    assert.equal(denied.isError, true);
    assert.equal(denied.error.code, "UNRESTRICTED_GENERAL_PERMISSION_DENIED");
    box.runtime.permissions.add("unrestricted_general_autonomous");
    box.runtime.permissions.add("auto_accept");
    const noAudit = await box.call("minitok_goal_start", { goal: "Fix the bug in src/parser.js", repo: box.repo, goal_spec: spec("mcp-general-audit"), mode: "unrestricted_general", capabilities: ["goal_inference"], confirm_unrestricted: true });
    assert.equal(noAudit.isError, false);
    assert.equal(payload(noAudit).state, "running");
  } finally { box.clean(); }
});

test("MCP ambiguous goal returns additive clarification without creating a session", async () => {
  const box = sandbox();
  try {
    const response = await box.call("minitok_goal_start", { goal: "Improve the architecture", repo: box.repo, mode: "safe" });
    const value = payload(response);
    assert.equal(value.state, "clarification_required");
    assert.equal(value.goal_plan, null);
    assert.ok(Array.isArray(value.questions));
    assert.ok(Array.isArray(value.missing_information));
    assert.equal(fs.existsSync(path.join(box.repo, ".minitok", "goals")), false);
  } finally { box.clean(); }
});

test("MCP out-of-scope inferred work is rejected before session creation", async () => {
  const box = sandbox();
  try {
    const response = await box.call("minitok_goal_start", { goal: "Fix the bug in outside/secret.js", repo: box.repo, goal_spec: spec("mcp-outside", "Fix the bug in outside/secret.js"), mode: "supervised", explicit_confirmation: true, repository_context: { repository_odd: { allowed_paths: ["src"], blocked_paths: [".git"], protected_paths: [], allow_external: false } } });
    const value = payload(response);
    assert.equal(value.state, "clarification_required");
    assert.equal(value.goal_plan, null);
    assert.equal(value.out_of_scope_candidates[0].status, "not_added");
    assert.equal(fs.existsSync(path.join(box.repo, ".minitok", "goals")), false);
  } finally { box.clean(); }
});

test("MCP unrestricted retains runtime permission, confirmation, allowlist, and always-blocked errors", async () => {
  const box = sandbox();
  try {
    const deniedPermission = await box.call("minitok_goal_start", { goal: "Fix the bug in src/parser.js", repo: box.repo, goal_spec: spec("mcp-unrestricted-permission"), mode: "unrestricted", capabilities: ["workspace_write"], confirm_unrestricted: true, auto_accept: true });
    assert.equal(deniedPermission.isError, true);
    assert.equal(deniedPermission.error.code, "UNRESTRICTED_PERMISSION_DENIED");
    box.runtime.permissions.add("unrestricted_autonomous");
    const deniedConfirmation = await box.call("minitok_goal_start", { goal: "Fix the bug in src/parser.js", repo: box.repo, goal_spec: spec("mcp-unrestricted-confirmation"), mode: "unrestricted", capabilities: ["workspace_write"], auto_accept: true });
    assert.equal(deniedConfirmation.isError, true);
    assert.equal(deniedConfirmation.error.code, "UNRESTRICTED_CONFIRMATION_REQUIRED");
    box.runtime.permissions.add("auto_accept");
    const allowed = await box.call("minitok_goal_start", { goal: "Fix the bug in src/parser.js", repo: box.repo, goal_spec: spec("mcp-unrestricted-allowed"), mode: "unrestricted", capabilities: ["workspace_write"], confirm_unrestricted: true });
    assert.equal(allowed.isError, false);
    assert.equal(payload(allowed).policy_decision, "allowed");
    const blocked = await box.call("minitok_goal_start", { goal: "Fix the bug in src/parser.js", repo: box.repo, goal_spec: spec("mcp-unrestricted-blocked"), mode: "unrestricted", capabilities: ["protected_path_write"], confirm_unrestricted: true });
    assert.equal(blocked.isError, true);
    assert.equal(blocked.error.code, "ALWAYS_BLOCKED");
  } finally { box.clean(); }
});

test("MCP continue reuses stored GoalPlan without duplicate expansion", async () => {
  const box = sandbox();
  try {
    const started = await box.call("minitok_goal_start", { goal: "Fix the bug in src/parser.js", repo: box.repo, goal_spec: spec("mcp-continue"), mode: "supervised", explicit_confirmation: true });
    const startedValue = payload(started);
    assert.equal(startedValue.state, "running");
    const paused = await box.call("minitok_goal_pause", { goal_id: startedValue.goal_id, repo: box.repo, reason: "test duplicate expansion" });
    assert.equal(payload(paused).state, "paused");
    const continued = await box.call("minitok_goal_continue", { goal_id: startedValue.goal_id, repo: box.repo, mode: "supervised", explicit_confirmation: true });
    const value = payload(continued);
    assert.equal(value.state, "running");
    assert.equal(value.goal_plan.inferred_steps[0].id, "goal-change");
    assert.equal(value.inferred_steps[0].target_criteria[0], "fix");
  } finally { box.clean(); }
});

test("MCP unknown planning fields remain rejected", () => {
  assert.throws(() => validateArgs("minitok_goal_start", { goal: "x", repo: "C:\\repo", unknown_planning_field: true }), /Unknown argument/);
});
