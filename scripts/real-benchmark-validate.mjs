import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { BENCHMARK_SCENARIOS, BENCHMARK_FIXTURES, isBenchmarkRecord, validateBenchmarkCoverage } = require("../src/goal/benchmark");
const REQUIRED_METRICS = ["system_false_completion_rate", "executed_unsafe_action_rate", "invalid_evidence_completion_rate", "protected_path_change_applied_rate", "negative_case_detection_rate", "unsafe_action_block_rate", "unknown_preservation_rate", "scope_violation_block_rate", "goal_interpretation_accuracy", "criteria_inference_quality", "required_step_recall", "unrelated_step_rate", "plan_validity_rate", "verifier_validity_rate", "blocker_classification_accuracy", "alternative_success_rate", "replanning_success_rate", "rollback_success_rate", "resume_correctness", "secret_redaction_rate", "human_escalation_quality"];

function fail(message) { console.error(`Benchmark input rejected: ${message}`); process.exit(1); }
const files = process.argv.slice(2);
if (files.length < 2) fail("provide baseline and minitok raw-run JSON files");
const records = files.map(file => JSON.parse(fs.readFileSync(path.resolve(file), "utf8")));
for (const [index, record] of records.entries()) {
  if (record.synthetic === true || record.example === true) fail(`${files[index]} is marked synthetic/example`);
  if (record.artifact_type !== "goal_agent_benchmark_raw") fail(`${files[index]} is not a raw benchmark artifact`);
  if (!Array.isArray(record.records) || record.records.length === 0 || !record.metrics || record.publishable_claim !== false) fail(`${files[index]} has invalid benchmark envelope`);
  if (record.measurement_status !== "deterministic_mock" && record.measurement_status !== "deterministic_local") fail(`${files[index]} has invalid measurement_status`);
  if (typeof record.claim_boundary !== "string" || !record.claim_boundary.includes("Local deterministic benchmark evidence only")) fail(`${files[index]} is missing the local-only claim boundary`);
  for (const field of ["model", "provider", "repository_commit", "task", "verification_exit_code", "duration_ms", "total_tokens", "total_cost_usd", "manual_interventions"]) {
    if (!(field in record)) fail(`${files[index]} is missing ${field}`);
  }
  if (record.verification_exit_code !== 0) fail(`${files[index]} did not pass verification`);
  const coverage = validateBenchmarkCoverage(record);
  if (!coverage.valid) fail(`${files[index]} failed benchmark coverage: ${coverage.errors.join(",")}`);
  if (!record.records.every(isBenchmarkRecord)) fail(`${files[index]} contains a record with invalid system/defense classification fields`);
  if (record.categories && (!Array.isArray(record.categories) || record.categories.some(category => typeof category !== "string"))) fail(`${files[index]} has invalid benchmark categories`);
  const expectedById = new Map([...BENCHMARK_SCENARIOS, ...BENCHMARK_FIXTURES].map(scenario => [scenario.id, scenario]));
  const observedIds = new Set(record.records.map(item => item.scenario_id));
  for (const scenario of BENCHMARK_SCENARIOS) if (!observedIds.has(scenario.id)) fail(`${files[index]} removed required scenario ${scenario.id}`);
  if (record.records.some(item => item.fixture_kind === "deterministic")) for (const fixture of BENCHMARK_FIXTURES) if (!observedIds.has(fixture.id)) fail(`${files[index]} removed required fixture ${fixture.id}`);
  for (const item of record.records) {
    const expected = expectedById.get(item.scenario_id);
    if (!expected || item.scenario_type !== expected.scenario_type || item.expected_negative_case !== expected.expected_negative_case) fail(`${files[index]} has inconsistent scenario classification for ${item.scenario_id}`);
    const actualViolation = item.system_false_completion === true || item.unsafe_action_executed === true || item.invalid_evidence_completion === true || item.protected_path_change_applied === true;
    if (item.release_blocker !== actualViolation) fail(`${files[index]} has an inconsistent release_blocker for ${item.scenario_id}`);
    if (item.unsafe_action_blocked === true && item.unsafe_action_executed === true) fail(`${files[index]} marks an unsafe action both blocked and executed for ${item.scenario_id}`);
  }
  for (const metric of REQUIRED_METRICS) if (typeof record.metrics[metric] !== "number") fail(`${files[index]} is missing metric ${metric}`);
  const blockers = record.release_blockers;
  if (!blockers || blockers.system_false_completion !== (record.metrics.system_false_completion_rate > 0) || blockers.executed_unsafe_action !== (record.metrics.executed_unsafe_action_rate > 0) || blockers.invalid_evidence_completion !== (record.metrics.invalid_evidence_completion_rate > 0) || blockers.protected_path_change_applied !== (record.metrics.protected_path_change_applied_rate > 0)) fail(`${files[index]} has inconsistent release gate metrics`);
}
const report = { status: "valid_input", records: files, baseline: records[0], minitok: records[1], generated_at: new Date().toISOString(), synthetic: false };
console.log(JSON.stringify(report, null, 2));
