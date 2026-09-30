"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { ADAPTER_KINDS, createAdapterRegistry, registerAdapter, discoverAdapters, executeAdapter, validateAdapterDescriptor, adapterFailureToBlockerInput } = require("../src/goal/adapter_registry");
const { discoverPlanAdapters } = require("../src/goal/general_planner");

function mock(name, output, extra = {}) { return { name, capabilities: ["read"], input_schema: { type: "object", required: ["value"], properties: { value: { type: "string" } }, additionalProperties: false }, output_schema: { type: "object", required: ["success"], properties: { success: { type: "boolean" } }, additionalProperties: true }, side_effects: [], reversible: true, rollback_support: true, verification_support: true, environment_requirements: {}, execution_policy: "safe", enabled: true, executor: () => output, ...extra }; }
function registryWith(adapter) { return createAdapterRegistry([adapter]); }

test("discovers every canonical adapter kind with the required contract", () => {
  const registry = createAdapterRegistry();
  assert.deepEqual([...registry.keys()], ADAPTER_KINDS);
  const discovered = discoverAdapters(registry);
  assert.equal(discovered.length, ADAPTER_KINDS.length);
  for (const adapter of discovered) for (const field of ["name", "capabilities", "input_schema", "output_schema", "side_effects", "reversible", "rollback_support", "verification_support", "environment_requirements", "execution_policy"]) assert.ok(Object.prototype.hasOwnProperty.call(adapter, field), `${adapter.name}.${field}`);
});

test("planner can query adapter capabilities without exposing executors", () => { const values = discoverPlanAdapters(["read"]); assert.ok(values.some(item => item.name === "filesystem")); assert.ok(values.every(item => !Object.prototype.hasOwnProperty.call(item, "executor"))); });

test("fails closed on capability mismatch", () => { const result = executeAdapter(registryWith(mock("filesystem", { success: true })), "filesystem", { value: "x" }, { capabilities: [] }); assert.equal(result.code, "ADAPTER_CAPABILITY_MISMATCH"); assert.deepEqual(result.missing_capabilities, ["read"]); });

test("executes an injected mock adapter and requires verifier evidence for completion", () => { const registry = registryWith(mock("filesystem", { success: true })); const result = executeAdapter(registry, "filesystem", { value: "x" }, { capabilities: ["read"] }); assert.equal(result.status, "verification_required"); assert.equal(result.completed, false); });

test("accepts mock completion only with executed valid verifier evidence", () => { const registry = registryWith(mock("filesystem", { success: true, verifier_evidence: [{ valid: true, executed: true }] })); const result = executeAdapter(registry, "filesystem", { value: "x" }, { capabilities: ["read"] }); assert.equal(result.status, "completed"); assert.equal(result.completed, true); });

test("production adapter is disabled without opt-in and audit", () => { const adapter = mock("api", { success: true }, { capabilities: ["external_call"], production: true, execution_policy: "authorized_external" }); const registry = registryWith(adapter); assert.equal(executeAdapter(registry, "api", { value: "x" }, { capabilities: ["external_call"] }).code, "PRODUCTION_ADAPTER_DISABLED"); assert.equal(executeAdapter(registry, "api", { value: "x" }, { capabilities: ["external_call"], production_adapter_opt_in: true }).code, "PRODUCTION_AUDIT_REQUIRED"); });

test("production adapter executes only after explicit opt-in, audit, and integrity gates", () => { const adapter = mock("api", { success: true, verifier_evidence: [{ valid: true, executed: true }] }, { capabilities: ["external_call"], production: true, execution_policy: "authorized_external" }); const result = executeAdapter(registryWith(adapter), "api", { value: "x" }, { capabilities: ["external_call"], production_adapter_opt_in: true, audit_persisted: true, integrity_preflight: true }); assert.equal(result.completed, true); });

test("exposes rollback support metadata without treating it as verification", () => { const registry = registryWith(mock("filesystem", { success: true }, { rollback_support: true })); const result = executeAdapter(registry, "filesystem", { value: "x" }, { capabilities: ["read"] }); assert.equal(result.rollback_support, true); assert.equal(result.completed, false); });

test("rejects invalid descriptor schemas and invalid adapter input", () => { assert.equal(validateAdapterDescriptor({ name: "filesystem" }).valid, false); const registry = registryWith(mock("filesystem", { success: true })); const result = executeAdapter(registry, "filesystem", {}, { capabilities: ["read"] }); assert.equal(result.code, "ADAPTER_INPUT_INVALID"); });

test("always-blocked adapter policies cannot execute", () => { const adapter = mock("filesystem", { success: true }, { execution_policy: "always_blocked" }); const result = executeAdapter(registryWith(adapter), "filesystem", { value: "x" }, { capabilities: ["read"] }); assert.equal(result.code, "ALWAYS_BLOCKED"); assert.equal(result.completed, false); });

test("maps adapter failure to blocker alternatives with redacted context", () => { const result = adapterFailureToBlockerInput({ code: "ADAPTER_CAPABILITY_MISMATCH", adapter: "api", secret: "password=hidden" }, { step_id: "step-1", evidence: [{ output: "token=hidden" }] }); assert.equal(result.category, "missing_capability"); assert.equal(result.alternatives.length, 2); assert.doesNotMatch(JSON.stringify(result), /password=hidden|token=hidden/i); });

test("source and runtime adapter registries remain in parity", () => { const read = file => fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n"); assert.equal(read(path.join(__dirname, "..", "src", "goal", "adapter_registry.js")), read(path.join(__dirname, "..", "extension", "runtime", "src", "goal", "adapter_registry.js"))); assert.equal(read(path.join(__dirname, "..", "src", "goal", "general_planner.js")), read(path.join(__dirname, "..", "extension", "runtime", "src", "goal", "general_planner.js"))); });
