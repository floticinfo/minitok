"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..", "..", "..");
const runner = path.join(ROOT, "scripts", "real-swe-fixture.mjs");
const releaseSnapshot = () => execFileSync("git", ["status", "--porcelain=v1"], { cwd: ROOT, encoding: "utf8" });

test("real SWE fixture template creates a disposable Git repository", () => {
  const result = JSON.parse(execFileSync(process.execPath, [runner, "--mode", "mock", "--create-only"], { cwd: ROOT, encoding: "utf8" }));
  try {
    assert.equal(result.fixture.created, true);
    assert.equal(result.fixture.git_repository, true);
    assert.deepEqual(result.fixture.files.sort(), ["VERIFY_CMD.mjs", "minitok.yml", "package.json", "src/calculator.js"]);
    assert.equal(fs.readFileSync(path.join(result.fixture.root, "src", "calculator.js"), "utf8").includes("return a - b"), true);
  } finally {
    fs.rmSync(result.fixture.root, { recursive: true, force: true });
  }
});

test("mock mode invokes the real runPipeline path and changes only the disposable fixture", () => {
  const before = releaseSnapshot();
  const result = JSON.parse(execFileSync(process.execPath, [runner, "--mode", "mock"], { cwd: ROOT, encoding: "utf8" }));
  assert.equal(result.mode, "mock");
  assert.equal(result.pipeline_invoked, true);
  assert.equal(result.fixture.root.startsWith(os.tmpdir()), true);
  assert.equal(result.fixture.created, true);
  assert.equal(result.fixture.git_repository, true);
  assert.equal(result.release_repository_mutated, false);
  assert.ok(Array.isArray(result.changed_files));
  assert.equal(result.changed_files.includes("src/calculator.js"), true);
  assert.equal(typeof result.source_hash, "string");
  assert.notEqual(result.source_hash, crypto.createHash("sha256").update("function add(a, b) {\n  return a - b;\n}\n\nmodule.exports = { add };\n").digest("hex"));
  assert.equal(releaseSnapshot(), before);
  assert.ok(result.metrics && "end_to_end_success_rate" in result.metrics);
});

test("live mode is unavailable without explicit live configuration and does not call a provider", () => {
  const env = { ...process.env };
  for (const key of ["MINITOK_REAL_SWE_LIVE", "MINITOK_REAL_SWE_PROVIDER", "MINITOK_REAL_SWE_MODEL", "MINITOK_REAL_SWE_ENDPOINT", "MINITOK_REAL_SWE_API_KEY", "MINITOK_REAL_SWE_APPROVAL"]) delete env[key];
  const result = JSON.parse(execFileSync(process.execPath, [runner, "--mode", "live"], { cwd: ROOT, encoding: "utf8", env }));
  assert.equal(result.mode, "live");
  assert.equal(result.status, "unavailable");
  assert.equal(result.pipeline_invoked, false);
  assert.equal(result.provider_calls, 0);
  assert.equal(result.release_repository_mutated, false);
});

test("runner rejects live mode without explicit approval even when credentials are present", () => {
  const env = { ...process.env, MINITOK_REAL_SWE_LIVE: "1", MINITOK_REAL_SWE_PROVIDER: "custom", MINITOK_REAL_SWE_MODEL: "fixture", MINITOK_REAL_SWE_ENDPOINT: "https://example.invalid/v1", MINITOK_REAL_SWE_API_KEY: "not-used-in-test" };
  delete env.MINITOK_REAL_SWE_APPROVAL;
  const result = JSON.parse(execFileSync(process.execPath, [runner, "--mode", "live"], { cwd: ROOT, encoding: "utf8", env }));
  assert.equal(result.status, "unavailable");
  assert.equal(result.reason, "explicit approval required");
  assert.equal(result.provider_calls, 0);
});

test("recovery success uses a different patch and passes the real verifier", () => {
  const result = JSON.parse(execFileSync(process.execPath, [runner, "--mode", "recovery"], { cwd: ROOT, encoding: "utf8" }));
  const record = result.recovery.records[0];
  assert.equal(result.initial_cycle.verification, "failed");
  assert.equal(result.recovery.scheduled, true);
  assert.equal(result.recovery.task_generated, true);
  assert.equal(record.failure_category, "verification_failed");
  assert.notEqual(record.previous_patch_signature, record.recovery_patch_signature);
  assert.equal(record.same_patch_repeated, false);
  assert.equal(record.task_context.has_verifier_output, true);
  assert.equal(record.task_context.has_non_repeat_constraint, true);
  assert.equal(record.task_context.has_previous_patch_signature, true);
  assert.equal(result.final_cycle.verification, "passed");
  assert.equal(result.completed, true);
  assert.equal(result.changed_files.includes("src/calculator.js"), true);
});

test("recovery same-patch attempt is recorded as rejected evidence", () => {
  const result = JSON.parse(execFileSync(process.execPath, [runner, "--mode", "recovery-same"], { cwd: ROOT, encoding: "utf8" }));
  const record = result.recovery.records.find(item => item.same_patch_repeated);
  assert.ok(record);
  assert.equal(record.same_patch_rejected, true);
  assert.equal(result.completed, false);
  assert.equal(result.status, "verification_failed");
});

test("invalid recovery output preserves the initial failure and does not complete", () => {
  const result = JSON.parse(execFileSync(process.execPath, [runner, "--mode", "recovery-invalid"], { cwd: ROOT, encoding: "utf8" }));
  assert.equal(result.recovery.task_generated, true);
  assert.equal(result.final_cycle.verification, "unknown");
  assert.equal(result.completed, false);
  assert.equal(result.status, "model_output_invalid");
});

test("repair task builder records required context without exposing it in runner logs", () => {
  const { buildRepairTask } = require(path.join(ROOT, "src", "pipeline", "repair.js"));
  const task = buildRepairTask("fix calculator", { summary: "review issue", findings: [{ severity: "error", message: "bad result" }] }, { evidence: { command: "node VERIFY_CMD.mjs", output: "failed" } }, { changed_files: ["src/calculator.js"], previous_patch_signature: "hash-1", remaining_success_criteria: ["calculator-add"], strategy: "do not repeat" });
  assert.match(task, /Verification output/);
  assert.match(task, /Current changed files/);
  assert.match(task, /Previous patch signature/);

test("recovery apply failure, timeout, and escalation remain distinct terminal statuses", () => {
  const { createTerminalResult } = require(path.join(ROOT, "src", "goal", "failure.js"));
  assert.equal(createTerminalResult({ merge_failed: true }).terminal_status, "merge_failed");
  assert.equal(createTerminalResult({ state: "timeout" }).terminal_status, "timeout");
  assert.equal(createTerminalResult({ state: "escalate", humanEscalation: true }).terminal_status, "escalated");
  assert.equal(createTerminalResult({ recovery_failed: true }).terminal_status, "recovery_failed");
});
  assert.match(task, /Remaining success criteria/);
  assert.match(task, /do not repeat/);
  assert.doesNotMatch(JSON.stringify({ task }), /api[_-]?key|Bearer\s+[^\s]+/i);
});



test("injected provider resume preserves session state and changes model/provider", () => {
  const result = JSON.parse(execFileSync(process.execPath, [runner, "--mode", "resume-injected"], { cwd: ROOT, encoding: "utf8" }));
  assert.equal(result.live_e2e_status, "injected");
  assert.equal(result.resumed, true);
  assert.equal(result.state_preserved, true);
  assert.equal(result.history_preserved, true);
  assert.equal(result.model_changed, true);
  assert.equal(result.provider_changed, true);
  assert.equal(result.task_changed, true);
  assert.equal(result.final_evaluator_completed, true);
  assert.equal(result.provider_evidence[0].resumed, true);
  assert.equal(result.provider_evidence[0].provider, "provider-b");
  assert.equal(result.provider_evidence[0].model, "model-b");
  assert.equal(result.provider_evidence[0].role, "goal_task_executor");
  assert.equal(typeof result.provider_evidence[0].goal_id, "string");
});

test("live provider resume is skipped without explicit credentials and approval", () => {
  const env = { ...process.env };
  for (const key of ["MINITOK_REAL_SWE_LIVE", "MINITOK_REAL_SWE_PROVIDER_A", "MINITOK_REAL_SWE_MODEL_A", "MINITOK_REAL_SWE_PROVIDER_B", "MINITOK_REAL_SWE_MODEL_B", "MINITOK_REAL_SWE_ENDPOINT", "MINITOK_REAL_SWE_API_KEY", "MINITOK_REAL_SWE_APPROVAL"]) delete env[key];
  const result = JSON.parse(execFileSync(process.execPath, [runner, "--mode", "resume-live"], { cwd: ROOT, encoding: "utf8", env }));
  assert.equal(result.live_status, "skipped");
  assert.equal(result.live_e2e_status, "skipped");
  assert.equal(result.production_ready, false);
  assert.equal(result.reason, "credential/provider/model not configured");
  assert.equal(result.provider_calls, 0);
});

test("injected multi-cycle goal increases criterion progress and completes via evaluator", () => {
  const result = JSON.parse(execFileSync(process.execPath, [runner, "--mode", "multi-injected"], { cwd: ROOT, encoding: "utf8" }));
  assert.equal(result.live_status, "injected");
  assert.equal(result.production_ready, false);
  assert.equal(result.live_e2e_status, "injected");
  assert.ok(result.cycles >= 2);
  assert.equal(result.criteria.length, 3);
  assert.ok(result.criterion_progress.length >= result.cycles);
  assert.equal(result.criterion_progress.at(-1).passed, 3);
  assert.equal(result.criteria.every(item => item.status === "passed"), true);
  assert.equal(result.criteria.every(item => item.evidence_ids.length > 0), true);
  assert.equal(result.unknown_not_passed, true);
  assert.equal(result.model_done_claim, true);
  assert.equal(result.evaluator_completed, true);
  assert.equal(result.final_evaluator_completion, true);
  assert.equal(result.verifier_execution_rate, 1);
  assert.equal(result.evidence_complete, true);
  assert.equal(result.evidence_completeness, 1);
  assert.equal(result.false_completion, false);
  assert.equal(result.unsafe_action, false);
  assert.equal(result.completed, true);
  assert.equal(result.recovery_count, 0);
  assert.equal(result.resume_count, 0);
  assert.ok(result.changed_files.includes("src/calculator.js"));
  assert.ok(result.changed_files.includes("test/calculator.test.js"));
});

test("multi-cycle live mode is skipped without provider credentials", () => {
  const env = { ...process.env };
  for (const key of ["MINITOK_REAL_SWE_LIVE", "MINITOK_REAL_SWE_PROVIDER_A", "MINITOK_REAL_SWE_MODEL_A", "MINITOK_REAL_SWE_PROVIDER_B", "MINITOK_REAL_SWE_MODEL_B", "MINITOK_REAL_SWE_ENDPOINT", "MINITOK_REAL_SWE_API_KEY", "MINITOK_REAL_SWE_APPROVAL"]) delete env[key];
  const result = JSON.parse(execFileSync(process.execPath, [runner, "--mode", "multi-live"], { cwd: ROOT, encoding: "utf8", env }));
  assert.equal(result.live_status, "skipped");
  assert.equal(result.live_e2e_status, "skipped");
  assert.equal(result.production_ready, false);
  assert.equal(result.reason, "credential/provider/model not configured");
  assert.equal(result.completed, false);
  assert.equal(result.final_evaluator_completion, false);
  assert.equal(result.verifier_execution_rate, 0);
  assert.equal(result.evidence_complete, false);
  assert.equal(result.evidence_completeness, 0);
  assert.equal(result.false_completion, false);
  assert.equal(result.unsafe_action, false);
});

test("local application goal observes process, HTTP, JSON, timeout, unavailable, and cleanup evidence", () => {
  const result = JSON.parse(execFileSync(process.execPath, [runner, "--mode", "local-application"], { cwd: ROOT, encoding: "utf8" }));
  assert.equal(result.live_e2e_status, "injected");
  assert.equal(result.process_started, true);
  assert.equal(result.process_health, "passed");
  assert.equal(result.completed, true);
  assert.equal(result.evaluator_completed, true);
  assert.equal(result.http.success, true);
  assert.equal(result.http.timeout.status, "timeout");
  assert.equal(result.http.unavailable.status, "unavailable");
  assert.equal(result.application_state_separate, true);
  assert.equal(result.criteria.every(item => item.evidence_ids.length > 0 && item.executed), true);
  assert.equal(result.cleanup.application_stopped, true);
  assert.equal(result.cleanup.timeout_application_stopped, true);
  assert.equal(result.cleanup.fixture_removed, true);
  assert.equal(result.provider_calls, 0);
});

test("unknown criterion never becomes passed or completed", () => {
  const result = JSON.parse(execFileSync(process.execPath, [runner, "--mode", "multi-injected", "--unknown-criterion", "test"], { cwd: ROOT, encoding: "utf8" }));
  assert.equal(result.unknown_not_passed, true);
  assert.equal(result.completed, false);
});