"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const BIN = path.join(__dirname, "..", "bin", "minitok.js");

function run(args) {
  const result = spawnSync(process.execPath, [BIN, ...args], {
    encoding: "utf8",
    env: { ...process.env, MINITOK_NO_COLOR: "1" },
  });
  return { status: result.status, stdout: result.stdout || "", stderr: result.stderr || "" };
}

test("run with a nonexistent --repo path fails fast with exit 1 and a clear error", () => {
  const bogus = path.join(os.tmpdir(), `mt-audit-missing-${Date.now()}-repo`);
  assert.equal(fs.existsSync(bogus), false, "precondition: path must not exist");
  const r = run(["run", "some task", "--repo", bogus]);
  assert.equal(r.status, 1, "exit code must be 1");
  assert.ok(
    r.stderr.includes(`Repository path does not exist: ${bogus}`),
    `expected missing-path error, got stderr: ${JSON.stringify(r.stderr)}`
  );
  // The session must NOT be created before the repo gate — no session info line.
  assert.ok(!r.stdout.includes("MINITOK_SESSION_INFO"), "session must not be created for a bad repo path");
});

test("run with a valid --repo path passes the repo gate", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mt-repo-gate-"));
  try {
    const r = run(["run", "some task", "--repo", dir]);
    // Repo gate passes; a later gate (entitlement) may still fail, but the
    // failure must NOT be the missing-path error.
    assert.ok(!r.stderr.includes("Repository path does not exist"), `repo gate should pass, got: ${r.stderr}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
