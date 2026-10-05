"use strict";

// Locks the user-facing CLI command surface so a command is never dropped or
// renamed silently. If a command is legitimately added/removed, update the
// EXPECTED_COMMANDS list below in the same change.

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");

const bin = path.resolve(__dirname, "../bin/minitok.js");

const EXPECTED_COMMANDS = [
  "activate", "activation-key", "agent", "auth", "account", "billing",
  "capability", "checkout", "deactivate", "doctor", "evolution",
  "goal", "gui|ui", "license", "mcp", "migrate", "models", "portal",
  "promote", "portal", "run", "runs", "runtime", "sessions", "status",
  "trial", "workspace",
].filter((v, i, a) => a.indexOf(v) === i).sort();

test("CLI --help lists exactly the expected top-level commands", () => {
  const r = spawnSync(process.execPath, [bin, "--help"], { encoding: "utf8" });
  assert.equal(r.status, 0, `--help failed: ${r.stderr}`);
  const listed = r.stdout.split(/\r?\n/)
    .map(l => l.match(/^ {2}([a-z][a-z0-9|-]+)\s/))
    .filter(Boolean)
    .map(m => m[1]);
  const missing = EXPECTED_COMMANDS.filter(c => !listed.includes(c));
  const extra = listed.filter(c => !EXPECTED_COMMANDS.includes(c));
  assert.deepEqual({ missing, extra }, { missing: [], extra: [] },
    "CLI command surface drifted; update EXPECTED_COMMANDS if intentional");
});

test("aliases resolve: gui|ui and runs list|show", () => {
  for (const args of [["ui", "--help"], ["gui", "--help"], ["runs", "list", "--help"], ["runs", "show", "--help"]]) {
    const r = spawnSync(process.execPath, [bin, ...args], { encoding: "utf8" });
    assert.equal(r.status, 0, `${args.join(" ")} failed: ${r.stderr}`);
  }
});

test("legacy commands are marked Legacy in --help descriptions", () => {
  const r = spawnSync(process.execPath, [bin, "--help"], { encoding: "utf8" });
  for (const legacy of ["checkout", "portal", "activation-key"]) {
    const line = r.stdout.split(/\r?\n/).find(l => l.trim().startsWith(legacy));
    assert.ok(line, `legacy command ${legacy} not in --help`);
    assert.match(line, /legacy/i, `${legacy} should be marked as legacy in its description`);
  }
});
