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
function stubProvider(calls, responseForCall = null) {
  const fake = {
    createProvider: name => ({
      name,
      isAvailable: async () => true,
      complete: async (messages) => {
        const prompt = messages.map(message => message.content).join("\n");
        calls.push(prompt);
        const response = responseForCall ? responseForCall(prompt, calls.length) : { verdict: "REJECT", confidence: 0.1, findings: [], summary: "probe", steps: [] };
        return { text: JSON.stringify(response), tokens: { input: 1, output: 1 }, model: "stub" };
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

test("text context includes bounded source previews for focused retrieval", () => {
  const repo = initRepo();
  try {
    fs.mkdirSync(path.join(repo, "src"), { recursive: true });
    fs.writeFileSync(path.join(repo, "src", "target.js"), "export function target() { return true; }\n");
    const { getRepoContext } = require(path.join(REPO, "src", "pipeline", "loop.js"));
    const context = getRepoContext(repo);
    assert.match(context, /--- src\/target\.js ---/);
    assert.match(context, /export function target/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("strict optimization fails closed to the text baseline without an exact proof", async () => {
  const restoreHome = isolateHome();
  const repo = initRepo();
  const calls = [];
  const originalLog = console.log;
  try {
    stubProvider(calls);
    const { TEST_AUTHORIZATION } = require(path.join(REPO, "src", "pipeline", "test-seam.js"));
    const { runPipelineInWorkspace } = require(path.join(REPO, "src", "pipeline", "loop.js"));
    console.log = () => {};
    const result = await runPipelineInWorkspace("probe", {
      repoRoot: repo,
      authorization: TEST_AUTHORIZATION,
      overrides: { budget: { max_cycles: 1 }, execution: { research_enabled: true, strict_optimization: true, context_representation: "workflow_ir", context_retrieval: "focused", max_output_tokens_by_stage: { intel: 10, plan: 10, work: 10, review: 10 } } },
    });
    assert.equal(result.metrics.optimization.allowed, false);
    assert.equal(result.metrics.optimization.fallback_reason, "strict_proof_required");
    assert.equal(result.metrics.context.representation, "text");
    assert.equal(result.metrics.context.retrieval.selected_stages, 0);
    assert.equal(calls.some(text => /minitok\.workflow-context/.test(text)), false);
  } finally {
    console.log = originalLog;
    delete require.cache[providerPath];
    fs.rmSync(repo, { recursive: true, force: true });
    restoreHome();
  }
});

test("workflow_ir is an opt-in pipeline context representation", async () => {
  const restoreHome = isolateHome();
  const repo = initRepo();
  const calls = [];
  const originalLog = console.log;
  try {
    stubProvider(calls);
    const { TEST_AUTHORIZATION } = require(path.join(REPO, "src", "pipeline", "test-seam.js"));
    const { runPipelineInWorkspace } = require(path.join(REPO, "src", "pipeline", "loop.js"));
    console.log = () => {};
    const result = await runPipelineInWorkspace("probe", {
      repoRoot: repo,
      authorization: TEST_AUTHORIZATION,
      overrides: { budget: { max_cycles: 1 }, execution: { research_enabled: true, strict_optimization: false, context_representation: "workflow_ir" } },
    });
    assert.ok(calls.some(text => /"kind":"minitok\.workflow-context"/.test(text)), "IR mode must send the canonical context kind");
    assert.ok(calls.some(text => /"stage":"intel"/.test(text)), "intel must receive its stage projection");
    assert.ok(calls.some(text => /"stage":"plan"/.test(text) && /"intelligence"/.test(text)), "plan must receive intelligence in its projection");
    assert.equal(result.metrics.context.requested_representation, "workflow_ir");
    assert.equal(result.metrics.context.representation, "workflow_ir");
    assert.equal(result.metrics.context.schema_version, 1);
    assert.ok(result.metrics.context.stages.intel);
    assert.ok(result.metrics.context.stages.plan);
  } finally {
    console.log = originalLog;
    delete require.cache[providerPath];
    fs.rmSync(repo, { recursive: true, force: true });
    restoreHome();
  }
});

test("adaptive representation selects text below its threshold", async () => {
  const restoreHome = isolateHome();
  const repo = initRepo();
  const calls = [];
  const originalLog = console.log;
  try {
    stubProvider(calls);
    const { TEST_AUTHORIZATION } = require(path.join(REPO, "src", "pipeline", "test-seam.js"));
    const { runPipelineInWorkspace } = require(path.join(REPO, "src", "pipeline", "loop.js"));
    console.log = () => {};
    const result = await runPipelineInWorkspace("probe", { repoRoot: repo, authorization: TEST_AUTHORIZATION, overrides: { budget: { max_cycles: 1 }, execution: { research_enabled: true, strict_optimization: false, context_representation: "adaptive", context_representation_threshold_chars: 999999 } } });
    assert.equal(result.metrics.context.requested_representation, "adaptive");
    assert.equal(result.metrics.context.representation, "text");
    assert.equal(result.metrics.context.adaptive_decision.selected, "text");
    assert.equal(result.metrics.context.adaptive_decision.reason, "minimum_savings_margin_not_met");
    assert.equal(result.metrics.context.adaptive_estimates.min_savings_ratio, 0.40);
  } finally {
    console.log = originalLog;
    delete require.cache[providerPath];
    fs.rmSync(repo, { recursive: true, force: true });
    restoreHome();
  }
});

test("repair cycles reuse intelligence and plan and record work-only state", async () => {
  const restoreHome = isolateHome();
  const repo = initRepo();
  const calls = [];
  const originalLog = console.log;
  try {
    stubProvider(calls, (prompt, callNumber) => {
      if (/repository intelligence analyst/i.test(prompt)) return { summary: "facts", relevant_files: ["a.txt"], existing_patterns: [], risks: [], constraints: [], recommendations: [] };
      if (/senior software architect/i.test(prompt)) return { steps: [{ id: 1, action: "modify", file: "a.txt", description: "keep the fixture stable" }] };
      if (/expert software engineer/i.test(prompt)) return { changes: [{ file: "a.txt", action: "modify", content: "x" }], summary: "stable", files_changed: 1 };
      if (/meticulous code reviewer/i.test(prompt)) return { verdict: callNumber === 4 ? "REJECT" : "APPROVE", confidence: 1, summary: "review", findings: [] };
      return { done: true, summary: "done" };
    });
    const { TEST_AUTHORIZATION } = require(path.join(REPO, "src", "pipeline", "test-seam.js"));
    const { runPipelineInWorkspace } = require(path.join(REPO, "src", "pipeline", "loop.js"));
    console.log = () => {};
    const result = await runPipelineInWorkspace("keep a.txt stable", { repoRoot: repo, authorization: TEST_AUTHORIZATION, autoAccept: true, overrides: { budget: { max_cycles: 2 }, validation: { enabled: false }, execution: { research_enabled: true } } });
    assert.equal(result.cycles.length, 2);
    assert.equal(result.cycles[0].repair_mode, false);
    assert.equal(result.cycles[1].repair_mode, true);
    assert.equal(result.cycles[1].repair_reason, "review");
    assert.equal(result.cycles[1].intel_state, "cached");
    assert.equal(result.cycles[1].plan_state, "cached");
    assert.equal(result.cycles[1].work_only, true);
    assert.equal(result.metrics.repair.intelligence_calls, 1);
    assert.equal(result.metrics.repair.plan_calls, 1);
    assert.equal(result.metrics.repair.cache_hits.intelligence, 1);
    assert.equal(result.metrics.repair.cache_hits.plan, 1);
    assert.equal(result.metrics.repair.work_only_cycles, 1);
    assert.ok(result.metrics.provider_outcomes.length > 0);
    assert.ok(result.metrics.provider_learning.decisions.length > 0);
  } finally {
    console.log = originalLog;
    delete require.cache[providerPath];
    fs.rmSync(repo, { recursive: true, force: true });
    restoreHome();
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
