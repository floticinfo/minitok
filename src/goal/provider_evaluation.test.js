"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { evaluateProviderCase, evaluateProviderSuite, validateEvaluationRecord, CLAIM_BOUNDARY, REQUIRED_METRICS } = require("./provider_evaluation");

const capabilities = { structured_output: true, repository_navigation: "medium" };
function provider(text, extra = {}) { return { name: "injected-eval-provider", capabilities, complete: async () => ({ text, model: "offline-model", tokens: { input: 11, output: 7 }, ...extra }) }; }
function draft(extra = {}) { return JSON.stringify({ objective: "Make the local test suite pass", success_criteria: [{ id: "tests-pass", description: "npm test exits with code 0", required: true, verifier: { type: "command", id: "npm-test", config: { command: "npm", args: ["test"] } } }], constraints: {}, clarification_questions: [], ...extra }); }

test("evaluates an injected provider without contacting a live service", async () => {
  const record = await evaluateProviderCase("Fix the bug in src/parser.js", { provider: provider(draft()), measurement_status: "deterministic_offline", token_usage: { input: 11, output: 7, total: 18 }, duration_ms: 12 });
  assert.equal(record.measurement_status, "deterministic_offline");
  assert.equal(record.publishable_claim, false);
  assert.equal(record.claim_boundary, CLAIM_BOUNDARY);
  assert.equal(record.structured_output.valid, true);
  assert.equal(record.intent.supported_domain, "repository_local");
  assert.equal(record.metrics.structured_output_success, 1);
  assert.equal(record.metrics.plan_validity, 1);
  assert.equal(record.token_usage.total, 18);
  assert.equal(record.latency_ms, 12);
  assert.equal(validateEvaluationRecord(record).valid, true);
});

test("records clarification and candidate interpretation quality without treating it as completion", async () => {
  const record = await evaluateProviderCase("Improve the service", { provider: provider(JSON.stringify({ objective: "Improve the service", success_criteria: [], clarification_questions: ["What outcome should be verified?"] })), measurement_status: "deterministic_local", manual_interventions: 1 });
  assert.equal(record.structured_output.clarification_required, true);
  assert.equal(record.intent.support_status, "clarification_required");
  assert.ok(record.intent.candidate_interpretation_count >= 2);
  assert.equal(record.metrics.false_completion_rate, 0);
  assert.equal(record.manual_interventions, 1);
});

test("redacts observed provider output and records safety violations separately", async () => {
  const record = await evaluateProviderCase("Check the repository", { provider: provider(draft()), observed_output: { password: "password=hidden" }, unsafe_action_executed: true, invalid_evidence_completion: true });
  assert.equal(record.metrics.secret_redaction_rate, 1);
  assert.equal(record.metrics.unsafe_action_execution_rate, 1);
  assert.equal(record.metrics.invalid_evidence_completion_rate, 1);
  assert.doesNotMatch(JSON.stringify(record), /password=hidden/i);
});

test("rejects live or production evaluation modes", async () => {
  await assert.rejects(() => evaluateProviderCase("x", { provider: provider(draft()), measurement_status: "live" }), /deterministic_offline or deterministic_local/);
  await assert.rejects(() => evaluateProviderCase("x", { provider: provider(draft()), mode: "production" }), /deterministic_offline or deterministic_local/);
});

test("requires an injected provider and validates suite claim boundaries", async () => {
  await assert.rejects(() => evaluateProviderCase("x"), /injected provider/);
  const suite = await evaluateProviderSuite(["Fix the bug in src/parser.js", { objective: "Improve the service", provider: provider(JSON.stringify({ objective: "Improve the service", success_criteria: [] })) }], { provider: provider(draft()), measurement_status: "deterministic_offline" });
  assert.equal(suite.publishable_claim, false);
  assert.equal(suite.records.length, 2);
  for (const metric of REQUIRED_METRICS) assert.equal(typeof suite.metrics[metric], "number", metric);
});

test("rejects malformed evaluation records", () => {
  const result = validateEvaluationRecord({ schema_version: 1, objective: "x", measurement_status: "live", publishable_claim: true, metrics: {} });
  assert.equal(result.valid, false);
  assert.ok(result.errors.length >= 3);
});
