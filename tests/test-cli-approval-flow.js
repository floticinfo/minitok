"use strict";

/**
 * Regression coverage for the documented `minitok run --approval-file` contract.
 *
 * The flags were parsed by the CLI and then dropped before `runPipeline`, so the
 * approval request was never written: the extension sidebar waited for a
 * `MINITOK_APPROVAL_REQUEST` line that never arrived and every non-TTY run
 * refused its changes for lack of a terminal. These tests pin both halves —
 * the CLI plumbing and the file protocol itself.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const { promptConfirmation } = require(path.join(ROOT, "src", "pipeline", "loop.js"));

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitForFile(file, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { return fs.readFileSync(file, "utf8"); } catch { await delay(25); }
  }
  throw new Error(`Timed out waiting for ${file}`);
}

function tempRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "minitok-approval-"));
  fs.mkdirSync(path.join(repo, ".minitok"), { recursive: true });
  return repo;
}

const CHANGES = { changes: [{ file: "src/a.js", action: "create", content: "module.exports = 1;\n" }] };

function captureStdout(run) {
  // Patch console.log rather than process.stdout.write: the test runner owns
  // stdout for its own reporting, and promptConfirmation announces the request
  // through console.log.
  const captured = [];
  const original = console.log;
  console.log = (...values) => { captured.push(values.map(String).join(" ")); };
  return Promise.resolve()
    .then(run)
    .finally(() => { console.log = original; })
    .then(value => ({ value, output: `${captured.join("\n")}\n` }));
}

test("an approval file drives the decision without a TTY", async () => {
  const repo = tempRepo();
  const approvalFile = path.join(repo, ".minitok", "approval.json");
  try {
    const { value: accepted, output } = await captureStdout(async () => {
      const pending = promptConfirmation(CHANGES, { repoRoot: repo, approvalFile, approvalTimeoutMs: 15000 });
      const request = JSON.parse(await waitForFile(approvalFile));
      assert.equal(request.type, "approval_request");
      assert.equal(typeof request.nonce, "string");
      assert.ok(request.nonce.length >= 16);
      assert.ok(request.expires_at > Date.now());
      // A response that does not carry the request nonce must be ignored rather
      // than accepted as an approval.
      fs.writeFileSync(`${approvalFile}.response`, `${JSON.stringify({ decision: "approve", nonce: "0".repeat(32), run_id: request.run_id })}\n`);
      await delay(300);
      assert.equal(fs.existsSync(approvalFile), true, "a mismatched nonce must not consume the request");
      fs.writeFileSync(`${approvalFile}.response`, `${JSON.stringify({ decision: "approve", nonce: request.nonce, run_id: request.run_id })}\n`);
      return pending;
    });
    assert.equal(accepted, true);
    assert.match(output, /MINITOK_APPROVAL_REQUEST /, "the request must be announced on stdout for the editor to read");
    assert.equal(fs.existsSync(approvalFile), false, "the request file is removed once answered");
    assert.equal(fs.existsSync(`${approvalFile}.response`), false, "the response file is consumed");
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("a rejection response stops the run and an unanswered request times out closed", async () => {
  const repo = tempRepo();
  const approvalFile = path.join(repo, ".minitok", "approval.json");
  try {
    const rejected = await captureStdout(async () => {
      const pending = promptConfirmation(CHANGES, { repoRoot: repo, approvalFile, approvalTimeoutMs: 15000 });
      const request = JSON.parse(await waitForFile(approvalFile));
      fs.writeFileSync(`${approvalFile}.response`, `${JSON.stringify({ decision: "reject", nonce: request.nonce, run_id: request.run_id })}\n`);
      return pending;
    });
    assert.equal(rejected.value, false);

    const timedOut = await captureStdout(() => promptConfirmation(CHANGES, { repoRoot: repo, approvalFile, approvalTimeoutMs: 300 }));
    assert.equal(timedOut.value, false, "an unanswered approval request must fail closed");
    assert.equal(fs.existsSync(approvalFile), false, "a timed-out request is cleaned up");
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("without an approval file a non-TTY run refuses changes unless auto-accept is explicit", async () => {
  const repo = tempRepo();
  try {
    assert.equal(await promptConfirmation(CHANGES, { repoRoot: repo }), false);
    assert.equal(await promptConfirmation(CHANGES, { repoRoot: repo, autoAccept: true }), true);
    assert.equal(await promptConfirmation({ changes: [] }, { repoRoot: repo }), true, "an empty change set needs no approval");
    assert.equal(await promptConfirmation(CHANGES, { repoRoot: repo, dryRun: true }), true);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("an approval file outside .minitok is rejected before any write", async () => {
  const repo = tempRepo();
  try {
    await assert.rejects(
      () => promptConfirmation(CHANGES, { repoRoot: repo, approvalFile: path.join(repo, "approval.json"), approvalTimeoutMs: 300 }),
      /approval_file must be under workspace\/\.minitok/
    );
    assert.equal(fs.existsSync(path.join(repo, "approval.json")), false);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});


test("cmdRun forwards the approval, run id, and cancellation options into the pipeline", async () => {
  const runPath = require.resolve(path.join(ROOT, "src", "cli", "commands", "run.js"));
  const loopPath = require.resolve(path.join(ROOT, "src", "pipeline", "loop.js"));
  const loaderPath = require.resolve(path.join(ROOT, "src", "config", "loader.js"));
  const providerPath = require.resolve(path.join(ROOT, "src", "llm", "provider.js"));
  const ids = [runPath, loopPath, loaderPath, providerPath];
  const saved = new Map(ids.map(id => [id, require.cache[id]]));

  const repo = tempRepo();
  let captured = null;
  try {
    require.cache[loaderPath] = { id: loaderPath, filename: loaderPath, loaded: true, exports: {
      loadConfig: () => ({ roles: { plan: {}, work: {}, review: {}, intel: {} }, providers: {}, security: {}, validation: {}, budget: {} }),
      resolveProviderName: () => "openai",
    } };
    require.cache[providerPath] = { id: providerPath, filename: providerPath, loaded: true, exports: {
      detectAvailableProviders: async () => ["openai"],
      verifyCredentials: async () => ({ status: "ok" }),
    } };
    require.cache[loopPath] = { id: loopPath, filename: loopPath, loaded: true, exports: {
      runPipeline: async (task, options) => { captured = options; return { success: true, cycles: [] }; },
    } };
    delete require.cache[runPath];

    const { cmdRun } = require(runPath);
    const controller = new AbortController();
    const approvalFile = path.join(repo, ".minitok", "approval.json");
    const exitCode = await cmdRun("forward the approval flags", {
      repo: repo,
      approvalFile,
      approvalTimeoutMs: "600000",
      runId: "run-1234",
      signal: controller.signal,
      autoAccept: false,
    });

    assert.equal(exitCode, 0);
    assert.ok(captured, "runPipeline must be called");
    assert.equal(captured.approvalFile, approvalFile);
    assert.equal(captured.approvalTimeoutMs, 600000, "the CLI string is converted to a number");
    assert.equal(captured.runId, "run-1234");
    assert.equal(captured.signal, controller.signal, "the signal reaches the pipeline so Ctrl-C cancels");
    assert.equal(captured.repoRoot, repo);
  } finally {
    for (const id of ids) {
      if (saved.get(id)) require.cache[id] = saved.get(id);
      else delete require.cache[id];
    }
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
