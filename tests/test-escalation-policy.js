"use strict";

/**
 * Phase: Model Escalation Policy
 *
 * Verifies:
 *  - FailureAnalyzer classifies TYPE_ERROR from mypy/tsc logs and maps a
 *    dedicated mypy/tsc repair strategy.
 *  - EscalationEngine escalates the work model/adapter after N repeated
 *    failures and jumps to the reasoning tier on high-complexity errors.
 *  - Token hard guardrail stops the loop and escalates to a human instead of
 *    merely compressing context.
 */
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execSync } = require("child_process");
const { FailureAnalyzer, categorizeFailure } = require("../src/evolution/analyzer");
const { EscalationEngine, DEFAULT_TIER_CHAIN } = require("../src/evolution/policy");
const { findEscalationModel } = require("../src/llm/models");

describe("FailureAnalyzer: TYPE_ERROR classification", () => {
  const analyzer = new FailureAnalyzer();

  it("classifies mypy output as type_error", () => {
    const msg = "error: Argument 1 to 'foo' has incompatible type 'int'; expected 'str'";
    assert.equal(analyzer.categorize(msg), "type_error");
    assert.equal(categorizeFailure(msg), "type_error");
  });

  it("classifies tsc output as type_error", () => {
    const msg = "error TS2339: Property 'bar' does not exist on type 'Foo'.";
    assert.equal(analyzer.categorize(msg), "type_error");
  });

  it("classifies tsc TS2345 incompatible argument as type_error", () => {
    const msg = "error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.";
    assert.equal(analyzer.categorize(msg), "type_error");
  });

  it("marks type_error as high complexity", () => {
    assert.deepEqual(analyzer.analyze("error TS2551: Property 'x' does not exist on type 'Y'"), {
      category: "type_error",
      repairStrategies: analyzer.suggestRepair("type_error"),
      highComplexity: true,
      isTypeError: true,
    });
  });

  it("maps a dedicated mypy/tsc repair strategy for type_error", () => {
    const strategies = analyzer.suggestRepair("error: Incompatible return value type (got 'int', expected 'str')");
    assert.ok(Array.isArray(strategies) && strategies.length > 0);
    const blob = strategies.join(" ").toLowerCase();
    assert.ok(blob.includes("mypy") || blob.includes("tsc"), "repair strategy must reference the type checker");
  });

  it("does not steal generic 'type' mentions from validation", () => {
    // A plain schema/type validation message (no compiler markers) stays validation.
    assert.equal(analyzer.categorize("schema type validation: missing field"), "validation");
  });
});

describe("EscalationEngine: model escalation on repeated failure", () => {
  it("turns an approval-required blocker into human escalation", () => {
    const engine = new EscalationEngine({ tokenHardLimit: 2_000_000, tokenStopRatio: 1 });
    const rec = engine.recordBlockerOutcome("g", { blocker_id: "b1", category: "authentication_failure", requires_user_decision: true, requires_external_access: true, alternatives: [{ approval_required: true, applicable: true }] });
    assert.equal(rec.stop, true);
    assert.equal(rec.humanEscalation, true);
    assert.equal(rec.reason, "blocker_requires_user_decision");
  });

  it("escalates after N consecutive failures (default threshold 2)", () => {
    const engine = new EscalationEngine({ tokenHardLimit: 2_000_000, tokenStopRatio: 1 });
    // failure 1 -> no escalation yet
    assert.deepEqual(engine.recordCycleOutcome("g", { success: false, category: "test", tokens: 0 }), { escalate: false, stop: false, humanEscalation: false, reason: undefined });
    // failure 2 -> escalate one tier
    const rec = engine.recordCycleOutcome("g", { success: false, category: "test", tokens: 0 });
    assert.equal(rec.escalate, true);
    assert.equal(rec.targetTier, "balanced"); // fast -> balanced
    assert.ok(rec.reason.includes("escalating"));
  });

  it("escalates to reasoning tier on a high-complexity TYPE_ERROR", () => {
    const engine = new EscalationEngine({ tokenHardLimit: 2_000_000, tokenStopRatio: 1 });
    // A single type_error → reasoning tier (complexity fast-track)
    const rec = engine.recordCycleOutcome("g", { success: false, category: "type_error", tokens: 0 });
    assert.equal(rec.escalate, true);
    assert.equal(rec.targetTier, "reasoning");
  });

  it("does not escalate beyond the reasoning tier", () => {
    const engine = new EscalationEngine({ tokenHardLimit: 2_000_000, tokenStopRatio: 1 });
    // high-complexity → reasoning (capped)
    engine.recordCycleOutcome("g", { success: false, category: "type_error", tokens: 0 });
    // further failures do not escalate again
    const rec = engine.recordCycleOutcome("g", { success: false, category: "type_error", tokens: 0 });
    assert.equal(rec.escalate, false);
    assert.equal(rec.stop, false);
  });

  it("resets consecutive failures on success", () => {
    const engine = new EscalationEngine({ failureThreshold: 2, tokenHardLimit: 2_000_000, tokenStopRatio: 1 });
    engine.recordCycleOutcome("g", { success: false, category: "test", tokens: 0 });
    engine.recordCycleOutcome("g", { success: true, category: "unknown", tokens: 0 });
    const rec = engine.recordCycleOutcome("g", { success: false, category: "test", tokens: 0 });
    assert.equal(rec.escalate, false, "one failure after a success should not yet escalate");
  });

  it("uses an explicit config-driven escalation model when provided", () => {
    const engine = new EscalationEngine({
      failureThreshold: 2,
      tokenHardLimit: 2_000_000,
      tokenStopRatio: 1,
      escalationModels: { work: "claude-opus-5" },
    });
    engine.recordCycleOutcome("g", { success: false, category: "test", tokens: 0 });
    const rec = engine.recordCycleOutcome("g", { success: false, category: "test", tokens: 0 });
    assert.equal(rec.escalate, true);
    assert.equal(rec.model, "claude-opus-5");
  });

  it("falls back to the injected modelResolver for the tier", () => {
    const resolved = [];
    const engine = new EscalationEngine({
      failureThreshold: 2,
      tokenHardLimit: 2_000_000,
      tokenStopRatio: 1,
      modelResolver: (tier) => { resolved.push(tier); return "fake-model-" + tier; },
    });
    engine.recordCycleOutcome("g", { success: false, category: "test", tokens: 0 });
    const rec = engine.recordCycleOutcome("g", { success: false, category: "test", tokens: 0 });
    assert.equal(rec.model, "fake-model-balanced");
    assert.deepEqual(resolved, ["balanced"]);
  });

  it("returns null model when no catalog match (loop enables reasoning instead)", () => {
    // camel-stream has no catalog entry → resolver yields null on the reasoning tier
    const engine = new EscalationEngine({
      failureThreshold: 2,
      tokenHardLimit: 2_000_000,
      tokenStopRatio: 1,
      modelResolver: (tier) => {
        const m = findEscalationModel("camel-stream", tier);
        return m ? m.id : null;
      },
    });
    // A single type_error (high complexity) escalates straight to reasoning.
    const rec = engine.recordCycleOutcome("g", { success: false, category: "type_error", tokens: 0 });
    assert.equal(rec.escalate, true);
    assert.equal(rec.targetTier, "reasoning");
    assert.equal(rec.model, null);
  });
});

describe("EscalationEngine: token hard guardrail", () => {
  it("stops and escalates to human when tokens approach the hard limit", () => {
    const engine = new EscalationEngine({ failureThreshold: 5, tokenHardLimit: 1000, tokenStopRatio: 0.9 });
    const rec = engine.recordCycleOutcome("g", { success: false, category: "test", tokens: 900 });
    assert.equal(rec.stop, true);
    assert.equal(rec.humanEscalation, true);
    assert.equal(rec.reason, "token_exhausted");
    assert.ok(rec.stopReason.includes("hard limit"));
  });

  it("fires the stop before N-failure escalation when tokens are exhausted", () => {
    const engine = new EscalationEngine({ failureThreshold: 2, tokenHardLimit: 1000, tokenStopRatio: 0.9 });
    // two failures would normally trigger escalation, but token exhaustion wins
    engine.recordCycleOutcome("g", { success: false, category: "test", tokens: 500 });
    const rec = engine.recordCycleOutcome("g", { success: false, category: "test", tokens: 500 });
    assert.equal(rec.stop, true);
    assert.equal(rec.humanEscalation, true);
    assert.equal(rec.escalate, false);
  });

  it("shouldStop is a pure, stateless threshold check", () => {
    const engine = new EscalationEngine({ failureThreshold: 2, tokenHardLimit: 1000, tokenStopRatio: 0.9 });
    assert.equal(engine.shouldStop(800), false);
    assert.equal(engine.shouldStop(900), true);
    assert.equal(engine.shouldStop(1000), true);
  });
});

describe("EscalationEngine: per-goal isolation", () => {
  it("tracks failures independently per goal key", () => {
    const engine = new EscalationEngine({ failureThreshold: 2, tokenHardLimit: 2_000_000, tokenStopRatio: 1 });
    engine.recordCycleOutcome("goalA", { success: false, category: "test", tokens: 0 });
    const bRec = engine.recordCycleOutcome("goalB", { success: false, category: "test", tokens: 0 });
    assert.equal(bRec.escalate, false, "goalB should not inherit goalA's failure count");
    // goalA reaches threshold
    const aRec = engine.recordCycleOutcome("goalA", { success: false, category: "test", tokens: 0 });
    assert.equal(aRec.escalate, true);
    bRec; // lint
  });
});

describe("Model-tier resolution helpers", () => {
  it("findEscalationModel returns a higher-tier model for a real provider", () => {
    const m = findEscalationModel("anthropic", "reasoning");
    assert.equal(m, null, "anthropic has no 'reasoning' tier model");
    const f = findEscalationModel("anthropic", "flagship");
    assert.ok(f, "anthropic has a flagship tier model");
    assert.equal(f.provider, "anthropic");
  });

  it("DEFAULT_TIER_CHAIN is ordered cheapest -> most capable", () => {
    assert.equal(DEFAULT_TIER_CHAIN[0], "fast");
    assert.equal(DEFAULT_TIER_CHAIN[DEFAULT_TIER_CHAIN.length - 1], "reasoning");
  });
});

// ---------------------------------------------------------------------------
// End-to-end: token hard limit triggers a safe human-escalation stop in the
// real pipeline loop (verifies the loop<->engine wiring, not just the engine).
// ---------------------------------------------------------------------------
function tmpDirEscalation() { return fs.mkdtempSync(path.join(os.tmpdir(), "mt-esc-")); }
function cleanEscalation(d) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {} }
function initGitEscalation(dir) {
  execSync("git init", { cwd: dir, stdio: "pipe" });
  execSync("git config user.email t@t.com", { cwd: dir, stdio: "pipe" });
  execSync("git config user.name T", { cwd: dir, stdio: "pipe" });
  fs.writeFileSync(path.join(dir, "VERIFY_CMD.mjs"), "process.exit(0);\n");
  execSync("git add -A && git commit -m init", { cwd: dir, stdio: "pipe" });
}

describe("E2E: token hard stop escalates to human", () => {
  let dir;
  let origCreateProvider;
  let pm;

  before(() => {
    dir = tmpDirEscalation();
    initGitEscalation(dir);
    fs.writeFileSync(path.join(dir, "package.json"), "{}");
    pm = require("../src/llm/provider");
    origCreateProvider = pm.createProvider;
    const { LLMProvider } = pm;
    class RejectWithTokens extends LLMProvider {
      constructor() { super("rej"); }
      isAvailable() { return true; }
      async complete(msgs) {
        const sys = msgs.find(m => m.role === "system")?.content || "";
        let text;
        if (sys.includes("architect")) text = JSON.stringify({ task_summary: "t", steps: [{ id: 1, action: "create", file: "x.js", description: "d", rationale: "r" }], estimated_files: 1, risk_level: "low" });
        else if (sys.includes("engineer")) text = JSON.stringify({ changes: [{ file: "x.js", action: "create", content: "x" }], summary: "d", files_changed: 1 });
        else if (sys.includes("review") || sys.includes("code reviewer")) text = JSON.stringify({ verdict: "REJECT", confidence: 0.1, summary: "nope", findings: [{ severity: "error", message: "rejected" }], security_findings: [], risk_level: "high", test_suggestions: [] });
        else text = JSON.stringify({ done: false, next_task: "retry" });
        // Tokens large enough that ~4 calls/cycle exhaust a 100-token hard limit fast.
        return { text, model: "mock", usage: {}, tokens: { input: 100, output: 50 } };
      }
    }
    pm.createProvider = (n) => n === "rej" ? new RejectWithTokens() : origCreateProvider(n);
  });

  after(() => {
    pm.createProvider = origCreateProvider;
    cleanEscalation(dir);
  });

  it("runPipeline stops and flags humanEscalation when the token hard limit is hit", async () => {
    const { runPipeline } = require("../src/pipeline/loop");
    const r = await runPipeline("write x.js", {
repoRoot: dir,
       providerOverride: "rej",
       knowledgePath: path.join(os.tmpdir(), "minitok-escalation-" + Date.now() + "-outcomes.json"),
      authorization: require("../src/pipeline/test-seam").TEST_AUTHORIZATION,
      autoAccept: true,
      overrides: { budget: { token_hard_limit: 100, max_cycles: 5 } },
    });
    // The hard guardrail must have engaged instead of looping to max_cycles.
    assert.equal(r.humanEscalation, true, "expected human escalation on token exhaustion");
    assert.equal(r.success, false);
    assert.ok(r.cycles.length < 5, "should stop before exhausting max_cycles");
    assert.equal(r.cycles[0].status, "REJECT");
  });
});
