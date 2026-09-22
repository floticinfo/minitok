"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createAdapterRegistry, executeAdapter, publicDescriptor } = require("../src/goal/adapter_registry");
const { requestFingerprint, externalStateFingerprint, validateExternalOperationContract } = require("../src/goal/external_operation_contract");

const inputSchema = { type: "object", required: ["value"], properties: { target: { type: "object" }, value: { type: "string" }, idempotency_key: { type: "string" } }, additionalProperties: true };
const outputSchema = { type: "object", required: ["success"], properties: { success: { type: "boolean" } }, additionalProperties: true };
function externalAdapter(executor, extra = {}) { return { name: "api", capabilities: ["external_call"], input_schema: inputSchema, output_schema: outputSchema, side_effects: ["external_call"], reversible: false, rollback_support: false, verification_support: true, environment_requirements: {}, execution_policy: "authorized_external", enabled: true, executor, external_operation_contract: { target_binding: { required: ["target_id"] }, required_capabilities: ["external_call"], mutation: true, read_after_write_required: true, retry_policy: { max_attempts: 1, retryable_statuses: ["timeout"], retry_unknown: false }, ...extra.contract }, ...extra }; }
function registry(executor, extra = {}) { return createAdapterRegistry([externalAdapter(executor, extra)]); }
function options(ledger, extra = {}) { return { mode: "authorized_external", capabilities: ["external_call"], operation_ledger: ledger, ...extra }; }
function target() { return { target: { target_id: "fixture-target", token: "secret-token" }, value: "publish-fixture" }; }
function passed(expected_external_state = { revision: 1 }) { return { success: true, expected_external_state, evidence: [{ valid: true, executed: true }] }; }

test("validates target binding and capability before an injected executor", async () => {
  let calls = 0;
  const adapter = registry(() => { calls += 1; return passed(); });
  const missingTarget = await executeAdapter(adapter, "api", { value: "x" }, options(new Map()));
  assert.equal(missingTarget.code, "EXTERNAL_TARGET_REQUIRED");
  const missingCapability = await executeAdapter(registry(() => { calls += 1; return passed(); }, { capabilities: [] }), "api", target(), options(new Map(), { capabilities: [] }));
  assert.equal(missingCapability.code, "EXTERNAL_CAPABILITY_MISMATCH");
  assert.equal(calls, 0);
});

test("requires an operation ledger and derives stable idempotency/request fingerprints", async () => {
  const adapter = registry(() => passed());
  const noLedger = await executeAdapter(adapter, "api", target(), options(undefined));
  assert.equal(noLedger.code, "OPERATION_LEDGER_REQUIRED");
  const first = await executeAdapter(adapter, "api", target(), options(new Map()));
  assert.match(first.idempotency_key, /^idem_[a-f0-9]{64}$/);
  assert.match(first.request_fingerprint, /^request_[a-f0-9]{64}$/);
  assert.equal(requestFingerprint("api", target(), adapter.get("api").external_operation_contract), first.request_fingerprint);
  assert.equal(externalStateFingerprint({ revision: 1, ignored: "x" }, ["revision"]), externalStateFingerprint({ revision: 1, ignored: "y" }, ["revision"]));
  assert.doesNotMatch(JSON.stringify(first), /secret-token/i);
});

test("prevents duplicate operations before calling the injected adapter twice", async () => {
  let calls = 0; const ledger = new Map(); const adapter = registry(() => { calls += 1; return passed(); }, { read_after_write_executor: () => ({ success: true, external_state: { revision: 1 } }) });
  const first = await executeAdapter(adapter, "api", target(), options(ledger));
  const second = await executeAdapter(adapter, "api", target(), options(ledger));
  assert.equal(first.status, "completed"); assert.equal(second.code, "DUPLICATE_EXTERNAL_OPERATION"); assert.equal(calls, 1);
});

test("requires read-after-write verification and detects external state drift", async () => {
  const expected = { revision: 7, status: "published" };
  const ok = await executeAdapter(registry(() => passed(expected), { read_after_write_executor: () => ({ success: true, external_state: expected }) }), "api", target(), options(new Map()));
  assert.equal(ok.completed, true); assert.equal(ok.verification.external_state.valid, true);
  const drift = await executeAdapter(registry(() => passed(expected), { read_after_write_executor: () => ({ success: true, external_state: { revision: 8, status: "published" } }) }), "api", target(), options(new Map()));
  assert.equal(drift.status, "unknown"); assert.equal(drift.verification.external_state.code, "EXTERNAL_STATE_DRIFT"); assert.equal(drift.completed, false);
});

test("preserves timeout, partial-success, and unknown outcomes without false completion", async () => {
  const timeout = await executeAdapter(registry(() => ({ status: "timeout", timed_out: true })), "api", target(), options(new Map()));
  const partial = await executeAdapter(registry(() => ({ status: "partial_success", partial_success: true, success: false })), "api", target(), options(new Map()));
  const unknown = await executeAdapter(registry(() => ({ status: "unknown" })), "api", target(), options(new Map()));
  assert.equal(timeout.status, "timeout"); assert.equal(partial.status, "partial_success"); assert.equal(unknown.status, "unknown");
  assert.equal(timeout.completed, false); assert.equal(partial.completed, false); assert.equal(unknown.completed, false);
});

test("applies explicit retry policy only to declared statuses", async () => {
  let calls = 0; const ledger = new Map();
  const adapter = registry(() => { calls += 1; return calls === 1 ? { status: "timeout", timed_out: true } : passed(); }, { contract: { retry_policy: { max_attempts: 2, retryable_statuses: ["timeout"] } }, read_after_write_executor: () => ({ success: true, external_state: { revision: 1 } }) });
  const result = await executeAdapter(adapter, "api", target(), options(ledger));
  assert.equal(calls, 2); assert.equal(result.attempts.length, 2); assert.equal(result.status, "completed");
});

test("rejects malformed contracts, hides injected readers, and preserves source/runtime parity", () => {
  assert.equal(validateExternalOperationContract({ target_binding: { required: [] } }).length > 0, true);
  const value = registry(() => passed()).get("api"); const exposed = publicDescriptor(value);
  assert.equal(exposed.executor, undefined); assert.equal(exposed.read_after_write_executor, undefined);
  const read = file => fs.readFileSync(path.join(__dirname, "..", file), "utf8").replace(/\r\n/g, "\n");
  assert.equal(read("src/goal/external_operation_contract.js"), read("extension/runtime/src/goal/external_operation_contract.js"));
  assert.equal(read("src/goal/adapter_registry.js"), read("extension/runtime/src/goal/adapter_registry.js"));
});
