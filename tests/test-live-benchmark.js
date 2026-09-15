"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");

test("live benchmark usage normalization includes provider cache fields", async () => {
  const { normalizeUsage, estimateCost, compareProfile } = await import("../scripts/live-benchmark-utils.mjs");
  const usage = normalizeUsage({ prompt_tokens: 1000, completion_tokens: 100, prompt_tokens_details: { cached_tokens: 400 } });
  assert.deepEqual(usage, { input: 1000, output: 100, total: 1100, cached_input: 400, cache_write: 0 });
  assert.equal(estimateCost(usage, { input_per_mtok: 3, output_per_mtok: 15, cache_read_per_mtok: 0.3 }).total, 0.00342);
  const comparison = compareProfile([
    { profile: "small_single_file", mode: "baseline", usage: { total: 100 }, cost: { total: 0.01 }, quality_outcome: "approved" },
    { profile: "small_single_file", mode: "adaptive", usage: { total: 75 }, cost: { total: 0.007 }, quality_outcome: "approved" },
  ], "small_single_file");
  assert.equal(comparison.total_token_reduction_pct, 25);
  assert.ok(Math.abs(comparison.cost_reduction_pct - 30) < 1e-9);
});

test("task routing classifies safe simple edits and protects risky tasks", () => {
  const { classifyTask, shouldSkipIntel } = require("../src/pipeline/task-routing");
  assert.equal(classifyTask("Change VALUE in src/target.mjs").profile, "small_single_file");
  assert.equal(classifyTask("Create src/new-file.mjs").profile, "new_file");
  assert.equal(classifyTask("Update src/a.js and src/b.js").profile, "multi_file");
  assert.equal(classifyTask("Refactor the authentication architecture").profile, "broad_rewrite");
  assert.equal(shouldSkipIntel("Change VALUE in src/target.mjs", { enabled: true, strict_optimization: false }).skip, true);
  assert.equal(shouldSkipIntel("Change VALUE in src/target.mjs", { enabled: true, strict_optimization: true }).reason, "strict_optimization");
  assert.equal(shouldSkipIntel("Create src/new-file.mjs", { enabled: true, strict_optimization: false }).skip, false);
  assert.equal(shouldSkipIntel("Update authentication config in src/auth.js", { enabled: true, strict_optimization: false }).skip, false);
});

test("live benchmark defaults to a no-network preflight", () => {
  const script = path.join(ROOT, "scripts", "live-cost-suite.mjs");
  const output = execFileSync(process.execPath, [script, "--preflight"], { cwd: ROOT, encoding: "utf8", env: { ...process.env, MINITOK_LIVE_ALLOW_PAID: "0", MINITOK_LIVE_ENDPOINT: "", MINITOK_LIVE_MODEL: "", MINITOK_LIVE_API_KEY: "" } });
  const report = JSON.parse(output);
  assert.ok(["preflight_only", "blocked_live_credentials"].includes(report.status));
  assert.equal(report.paid_calls_allowed, false);
  assert.deepEqual(report.profiles, ["small_single_file", "multi_file", "new_file", "broad_rewrite"]);
  assert.deepEqual(report.modes, ["baseline", "adaptive"]);
});
