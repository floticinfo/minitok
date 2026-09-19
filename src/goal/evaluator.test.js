"use strict";

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createGoalSpec } = require("./spec");
const { evaluateGoal } = require("./evaluator");

function rootDirectory() { return fs.mkdtempSync(path.join(os.tmpdir(), "minitok-goal-eval-")); }
function clean(root) { fs.rmSync(root, { recursive: true, force: true }); }
function criterion(id, type, config, required = true) { return { id, description: id, required, verifier: { type, id: `${type}-${id}`, config } }; }
function goal(criteria) {
  return createGoalSpec({ schema_version: 1, goal_id: "goal-evaluator-test", objective: "Evaluate criteria", success_criteria: criteria,
    constraints: { allowed_paths: [], blocked_paths: [".git", ".env"], max_cycles: 3, timeout_ms: 1000, requires_approval_for: [] }, execution_policy: { mode: "safe" } });
}
function runner(result) { return async () => ({ duration_ms: 2, exit_code: 0, status: "passed", output: "ok", ...result }); }

describe("GoalEvaluator", () => {
  test("marks all required criteria passed and completes", async () => {
    const root = rootDirectory();
    try {
      const result = await evaluateGoal(goal([criterion("command", "command", { command: "node", args: ["--version"] }), criterion("file", "file", { path: "ready.txt", exists: true })]), {
        repoRoot: root, commandRunner: runner({}), fileSystem: { existsSync: file => file.endsWith("ready.txt"), readFileSync: () => "ready" },
      });
      assert.equal(result.completed, true);
      assert.ok(result.evidence.every(item => item.executed === true && item.execution.executed === true));
      assert.deepEqual(result.criteria.map(item => item.status), ["passed", "passed"]);
    } finally { clean(root); }
  });

  test("fails when a required criterion fails", async () => {
    const result = await evaluateGoal(goal([criterion("bad", "command", { command: "node", args: ["--version"] })]), { commandRunner: runner({ status: "failed", exit_code: 2, output: "assertion failed" }) });
    assert.equal(result.completed, false);
    assert.equal(result.criteria[0].status, "failed");
    assert.deepEqual(result.remaining_criteria, ["bad"]);
  });

  test("keeps verifier execution timeout as unknown", async () => {
    const result = await evaluateGoal(goal([criterion("slow", "command", { command: "node", args: ["--version"] })]), { commandRunner: runner({ status: "failed", timed_out: true, error: "timeout" }) });
    assert.equal(result.completed, false);
    assert.equal(result.criteria[0].status, "unknown");
    assert.deepEqual(result.unknown_criteria, ["slow"]);
    assert.equal(result.criteria[0].evidence_ids.length, 1);
  });

  test("keeps verifier execution errors unknown", async () => {
    const result = await evaluateGoal(goal([criterion("error", "command", { command: "node", args: ["--version"] })]), { commandRunner: async () => { throw new Error("runner unavailable"); } });
    assert.equal(result.completed, false);
    assert.equal(result.criteria[0].status, "unknown");
    assert.match(result.criteria[0].reason, /runner unavailable/);
  });

  test("does not fail completion for an optional failed criterion", async () => {
    const result = await evaluateGoal(goal([
      criterion("required", "command", { command: "node", args: ["--version"] }, true),
      criterion("optional", "command", { command: "node", args: ["--version"] }, false),
    ]), { commandRunner: async (_command, _args, _root, { criterion }) => criterion.id === "optional" ? { status: "failed", exit_code: 1, output: "optional failure" } : { status: "passed", exit_code: 0, output: "ok", duration_ms: 2 } });
    assert.equal(result.completed, true);
    assert.equal(result.criteria[1].status, "failed");
  });

  test("redacts secrets from evaluator evidence", async () => {
    const result = await evaluateGoal(goal([criterion("secret", "command", { command: "node", args: ["--version"] })]), { commandRunner: runner({ output: "token=super-secret Bearer abc123", stderr: "password=hunter2" }) });
    const evidence = result.evidence[0];
    assert.equal(evidence.stdout.includes("super-secret"), false);
    assert.equal(evidence.stdout.includes("abc123"), false);
    assert.equal(evidence.stderr.includes("hunter2"), false);
    assert.equal(evidence.stdout.includes("[REDACTED]"), true);
  });

  test("ignores model done and review APPROVE", async () => {
    const result = await evaluateGoal(goal([criterion("required", "command", { command: "node", args: ["--version"] })]), { commandRunner: runner({ status: "failed", exit_code: 1 }), done: true, completed: true, review: { verdict: "APPROVE" } });
    assert.equal(result.completed, false);
    assert.equal(result.criteria[0].status, "failed");
  });

  test("produces stable statuses and evidence ids on repeated evaluation", async () => {
    const spec = goal([criterion("stable", "command", { command: "node", args: ["--version"] })]);
    const options = { commandRunner: runner({ output: "same" }), now: () => "2026-01-01T00:00:00.000Z" };
    const first = await evaluateGoal(spec, options);
    const second = await evaluateGoal(spec, options);
    assert.deepEqual(first.criteria, second.criteria);
    assert.deepEqual(first.evidence, second.evidence);
    assert.equal(first.evaluated_at, second.evaluated_at);
  });

  test("file verifier supports safe existence, content, and changed checks", async () => {
    const root = rootDirectory();
    fs.writeFileSync(path.join(root, "state.txt"), "new state");
    try {
      const spec = goal([
        criterion("exists", "file", { path: "state.txt", exists: true }),
        criterion("contains", "file", { path: "state.txt", contains: "new" }),
        criterion("changed", "file", { path: "state.txt", changed: true }),
      ]);
      const result = await evaluateGoal(spec, { repoRoot: root, baselineFiles: { "state.txt": "old state" } });
      assert.equal(result.completed, true);
      assert.deepEqual(result.criteria.map(item => item.status), ["passed", "passed", "passed"]);
    } finally { clean(root); }
  });

  test("reports required progress and refuses completion for an unexecuted repository verifier", async () => {
  const spec = createGoalSpec({ schema_version: 1, goal_id: "odd-evaluator", objective: "odd", success_criteria: [{ id: "repo-check", description: "local check", required: true, verifier: { type: "custom", id: "repo-check", config: { repository_check: { kind: "local_command", command: "npm", args: ["test"] } } } }], constraints: { allowed_paths: [], blocked_paths: [".git"], max_cycles: 1, max_tokens: 0, timeout_ms: 1000, stagnation_limit: 1, max_changed_files: 2, same_task_limit: 1, same_failure_limit: 1, requires_approval_for: [], repository_odd: { allowed_paths: [], protected_paths: ["package.json"], required_checks: ["git_status"], allow_external: false } }, execution_policy: { mode: "safe" } });
  const result = await evaluateGoal(spec, { repoRoot: "C:\\repo" });
  assert.equal(result.completed, false);
  assert.deepEqual(result.progress, { required_total: 1, passed: 0, failed: 0, unknown: 1, progress_ratio: 0 });
});

test("preserves blocked and escalated application states and refuses completion", async () => {
    const { APPLICATION_CAPABILITIES } = require("./application");
    const blocked = await evaluateGoal(goal([criterion("deployment", "custom", { application_check: { kind: "deployment", environment: "production", approval: true, rollback_strategy: "previous-release", health_check: { path: "/health" } } })]), { application: { capabilities: new Set(APPLICATION_CAPABILITIES), approvals: new Set(APPLICATION_CAPABILITIES) } });
    assert.equal(blocked.completed, false);
    assert.equal(blocked.criteria[0].status, "blocked");
    const escalated = await evaluateGoal(goal([criterion("deployment", "custom", { application_check: { kind: "deployment", environment: "staging", approval: true, rollback_strategy: "previous-release", health_check: { path: "/health" } } })]), { application: { capabilities: new Set(APPLICATION_CAPABILITIES), approvals: new Set(APPLICATION_CAPABILITIES), deployer: async () => ({ success: true }), healthCheck: async () => ({ healthy: false }), rollback: async () => ({ success: false }) } });
    assert.equal(escalated.completed, false);
    assert.equal(escalated.criteria[0].status, "escalated");
  });

test("unsupported custom verifier remains unknown", async () => {
    const result = await evaluateGoal(goal([criterion("custom", "custom", { handler: "javascript" })]), { customVerifier: async () => ({ status: "passed" }) });
    assert.equal(result.completed, false);
    assert.equal(result.criteria[0].status, "unknown");
  });
});
