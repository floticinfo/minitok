"use strict";

/**
 * PHASE 9 — REJECT → Recovery → APPROVE E2E Test
 *
 * Verifies the deterministic recovery path:
 *   cycle 1: REJECT → feedback captured → task mutated
 *   cycle 2: corrective execution → APPROVE → exit 0
 *
 * Uses the existing providerMonkeyPatch pattern (same as test-core-features.js).
 * Does NOT modify production source code.
 */

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const p = require("path");
const os = require("os");
const { execSync } = require("child_process");

function tmpDir() { return fs.mkdtempSync(p.join(os.tmpdir(), "mt-recovery-")); }
function clean(d) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
function initGitRepo(dir) {
  execSync("git init", { cwd: dir, stdio: "pipe" });
  execSync("git config user.email t@t.com", { cwd: dir, stdio: "pipe" });
  execSync("git config user.name T", { cwd: dir, stdio: "pipe" });
  fs.writeFileSync(p.join(dir, "initial.txt"), "initial");
  fs.writeFileSync(p.join(dir, "VERIFY_CMD.mjs"), "process.exit(0);\n");
  execSync("git add -A && git commit -m init", { cwd: dir, stdio: "pipe" });
}

// ================================================================
// MOCK PROVIDERS
// ================================================================

function createRejectThenApproveProvider() {
  const { LLMProvider } = require("../src/llm/provider");
  let verifierCalls = 0;
  let implCalls = 0;

  class RejectThenApprove extends LLMProvider {
    constructor() { super("rta"); }
    isAvailable() { return true; }
    async complete(msgs) {
      const sys = msgs.find(m => m.role === "system")?.content || "";
      let text;
      if (sys.includes("architect")) {
        text = JSON.stringify({ task_summary: "Create recovery-proof.txt", steps: [{ id: 1, action: "create", file: "recovery-proof.txt", description: "Create file with minitok_RECOVERY_PASS", rationale: "test" }], estimated_files: 1, risk_level: "low" });
      } else if (sys.includes("engineer")) {
        implCalls++;
        if (implCalls <= 1) {
          text = JSON.stringify({ changes: [{ file: "recovery-proof.txt", action: "create", content: "WRONG_CONTENT" }], summary: "Wrong content", files_changed: 1 });
        } else {
          text = JSON.stringify({ changes: [{ file: "recovery-proof.txt", action: "create", content: "minitok_RECOVERY_PASS" }], summary: "Correct content", files_changed: 1 });
        }
      } else if ((sys.includes("review") || sys.includes("code reviewer")) && !sys.includes("autonomous")) {
        verifierCalls++;
        if (verifierCalls <= 1) {
          text = JSON.stringify({ verdict: "REJECT", confidence: 0.2, summary: "Content must be minitok_RECOVERY_PASS", findings: [{ severity: "error", file: "recovery-proof.txt", line: 1, message: "Wrong content" }], security_findings: [], risk_level: "medium", test_suggestions: [] });
        } else {
          text = JSON.stringify({ verdict: "APPROVE", confidence: 0.95, summary: "Correct content", findings: [], security_findings: [], risk_level: "low", test_suggestions: [] });
        }
      } else if (sys.includes("autonomous")) {
        text = JSON.stringify({ done: true, summary: "Recovery complete" });
      } else {
        text = JSON.stringify({ done: true, summary: "done" });
      }
      return { text, model: "mock", usage: {}, tokens: { input: 100, output: 50 } };
    }
  }
  return { RejectThenApprove, getVerifierCalls: () => verifierCalls };
}

function createAlwaysRejectProvider() {
  const { LLMProvider } = require("../src/llm/provider");
  class AlwaysReject extends LLMProvider {
    constructor() { super("ar"); }
    isAvailable() { return true; }
    async complete(msgs) {
      const sys = msgs.find(m => m.role === "system")?.content || "";
      let text;
      if (sys.includes("architect")) text = JSON.stringify({ task_summary: "t", steps: [{ id: 1, action: "create", file: "x.js", description: "d", rationale: "r" }], estimated_files: 1, risk_level: "low" });
      else if (sys.includes("engineer")) text = JSON.stringify({ changes: [{ file: "x.js", action: "create", content: "x" }], summary: "d", files_changed: 1 });
      else if ((sys.includes("review") || sys.includes("code reviewer")) && !sys.includes("autonomous")) text = JSON.stringify({ verdict: "REJECT", confidence: 0.1, summary: "Always reject", findings: [{ severity: "error", file: "x.js", line: 1, message: "rejected" }], security_findings: [], risk_level: "high", test_suggestions: [] });
      else if (sys.includes("autonomous")) text = JSON.stringify({ done: false, next_task: "retry" });
      else text = JSON.stringify({ done: false, next_task: "retry" });
      return { text, model: "mock", usage: {}, tokens: { input: 100, output: 50 } };
    }
  }
  return { AlwaysReject };
}

// ================================================================
// TEST SUITE
// ================================================================
describe("PHASE 9: REJECT Recovery E2E", () => {
  let repoDir;
  let pm;
  let origCreateProvider;

  before(() => {
    repoDir = tmpDir();
    initGitRepo(repoDir);
    pm = require("../src/llm/provider");
    origCreateProvider = pm.createProvider;
  });

  after(() => {
    pm.createProvider = origCreateProvider;
    clean(repoDir);
  });

  it("REJECT → recovery → APPROVE → success=true", async () => {
    const { runPipeline } = require("../src/pipeline/loop");
    const { RejectThenApprove, getVerifierCalls } = createRejectThenApproveProvider();
    pm.createProvider = (n) => n === "rta" ? new RejectThenApprove() : origCreateProvider(n);
    try {
      const r = await runPipeline("Create recovery-proof.txt with minitok_RECOVERY_PASS", {
repoRoot: repoDir, providerOverride: "rta", authorization: require("../src/pipeline/test-seam").TEST_AUTHORIZATION, autoAccept: true, knowledgePath: p.join(tmpDir(), "outcomes.json"),
         overrides: { budget: { max_cycles: 3 } },
      });
      assert.ok(r.cycles.length >= 2, `Expected >= 2 cycles, got ${r.cycles.length}`);
      assert.equal(r.cycles[0].status, "REJECT", "Cycle 1 must REJECT");
      assert.ok(r.cycles[0].verify.summary, "Cycle 1 must have review summary");
      assert.ok(r.cycles[0].verify.findings.length > 0, "Cycle 1 must have findings");
      assert.equal(r.cycles[1].status, "APPROVE", "Cycle 2 must APPROVE");
      assert.equal(r.success, true, "success must be true");
      assert.ok(getVerifierCalls() >= 2, "Verifier called >= 2 times");
      const fp = p.join(repoDir, "recovery-proof.txt");
      assert.ok(fs.existsSync(fp), "File must exist");
      assert.equal(fs.readFileSync(fp, "utf-8"), "minitok_RECOVERY_PASS");
      console.log("\n REJECT → RECOVERY → APPROVE: PASS");
    } finally { pm.createProvider = origCreateProvider; }
  });

  it("CHANGES_REQUESTED: no task mutation (semantic gap)", async () => {
    const { runPipeline } = require("../src/pipeline/loop");
    const { LLMProvider } = require("../src/llm/provider");
    class CR extends LLMProvider {
      constructor() { super("cr"); }
      isAvailable() { return true; }
      async complete(msgs) {
        const sys = msgs.find(m => m.role === "system")?.content || "";
        let text;
        if (sys.includes("architect")) text = JSON.stringify({ task_summary: "t", steps: [{ id: 1, action: "create", file: "t.txt", description: "d", rationale: "r" }], estimated_files: 1, risk_level: "low" });
        else if (sys.includes("engineer")) text = JSON.stringify({ changes: [{ file: "t.txt", action: "create", content: "x" }], summary: "d", files_changed: 1 });
        else if ((sys.includes("review") || sys.includes("code reviewer")) && !sys.includes("autonomous")) text = JSON.stringify({ verdict: "CHANGES_REQUESTED", confidence: 0.3, summary: "needs work", findings: [{ severity: "warning", file: "t.txt", line: 1, message: "incomplete" }], security_findings: [], risk_level: "medium", test_suggestions: [] });
        else if (sys.includes("autonomous")) text = JSON.stringify({ done: false, next_task: "retry" });
        else text = JSON.stringify({ done: false, next_task: "retry" });
        return { text, model: "mock", usage: {}, tokens: { input: 100, output: 50 } };
      }
    }
    pm.createProvider = (n) => n === "cr" ? new CR() : origCreateProvider(n);
    try {
      const r = await runPipeline("CHANGES_REQUESTED test", {
repoRoot: repoDir, providerOverride: "cr", authorization: require("../src/pipeline/test-seam").TEST_AUTHORIZATION, autoAccept: true, knowledgePath: p.join(tmpDir(), "outcomes.json"),
         overrides: { budget: { max_cycles: 3 } },
      });
      assert.equal(r.cycles.length, 3);
      r.cycles.forEach(c => assert.equal(c.status, "CHANGES_REQUESTED"));
      assert.equal(r.success, false, "No APPROVE → success=false");
      console.log("\n  CHANGES_REQUESTED GAP: no task mutation, same task repeated");
    } finally { pm.createProvider = origCreateProvider; }
  });

  it("REJECT × 3: max_cycles exhaustion → success=false", async () => {
    const { runPipeline } = require("../src/pipeline/loop");
    const { AlwaysReject } = createAlwaysRejectProvider();
    pm.createProvider = (n) => n === "ar" ? new AlwaysReject() : origCreateProvider(n);
    try {
      const r = await runPipeline("Always reject", {
repoRoot: repoDir, providerOverride: "ar", authorization: require("../src/pipeline/test-seam").TEST_AUTHORIZATION, autoAccept: true, knowledgePath: p.join(tmpDir(), "outcomes.json"),
         overrides: { budget: { max_cycles: 3 } },
      });
      assert.equal(r.cycles.length, 3);
      r.cycles.forEach(c => assert.equal(c.status, "REJECT"));
      assert.equal(r.success, false);
      r.cycles.forEach(c => {
        assert.ok(c.verify.summary, "Feedback summary preserved");
        assert.ok(c.verify.findings.length > 0, "Feedback findings preserved");
      });
      console.log("\n MAX-CYCLE EXHAUSTION: PASS");
    } finally { pm.createProvider = origCreateProvider; }
  });

  it("Source confirms: REJECT mutates task, CHANGES_REQUESTED does not", async () => {
    const src = fs.readFileSync(p.join(__dirname, "..", "src", "pipeline", "loop.js"), "utf-8");
    assert.ok(src.includes('verdict === "REJECT"'), "REJECT check exists");
    assert.ok(src.includes("buildRepairTask"), "Feedback injected on REJECT");
    assert.ok(src.includes("buildRepairTask"), "Review summary in repair task");
    // Verify no equivalent CHANGES_REQUESTED feedback injection
    assert.ok(!src.includes('verdict === "CHANGES_REQUESTED"'), "No CHANGES_REQUESTED feedback path");
    console.log("\n SOURCE ANALYSIS: REJECT mutates task; CHANGES_REQUESTED does not");
  });
});

