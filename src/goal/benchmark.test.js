"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { BENCHMARK_SCENARIOS, MODEL_PROFILES, runBenchmarkScenario, runBenchmarkSuite, calculateBenchmarkMetrics, summarizeBenchmark, isBenchmarkRecord, validateBenchmarkRaw } = require("./benchmark");

test("defines all required local benchmark scenarios without external actions", () => {
  assert.equal(BENCHMARK_SCENARIOS.length, 25);
  assert.ok(BENCHMARK_SCENARIOS.every(scenario => scenario.external_access === false));
  for (const id of ["simple_bug_fix", "multi_file_feature", "incomplete_requirement", "ambiguous_goal", "hidden_dependency", "verifier_failure", "environment_failure", "tool_discovery", "missing_verifier", "blocker_recovery", "alternative_selection", "assumption_invalidation", "plan_rewrite", "rollback", "resume", "external_action", "security_boundary", "repeated_failure", "weak_model", "model_switch", "interruption_resume", "approval_required", "scope_violation", "false_completion_claim", "unknown_verifier_state"]) assert.ok(BENCHMARK_SCENARIOS.some(scenario => scenario.id === id));
});

test("records capability-based model outcome and evidence fields", async () => {
  const record = await runBenchmarkScenario(BENCHMARK_SCENARIOS[0], { model: MODEL_PROFILES[0], execute: async scenario => ({ completed: true, goal_achieved: true, cycle_count: 1, token_usage: 12, verifier_executed: true, verifier_evidence: [scenario.expected_criteria[0]], evidence_complete: true }) });
  assert.equal(record.model_profile, "strong-capability");
  assert.equal(record.completed, true);
  assert.equal(record.false_completion, false);
  assert.equal(record.unsafe_action, false);
});

test("calculates false completion and unsafe action as first-class metrics", () => {
  const metrics = calculateBenchmarkMetrics([{ scenario_type: "positive", expected_negative_case: false, system_completed: true, completed: true, goal_achieved: true, system_false_completion: false, invalid_evidence_completion: false, false_completion: false, unsafe_action_attempted: false, unsafe_action_blocked: false, unsafe_action_executed: false, protected_path_change_applied: false, unsafe_action: false, negative_case_handled_correctly: false, release_blocker: false, verifier_execution_rate: 1, verifier_evidence: ["e"], evidence_complete: true }, { scenario_type: "positive", expected_negative_case: false, system_completed: true, completed: true, goal_achieved: false, system_false_completion: true, invalid_evidence_completion: true, false_completion: true, unsafe_action_attempted: true, unsafe_action_blocked: false, unsafe_action_executed: true, protected_path_change_applied: false, unsafe_action: true, negative_case_handled_correctly: false, release_blocker: true, verifier_execution_rate: 0, verifier_evidence: [], evidence_complete: false }]);
  assert.equal(metrics.goal_completion_rate, 0.5);
  assert.equal(metrics.false_completion_rate, 0.5);
  assert.equal(metrics.system_false_completion_rate, 0.5);
  assert.equal(metrics.executed_unsafe_action_rate, 0.5);
  assert.equal(metrics.unsafe_action_rate, 0.5);
  assert.equal(metrics.evidence_completeness, 0.5);
});

test("runs each scenario for each capability profile without external access", async () => {
  const suite = await runBenchmarkSuite({ models: MODEL_PROFILES.slice(0, 2), execute: async (_scenario, model) => ({ model_profile: model.id, goal_achieved: false, missing_goal: true }) });
  assert.equal(suite.records.length, 50);
  assert.equal(suite.metrics.total_runs, 50);
  assert.equal(suite.metrics.unsafe_action_rate, 0);
});

test("covers the Phase 13 category taxonomy with deterministic fixtures", async () => {
  const { BENCHMARK_CATEGORIES, BENCHMARK_FIXTURES } = require("./benchmark");
  const suite = await runBenchmarkSuite({ models: [MODEL_PROFILES[0]], includeFixtures: true, execute: async scenario => ({ goal_achieved: !scenario.expected_negative_case, completed: !scenario.expected_negative_case, verifier_executed: !scenario.expected_negative_case, verifier_execution_rate: scenario.expected_negative_case ? 0 : 1, verifier_evidence: scenario.expected_negative_case ? [] : ["fixture"], evidence_complete: !scenario.expected_negative_case, negative_case_handled_correctly: scenario.expected_negative_case, plan_valid: true, confidence: 0.8, status: scenario.expected_negative_case ? "blocked" : "completed" }) });
  assert.deepEqual(suite.categories, BENCHMARK_CATEGORIES);
  assert.equal(BENCHMARK_FIXTURES.length, BENCHMARK_CATEGORIES.length);
  assert.ok(BENCHMARK_CATEGORIES.every(category => suite.records.some(record => record.category === category)));
  assert.equal(suite.metrics.category_confidence.simple_repository_task.runs > 0, true);
  for (const metric of ["goal_interpretation_accuracy", "criteria_inference_quality", "required_step_recall", "unrelated_step_rate", "plan_validity_rate", "verifier_validity_rate", "blocker_classification_accuracy", "alternative_success_rate", "replanning_success_rate", "rollback_success_rate", "resume_correctness", "secret_redaction_rate", "human_escalation_quality"]) assert.equal(typeof suite.metrics[metric], "number", metric);
});

test("separates model self-report from evaluator result and records failure cause", async () => {
  const record = await runBenchmarkScenario(BENCHMARK_SCENARIOS[0], { model: MODEL_PROFILES[0], execute: async () => ({ completed: true, goal_achieved: false, verifier_execution_rate: 0, evidence_complete: false, model_self_report: { done: true, completed: true }, evaluator_result: { completed: false, goal_achieved: false }, failure_category: "verification_failure", confidence: 0.2 }) });
  assert.equal(record.model_self_report.done, true);
  assert.equal(record.evaluator_result.completed, false);
  assert.equal(record.failure_cause, "verification_failure");
  assert.equal(record.system_false_completion, true);
});

test("preserves the compact summary compatibility fields", () => {
  const summary = summarizeBenchmark([{ completed: true, goal_achieved: true, invalid_completion: false, verifier_execution_rate: 1, verifier_evidence: ["e"] }, { completed: false, goal_achieved: false, invalid_completion: true }]);
  assert.equal(summary.total, 2);
  assert.equal(summary.completed, 1);
  assert.equal(summary.invalid_completions, 1);
  assert.equal(summary.completion_rate, 0.5);
});

test("validates raw result schema and rejects missing fields", () => {
  const record = { scenario_id: "x", scenario_type: "negative", expected_negative_case: true, system_completed: false, completed: false, goal_achieved: false, system_false_completion: false, invalid_evidence_completion: false, false_completion: false, unsafe_action_attempted: false, unsafe_action_blocked: false, unsafe_action_executed: false, protected_path_change_applied: false, negative_case_handled_correctly: true, release_blocker: false, cycle_count: 1, verifier_execution_rate: 0, evidence_complete: false, unsafe_action: false };
  assert.equal(isBenchmarkRecord(record), true);
  assert.equal(isBenchmarkRecord({ ...record, unsafe_action_executed: undefined }), false);
  const raw = { schema_version: 1, artifact_type: "goal_agent_benchmark_raw", result_kind: "mock", mode: "mock", measurement_status: "deterministic_mock", synthetic: false, example: false, publishable_claim: false, claim_boundary: "Local deterministic benchmark evidence only", model: "m", provider: "none", repository_commit: "commit", task: "task", verification_exit_code: 0, duration_ms: 1, total_tokens: 1, total_cost_usd: 0, manual_interventions: 0, records: [record], metrics: {} };
  assert.equal(validateBenchmarkRaw(raw), true);
  const missing = { ...raw }; delete missing.metrics;
  assert.equal(validateBenchmarkRaw(missing), false);
});

test("classifies a blocked security attempt as defense success, not a product violation", async () => {
  const scenario = BENCHMARK_SCENARIOS.find(item => item.id === "scope_violation");
  const record = await runBenchmarkScenario(scenario, { execute: async () => ({ completed: false, goal_achieved: false, unsafe_action_attempted: true, unsafe_action_blocked: true, unsafe_action_executed: false, status: "blocked" }) });
  assert.equal(record.unsafe_action_attempted, true);
  assert.equal(record.unsafe_action_blocked, true);
  assert.equal(record.unsafe_action_executed, false);
  assert.equal(record.negative_case_handled_correctly, true);
  assert.equal(record.release_blocker, false);
  const metrics = calculateBenchmarkMetrics([record]);
  assert.equal(metrics.executed_unsafe_action_rate, 0);
  assert.equal(metrics.unsafe_action_block_rate, 1);
  assert.equal(metrics.scope_violation_block_rate, 1);
});

test("marks an actually applied protected path as a release blocker", async () => {
  const scenario = BENCHMARK_SCENARIOS.find(item => item.id === "scope_violation");
  const record = await runBenchmarkScenario(scenario, { execute: async () => ({ completed: false, goal_achieved: false, unsafe_action_attempted: true, unsafe_action_blocked: false, unsafe_action_executed: true, protected_path_change_applied: true, status: "failure" }) });
  assert.equal(record.unsafe_action_executed, true);
  assert.equal(record.protected_path_change_applied, true);
  assert.equal(record.release_blocker, true);
  assert.equal(calculateBenchmarkMetrics([record]).protected_path_change_applied_rate, 1);
});

test("marks invalid completion, false completion, and unsafe action independently", async () => {
  const scenario = BENCHMARK_SCENARIOS.find(item => item.id === "false_completion_claim");
  const record = await runBenchmarkScenario(scenario, { execute: async () => ({ completed: true, goal_achieved: false, verifier_execution_rate: 0, evidence_complete: false, false_completion: true, unsafe_action: true }) });
  assert.equal(record.false_completion, true);
  assert.equal(record.unsafe_action, true);
  assert.equal(record.status, "false_completion");
  const metrics = calculateBenchmarkMetrics([record]);
  assert.equal(metrics.false_completion_rate, 1);
  assert.equal(metrics.unsafe_action_rate, 1);
});

test("records behavioral outcome metrics and observed capability profiles", async () => {
  const suite = await runBenchmarkSuite({ models: [MODEL_PROFILES[0]], observation_options: { minObservations: 1 }, execute: async () => ({ completed: true, goal_achieved: true, verifier_executed: true, verifier_execution_rate: 1, verifier_evidence: ["criterion"], evidence_complete: true, behavior_observations: { structured_json_output_success: true, tool_action_proposal_success: true, repository_navigation_success: true, patch_application_success: true, verifier_failure_recovery_success: true, long_horizon_completion_success: true } }) });
  assert.equal(suite.metrics.structured_json_output_success_rate, 1);
  assert.equal(suite.metrics.patch_application_success_rate, 1);
  assert.equal(suite.observed_capability_profiles[0].observed_capabilities.structured_output, true);
  assert.equal(suite.observed_capability_profiles[0].confidence.overall, "medium");
});

test("empty benchmark input cannot validate as a raw measurement", () => {
  assert.equal(validateBenchmarkRaw({ schema_version: 1, artifact_type: "goal_agent_benchmark_raw", result_kind: "mock", mode: "mock", measurement_status: "deterministic_mock", synthetic: false, example: false, publishable_claim: false, claim_boundary: "Local deterministic benchmark evidence only", model: "m", provider: "none", repository_commit: "commit", task: "task", verification_exit_code: 0, duration_ms: 0, total_tokens: 0, total_cost_usd: 0, manual_interventions: 0, records: [], metrics: {} }), false);
});

test("Phase 10 benchmark contract requires all lifecycle scenarios and safety metrics", async () => {
  const { REQUIRED_BENCHMARK_SCENARIO_IDS, REQUIRED_BENCHMARK_METRICS, validateBenchmarkCoverage } = require("./benchmark");
  const suite = await runBenchmarkSuite({ models: [MODEL_PROFILES[0]], execute: async scenario => ({ completed: false, goal_achieved: false, verifier_executed: false, verifier_execution_rate: 0, verifier_evidence: [], evidence_complete: false, negative_case_handled_correctly: scenario.expected_negative_case, status: scenario.expected_negative_case ? "blocked" : "incomplete", secret: "token=hidden" }) });
  const raw = { schema_version: 1, artifact_type: "goal_agent_benchmark_raw", result_kind: "mock", mode: "mock", measurement_status: "deterministic_mock", synthetic: false, example: false, publishable_claim: false, claim_boundary: "Local deterministic benchmark evidence only; no production or live provider claim", model: "mock", provider: "none", repository_commit: "commit", task: "deterministic local benchmark", verification_exit_code: 0, duration_ms: 1, total_tokens: 0, total_cost_usd: 0, manual_interventions: 0, records: suite.records, metrics: suite.metrics };
  assert.equal(REQUIRED_BENCHMARK_SCENARIO_IDS.every(id => suite.records.some(record => record.scenario_id === id)), true);
  assert.equal(REQUIRED_BENCHMARK_METRICS.every(metric => typeof suite.metrics[metric] === "number"), true);
  assert.equal(validateBenchmarkCoverage(raw).valid, true);
  assert.doesNotMatch(JSON.stringify(raw), /token=hidden/i);
});

test("benchmark coverage rejects a live or production success claim", () => {
  const { validateBenchmarkCoverage } = require("./benchmark");
  const invalid = { schema_version: 1, artifact_type: "goal_agent_benchmark_raw", result_kind: "mock", mode: "mock", measurement_status: "deterministic_mock", synthetic: false, example: false, publishable_claim: true, claim_boundary: "Production deploy succeeded with live provider", model: "mock", provider: "none", repository_commit: "commit", task: "task", verification_exit_code: 0, duration_ms: 0, total_tokens: 0, total_cost_usd: 0, manual_interventions: 0, records: [{ scenario_id: "simple_bug_fix" }], metrics: {} };
  assert.equal(validateBenchmarkCoverage(invalid).valid, false);
});
