"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createGoalSpec } = require("../src/goal/spec");
const { GoalController } = require("../src/goal/controller");
const { executeRiskOperations, RISK_OPERATIONS } = require("../src/goal/risk_execution");
const { createBlockerReport, selectAlternative, normalizeAlternative } = require("../src/goal/blocker");
const { createGoalSession, saveGoalSession, loadGoalSession, pauseGoalSession, releaseGoalSessionLock, resumeGoalSession } = require("../src/goal/session");
const { cmdGoalContinue } = require("../src/cli/commands/goal");
const { auditRead } = require("../src/core/audit");

function sandbox() { const root = fs.mkdtempSync(path.join(os.tmpdir(), "minitok-phase9-e2e-")); return { root, auditPath: path.join(root, "audit.jsonl"), clean: () => fs.rmSync(root, { recursive: true, force: true }) }; }
function goal(id, allowedPaths = []) { return createGoalSpec({ schema_version: 1, goal_id: id, objective: id, success_criteria: [{ id: "a", description: "criterion", required: true, verifier: { type: "custom", id: "criterion", config: {} } }], constraints: { allowed_paths: allowedPaths, blocked_paths: [".git", "VERIFY_CMD.mjs"], max_cycles: 3, max_tokens: 0, timeout_ms: 0, stagnation_limit: 3, max_changed_files: 5, same_task_limit: 2, same_failure_limit: 2, requires_approval_for: [] }, execution_policy: { mode: "safe" } }); }
function config(capabilities = RISK_OPERATIONS) { return { goal: { unrestricted: { enabled: true, capabilities, require_explicit_confirmation: true, require_auto_accept: true } } }; }
function evaluation(g, passed) { return { goal_id: g.goal_id, completed: passed, criteria: [{ id: "a", status: passed ? "passed" : "failed", evidence_ids: [passed ? "e-pass" : "e-pending"], reason: passed ? "verified" : "pending" }], evidence: [{ evidence_id: passed ? "e-pass" : "e-pending", valid: passed, executed: true, execution: { executed: true } }], remaining_criteria: passed ? [] : ["a"], unknown_criteria: [] }; }

test("Scenario A: safe keeps the existing write approval boundary", async () => {
  const b = sandbox(); let executed = 0;
  try {
    const g = goal("phase9-safe");
    const output = await new GoalController(g, { mode: "safe", capabilities: ["workspace_write"], workspaceRoot: b.root, evaluator: async () => evaluation(g, false), taskProposer: async () => ({ next_task: "edit src/app.js", target_criteria: ["a"], capabilities: ["workspace_write"], paths: ["src/app.js"] }), taskExecutor: async () => { executed += 1; return { success: true }; } }).run();
    assert.equal(executed, 0); assert.ok(["blocked", "escalate"].includes(output.state)); assert.equal(output.action_history.some(item => item.policy_decision === "denied"), true);
  } finally { b.clean(); }
});

test("Scenario B: supervised requires approval before execution and runs after confirmation", async () => {
  const b = sandbox(); let executed = 0; let passed = false; const g = goal("phase9-supervised");
  const proposer = async () => ({ next_task: "edit src/app.js", target_criteria: ["a"], capabilities: ["workspace_write"], paths: ["src/app.js"] });
  try {
    const session = createGoalSession({ workspaceRoot: b.root, goalSpec: g });
    const first = await new GoalController(g, { session, releaseSessionOnExit: true, mode: "supervised", capabilities: ["workspace_write"], evaluator: async () => evaluation(g, false), taskProposer: proposer, taskExecutor: async () => { executed += 1; return { success: true }; } }).run();
    assert.equal(executed, 0); assert.ok(first.action_history.some(item => item.policy_decision === "approval_required"));
    const resumed = resumeGoalSession(b.root, g.goal_id);
    const second = await new GoalController(g, { session: resumed, releaseSessionOnExit: true, mode: "supervised", capabilities: ["workspace_write"], explicit_confirmation: true, evaluator: async () => evaluation(g, passed), taskProposer: proposer, taskExecutor: async () => { executed += 1; passed = true; return { success: true, status: "success" }; } }).run();
    assert.equal(executed, 1); assert.equal(second.completed, true);
  } finally { b.clean(); }
});

test("Scenario C: unrestricted local workspace write runs through a mock adapter and verifies persistence", async () => {
  const b = sandbox(); let adapterCalls = 0; let taskCalls = 0; let evaluations = 0; const g = goal("phase9-unrestricted-local");
  try {
    const session = createGoalSession({ workspaceRoot: b.root, goalSpec: g });
    const output = await new GoalController(g, { session, releaseSessionOnExit: true, mode: "unrestricted", capabilities: ["workspace_write"], explicit_confirmation: true, auto_accept: true, config: config(["workspace_write"]), workspaceRoot: b.root, auditPath: b.auditPath, evaluator: async () => { evaluations += 1; return evaluation(g, evaluations > 1 && fs.existsSync(path.join(b.root, "src", "result.txt"))); }, taskProposer: async () => ({ next_task: "write result", target_criteria: ["a"], capabilities: ["workspace_write"], paths: ["src/result.txt"], risk_operations: [{ operation: "workspace_write", paths: ["src/result.txt"] }] }), adapters: { workspace_write: async input => { adapterCalls += 1; fs.mkdirSync(path.join(b.root, "src"), { recursive: true }); fs.writeFileSync(path.join(b.root, input.paths[0]), "verified\n"); return { success: true, status: "simulated", verification_result: "passed" }; } }, taskExecutor: async () => { taskCalls += 1; return { success: true, status: "success" }; } }).run();
    assert.equal(output.completed, true); assert.equal(adapterCalls, 1); assert.equal(taskCalls, 1); assert.ok(output.execution_audits.length >= 2); assert.equal(auditRead(b.auditPath).every(item => item.type === "execution"), true);
  } finally { b.clean(); }
});

test("Scenario D: unrestricted external publish and deploy use injected adapters only", async () => {
  const b = sandbox(); const calls = [];
  try {
    const result = await executeRiskOperations({ risk_operations: [{ operation: "publish", external_target: "https://registry.example.test/package?token=secret" }, { operation: "deploy", external_target: "https://staging.example.test/app" }] }, { mode: "unrestricted", explicit_confirmation: true, auto_accept: true, config: config(["publish", "deploy"]), workspaceRoot: b.root, auditPath: b.auditPath, adapters: { publish: async input => { calls.push(input.operation); return { success: true, status: "published-by-mock", verification_result: "passed" }; }, deploy: async input => { calls.push(input.operation); return { success: true, status: "deployed-by-mock", verification_result: "healthy" }; } } });
    assert.equal(result.success, true); assert.deepEqual(calls, ["publish", "deploy"]); assert.equal(result.audits.filter(item => item.phase === "final").every(item => item.external_target.hostname.endsWith("example.test")), true); assert.doesNotMatch(JSON.stringify(result), /token=secret|password|Bearer/i);
  } finally { b.clean(); }
});


test("Scenario F: always-blocked and integrity violations escalate without adapter execution", async () => {
  const b = sandbox(); let calls = 0;
  try {
    const result = await executeRiskOperations({ risk_operations: [{ operation: "protected_path_write", paths: ["VERIFY_CMD.mjs"] }, { operation: "workspace_write", verifier_tampering: true, paths: ["src/app.js"] }] }, { mode: "unrestricted", explicit_confirmation: true, auto_accept: true, config: config(["workspace_write"]), workspaceRoot: b.root, auditPath: b.auditPath, task: "private key=do-not-record", adapters: { workspace_write: async () => { calls += 1; return { success: true }; } } });
    assert.equal(result.success, false); assert.equal(calls, 0); assert.ok(result.audits.every(item => item.policy_decision === "denied")); assert.doesNotMatch(JSON.stringify(result), /do-not-record|private key/i);
    const report = createBlockerReport({ category: "permission_blocked", stage: "security", cause: "private key exposure is always blocked", affected_step: "secret logging", alternatives: [{ alternative_id: "blocked", description: "Expose private key", rationale: "forbidden", expected_benefit: "none", risk_level: "critical", side_effects: ["credential"], required_permissions: [], estimated_cost: "unknown", reversible: false, verification_plan: {}, execution_policy: "always_blocked", applicable: true }] });
    assert.equal(selectAlternative(report, { execution_policy: "unrestricted", explicit_confirmation: true, auto_accept: true }).status, "escalate");
  } finally { b.clean(); }
});

test("Scenario G: persisted unrestricted state is not trusted on resume and redacted evidence survives pause", async () => {
  const b = sandbox(); const g = goal("phase9-persistence");
  try {
    const session = createGoalSession({ workspaceRoot: b.root, goalSpec: g }); session.state.execution_policy = { mode: "unrestricted", allowed: true, capabilities: ["publish"], denied_capabilities: [], approval_required: false }; session.state.execution_audits = [{ audit_id: "exec-audit-persisted", task: "token=[REDACTED]", final_outcome: "completed" }]; saveGoalSession(session); pauseGoalSession(session, "phase9 pause"); releaseGoalSessionLock(session);
    const loaded = loadGoalSession(b.root, g.goal_id, { lock: false }); assert.equal(loaded.state.execution_audits[0].audit_id, "exec-audit-persisted"); assert.doesNotMatch(fs.readFileSync(loaded.paths.state, "utf8"), /token=secret|password=/i);
    const denied = await cmdGoalContinue(g.goal_id, { repo: b.root, json: true }); assert.equal(denied, 1); const stillStored = loadGoalSession(b.root, g.goal_id, { lock: false }); assert.equal(stillStored.state.execution_policy.mode, "unrestricted");
  } finally { b.clean(); }
});

test("Scenario E: blocker alternatives preserve retry and credential boundaries", () => {
  const network = createBlockerReport({ category: "network_failure", stage: "verify", cause: "connection reset", affected_step: "remote" });
  assert.equal(selectAlternative(network, { execution_policy: "safe" }).alternative.alternative_id, "retry-backoff");
  const auth = createBlockerReport({ category: "authentication_failure", stage: "publish", cause: "provider authentication failed", affected_step: "publish" });
  assert.equal(selectAlternative(auth, { execution_policy: "safe" }).alternative.alternative_id, "local-validation");
  const credentialAlternative = normalizeAlternative({ alternative_id: "credential-run", description: "Use approved credential", rationale: "authorized external retry", expected_benefit: "publish", risk_level: "high", side_effects: ["credential", "external_call"], required_permissions: ["credential"], estimated_cost: "high", reversible: false, verification_plan: {}, applicable: true });
  const unrestricted = createBlockerReport({ category: "authentication_failure", stage: "publish", cause: "failed auth", affected_step: "publish", alternatives: [credentialAlternative] });
  const selected = selectAlternative(unrestricted, { execution_policy: "unrestricted", explicit_confirmation: true, auto_accept: true, actor: { credential_present: true }, config: config(["credential_use", "external_call"]) });
  assert.equal(selected.status, "selected"); assert.equal(selected.alternative.alternative_id, "credential-run");
});

