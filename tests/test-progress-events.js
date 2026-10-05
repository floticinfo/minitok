"use strict";

/**
 * The pipeline always reported structured progress through `opts.onProgress`
 * (phase / state / cycle / tokens / cost), but no caller consumed it — the CLI
 * never forwarded it to stdout, so the editor sidebar could only scrape the
 * coarse "Planning..." text lines. cmdRun now emits each event on the
 * MINITOK_PROGRESS line protocol (the same transport approvals use).
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..");
const runSource = fs.readFileSync(path.join(repoRoot, "src", "cli", "commands", "run.js"), "utf8");
const loopSource = fs.readFileSync(path.join(repoRoot, "src", "pipeline", "loop.js"), "utf8");

test("cmdRun forwards pipeline progress to the MINITOK_PROGRESS line", () => {
  assert.match(
    runSource,
    /onProgress:\s*\(event\)\s*=>\s*\{[\s\S]{0,200}MINITOK_PROGRESS \$\{JSON\.stringify\(event\)\}/,
    "cmdRun must emit every onProgress event as a MINITOK_PROGRESS line",
  );
});

test("the pipeline reports the five phases with started/completed states", () => {
  for (const phase of ["intel", "plan", "work", "verify", "review"]) {
    assert.match(loopSource, new RegExp(`onProgress\\?\\.\\(\\{ phase: "${phase}", state: "started", cycle \\}\\)`), `${phase} must report start`);
    assert.match(loopSource, new RegExp(`onProgress\\?\\.\\(\\{ phase: "${phase}", state: "completed", cycle`), `${phase} must report completion`);
  }
});

test("phase completions carry token and cost totals", () => {
  assert.match(
    loopSource,
    /onProgress\?\.\(\{ phase: "work", state: "completed", cycle, tokens: implResult\.tokens, total_tokens: results\.totalTokens, total_cost: results\.totalCost \}\)/,
    "work completion must include token and cost totals",
  );
});