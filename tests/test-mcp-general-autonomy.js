"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { getToolDefinitions, getToolHandler } = require("../src/mcp/tools");

function configText() { return `goal:\n  unrestricted_general:\n    enabled: true\n    capabilities: [goal_inference, criteria_inference, plan_expansion, replanning, workspace_write]\n    require_explicit_confirmation: true\n    require_auto_accept: true\n    allow_goal_inference: true\n    allow_provisional_criteria: true\n    allow_replanning: true\n    allow_tool_discovery: true\n    allow_external_adapters: false\n    max_plan_depth: 50\n    max_replan_count: 20\n    max_assumption_count: 100\n`; }
function box(permissions = ["read", "write", "verify_exec", "auto_accept", "unrestricted_general_autonomous"]) { const root = fs.mkdtempSync(path.join(os.tmpdir(), "minitok-mcp-general-")); fs.writeFileSync(path.join(root, "minitok.yml"), configText()); const services = { entitlement: { status: async () => ({ allowed: true, state: "ALLOWED" }) } }; const runtime = { workspaceRoot: root, permissions: new Set(permissions), safeResult: true, services, taskExecutor: async () => ({ success: true, status: "success" }), evaluator: async () => ({ completed: false, criteria: [], evidence: [] }) }; return { root, services, runtime, call: args => getToolHandler("minitok_goal_start", args, services, runtime), clean: () => fs.rmSync(root, { recursive: true, force: true }) }; }
function payload(result) { return JSON.parse(result.content[0].text); }

for (const name of ["minitok_goal_start", "minitok_goal_continue", "minitok_goal_resume"]) test(`MCP general schema exposes explicit general confirmation: ${name}`, () => { const schema = getToolDefinitions().find(tool => tool.name === name).inputSchema; assert.ok(schema.properties.confirm_unrestricted_general); assert.ok(schema.properties.mode.enum.includes("unrestricted_general")); });

test("MCP interprets abstract natural language and returns provisional criteria", async () => {
  const b = box();
  try {
    const result = await b.call({ goal: "Make the service production-ready", repo: b.root, mode: "unrestricted_general", confirm_unrestricted_general: true, capabilities: ["goal_inference", "criteria_inference", "plan_expansion", "replanning", "workspace_write"] });
    const value = payload(result);
    assert.equal(result.isError, false);
    assert.equal(value.state, "running");
    assert.equal(value.execution_mode, "unrestricted_general");
    assert.ok(value.inferred_steps.length >= 2);
    assert.ok(value.goal_plan);
  } finally { b.clean(); }
});

test("MCP general mode fails closed without runtime permission and preserves always_blocked", async () => {
  const denied = box(["read", "write", "verify_exec", "auto_accept"]);
  try {
    const result = await denied.call({ goal: "Make the service production-ready", repo: denied.root, mode: "unrestricted_general", confirm_unrestricted_general: true, capabilities: ["goal_inference"] });
    assert.equal(result.isError, true);
    assert.equal(result.error.code, "UNRESTRICTED_GENERAL_PERMISSION_DENIED");
  } finally { denied.clean(); }
  const blocked = box();
  try {
    const result = await blocked.call({ goal: "Make the service production-ready", repo: blocked.root, mode: "unrestricted_general", confirm_unrestricted_general: true, capabilities: ["protected_path_write"] });
    assert.equal(result.isError, true);
    assert.equal(result.error.code, "ALWAYS_BLOCKED");
  } finally { blocked.clean(); }
});

test("MCP safe mode keeps clarification boundary for abstract goals", async () => {
  const b = box();
  try {
    const result = await getToolHandler("minitok_goal_start", { goal: "Make the service production-ready", repo: b.root, mode: "safe" }, b.services, b.runtime);
    const value = payload(result);
    assert.equal(value.state, "clarification_required");
    assert.equal(value.goal_plan, null);
  } finally { b.clean(); }
});
