"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { directEditDecision, projectStageContext, dynamicOutputBudget, repairContext, providerCacheOptions } = require("../src/pipeline/optimization");

function fixture(content = "const value = 1;\n") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "minitok-optimization-"));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "a.js"), content);
  return root;
}

test("direct edit eligibility is fail-closed and opt-in", () => {
  const root = fixture();
  try {
    assert.equal(directEditDecision("Change value in src/a.js", root).eligible, false);
    const selected = directEditDecision("Change value in src/a.js", root, { enabled: true });
    assert.equal(selected.eligible, true);
    assert.equal(selected.reason, "safe_explicit_single_file");
    assert.equal(directEditDecision("Refactor authentication in src/a.js", root, { enabled: true }).eligible, false);
    assert.equal(directEditDecision("Change value in src/missing.js", root, { enabled: true }).reason, "target_missing");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("stage projections report context savings without losing the requested stage data", () => {
  const raw = "repository context\n".repeat(1000);
  const projected = projectStageContext(raw, "plan", { intelligence: { summary: "facts", relevant_files: ["src/a.js"], risks: [] }, max_chars: 100 });
  assert.match(projected.text, /Repository facts/);
  assert.equal(projected.original_chars, raw.length);
  assert.ok(projected.text.length < raw.length);
});

test("dynamic output budgets stay under configured ceilings", () => {
  assert.equal(dynamicOutputBudget("work", 8192, { profile: "small_single_file", target_bytes: 100, operations: 1 }), 512);
  assert.ok(dynamicOutputBudget("work", 8192, { profile: "multi_file", target_bytes: 4000, operations: 3 }) <= 8192);
  assert.equal(dynamicOutputBudget("work", 8192, { enabled: false, profile: "small_single_file", target_bytes: 100 }), 8192);
});

test("repair context contains a bounded failure and patch digest", () => {
  const value = repairContext("original task", { files: ["src/a.js"], failure: "failure output", patch: "full patch" });
  assert.match(value, /repair\.v1/);
  assert.match(value, /src[\\\\/]a\.js/);
  assert.match(value, /patch_digest/);
  assert.ok(value.length < 4000);
});

test("provider cache options are deterministic metadata and can be disabled", () => {
  assert.deepEqual(providerCacheOptions({ static_prefix: "fixed" }), providerCacheOptions({ static_prefix: "fixed" }));
  assert.equal(providerCacheOptions({ enabled: false }).cache_input, false);
});

test("optimization mode defaults to auto and validates the three policies", () => {
  const { DEFAULTS, validateConfig } = require("../src/config/loader");
  assert.equal(DEFAULTS.execution.optimization_mode, "auto");
  assert.doesNotThrow(() => validateConfig({ execution: { optimization_mode: "auto" } }));
  assert.doesNotThrow(() => validateConfig({ execution: { optimization_mode: "manual" } }));
  assert.doesNotThrow(() => validateConfig({ execution: { optimization_mode: "off" } }));
  assert.throws(() => validateConfig({ execution: { optimization_mode: "always" } }), /optimization_mode must be/);
});

test("manual and off modes retain explicit control semantics", () => {
  const root = fixture();
  try {
    assert.equal(directEditDecision("Change value in src/a.js", root, { enabled: false }).eligible, false);
    assert.equal(directEditDecision("Change value in src/a.js", root, { enabled: true }).eligible, true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
