"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { intel } = require("./intel");
const { verifyCommand } = require("./check");
const { plan } = require("./planner");
const { implement } = require("./implementer");
const { verify } = require("./verifier");
const { buildRepairTask } = require("./repair");
const { approvalRequest, validateApprovalResponse, writeApprovalRequest, buildRoleOptions, summarizeRunOutcome } = require("./loop");

describe("Pipeline stages", () => {
  it("propagates role provider options without mutating pipeline options", () => {
    const signal = {};
    const roleOptions = buildRoleOptions({ model: "reasoning-model", reasoning: "high", thinking: "adaptive", effort: "medium", thinking_budget: 12000 }, signal);
    assert.deepEqual(roleOptions, {
      model: "reasoning-model",
      signal,
      reasoning_effort: "high",
      thinking: { enabled: true, budget_tokens: 12000 },
      effort: "medium",
      thinking_budget: 12000,
    });
    assert.deepEqual(buildRoleOptions({ thinking: "dynamic" }), { model: undefined, signal: undefined, thinking: "dynamic" });
  });

  it("preserves provider-compatible options for roles without advanced settings", () => {
    const roleOptions = buildRoleOptions({ model: "standard-model" });
    assert.deepEqual(roleOptions, { model: "standard-model", signal: undefined });
  });

  it("parses repository intelligence from provider output", async () => {
    const provider = { complete: async () => ({ text: JSON.stringify({ summary: "found", relevant_files: ["src/index.js"] }), tokens: { input: 2, output: 3 }, model: "test" }) };
    const result = await intel(provider, "task", "context");
    assert.equal(result.intelligence.summary, "found");
    assert.deepEqual(result.intelligence.relevant_files, ["src/index.js"]);
    assert.equal(result.tokens.output, 3);
  });

  it("returns failed evidence with a nonzero VERIFY_CMD.sh", () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "minitok-verify-"));
    fs.writeFileSync(path.join(repo, "VERIFY_CMD.sh"), "exit 7\n");
    const result = verifyCommand(repo, { command: process.execPath, args: ["-e", "process.exit(7)"], script_path: "VERIFY_CMD.sh" });
    assert.equal(result.passed, false);
    assert.equal(result.evidence.exit_code, 7);
    assert.equal(result.evidence.status, "failed");
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it("requires VERIFY_CMD.sh when no script exists", () => {
    const result = verifyCommand(process.cwd(), { script_path: "missing-VERIFY_CMD.sh" });
    assert.equal(result.passed, false);
    assert.equal(result.evidence.status, "missing");
    assert.equal(result.evidence.exit_code, 1);
  });

  it("passes when the configured gate command exits zero", () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "minitok-verify-"));
    fs.writeFileSync(path.join(repo, "VERIFY_CMD.sh"), "exit 0\n");
    const result = verifyCommand(repo, { command: process.execPath, args: ["-e", "process.exit(0)"], script_path: "VERIFY_CMD.sh" });
    assert.equal(result.passed, true);
    assert.equal(result.evidence.exit_code, 0);
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it("marks verification failures separately from reviewer rejection", () => {
    const source = fs.readFileSync(path.join(__dirname, "loop.js"), "utf8");
    // Verification failure outranks a low-confidence approval, which in turn
    // outranks the reviewer verdict, so the three outcomes stay distinguishable.
    assert.match(source, /const verdict = !checkPassed \? "VERIFICATION_FAILED" : lowConfidence \? "LOW_CONFIDENCE" : reviewRejected \? "REVIEW_REJECTED"/);
    assert.match(source, /verdict === "REVIEW_REJECTED" \|\| verdict === "VERIFICATION_FAILED"/);
  });

  it("synchronizes embedded runtime before canonical verification", () => {
    const { syncCanonicalRuntime } = require("./check");
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "minitok-canonical-") );
    fs.writeFileSync(path.join(d, "package.json"), JSON.stringify({ name: "customer-app" }));
    assert.equal(syncCanonicalRuntime(d), null);
    fs.rmSync(d, { recursive: true, force: true });
  });

  it("classifies missing and non-executable verification gates separately from gate failures", () => {
    const { classifyVerificationEvidence } = require("./check");
    assert.equal(classifyVerificationEvidence({ status: "missing", exit_code: 1 }), "VERIFICATION_INFRA_FAILED");
    assert.equal(classifyVerificationEvidence({ status: "infra_failed", exit_code: 1 }), "VERIFICATION_INFRA_FAILED");
    assert.equal(classifyVerificationEvidence({ status: "failed", exit_code: 1 }), "VERIFICATION_FAILED");
    assert.equal(classifyVerificationEvidence({ status: "passed", exit_code: 0 }), "PASSED");
  });

  it("does not leak minitok control environment variables into customer verification", () => {
    const { verificationEnvironment } = require("./check");
    const env = verificationEnvironment({ MINITOK_BUDGET_MAX_CYCLES: "3", MINITOK_BUDGET_STAGNATION_LIMIT: "4", CUSTOMER_FLAG: "keep" });
    assert.equal(env.MINITOK_BUDGET_MAX_CYCLES, undefined);
    assert.equal(env.MINITOK_BUDGET_STAGNATION_LIMIT, undefined);
    assert.equal(env.CUSTOMER_FLAG, "keep");
  });

  it("withholds provider credentials and the MCP grant from a repository verification script", () => {
    const { verificationEnvironment } = require("./check");
    const env = verificationEnvironment({
      ANTHROPIC_API_KEY: "sk-ant-secret",
      OPENAI_API_KEY: "sk-openai-secret",
      GEMINI_API_KEY: "gm-secret",
      OPENROUTER_API_KEY: "or-secret",
      CAMEL_STREAM_API_KEY: "camel-secret",
      MINITOK_MCP_AUTH_TOKEN: "mcp-secret",
      MINITOK_MCP_AUTH_TOKEN_FILE: "/home/user/.minitok/mcp/runtime-token.json",
      MINITOK_CUSTOMER_TOKEN: "customer-secret",
      PATH: "/usr/bin",
      HOME: "/home/user",
      DATABASE_URL: "postgres://user:pass@localhost/db",
      CI: "true",
    });
    for (const key of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY", "CAMEL_STREAM_API_KEY", "MINITOK_MCP_AUTH_TOKEN", "MINITOK_MCP_AUTH_TOKEN_FILE", "MINITOK_CUSTOMER_TOKEN"]) {
      assert.equal(env[key], undefined, `${key} must not reach repository code`);
    }
    // Only credentials are removed: a gate that needs its build environment keeps it.
    assert.equal(env.PATH, "/usr/bin");
    assert.equal(env.HOME, "/home/user");
    assert.equal(env.DATABASE_URL, "postgres://user:pass@localhost/db");
    assert.equal(env.CI, "true");
  });

  it("excludes internal .minitok runtime metadata from reviewer status", async () => {
    const { execFileSync } = require("node:child_process");
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "minitok-review-status-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: repo });
      execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: repo });
      execFileSync("git", ["config", "user.name", "test"], { cwd: repo });
      fs.writeFileSync(path.join(repo, "README.md"), "baseline\n");
      execFileSync("git", ["add", "README.md"], { cwd: repo });
      execFileSync("git", ["commit", "-qm", "baseline"], { cwd: repo });
      fs.mkdirSync(path.join(repo, ".minitok", "evidence"), { recursive: true });
      fs.writeFileSync(path.join(repo, ".minitok", "run.lock"), "runtime\n");
      let reviewPrompt = "";
      const provider = { complete: async messages => { reviewPrompt = messages[1].content; return { text: JSON.stringify({ verdict: "APPROVE", confidence: 1, summary: "ok", findings: [], security_findings: [], risk_level: "low", test_suggestions: [] }), tokens: { input: 1, output: 1 }, model: "test" }; } };
      await verify(provider, "review task", { changes: { changes: [] }, check: { passed: true } }, repo);
      assert.doesNotMatch(reviewPrompt, /\\.minitok/);
      assert.match(reviewPrompt, /Git Status\nclean/);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("builds a repair task from review and check failures", () => {
    const task = buildRepairTask("original goal", { summary: "bad change", findings: [{ severity: "error", message: "fix this" }] }, { evidence: { command: "npm test", output: "failed test" } });
    assert.match(task, /original goal/);
    assert.match(task, /fix this/);
    assert.match(task, /failed test/);
  });

  it("rejects forged nonce and substituted run responses", () => {
    const request = approvalRequest({ changes: [] }, { runId: "run-1", approvalTimeoutMs: 1000 }, 1000);
    assert.equal(validateApprovalResponse({ decision: "approve", nonce: "forged", run_id: "run-1" }, request, 1500), false);
    assert.equal(validateApprovalResponse({ decision: "approve", nonce: request.nonce, run_id: "run-2" }, request, 1500), false);
  });

  it("accepts a response carrying the request nonce and run ID", () => {
    const request = approvalRequest({ changes: [] }, { runId: "run-1", approvalTimeoutMs: 1000 }, 1000);
    assert.equal(validateApprovalResponse({ decision: "approve", nonce: request.nonce, run_id: request.run_id }, request, 1500), true);
  });

  it("rejects expired and malformed approval responses", () => {
    const request = approvalRequest({ changes: [] }, { runId: "run-1", approvalTimeoutMs: 1000 }, 1000);
    assert.equal(validateApprovalResponse({ decision: "approve", nonce: request.nonce, run_id: "run-1" }, request, 2000), false);
    assert.equal(validateApprovalResponse({ decision: "yes", nonce: request.nonce, run_id: "run-1" }, request, 1500), false);
  });

  it("writes approval requests atomically", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "minitok-approval-"));
    try {
      const file = path.join(directory, "approval.json");
      const request = approvalRequest({ changes: [] }, { runId: "run-1", approvalTimeoutMs: 1000 }, 1000);
      writeApprovalRequest(file, request);
      assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), request);
      assert.equal(fs.readdirSync(directory).some(name => name.includes(".tmp.")), false);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  // A reply cut off by the output token budget is not a formatting mistake: it
  // used to be reported as "Invalid JSON", which sent the operator (and the repair
  // loop) after the wrong problem and paid for the same overflow again.

  const truncatedReply = finish_reason => ({ text: "{\"steps\": [", tokens: { input: 1, output: 2 }, model: "mock", finish_reason, truncated: true });

  it("reports a truncated planner reply as a token limit instead of invalid JSON", async () => {
    const provider = { complete: async () => truncatedReply("max_tokens") };
    const result = await plan(provider, "task", "context");
    assert.match(result.plan.error, /stopped at its output token limit \(finish_reason: max_tokens\)/);
    assert.equal(result.plan.truncated, true);
    assert.doesNotMatch(result.plan.error, /Invalid JSON|No JSON/);
  });

  it("reports a truncated review as a token limit as well", async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "minitok-review-"));
    try {
      const provider = { complete: async () => truncatedReply("length") };
      const result = await verify(provider, "task", { changes: { changes: [] }, check: { passed: true } }, repo);
      assert.match(result.review.error, /stopped at its output token limit \(finish_reason: length\)/);
      assert.equal(result.review.truncated, true);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("does not retry a truncated implementation, but still retries malformed JSON", async () => {
    let truncatedCalls = 0;
    const truncatedProvider = { complete: async () => { truncatedCalls += 1; return { ...truncatedReply("length"), text: "{\"changes\": [" }; } };
    const truncated = await implement(truncatedProvider, { plan: { steps: [] } }, "context");
    assert.equal(truncatedCalls, 1, "retrying a token-limit overflow with the same budget only truncates again");
    assert.match(truncated.changes.error, /stopped at its output token limit \(finish_reason: length\)/);

    let attempts = 0;
    const flakyProvider = { complete: async () => { attempts += 1; return { text: attempts === 1 ? "not json at all" : JSON.stringify({ changes: [] }), tokens: { input: 1, output: 1 }, model: "mock", finish_reason: "stop", truncated: false }; } };
    const repaired = await implement(flakyProvider, { plan: { steps: [] } }, "context");
    assert.equal(attempts, 2, "a malformed reply is still worth one retry");
    assert.deepEqual(repaired.changes.changes, []);
  });

  it("derives the run outcome from the final cycle, not from an earlier approval", () => {
    // A goal-directed run can approve a change set and then fail the follow-up
    // task it generated. The run is not a success, but the approved work has to
    // stay distinguishable from "nothing ever passed" so it can be preserved.
    assert.deepEqual(summarizeRunOutcome([{ status: "APPROVE" }, { status: "REJECT" }]), {
      success: false,
      approved: true,
      last_cycle_status: "REJECT",
    });
    assert.deepEqual(summarizeRunOutcome([{ status: "REJECT" }, { status: "APPROVE" }]), { success: true, approved: true, last_cycle_status: "APPROVE" });
    assert.deepEqual(summarizeRunOutcome([{ status: "APPROVE" }]), { success: true, approved: true, last_cycle_status: "APPROVE" });
    assert.deepEqual(summarizeRunOutcome([{ status: "impl_failed" }, { status: "CHANGES_REQUESTED" }]), { success: false, approved: false, last_cycle_status: "CHANGES_REQUESTED" });
  });

  it("treats an empty, missing or status-less final cycle as a failure", () => {
    for (const cycles of [[], null, undefined]) {
      assert.deepEqual(summarizeRunOutcome(cycles), { success: false, approved: false, last_cycle_status: null });
    }
    assert.deepEqual(summarizeRunOutcome([{ status: "APPROVE" }, {}]), { success: false, approved: true, last_cycle_status: null });
  });
});
