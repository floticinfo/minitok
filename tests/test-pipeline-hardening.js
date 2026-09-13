"use strict";

/**
 * Pipeline hardening regressions.
 *
 *  - Signal handlers installed by the caller (both GUIs) must not multiply per
 *    run: re-adding the snapshot doubled the listener count every task.
 *  - An approval wait must stop when the run is cancelled.
 *  - execution.research_enabled must actually skip the intel phase.
 *
 * The entitlement gate is bypassed with the documented test seam and the provider
 * module is stubbed, so these tests make no network request.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const REPO = path.resolve(__dirname, "..");
const providerPath = require.resolve(path.join(REPO, "src", "llm", "provider.js"));
const loopPath = require.resolve(path.join(REPO, "src", "pipeline", "loop.js"));

/** Replace the provider module with a recording stub. */
function stubProvider(calls) {
  const fake = {
    createProvider: name => ({
      name,
      isAvailable: async () => true,
      complete: async (messages) => {
        calls.push(messages.map(message => message.content).join("\n"));
        return { text: JSON.stringify({ verdict: "REJECT", confidence: 0.1, findings: [], summary: "probe", steps: [] }), tokens: { input: 1, output: 1 }, model: "stub" };
      },
    }),
    FallbackProvider: class {
      constructor(primary) { this.primary = primary; }
      get name() { return this.primary.name; }
      isAvailable() { return this.primary.isAvailable(); }
      complete(...args) { return this.primary.complete(...args); }
    },
    configureRetries: () => {},
    _estimateCost: () => ({ total: 0 }),
  };
  require.cache[providerPath] = { id: providerPath, filename: providerPath, loaded: true, exports: fake, paths: [] };
  // loop.js binds the provider module at its first require, so drop it too or a
  // later stub would be ignored.
  delete require.cache[loopPath];
}

function initRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "minitok-pipeline-"));
  for (const args of [["init", "-q"], ["config", "user.email", "t@t.t"], ["config", "user.name", "t"]]) execFileSync("git", args, { cwd: repo, stdio: "pipe" });
  fs.writeFileSync(path.join(repo, "a.txt"), "x");
  execFileSync("git", ["add", "-A"], { cwd: repo, stdio: "pipe" });
  execFileSync("git", ["commit", "-qm", "init"], { cwd: repo, stdio: "pipe" });
  return repo;
}

/** Isolate ~/.minitok (knowledge store, evidence) from the developer machine. */
function isolateHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "minitok-home-"));
  const previous = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME };
  process.env.USERPROFILE = home;
  process.env.HOME = home;
  return () => {
    if (previous.USERPROFILE === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = previous.USERPROFILE;
    if (previous.HOME === undefined) delete process.env.HOME; else process.env.HOME = previous.HOME;
    fs.rmSync(home, { recursive: true, force: true });
  };
}

test("repeated runs do not multiply the caller's signal handlers", async () => {
  const restoreHome = isolateHome();
  const repo = initRepo();
  const onSignal = () => {};
  const originalLog = console.log;
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  const sigintBefore = process.listeners("SIGINT").length;
  const sigtermBefore = process.listeners("SIGTERM").length;
  try {
    stubProvider([]);
    const { TEST_AUTHORIZATION } = require(path.join(REPO, "src", "pipeline", "test-seam.js"));
    const { runPipelineInWorkspace } = require(path.join(REPO, "src", "pipeline", "loop.js"));
    console.log = () => {};
    for (let run = 0; run < 3; run += 1) {
      await runPipelineInWorkspace("probe", { repoRoot: repo, authorization: TEST_AUTHORIZATION, overrides: { budget: { max_cycles: 1 }, execution: { research_enabled: false } } });
    }
    assert.equal(process.listeners("SIGINT").length, sigintBefore, "the SIGINT listener count must not grow across runs");
    assert.equal(process.listeners("SIGTERM").length, sigtermBefore, "the SIGTERM listener count must not grow across runs");
    assert.equal(process.listeners("SIGINT").filter(handler => handler === onSignal).length, 1, "the caller's handler must stay registered exactly once");
  } finally {
    console.log = originalLog;
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    delete require.cache[providerPath];
    fs.rmSync(repo, { recursive: true, force: true });
    restoreHome();
  }
});

test("an approval wait ends as soon as the run is cancelled", async () => {
  const repo = initRepo();
  const originalLog = console.log;
  try {
    const { promptConfirmation } = require(path.join(REPO, "src", "pipeline", "loop.js"));
    const approvalFile = path.join(repo, ".minitok", "approval.json");
    fs.mkdirSync(path.dirname(approvalFile), { recursive: true });
    const controller = new AbortController();
    console.log = () => {};
    const started = Date.now();
    const decision = promptConfirmation({ changes: [{ action: "edit", file: "a.txt" }] }, { repoRoot: repo, approvalFile, signal: controller.signal, approvalTimeoutMs: 10000 });
    setTimeout(() => controller.abort(), 50);
    assert.equal(await decision, false, "a cancelled run must reject the changes");
    assert.ok(Date.now() - started < 3000, "cancellation must not wait for the approval timeout");
    assert.equal(fs.existsSync(approvalFile), false, "the stale approval request must be removed");
  } finally {
    console.log = originalLog;
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("execution.research_enabled decides whether the intel phase runs", async () => {
  const restoreHome = isolateHome();
  const repo = initRepo();
  const calls = [];
  const originalLog = console.log;
  try {
    stubProvider(calls);
    const { TEST_AUTHORIZATION } = require(path.join(REPO, "src", "pipeline", "test-seam.js"));
    const { runPipelineInWorkspace } = require(path.join(REPO, "src", "pipeline", "loop.js"));
    console.log = () => {};
    const run = overrides => runPipelineInWorkspace("probe", { repoRoot: repo, authorization: TEST_AUTHORIZATION, overrides: { budget: { max_cycles: 1 }, ...overrides } });

    await run({ execution: { research_enabled: false } });
    assert.ok(calls.length > 0, "the other phases must still run");
    assert.equal(calls.some(text => /repository intelligence analyst/i.test(text)), false, "intel must not run when research is disabled");

    calls.length = 0;
    await run({ execution: { research_enabled: true } });
    assert.equal(calls.some(text => /repository intelligence analyst/i.test(text)), true, "intel must run when research is enabled");
  } finally {
    console.log = originalLog;
    delete require.cache[providerPath];
    fs.rmSync(repo, { recursive: true, force: true });
    restoreHome();
  }
});
