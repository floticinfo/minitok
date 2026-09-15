"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, execFileSync: run } = require("node:child_process");

const ROOT = path.join(__dirname, "..");

function sampleRun(index) {
  return {
    model: "openai/test",
    provider: "openai-compatible",
    repository_commit: `fixture-${index}`,
    task: "benchmark fixture",
    verification_exit_code: 0,
    verification: { passed: true, exit_code: 0 },
    duration_ms: 100 + index,
    total_tokens: 1000 + index,
    total_cost_usd: 0.01,
    manual_interventions: 0,
    provider_usage: { input: 800, output: 200, total: 1000 },
    provider_cost_usd: 0.01,
    review_verdict: "APPROVE",
    repair_cycles: 0,
    changed_files: 1,
    compaction: { compacted: false },
  };
}

test("run evidence keeps benchmark metrics and redacts sensitive values", async () => {
  const { normalizeEvidence } = require(path.join(ROOT, "src", "run-evidence.js"));
  const evidence = normalizeEvidence({
    task: "record metrics",
    metrics: {
      provider_calls: 4,
      provider_usage: { input: 100, output: 20, total: 120 },
      provider_cost_usd: 0.02,
      review: { verdicts: { APPROVE: 1 }, changes_requested: 0, rejected: 0 },
      repair_cycles: 0,
      compaction: { compacted_count: 1 },
      api_key: "must-not-leak",
    },
  });
  assert.equal(evidence.metrics.provider_usage.total, 120);
  assert.equal(evidence.metrics.api_key, "[REDACTED]");
});

test("DSL representation benchmark compares payloads and validates all cases", () => {
  const script = path.join(ROOT, "scripts", "dsl-representation-benchmark.mjs");
  const output = execFileSync(process.execPath, [script], { cwd: ROOT, encoding: "utf8", env: { ...process.env, MINITOK_DSL_BENCHMARK_RUNS: "2" } });
  const report = JSON.parse(output);
  assert.equal(report.status, "dsl_representation_benchmark");
  assert.equal(report.synthetic, true);
  assert.equal(report.repetitions, 2);
  assert.deepEqual(report.cases, ["exact_single_file", "line_single_file", "multi_file", "new_file"]);
  assert.deepEqual(report.representations, ["dsl", "compact_edit_ir_v2", "full_file"]);
  assert.equal(report.runs.length, 8);
  for (const run of report.runs) {
    assert.equal(run.rows.dsl.semantic_validation, true);
    assert.equal(run.rows.compact_edit_ir_v2.semantic_validation, true);
    assert.equal(run.rows.full_file.semantic_validation, true);
    assert.ok(run.rows.dsl.transport_bytes > 0);
    assert.ok(run.rows.compact_edit_ir_v2.manifest_bytes >= 0);
    assert.equal(run.rows.full_file.reduction_vs_full_pct, 0);
  }
  assert.equal(report.summary.full_file.semantic_validation_rate, 1);
});

test("representation benchmark repeats randomized text and IR runs", () => {
  const script = path.join(ROOT, "scripts", "representation-benchmark.mjs");
  const output = execFileSync(process.execPath, [script], { encoding: "utf8", env: { ...process.env, MINITOK_BENCHMARK_RUNS: "3" } });
  const report = JSON.parse(output);
  assert.equal(report.status, "repeated_representation_benchmark");
  assert.equal(report.synthetic, true);
  assert.equal(report.repetitions, 3);
  assert.equal(report.randomized_order, true);
  assert.equal(report.runs.length, 12);
  for (const run of report.runs) {
    assert.ok(["text", "workflow_ir", "edit_ir", "adaptive"].includes(run.representation));
    assert.equal(run.verification_exit_code, 0);
    assert.equal(run.final_status, "success");
    assert.ok(run.total_tokens > 0);
    assert.ok(run.provider_calls > 0);
    assert.ok(run.context);
    assert.ok(run.edits);
    assert.ok(run.stage_metrics);
  }
  assert.equal(new Set(report.runs.map(run => run.representation)).size, 4);
});

test("benchmark stats use medians and exclude ineligible timeout runs from approval rate", async () => {
  const { median, summarizeQualityRuns } = await import("../scripts/benchmark-stats.mjs");
  assert.equal(median([9, 1, 5]), 5);
  assert.equal(median([4, 2]), 3);
  const summary = summarizeQualityRuns([
    { quality_outcome: "approved", complete_run: true, approval_eligible: true, total_tokens: 100, provider_usage: { input: 70, output: 30 }, prompt_chars: 400, provider_cost_usd: 0.01, retrieval_metrics: { selected_stages: 3 } },
    { quality_outcome: "review_rejected", complete_run: true, approval_eligible: true, total_tokens: 200, provider_usage: { input: 120, output: 80 }, prompt_chars: 800, provider_cost_usd: 0.02, retrieval_metrics: { selected_stages: 0 } },
    { quality_outcome: "timeout", complete_run: false, approval_eligible: false, total_tokens: 999, provider_usage: { input: 500, output: 499 }, prompt_chars: 2000, provider_cost_usd: null, retrieval_metrics: { selected_stages: 3 } },
  ]);
  assert.equal(summary.complete_runs, 2);
  assert.equal(summary.approval_rate, 0.5);
  assert.equal(summary.median_total_tokens, 200);
  assert.equal(summary.median_input_tokens, 120);
  assert.equal(summary.retrieval_selected_run_rate, 2 / 3);
  assert.equal(summary.quality_outcomes.timeout, 1);
});

test("provider learning excludes incomplete runs and selects only a quality-safe cheaper provider", async () => {
  const { summarizeProviderLearning, selectProviderByLearnedCost } = require(path.join(ROOT, "src", "evolution", "provider-learning.js"));
  const runs = [
    ...Array.from({ length: 3 }, () => ({ status: "success", quality_outcome: "approved", complete_run: true, strict_proof: true, provider_outcomes: [{ role: "work", provider: "cheap", model: "m", cost_usd: 0.01, complete_run: true, strict_proof: true }] })),
    ...Array.from({ length: 3 }, () => ({ status: "success", quality_outcome: "approved", complete_run: true, strict_proof: true, provider_outcomes: [{ role: "work", provider: "safe", model: "m", cost_usd: 0.03, complete_run: true, strict_proof: true }] })),
    { status: "failure", quality_outcome: "timeout", complete_run: false, provider_outcomes: [{ role: "work", provider: "cheap", model: "m", cost_usd: 0.5, complete_run: false }] },
  ];
  const stats = summarizeProviderLearning(runs, { role: "work" });
  assert.equal(stats.find(item => item.provider === "cheap").complete_runs, 3);
  const decision = selectProviderByLearnedCost("safe", ["cheap", "safe"], runs, { role: "work", min_samples: 3, min_approval_rate: 0.8, min_complete_rate: 0.7 });
  assert.equal(decision.provider, "cheap");
  assert.equal(decision.selected, true);
  const unproven = selectProviderByLearnedCost("safe", ["cheap", "safe"], runs.map(run => ({ ...run, strict_proof: false })), { role: "work", min_samples: 3, min_approval_rate: 0.8, min_complete_rate: 0.7 });
  assert.equal(unproven.provider, "safe");
  assert.equal(unproven.selected, false);
});

test("strict optimization proof requires exact patch/review/verification equality and lower cost", () => {
  const { compareOptimizationProof } = require(path.join(ROOT, "src", "pipeline", "strict-proof.js"));
  const common = { identity: "same-workload", complete_run: true, approval_eligible: true, changes: [{ file: "a.js", action: "modify", content: "x" }], verification: { passed: true, exit_code: 0, command: "VERIFY_CMD.mjs", output: "ok" }, review: { verdict: "APPROVE", confidence: 0.95, findings: [] } };
  const proof = compareOptimizationProof({ ...common, cost_usd: 0.02 }, { ...common, cost_usd: 0.01 });
  assert.equal(proof.passed, true);
  const rejected = compareOptimizationProof({ ...common, cost_usd: 0.02 }, { ...common, cost_usd: 0.02, changes: [{ file: "a.js", action: "modify", content: "different" }] });
  assert.equal(rejected.passed, false);
  assert.ok(rejected.reasons.includes("canonical_patch_differs"));
  assert.ok(rejected.reasons.includes("candidate_cost_is_not_strictly_lower"));
});

test("stage cache persists bounded JSON results and invalidates by key", () => {
  const { StageCache } = require(path.join(ROOT, "src", "pipeline", "stage-cache.js"));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "minitok-stage-cache-"));
  const file = path.join(directory, "stages.json");
  try {
    const cache = new StageCache(file, { maxEntries: 1 });
    cache.set("a", { plan: { steps: [] } });
    cache.set("b", { plan: { steps: [{ id: 1 }] } });
    assert.equal(cache.get("a"), null);
    assert.deepEqual(cache.get("b"), { plan: { steps: [{ id: 1 }] } });
    const reloaded = new StageCache(file, { maxEntries: 1 });
    assert.deepEqual(reloaded.get("b"), { plan: { steps: [{ id: 1 }] } });
    assert.equal(reloaded.invalidate("b"), true);
    assert.equal(reloaded.get("b"), null);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("live benchmark utility tests cover no-network preflight and cache usage", () => {
  const script = path.join(ROOT, "scripts", "live-cost-suite.mjs");
  const output = execFileSync(process.execPath, [script, "--preflight"], { cwd: ROOT, encoding: "utf8", env: { ...process.env, MINITOK_LIVE_ALLOW_PAID: "0", MINITOK_LIVE_ENDPOINT: "", MINITOK_LIVE_MODEL: "", MINITOK_LIVE_API_KEY: "" } });
  const report = JSON.parse(output);
  assert.equal(report.paid_calls_allowed, false);
  assert.equal(report.synthetic, false);
});

test("benchmark validator accepts repeated raw runs and rejects one-shot evidence", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "minitok-benchmark-test-"));
  const baseline = path.join(directory, "baseline.json");
  const minitok = path.join(directory, "minitok.json");
  try {
    fs.writeFileSync(baseline, JSON.stringify({ runs: [1, 2, 3].map(sampleRun) }));
    fs.writeFileSync(minitok, JSON.stringify({ runs: [4, 5, 6].map(sampleRun) }));
    const validator = path.join(ROOT, "scripts", "real-benchmark-validate.mjs");
    const output = execFileSync(process.execPath, [validator, baseline, minitok], { encoding: "utf8" });
    const report = JSON.parse(output);
    assert.equal(report.status, "valid_input");
    assert.ok(report.metrics_contract.includes("provider_usage"));

    const oneShot = path.join(directory, "one-shot.json");
    fs.writeFileSync(oneShot, JSON.stringify({ runs: [sampleRun(1)] }));
    assert.throws(() => run(process.execPath, [validator, oneShot, minitok], { encoding: "utf8", stdio: "pipe" }), /requires at least 3 repeated runs/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
