"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { observeEnvironment } = require("../src/goal/environment_observer");
const { createTool, preflightTool } = require("../src/goal/tool_registry");
const { createAdapterRegistry, descriptor } = require("../src/goal/adapter_registry");
const { executeGoal } = require("../src/goal/general_execution");
function general(options = {}) { return { mode: "unrestricted_general", general_inference: true, general_execution: true, explicit_confirmation: true, runtime_permission: true, audit_persisted: true, integrity_preflight: true, capabilities: ["read", "verify", "external_call"], ...options }; }
function loopResult(options) { return executeGoal({ objective: "route tools", constraints: { max_cycles: 1, max_tokens: 0, timeout_ms: 0, stagnation_limit: 1 }, success_criteria: [] }, general({ generalLoop: async (_intent, loopOptions) => { const observation = await loopOptions.observeEnvironment({ cycle: 0 }); const action = await loopOptions.execute({ id: "route-step", description: "route", required_commands: ["missing-command"] }, { environment: observation, cycle: 0 }); return action; }, ...options })); }

test("missing command produces a blocker result without invoking executor", async () => {
  let called = false; const result = await loopResult({ taskExecutor: async () => { called = true; return { status: "passed" }; }, observeEnvironment: async () => observeEnvironment({ workspaceRoot: process.cwd(), commands: ["missing-command"], commandAvailable: () => false }) });
  assert.equal(called, false); assert.equal(result.category, "tool_unavailable"); assert.match(result.reason, /command_unavailable/);
});

test("stale observation is re-observed before routing", async () => {
  let observations = 0; const old = "2020-01-01T00:00:00.000Z"; const fresh = new Date().toISOString(); const result = await loopResult({ observeEnvironment: async () => observeEnvironment({ workspaceRoot: process.cwd(), commands: [], ttl_ms: 60000, now: observations++ === 0 ? old : fresh }), taskExecutor: async () => ({ status: "passed", success: true }) });
  assert.equal(observations, 2); assert.notEqual(result.category, "environment_failure");
});

test("stale tool preflight is denied", () => { const tool = createTool({ name: "stale-tool", kind: "command", observed_at: "2020-01-01T00:00:00.000Z", ttl_ms: 1 }); const result = preflightTool(tool, { capabilities: ["read"], now: Date.now() }); assert.equal(result.allowed, false); assert.equal(result.status, "stale"); });

test("injected mock adapter executes only with capability and verifier evidence", async () => {
  let called = false; const registry = createAdapterRegistry([{ name: "filesystem", capabilities: ["read"], input_schema: { type: "object", additionalProperties: true }, executor: input => { called = true; return { success: true, evidence: [{ evidence_id: "adapter-evidence", valid: true, executed: true }], secret: input.secret }; } }]);
  const result = await executeGoal({ objective: "adapter", constraints: { max_cycles: 1, max_tokens: 0, timeout_ms: 0, stagnation_limit: 1 }, success_criteria: [] }, general({ adapterRegistry: registry, capabilities: ["read"], taskExecutor: async () => { throw new Error("task executor must not run"); }, generalLoop: async (_intent, options) => options.execute({ id: "adapter-step", description: "adapter", adapter: "filesystem", adapter_input: { secret: "password=hidden" } }, { environment: { commands: {}, tools: [], observed_at: new Date().toISOString(), ttl_ms: 60000 }, cycle: 0 }) }));
  assert.equal(called, true); assert.equal(result.status, "passed"); assert.equal(result.verification.valid, true); assert.doesNotMatch(JSON.stringify(result), /password=hidden/i);
});

test("external adapter is denied by default despite a registry executor", async () => {
  let called = false; const registry = createAdapterRegistry([{ name: "api", capabilities: ["external_call"], side_effects: ["external_call"], execution_policy: "authorized_external", input_schema: { type: "object", additionalProperties: true }, executor: () => { called = true; return { success: true, evidence: [{ valid: true, executed: true }] }; } }]);
  const result = await executeGoal({ objective: "external", constraints: { max_cycles: 1, max_tokens: 0, timeout_ms: 0, stagnation_limit: 1 }, success_criteria: [] }, general({ adapterRegistry: registry, capabilities: ["external_call"], explicit_confirmation: false, generalLoop: async (_intent, options) => options.execute({ id: "external-step", description: "external", adapter: "api", adapter_input: {} }, { environment: { commands: {}, tools: [], observed_at: new Date().toISOString(), ttl_ms: 60000 }, cycle: 0 }) }));
  assert.equal(called, false); assert.equal(result.category, "permission_blocked"); assert.equal(result.code, "EXTERNAL_CAPABILITY_REQUIRED");
});
