"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { loadConfig, validateConfig, redactGoalExecutionConfig } = require("../src/config/loader");
const { resolveExecutionPolicy } = require("../src/goal/execution_policy");
const { cmdGoalStart } = require("../src/cli/commands/goal");
const { getToolHandler } = require("../src/mcp/tools");
function box(configText = "") { const root = fs.mkdtempSync(path.join(os.tmpdir(), "minitok-phase7-")); if (configText) fs.writeFileSync(path.join(root, "minitok.yml"), configText); return { root, clean: () => fs.rmSync(root, { recursive: true, force: true }) }; }
const general = { enabled: true, require_explicit_confirmation: true, require_auto_accept: true, allow_goal_inference: true, allow_provisional_criteria: true, allow_replanning: true, allow_tool_discovery: true, allow_external_adapters: false, capabilities: ["goal_inference", "criteria_inference", "plan_expansion", "replanning", "tool_discovery", "workspace_write"], max_plan_depth: 50, max_replan_count: 20, max_assumption_count: 100 };
const generalConfig = { goal: { unrestricted_general: general } };
const generalInput = { mode: "unrestricted_general", capabilities: ["goal_inference", "criteria_inference", "plan_expansion", "replanning", "tool_discovery", "workspace_write"], explicit_confirmation: true, auto_accept: true, runtime_permission: true, audit_persisted: true, integrity_preflight: true, config: generalConfig };
function yamlConfig() { return `goal:\n  unrestricted_general:\n    enabled: true\n    require_explicit_confirmation: true\n    require_auto_accept: true\n    allow_goal_inference: true\n    allow_provisional_criteria: true\n    allow_replanning: true\n    allow_tool_discovery: true\n    allow_external_adapters: false\n    capabilities: [goal_inference, criteria_inference, plan_expansion, replanning, tool_discovery, workspace_write]\n    max_plan_depth: 50\n    max_replan_count: 20\n    max_assumption_count: 100\n`; }
function parse(result) { return JSON.parse(result.content[0].text); }

test("general autonomy is disabled by default and aliases cannot bypass the explicit mode", () => {
  const config = loadConfig(path.join(os.tmpdir(), "phase7-no-config.yml"));
  assert.equal(config.goal.default_mode, "safe"); assert.equal(config.goal.unrestricted_general.enabled, false);
  assert.equal(resolveExecutionPolicy({ ...generalInput, config }).allowed, false);
  assert.equal(resolveExecutionPolicy({ ...generalInput, mode: "unrestricted-general" }).denied_capabilities[0], "invalid_mode");
});

test("config and resolver reject unknown, duplicate, and always-blocked general capabilities", () => {
  assert.throws(() => validateConfig({ goal: { unrestricted_general: { capabilities: ["unknown_general"] } } }), /unknown capability/);
  assert.throws(() => validateConfig({ goal: { unrestricted_general: { capabilities: ["read", "read"] } } }), /duplicate/);
  assert.throws(() => validateConfig({ goal: { unrestricted_general: { capabilities: ["protected_path_write"] } } }), /always-blocked/);
  const unknown = resolveExecutionPolicy({ ...generalInput, capabilities: ["unknown_general"] }); assert.equal(unknown.allowed, false); assert.deepEqual(unknown.denied_capabilities, ["unknown_general"]);
  const blocked = resolveExecutionPolicy({ ...generalInput, capabilities: ["protected_path_write"] }); assert.equal(blocked.allowed, false); assert.deepEqual(blocked.always_blocked_capabilities, ["protected_path_write"]);
});

test("CLI and MCP expose the same allowed general policy decision", async () => {
  const cliBox = box(yamlConfig()); const mcpBox = box(yamlConfig()); const capabilities = general.capabilities.join(",");
  try {
    let cliPolicy;
    const cliCode = await cmdGoalStart("Make the local service ready", { repo: cliBox.root, mode: "unrestricted_general", confirmUnrestrictedGeneral: true, allowUnrestrictedGeneral: true, autoAccept: true, capabilities, json: true, runGoal: async (_spec, options) => { cliPolicy = options.policyDecision; return { completed: false, state: "blocked" }; } });
    assert.equal(cliCode, 1); assert.equal(cliPolicy.mode, "unrestricted_general");
    const services = { entitlement: { status: async () => ({ allowed: true, state: "ALLOWED" }) } };
    const runtime = { workspaceRoot: mcpBox.root, permissions: new Set(["read", "write", "verify_exec", "auto_accept", "unrestricted_general_autonomous"]), safeResult: true, services, taskExecutor: async () => ({ success: false, status: "blocked" }), evaluator: async () => ({ completed: false, criteria: [], evidence: [] }) };
    const result = await getToolHandler("minitok_goal_start", { goal: "Make the local service ready", repo: mcpBox.root, mode: "unrestricted_general", confirm_unrestricted_general: true, capabilities: general.capabilities }, services, runtime);
    const value = parse(result); assert.equal(result.isError, false); assert.equal(value.execution_mode, cliPolicy.mode); assert.deepEqual(value.granted_capabilities, cliPolicy.capabilities); assert.equal(value.policy_decision, "allowed");
  } finally { cliBox.clean(); mcpBox.clean(); }
});

test("redacted policy projection contains no credential material", () => {
  const safe = redactGoalExecutionConfig(validateConfig({ ...generalConfig, providers: { local: { api_key: "secret-value" } } }));
  assert.doesNotMatch(JSON.stringify(safe), /secret-value|api_key|password|token|authorization/i); assert.equal(safe.unrestricted_general.enabled, true);
});


test("every unrestricted_general gate fails closed independently", () => {
  for (const field of ["explicit_confirmation", "auto_accept", "runtime_permission", "audit_persisted", "integrity_preflight"]) {
    const input = { ...generalInput, [field]: false }; const decision = resolveExecutionPolicy(input);
    assert.equal(decision.allowed, false, field); assert.ok(decision.denied_capabilities.length > 0, field);
  }
  for (const field of ["enabled", "allow_goal_inference", "allow_provisional_criteria", "allow_replanning", "allow_tool_discovery"]) {
    const policy = { ...general }; policy[field] = false;
    const decision = resolveExecutionPolicy({ ...generalInput, config: { goal: { unrestricted_general: policy } } });
    assert.equal(decision.allowed, false, field);
  }
  for (const field of ["max_plan_depth", "max_replan_count", "max_assumption_count"]) {
    const policy = { ...general }; delete policy[field];
    const decision = resolveExecutionPolicy({ ...generalInput, config: { goal: { unrestricted_general: policy } } });
    assert.equal(decision.allowed, false, field); assert.deepEqual(decision.denied_capabilities, ["budget_limits"]);
  }
});

test("general and existing unrestricted policies remain separate", () => {
  const unrestrictedOnly = { goal: { unrestricted: { enabled: true, capabilities: ["publish"], require_explicit_confirmation: true, require_auto_accept: true } } };
  assert.equal(resolveExecutionPolicy({ mode: "unrestricted", capabilities: ["publish"], explicit_confirmation: true, auto_accept: true, config: unrestrictedOnly }).allowed, true);
  assert.equal(resolveExecutionPolicy({ ...generalInput, config: unrestrictedOnly }).allowed, false);
  const generalOnly = { goal: { unrestricted: { enabled: false, capabilities: ["publish"], require_explicit_confirmation: true, require_auto_accept: true }, unrestricted_general: general } };
  assert.equal(resolveExecutionPolicy({ ...generalInput, config: generalOnly }).allowed, true);
  assert.equal(resolveExecutionPolicy({ mode: "unrestricted", capabilities: ["publish"], explicit_confirmation: true, auto_accept: true, config: generalOnly }).allowed, false);
});
