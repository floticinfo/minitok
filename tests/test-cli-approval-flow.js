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
const { execSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const { promptConfirmation, approvalRequest, validateApprovalResponse } = require(path.join(ROOT, "src", "pipeline", "loop.js"));
const { writeApprovalResponse } = require(path.join(ROOT, "src", "cli", "gui-run.js"));

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

test("auto-accept takes precedence over an approval file, and says so", async () => {
  const repo = tempRepo();
  const approvalFile = path.join(repo, ".minitok", "approval.json");
  const warnings = [];
  const originalError = console.error;
  console.error = (...values) => { warnings.push(values.map(String).join(" ")); };
  try {
    // The extension's autoApprove setting passes both flags. With the opposite
    // order the run polled the approval file for the whole timeout (30 minutes by
    // default) and then rejected every change, so an explicit "do not wait for a
    // human" instruction turned into a guaranteed refusal.
    const started = Date.now();
    const granted = await promptConfirmation(CHANGES, { repoRoot: repo, approvalFile, autoAccept: true, approvalTimeoutMs: 30000 });
    assert.equal(granted, true, "an explicit auto-accept must not wait for a human");
    assert.ok(Date.now() - started < 5000, "the approval timeout must not be consumed");
    assert.equal(fs.existsSync(approvalFile), false, "no request is written when auto-accept wins");
    assert.match(warnings.join("\n"), /--auto-accept takes precedence over --approval-file/, "the ignored file must be announced, not silently dropped");

    // allowAutoAccept:false still refuses the shortcut, so the safety valve that
    // guards the flag keeps working.
    warnings.length = 0;
    assert.equal(await promptConfirmation(CHANGES, { repoRoot: repo, autoAccept: true, allowAutoAccept: false }), false);
  } finally {
    console.error = originalError;
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

test("the GUI approval helper writes the payload the pipeline accepts", async () => {
  const repo = tempRepo();
  const approvalFile = path.join(repo, ".minitok", "approval.json");
  try {
    const { value: accepted } = await captureStdout(async () => {
      const pending = promptConfirmation(CHANGES, { repoRoot: repo, approvalFile, approvalTimeoutMs: 15000 });
      await waitForFile(approvalFile);
      const written = writeApprovalResponse(approvalFile, "approve");
      assert.equal(written.ok, true, written.reason);
      return pending;
    });
    assert.equal(accepted, true, "an interactive approval must be honoured instead of waiting for the timeout");

    // The request file is consumed with the decision, so the helper has to report
    // a clear failure rather than writing a response the pipeline would discard.
    const missing = writeApprovalResponse(approvalFile, "approve");
    assert.equal(missing.ok, false);
    assert.match(missing.reason, /unreadable|malformed/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("a decision-only payload is rejected by the approval contract", () => {
  const request = approvalRequest(CHANGES, { approvalTimeoutMs: 1000 });
  // The TUI GUI wrote exactly this shape, so every answer was discarded as
  // invalid and the run waited out the whole approval timeout.
  assert.equal(validateApprovalResponse({ decision: "approve" }, request), false);
  assert.equal(validateApprovalResponse({ decision: "approve", nonce: request.nonce, run_id: request.run_id }, request), true);
  assert.equal(validateApprovalResponse({ decision: "approve", nonce: request.nonce, run_id: request.run_id, files: [] }, request), false, "extra keys are rejected");
  assert.equal(validateApprovalResponse({ decision: "maybe", nonce: request.nonce, run_id: request.run_id }, request), false);
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
/**
 * The approval path has to survive isolation.
 *
 * `minitok run` — and therefore the CLI flags, the editor sidebar, the TUI GUI and
 * the MCP tools — executes inside a disposable clone. `promptConfirmation`
 * validated the request path against whatever `repoRoot` it was handed, which
 * isolation makes the clone, while every caller points at
 * `<workspace>/.minitok/...`. The combination was never covered, so an isolated
 * run with an approval file always died with "approval_file must be under
 * workspace/.minitok" before a single change was reviewed. `runPipeline` now
 * forwards the operator's repository as `approvalRoot`; this test drives a real
 * isolated run (mock provider, real clone, real merge) to prove the request is
 * written where the operator is watching and that the decision still counts.
 */
test("an isolated run writes and honours the approval file in the real workspace", async () => {
  const repo = tempRepo();
  const approvalFile = path.join(repo, ".minitok", "approval.json");
  const providerPath = path.join(ROOT, "src", "llm", "provider.js");
  const providerModule = require(providerPath);
  const { runPipeline } = require(path.join(ROOT, "src", "pipeline", "loop.js"));
  const { TEST_AUTHORIZATION } = require(path.join(ROOT, "src", "pipeline", "test-seam.js"));
  const originalCreateProvider = providerModule.createProvider;
  const knowledgePath = path.join(os.tmpdir(), `minitok-approval-knowledge-${process.pid}-${Date.now()}.json`);

  class ApprovingProbe extends providerModule.LLMProvider {
    constructor() { super("approval-probe"); }
    isAvailable() { return true; }
    async complete(messages) {
      const system = messages.find(message => message.role === "system")?.content || "";
      let text;
      if (system.includes("architect")) text = JSON.stringify({ task_summary: "Create approved.txt", steps: [{ id: 1, action: "create", file: "approved.txt", description: "Create the approved file", rationale: "test" }], estimated_files: 1, risk_level: "low" });
      else if (system.includes("engineer")) text = JSON.stringify({ changes: [{ file: "approved.txt", action: "create", content: "approved_by_human\n" }], summary: "Create the approved file", files_changed: 1 });
      else if ((system.includes("review") || system.includes("code reviewer")) && !system.includes("autonomous")) text = JSON.stringify({ verdict: "APPROVE", confidence: 0.95, summary: "Looks right", findings: [], security_findings: [], risk_level: "low", test_suggestions: [] });
      else text = JSON.stringify({ done: true, summary: "done" });
      return { text, model: "mock", usage: {}, tokens: { input: 100, output: 50 } };
    }
  }

  try {
    execSync("git init", { cwd: repo, stdio: "pipe" });
    execSync("git config user.email t@t.com", { cwd: repo, stdio: "pipe" });
    execSync("git config user.name T", { cwd: repo, stdio: "pipe" });
    fs.writeFileSync(path.join(repo, "VERIFY_CMD.mjs"), "process.exit(0);\n");
    execSync("git add -A && git commit -m init", { cwd: repo, stdio: "pipe" });

    providerModule.createProvider = name => name === "approval-probe" ? new ApprovingProbe() : originalCreateProvider(name);

    const pending = runPipeline("Create approved.txt", {
      repoRoot: repo,
      providerOverride: "approval-probe",
      authorization: TEST_AUTHORIZATION,
      knowledgePath,
      approvalFile,
      approvalTimeoutMs: 15000,
      overrides: { budget: { max_cycles: 2 } },
    });

    // The request has to appear inside the operator's workspace while the run is
    // still waiting: the clone is disposable and nothing there is watched.
    const request = JSON.parse(await waitForFile(approvalFile, 60000));
    assert.equal(request.type, "approval_request");
    fs.writeFileSync(`${approvalFile}.response`, `${JSON.stringify({ decision: "approve", nonce: request.nonce, run_id: request.run_id })}\n`);

    const result = await pending;
    assert.equal(result.success, true, "an approved isolated run must succeed");
    assert.equal(result.isolation.applied, true, "the approved diff must reach the real workspace");
    // Normalise line endings: the patch is applied through git on Windows, which
    // may rewrite LF as CRLF depending on the checkout configuration.
    assert.equal(fs.readFileSync(path.join(repo, "approved.txt"), "utf8").replace(/\r\n/g, "\n"), "approved_by_human\n");
    assert.equal(fs.existsSync(approvalFile), false, "an answered request is consumed");
    assert.equal(fs.existsSync(`${approvalFile}.response`), false, "the response file is consumed");

    // The clone's own contract is deleted with the clone, so the terminal state has
    // to reach the operator-visible one: without the mirror it stayed on "running"
    // (or "interrupted") and no tool could tell a finished run from a crashed one.
    const contract = JSON.parse(fs.readFileSync(path.join(repo, ".minitok", "contracts", "task-contract.json"), "utf8"));
    assert.equal(contract.status, "completed");
    assert.equal(contract.success, true);
    assert.equal(contract.approved, true);
    assert.equal(contract.merged, true, "the approved diff reached the repository");
    assert.equal(contract.isolated, true);
    assert.equal(contract.last_cycle_status, "APPROVE");
    assert.equal(contract.goal, undefined, "the goal is stored as a hash, never in clear text");
    assert.ok(contract.goal_id, "the sanitized goal id is recorded");
  } finally {
    providerModule.createProvider = originalCreateProvider;
    try { fs.rmSync(knowledgePath, { force: true }); } catch {}
    fs.rmSync(repo, { recursive: true, force: true });
  }
});


});
