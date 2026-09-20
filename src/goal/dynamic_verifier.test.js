"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  VERIFIER_TYPES,
  createDynamicVerifier,
  validateDynamicVerifier,
  synthesizeVerifier,
  commandValidation,
  evaluateDynamicVerifier,
  detectVerifierTampering,
  invalidateVerifierEvidence,
  resolveVerifierEvidence,
  isCompletionVerified,
} = require("./dynamic_verifier");

function verifier(overrides = {}) { return createDynamicVerifier({ criterion_id: "goal", type: "custom_adapter", description: "Observe the goal result", command_or_adapter: { adapter: "test" }, expected_observation: { ok: true }, ...overrides }); }

test("supports all declared verifier types", () => {
  assert.deepEqual(VERIFIER_TYPES, ["file_state", "command", "test", "http_assertion", "process_health", "api_assertion", "database_read_only", "browser_assertion", "artifact_check", "git_state", "custom_adapter", "human_confirmation"]);
});

test("synthesizes file and test verifiers for criteria without a verifier", () => {
  const file = synthesizeVerifier({ id: "file", description: "The target file exists" }, { paths: ["src/result.js"] });
  assert.equal(file.type, "file_state");
  assert.equal(validateDynamicVerifier(file, { workspaceRoot: process.cwd() }).valid, true);
  const testVerifier = synthesizeVerifier({ id: "tests", description: "Regression tests pass" });
  assert.equal(testVerifier.type, "test");
  assert.equal(validateDynamicVerifier(testVerifier).valid, true);
});

test("rejects commands outside the read-only allowlist", () => {
  assert.equal(commandValidation({ command: "sh", args: ["-c", "echo unsafe"] }).status, "invalid");
  assert.equal(commandValidation({ command: "npm", args: ["publish"] }).status, "approval_required");
  assert.equal(commandValidation({ command: "npm", args: ["run-script", "lint"] }).status, "validated");
  const unsafe = verifier({ type: "command", command_or_adapter: { command: "npm", args: ["install"] } });
  assert.equal(validateDynamicVerifier(unsafe).valid, false);
});

test("evaluates passed, failed, unknown, timeout, unavailable, and not-executed results", async () => {
  const value = verifier({ type: "custom_adapter" });
  const passed = await evaluateDynamicVerifier(value, { observe: async () => ({ status: "passed", executed: true, observation: { ok: true } }) });
  assert.equal(passed.status, "passed"); assert.equal(passed.valid, true); assert.equal(passed.evidence.executed, true);
  const failed = await evaluateDynamicVerifier(value, { observe: async () => ({ status: "failed", executed: true, reason: "check failed" }) }); assert.equal(failed.status, "failed"); assert.equal(failed.valid, false);
  const unknown = await evaluateDynamicVerifier(value, { observe: async () => ({ status: "unknown", executed: true }) }); assert.equal(unknown.status, "unknown");
  const unavailable = await evaluateDynamicVerifier(value, {}); assert.equal(unavailable.status, "not_executed");
  const timeout = await evaluateDynamicVerifier(createDynamicVerifier({ ...value, timeout_ms: 5 }), { observe: () => new Promise(() => {}) }); assert.equal(timeout.status, "unknown");
});

test("detects verifier tampering and invalidates previous evidence", async () => {
  const value = verifier(); const result = await evaluateDynamicVerifier(value, { observe: async () => ({ status: "passed", executed: true, observation: { ok: true } }) });
  const tampered = { ...value, description: "changed verifier" }; const change = detectVerifierTampering(tampered, value.verifier_fingerprint); assert.equal(change.tampered, true);
  const invalidated = invalidateVerifierEvidence([result.evidence], tampered, "verifier definition changed"); assert.equal(invalidated[0].valid, false); assert.equal(invalidated[0].invalidated, true);
});

test("does not complete on unknown, conflicting, or model self-report evidence", () => {
  const passed = { status: "passed", valid: true, evidence: { valid: true, executed: true }, evidence_id: "p" }; const failed = { status: "failed", valid: false, evidence: { valid: false, executed: true }, evidence_id: "f" }; const unknown = { status: "unknown", valid: false, evidence: { valid: false, executed: true }, evidence_id: "u" };
  assert.equal(resolveVerifierEvidence([passed, failed]).conflict, true); assert.equal(isCompletionVerified([passed, failed]), false); assert.equal(isCompletionVerified([unknown]), false); assert.equal(isCompletionVerified([passed], { model_self_report: true }), false); assert.equal(isCompletionVerified([passed]), true);
});

test("redacts sensitive verifier input and rejects dangerous object keys", () => {
  const value = verifier({ description: "Use password=do-not-store", inputs: { token: "do-not-store" } }); assert.doesNotMatch(JSON.stringify(value), /do-not-store/);
  const bad = JSON.parse(JSON.stringify(value)); bad.inputs = { constructor: { polluted: true } }; assert.equal(validateDynamicVerifier(bad).valid, false);
});

test("source and extension runtime implementations remain identical", () => {
  const read = file => fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  assert.equal(read(path.join(__dirname, "dynamic_verifier.js")), read(path.join(__dirname, "..", "..", "extension", "runtime", "src", "goal", "dynamic_verifier.js")));
});
