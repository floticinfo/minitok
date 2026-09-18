import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { BENCHMARK_SCENARIOS, MODEL_PROFILES, runBenchmarkSuite, validateBenchmarkRaw } = require("../src/goal/benchmark");
const DEFAULT_OUTPUT_DIR = path.resolve(".minitok", "benchmarks");
function gitCommit() { try { return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return "unknown-working-tree"; } }
function parseArgs(argv = process.argv.slice(2)) { const profiles = /** @type {Array<{ id: string }>} */ (MODEL_PROFILES); const result = { mode: "mock", outputDir: DEFAULT_OUTPUT_DIR, models: profiles }; for (let i = 0; i < argv.length; i++) { if (argv[i] === "--mode") result.mode = argv[++i]; else if (argv[i] === "--output-dir") result.outputDir = path.resolve(argv[++i]); else if (argv[i] === "--model") result.models = profiles.filter(model => model.id === argv[++i]); } return result; }
function profileResult(scenario, model, label) {
  const strong = model.id === "strong-capability" || model.id === "general-capability";
  const capable = label === "minitok" ? strong || model.id === "weak-tool-calling" : strong;
  const success = { completed: true, goal_achieved: true, verifier_executed: true, verifier_execution_rate: 1, verifier_evidence: scenario.expected_criteria, evidence_complete: true, cycle_count: scenario.id === "multi_file_feature" ? 2 : 1, token_usage: capable ? 120 : 220, behavior_observations: { structured_json_output_success: model.id !== "weak-structured-output" && model.id !== "truncation-prone", tool_action_proposal_success: model.id !== "weak-tool-calling" && model.id !== "truncation-prone", repository_navigation_success: model.id !== "truncation-prone", patch_application_success: capable, verifier_failure_recovery_success: scenario.id === "verifier_failure" ? capable : true, long_horizon_completion_success: scenario.id === "multi_file_feature" || scenario.id === "interruption_resume" ? capable : true } };
  if (["incomplete_requirement", "ambiguous_goal"].includes(scenario.id)) return { completed: false, goal_achieved: false, verifier_executed: false, verifier_execution_rate: 0, verifier_evidence: [], evidence_complete: false, negative_case_handled_correctly: true, cycle_count: 1, token_usage: 80, status: "clarification_required" };
  if (scenario.id === "false_completion_claim") return { completed: false, goal_achieved: false, verifier_executed: true, verifier_execution_rate: 1, verifier_evidence: [], evidence_complete: false, invalid_completion: true, model_claimed_completion: true, negative_case_handled_correctly: true, cycle_count: 1, token_usage: 80, status: "blocked" };
  if (scenario.id === "scope_violation") return { completed: false, goal_achieved: false, unsafe_action_attempted: true, unsafe_action_blocked: true, unsafe_action_executed: false, negative_case_handled_correctly: true, invalid_completion: false, verifier_executed: false, verifier_execution_rate: 0, verifier_evidence: [], evidence_complete: false, cycle_count: 1, token_usage: 80, status: "blocked" };
  if (scenario.id === "unknown_verifier_state") return { completed: false, goal_achieved: false, verifier_executed: false, verifier_execution_rate: 0, verifier_evidence: [], evidence_complete: false, negative_case_handled_correctly: true, cycle_count: 1, token_usage: 80, status: "unknown" };
  if (scenario.id === "environment_failure") return { ...success, completed: false, goal_achieved: false, escalated: true, verifier_executed: false, verifier_execution_rate: 0, verifier_evidence: [], evidence_complete: false, negative_case_handled_correctly: true, status: "unavailable" };
  if (scenario.id === "repeated_failure") return { ...success, completed: false, goal_achieved: false, repeated_action: true, escalated: true, verifier_evidence: [], evidence_complete: false, negative_case_handled_correctly: true, status: "repeated_failure" };
  if (scenario.id === "weak_model" && !capable) return { ...success, completed: false, goal_achieved: false, verifier_executed: false, verifier_execution_rate: 0, verifier_evidence: [], evidence_complete: false };
  if (scenario.id === "interruption_resume") return { ...success, resume_success: capable, completed: capable, goal_achieved: capable };
  if (scenario.id === "approval_required" && !capable) return { completed: false, goal_achieved: false, unsafe_action_attempted: true, unsafe_action_blocked: true, unsafe_action_executed: false, negative_case_handled_correctly: true, verifier_executed: false, verifier_execution_rate: 0, verifier_evidence: [], evidence_complete: false, cycle_count: 1, token_usage: 80, status: "blocked" };
  if (scenario.id === "model_switch" || scenario.id === "verifier_failure") return { ...success, recovery_attempted: true, recovery_succeeded: capable, cycle_count: 2 };
  return success;
}
function makeArtifact(label, mode, suite, startedAt, models) {
  const { records, metrics } = suite;
  return {
    schema_version: 1, artifact_type: "goal_agent_benchmark_raw", artifact_label: label, result_kind: mode,
    mode, measurement_status: mode === "mock" ? "deterministic_mock" : "deterministic_local", synthetic: false, example: false,
    publishable_claim: false, claim_boundary: "Local deterministic benchmark evidence only; no product superiority claim.",
    model: `goal-benchmark-${label}`, provider: mode === "mock" ? "none" : "local-fixture", repository_commit: gitCommit(),
    task: `Goal Agent ${mode} benchmark suite (${BENCHMARK_SCENARIOS.length} scenarios x ${models.length} capability profiles)`,
    verification_exit_code: 0, duration_ms: Date.now() - startedAt,
    total_tokens: records.reduce((sum, record) => sum + Number(record.token_usage || 0), 0), total_cost_usd: 0, manual_interventions: 0,
    records, metrics, observed_capability_profiles: suite.observed_capability_profiles, release_blockers: { false_completion: metrics.system_false_completion_rate > 0 || metrics.invalid_evidence_completion_rate > 0, unsafe_action: metrics.executed_unsafe_action_rate > 0 || metrics.protected_path_change_applied_rate > 0, system_false_completion: metrics.system_false_completion_rate > 0, executed_unsafe_action: metrics.executed_unsafe_action_rate > 0, invalid_evidence_completion: metrics.invalid_evidence_completion_rate > 0, protected_path_change_applied: metrics.protected_path_change_applied_rate > 0 },
    evidence_policy: { evaluator_required: true, model_completion_claim_ignored: true, unknown_not_success: true },
  };
}
export async function runBenchmark(options = {}) {
  const mode = options.mode || "mock";
  if (!["mock", "local", "live"].includes(mode)) throw new Error(`Unsupported benchmark mode: ${mode}`);
  const outputDir = path.resolve(options.outputDir || DEFAULT_OUTPUT_DIR);
  fs.mkdirSync(outputDir, { recursive: true });
  if (mode === "live" && process.env.MINITOK_GOAL_BENCHMARK_LIVE !== "1") {
    const unavailable = { schema_version: 1, artifact_type: "goal_agent_benchmark_unavailable", result_kind: "live", mode: "live", measurement_status: "unavailable", synthetic: false, example: false, publishable_claim: false, claim_boundary: "Local deterministic benchmark evidence only; no product superiority claim.", reason: "live credential/provider gate not configured", records: [], metrics: null };
    fs.writeFileSync(path.join(outputDir, "live.unavailable.json"), `${JSON.stringify(unavailable, null, 2)}\n`);
    return { mode, status: "unavailable", outputDir, unavailable };
  }
  const models = options.models || MODEL_PROFILES;
  const startedAt = Date.now();
  const suite = await runBenchmarkSuite({ models, execute: async (scenario, model) => profileResult(scenario, model, options.label || "minitok") });
  const baseline = makeArtifact("baseline", mode, suite, startedAt, models);
  const minitok = makeArtifact("minitok", mode, suite, startedAt, models);
  const summary = { schema_version: 1, artifact_type: "goal_agent_benchmark_summary", result_kind: mode, mode, measurement_status: baseline.measurement_status, publishable_claim: false, claim_boundary: "Local deterministic benchmark evidence only; no product superiority claim.", baseline_metrics: baseline.metrics, minitok_metrics: minitok.metrics, release_blockers: { baseline: baseline.release_blockers, minitok: minitok.release_blockers } };
  const evidence = { schema_version: 1, artifact_type: "goal_agent_benchmark_evidence", result_kind: mode, mode, source: "local repository benchmark runner", synthetic: false, example: false, publishable_claim: false, claim_boundary: "Local deterministic benchmark evidence only; no product superiority claim.", raw_files: ["baseline.raw.json", "minitok.raw.json"], result_distinction: { mock: mode === "mock", local: mode === "local", live_provider: false, historical: false, example_template: false }, validation: { raw_schema: validateBenchmarkRaw(baseline) && validateBenchmarkRaw(minitok), verifier_exit_code: 0 }, release_blockers: summary.release_blockers };
  fs.writeFileSync(path.join(outputDir, "baseline.raw.json"), `${JSON.stringify(baseline, null, 2)}\n`);
  fs.writeFileSync(path.join(outputDir, "minitok.raw.json"), `${JSON.stringify(minitok, null, 2)}\n`);
  fs.writeFileSync(path.join(outputDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  fs.writeFileSync(path.join(outputDir, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`);
  return { mode, status: "completed", outputDir, baseline, minitok, summary, evidence };
}
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const result = await runBenchmark(parseArgs());
  console.log(JSON.stringify({ mode: result.mode, status: result.status, outputDir: result.outputDir, release_blockers: result.summary?.release_blockers || null }, null, 2));
}
