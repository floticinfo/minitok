"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { intel } = require("./intel");
const { verifyCommand } = require("./check");
const { buildRepairTask } = require("./repair");
const { approvalRequest, validateApprovalResponse, writeApprovalRequest, buildRoleOptions } = require("./loop");

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
    assert.match(source, /const verdict = checkPassed \? reviewVerdict : "VERIFICATION_FAILED"/);
    assert.match(source, /verdict === "REJECT" \|\| verdict === "VERIFICATION_FAILED"/);
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
});
