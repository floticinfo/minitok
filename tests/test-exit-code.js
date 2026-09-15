"use strict";

/**
 * Exit-code regression tests for PD-1.
 *
 * Verifies that cmdRun returns the correct exit code based on
 * the actual pipeline outcome, not merely whether an exception occurred.
 *
 * Contract (final-cycle semantics — keep in sync with summarizeRunOutcome in
 * src/pipeline/loop.js):
 *   last cycle APPROVE -> 0
 *   anything else (REJECT, CHANGES_REQUESTED, failure, error, no cycles) -> 1
 *   an earlier APPROVE does NOT rescue a run that ends on a rejection
 *
 * Uses require.cache manipulation to mock the runPipeline dependency.
 */

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { TEST_AUTHORIZATION } = require("../src/pipeline/test-seam");

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mt-exit-"));
}
function clean(d) {
  try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
}
function initGitRepo(dir) {
  const { execSync } = require("child_process");
  execSync("git init", { cwd: dir, stdio: "pipe" });
  execSync("git config user.email t@t.com", { cwd: dir, stdio: "pipe" });
  execSync("git config user.name T", { cwd: dir, stdio: "pipe" });
  fs.writeFileSync(path.join(dir, "test.txt"), "initial");
  execSync("git add -A && git commit -m init", { cwd: dir, stdio: "pipe" });
}

function makePipelineResult(statuses) {
  const cycles = statuses.map((status, i) => ({
    cycle: i + 1,
    plan: { steps: [{ action: "edit", file: "test.txt" }] },
    implement: { summary: "mock", files_changed: 1 },
    verify: { verdict: status, confidence: status === "APPROVE" ? 0.95 : 0.3, summary: "mock", findings: [] },
    status,
  }));
  const success = cycles.length > 0 && cycles[cycles.length - 1].status === "APPROVE";
  const approved = cycles.some(c => c.status === "APPROVE");
  return {
    cycles,
    goal: "test task",
    totalTokens: { input: 100, output: 50 },
    evolution: { knowledge_size: 0 },
    success,
    approved,
    last_cycle_status: cycles.length > 0 ? cycles[cycles.length - 1].status : null,
  };
}

// Mock state
let _mockResult = null;
let _mockThrow = null;
let _providerPath = null;
let _providerOriginal = null;

function installMock(result, shouldThrow) {
  _mockResult = result;
  _mockThrow = shouldThrow || null;

  const mockModule = {
    runPipeline: async (task, opts) => {
      if (_mockThrow) throw new Error(_mockThrow);
      if (typeof _mockResult === "function") return _mockResult(task, opts);
      return _mockResult;
    },
    getRepoContext: () => "",
    compactContext: (t) => t,
    promptConfirmation: async () => true,
  };

  const loopPath = require.resolve("../src/pipeline/loop");
  delete require.cache[loopPath];
  require.cache[loopPath] = {
    id: loopPath, filename: loopPath, loaded: true,
    exports: mockModule,
    paths: require.cache[loopPath] ? require.cache[loopPath].paths : [],
  };

  _providerPath = require.resolve("../src/llm/provider");
  _providerOriginal = require.cache[_providerPath];
  require.cache[_providerPath] = {
    id: _providerPath, filename: _providerPath, loaded: true,
    exports: {
      detectAvailableProviders: async () => ["anthropic"],
      verifyCredentials: async () => ({ status: "ok", detail: "test fixture" }),
    },
    paths: _providerOriginal?.paths || [],
  };
  const runPath = require.resolve("../src/cli/commands/run");
  delete require.cache[runPath];
}
describe("PD-1: Exit code reflects actual pipeline outcome", () => {
  let repoDir;
  before(() => { repoDir = tmpDir(); initGitRepo(repoDir); });
  after(() => { clean(repoDir); restoreMocks(); });

  it("Case A -- genuine success -> exit code 0", async () => {
    installMock(makePipelineResult(["APPROVE"]));
    const { cmdRun } = require("../src/cli/commands/run");
    const exitCode = await cmdRun("test task", { repo: repoDir, dryRun: true, autoAccept: true, authorization: TEST_AUTHORIZATION });
    assert.equal(exitCode, 0, "successful pipeline should return 0");
    restoreMocks();
  });

  it("Case B -- all REJECT -> exit code 1", async () => {
    installMock(makePipelineResult(["REJECT", "REJECT", "REJECT"]));
    const { cmdRun } = require("../src/cli/commands/run");
    const exitCode = await cmdRun("test task", { repo: repoDir, dryRun: true, autoAccept: true, authorization: TEST_AUTHORIZATION });
    assert.equal(exitCode, 1, "all-rejected pipeline should return 1");
    restoreMocks();
  });

  it("Case C -- all CHANGES_REQUESTED -> exit code 1", async () => {
    installMock(makePipelineResult(["CHANGES_REQUESTED", "CHANGES_REQUESTED", "CHANGES_REQUESTED"]));
    const { cmdRun } = require("../src/cli/commands/run");
    const exitCode = await cmdRun("test task", { repo: repoDir, dryRun: true, autoAccept: true, authorization: TEST_AUTHORIZATION });
    assert.equal(exitCode, 1, "all-changes-requested pipeline should return 1");
    restoreMocks();
  });

  it("Case D -- implementation failure -> exit code 1", async () => {
    installMock(makePipelineResult(["impl_failed"]));
    const { cmdRun } = require("../src/cli/commands/run");
    const exitCode = await cmdRun("test task", { repo: repoDir, dryRun: true, autoAccept: true, authorization: TEST_AUTHORIZATION });
    assert.equal(exitCode, 1, "implementation failure should return 1");
    restoreMocks();
  });

  it("Case E -- plan failure -> exit code 1", async () => {
    installMock(makePipelineResult(["plan_failed"]));
    const { cmdRun } = require("../src/cli/commands/run");
    const exitCode = await cmdRun("test task", { repo: repoDir, dryRun: true, autoAccept: true, authorization: TEST_AUTHORIZATION });
    assert.equal(exitCode, 1, "plan failure should return 1");
    restoreMocks();
  });

  it("Case F -- rejected by user -> exit code 1", async () => {
    installMock(makePipelineResult(["rejected_by_user"]));
    const { cmdRun } = require("../src/cli/commands/run");
    const exitCode = await cmdRun("test task", { repo: repoDir, dryRun: true, autoAccept: true, authorization: TEST_AUTHORIZATION });
    assert.equal(exitCode, 1, "user-rejected pipeline should return 1");
    restoreMocks();
  });

  it("Case G -- empty cycles -> exit code 1", async () => {
    installMock(makePipelineResult([]));
    const { cmdRun } = require("../src/cli/commands/run");
    const exitCode = await cmdRun("test task", { repo: repoDir, dryRun: true, autoAccept: true, authorization: TEST_AUTHORIZATION });
    assert.equal(exitCode, 1, "empty cycles should return 1");
    restoreMocks();
  });

  it("Case H -- pipeline throws -> exit code 1", async () => {
    installMock(null, "Network failure");
    const { cmdRun } = require("../src/cli/commands/run");
    const exitCode = await cmdRun("test task", { repo: repoDir, dryRun: true, autoAccept: true, authorization: TEST_AUTHORIZATION });
    assert.equal(exitCode, 1, "exception should return 1");
    restoreMocks();
  });

  it("Case J -- approved, then the final cycle rejected -> exit code 1", async () => {
    installMock(makePipelineResult(["APPROVE", "REJECT"]));
    const { cmdRun } = require("../src/cli/commands/run");
    const exitCode = await cmdRun("test task", { repo: repoDir, dryRun: true, autoAccept: true, authorization: TEST_AUTHORIZATION });
    assert.equal(exitCode, 1, "a run that ends on a rejection must not exit 0 because an earlier cycle was approved");
    restoreMocks();
  });

  it("Case I -- no task argument -> exit code 1", async () => {
    const { cmdRun } = require("../src/cli/commands/run");
    const exitCode = await cmdRun(null, {});
    assert.equal(exitCode, 1, "missing task should return 1");
  });
});

function restoreMocks() {
  _mockResult = null;
  _mockThrow = null;
  const loopPath = require.resolve("../src/pipeline/loop");
  delete require.cache[loopPath];
  const runPath = require.resolve("../src/cli/commands/run");
  delete require.cache[runPath];
  if (_providerPath) {
    if (_providerOriginal) require.cache[_providerPath] = _providerOriginal;
    else delete require.cache[_providerPath];
    _providerPath = null;
    _providerOriginal = null;
  }
}
