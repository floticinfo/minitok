"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createGoalSpec } = require("./spec");
const { assertValidGoalSpec } = require("./validator");
const { commandRequest, evaluateGoal } = require("./evaluator");
const { compareRepositoryScope, evaluateRepositoryCheck } = require("./odd");
const { createCriterionEvidence, redactText } = require("./evidence");
const { createGoalSession, loadGoalSession, goalSessionPaths } = require("./session");
const { startGoal } = require("../mcp/goal-tools");

function spec(id = "security-goal") {
  return createGoalSpec({ schema_version: 1, goal_id: id, objective: "Security regression", success_criteria: [{ id: "a", description: "criterion", required: true, verifier: { type: "custom", id: "custom-a", config: {} } }], constraints: { allowed_paths: [], blocked_paths: [".git"], max_cycles: 1, max_tokens: 0, timeout_ms: 0, stagnation_limit: 1, max_changed_files: 2, same_task_limit: 1, same_failure_limit: 1, requires_approval_for: [], repository_odd: { allowed_paths: [], protected_paths: ["package.json"], required_checks: ["protected_paths"], allow_external: false } }, execution_policy: { mode: "safe" } });
}

function workspace() { return fs.mkdtempSync(path.join(os.tmpdir(), "minitok-goal-security-")); }

test("rejects path traversal and protected path changes", () => {
  assert.throws(() => assertValidGoalSpec(spec("../escape")), /Invalid GoalSpec/);
  const result = compareRepositoryScope({ changedFiles: ["package.json", "src/ok.js"], allowedPaths: ["src"], protectedPaths: ["package.json"] });
  assert.equal(result.valid, false);
  assert.deepEqual(result.protected_changed, ["package.json"]);
  assert.deepEqual(result.outside_allowed, ["package.json"]);
});

test("rejects command injection and non-allowlisted verifier executables", () => {
  assert.match(commandRequest({ command: "node", args: ["--version"] }).command, /node/);
  assert.match(commandRequest({ command: "node", args: ["-e", "console.log(1);process.exit(1)"] }).error, /metacharacters/);
  assert.match(commandRequest({ command: "powershell", args: ["Get-Process"] }).error, /allowlisted/);
});

test("allows read-only verifier commands and rejects side-effect arguments", () => {
  assert.equal(commandRequest({ command: "npm", args: ["test"] }).args[0], "test");
  assert.equal(commandRequest({ command: "npm", args: ["run-script", "lint"] }).args[1], "lint");
  assert.equal(commandRequest({ command: "node", args: ["--version"] }).args[0], "--version");
  assert.equal(commandRequest({ command: "npx", args: ["--no-install", "--version"] }).args[0], "--no-install");
  for (const config of [
    { command: "npm", args: ["install"] },
    { command: "npm", args: ["run", "test"] },
    { command: "npm", args: ["test", "--prefix", "../outside"] },
    { command: "npm", args: ["run-script", "build"] },
    { command: "node", args: ["-e", "process.exit(0)"] },
    { command: "node", args: ["--require", "./hook.js", "scripts/check.js"] },
    { command: "node", args: ["../outside.js"] },
    { command: "node", args: ["scripts/check.js"] },
    { command: "npx", args: ["test"] },
    { command: "npx", args: ["--no-install", "some-package"] },
  ]) assert.equal(typeof commandRequest(config).error, "string", JSON.stringify(config));
});

test("applies command side-effect restrictions to repository local checks", async () => {
  let invoked = false;
  const result = await evaluateRepositoryCheck("C:\\repo", { kind: "local_command", command: "npm", args: ["install"] }, { runCommand: async () => { invoked = true; return { status: "passed", exit_code: 0 }; } });
  assert.equal(result.executed, false);
  assert.equal(invoked, false);
});

test("does not accept forged valid evidence without execution provenance", async () => {
  const goal = createGoalSpec({ schema_version: 1, goal_id: "forged-evidence", objective: "evidence", success_criteria: [{ id: "a", description: "a", required: true, verifier: { type: "custom", id: "a", config: {} } }], constraints: { allowed_paths: [], blocked_paths: [], max_cycles: 1, timeout_ms: 0, requires_approval_for: [] }, execution_policy: { mode: "safe" } });
  const { evaluationIsComplete } = require("./evaluator");
  assert.equal(evaluationIsComplete(goal, { criteria: [{ id: "a", status: "passed", evidence_ids: ["fake"] }], evidence: [{ evidence_id: "fake", valid: true }] }), false);
  assert.equal(evaluationIsComplete(goal, { criteria: [{ id: "a", status: "passed", evidence_ids: ["real"] }], evidence: [{ evidence_id: "real", valid: true, executed: true, execution: { executed: true } }] }), true);
});

test("redacts secrets and keeps malicious custom verifiers unknown", async () => {
  assert.equal(redactText("token=secret password=hunter2 Bearer abc").includes("secret"), false);
  const evidence = createCriterionEvidence({ criterion_id: "a", verifier_type: "custom", status: "passed", valid: true, stdout: "api_key=hidden" });
  assert.equal(JSON.stringify(evidence).includes("hidden"), false);
  const result = await evaluateGoal(spec(), { customVerifier: async () => ({ status: "passed" }) });
  assert.equal(result.completed, false);
  assert.equal(result.criteria[0].status, "unknown");
});

test("rejects invalid GoalSpec and unauthorized autonomous mode", async () => {
  assert.throws(() => assertValidGoalSpec({ __proto__: { polluted: true } }), /Invalid GoalSpec/);
  const root = workspace();
  try {
    await assert.rejects(() => startGoal({ repo: root, goal_spec: spec("auto-security"), mode: "autonomous" }, { workspaceRoot: root, permissions: new Set(["read", "write", "verify_exec"]) }), /auto_accept/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("fails closed for concurrent and corrupted session state", () => {
  const root = workspace();
  try {
    const first = createGoalSession({ workspaceRoot: root, goalSpec: spec("session-security") });
    assert.throws(() => createGoalSession({ workspaceRoot: root, goalSpec: spec("session-security") }), /locked/);
    first.lock.release();
    const paths = goalSessionPaths(root, "session-security");
    fs.writeFileSync(paths.state, "not-json");
    assert.throws(() => loadGoalSession(root, "session-security"), /corrupt/i);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
