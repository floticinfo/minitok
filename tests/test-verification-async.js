"use strict";

/**
 * Regression coverage for the asynchronous verification gate.
 *
 * `verifyCommand` ran the repository's gate with `execFileSync`. Inside the
 * long-lived host process that blocks the single event loop that also answers
 * `/health`, `/readyz`, `/status` and every MCP session (including their request
 * timeouts), so one pipeline cycle — a gate may legitimately take minutes —
 * looked like an outage to every other client of the same process. The gate now
 * has an asynchronous twin that the pipeline awaits; the synchronous entry point
 * stays for callers that need the old contract.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const { runVerificationAsync, verifyCommandAsync } = require(path.join(ROOT, "src", "pipeline", "check.js"));

function gateRepo(script) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "minitok-gate-"));
  fs.writeFileSync(path.join(repo, "VERIFY_CMD.mjs"), script);
  return repo;
}

test("the verification gate keeps the event loop free while it runs", async () => {
  const repo = gateRepo('await new Promise(resolve => setTimeout(resolve, 900));\nconsole.log("gate done");\nprocess.exit(0);\n');
  let ticks = 0;
  const timer = setInterval(() => { ticks += 1; }, 20);
  try {
    const evidence = await runVerificationAsync(repo, { script_path: "VERIFY_CMD.mjs", timeout_ms: 30000 });
    assert.equal(evidence.status, "passed");
    assert.match(evidence.output, /gate done/, "the gate output is captured");
    // A synchronous gate starves every timer for its whole duration; this one must
    // leave the loop able to serve other work.
    assert.ok(ticks >= 10, `the event loop must keep running while the gate runs, observed ${ticks} ticks`);
  } finally {
    clearInterval(timer);
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("verifyCommandAsync reports a failing gate with its exit code", async () => {
  const repo = gateRepo('console.error("boom");\nprocess.exit(3);\n');
  try {
    const result = await verifyCommandAsync(repo, { script_path: "VERIFY_CMD.mjs", timeout_ms: 30000 });
    assert.equal(result.passed, false);
    assert.equal(result.evidence.status, "failed");
    assert.equal(result.evidence.exit_code, 3);
    assert.match(result.evidence.output, /boom/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("a gate that never exits is cut off by validation.timeout_ms", async () => {
  // The synchronous gate had no way to be interrupted, so a gate that hangs held
  // the process (and the run lock) forever.
  const repo = gateRepo("setTimeout(() => {}, 15000);\n");
  const started = Date.now();
  try {
    const result = await verifyCommandAsync(repo, { script_path: "VERIFY_CMD.mjs", timeout_ms: 800 });
    assert.equal(result.passed, false, "a timed-out gate must not pass");
    assert.ok(Date.now() - started < 10000, "the gate must be cut off instead of hanging the host");
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("the pipeline awaits the asynchronous gate instead of the blocking one", () => {
  const loopSource = fs.readFileSync(path.join(ROOT, "src", "pipeline", "loop.js"), "utf8");
  assert.match(loopSource, /const \{ verifyCommandAsync \} = require\("\.\/check"\);/);
  assert.match(loopSource, /await verifyCommandAsync\(repoRoot, \{ script_path: config\.validation\?\.script_path, timeout_ms: config\.validation\?\.timeout_ms \}\)/);
  assert.doesNotMatch(loopSource, /verifyCommand\(repoRoot/, "the blocking gate must not be reachable from the pipeline");
  assert.doesNotMatch(loopSource, /execFileSync\(|execSync\(|spawnSync\(/, "the pipeline must not run repository code synchronously");
  assert.doesNotMatch(loopSource, /require\("(?:node:)?child_process"\)/, "no synchronous child-process module is imported");
});
