"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.resolve(__dirname, "../../..");
const RUNNER = path.join(ROOT, "scripts", "goal-benchmark.mjs");

function run(mode, outputDir) { return execFileSync(process.execPath, [RUNNER, "--mode", mode, "--output-dir", outputDir], { cwd: ROOT, encoding: "utf8" }); }

test("executes the mock benchmark and writes compatible raw/summary/evidence artifacts", () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "goal-benchmark-"));
  try {
    run("mock", outputDir);
    for (const name of ["baseline.raw.json", "minitok.raw.json", "summary.json", "evidence.json"]) assert.equal(fs.existsSync(path.join(outputDir, name)), true);
    const baseline = JSON.parse(fs.readFileSync(path.join(outputDir, "baseline.raw.json"), "utf8"));
    const minitok = JSON.parse(fs.readFileSync(path.join(outputDir, "minitok.raw.json"), "utf8"));
    assert.equal(baseline.result_kind, "mock");
    assert.equal(baseline.publishable_claim, false);
    assert.equal(baseline.records.length > 0, true);
    assert.equal(typeof baseline.metrics.goal_completion_rate, "number");
    assert.equal(baseline.release_blockers.false_completion, false);
    assert.equal(baseline.release_blockers.unsafe_action, false);
    assert.equal(baseline.metrics.system_false_completion_rate, 0);
    assert.equal(baseline.metrics.executed_unsafe_action_rate, 0);
    assert.equal(baseline.metrics.unsafe_action_block_rate > 0, true);
    const validation = execFileSync(process.execPath, [path.join(ROOT, "scripts", "real-benchmark-validate.mjs"), path.join(outputDir, "baseline.raw.json"), path.join(outputDir, "minitok.raw.json")], { cwd: ROOT, encoding: "utf8" });
    assert.match(validation, /valid_input/);
    assert.equal(minitok.result_kind, "mock");
  } finally { fs.rmSync(outputDir, { recursive: true, force: true }); }
});

test("live benchmark is explicitly unavailable without its gate", () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "goal-benchmark-live-"));
  const previous = process.env.MINITOK_GOAL_BENCHMARK_LIVE;
  delete process.env.MINITOK_GOAL_BENCHMARK_LIVE;
  try {
    run("live", outputDir);
    const result = JSON.parse(fs.readFileSync(path.join(outputDir, "live.unavailable.json"), "utf8"));
    assert.equal(result.measurement_status, "unavailable");
    assert.equal(result.publishable_claim, false);
  } finally { if (previous === undefined) delete process.env.MINITOK_GOAL_BENCHMARK_LIVE; else process.env.MINITOK_GOAL_BENCHMARK_LIVE = previous; fs.rmSync(outputDir, { recursive: true, force: true }); }
});
