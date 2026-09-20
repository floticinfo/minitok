"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { executeRiskOperations, RISK_OPERATIONS } = require("./risk_execution");
const { auditRead } = require("../core/audit");
const { createExecutionAuditRecord, redactExternalTarget } = require("./execution_audit");

function box() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "minitok-risk-audit-"));
  return { root, auditPath: path.join(root, "audit.jsonl"), clean: () => fs.rmSync(root, { recursive: true, force: true }) };
}
function config() {
  return { goal: { unrestricted: { enabled: true, capabilities: [...RISK_OPERATIONS], require_explicit_confirmation: true, require_auto_accept: true } } };
}
function adapters(calls) {
  return Object.fromEntries(RISK_OPERATIONS.map(operation => [operation, async input => { calls.push({ operation, input }); return { success: true, status: "simulated", verification_result: "passed", secret: "token=must-not-leak" }; }]));
}

test("unrestricted executes every configured risky operation through injected adapters", async () => {
  const b = box(); const calls = [];
  try {
    const result = await executeRiskOperations({ risk_operations: RISK_OPERATIONS.map(operation => ({ operation, paths: operation === "workspace_write" ? ["src/app.js"] : [], external_target: operation === "external_call" ? "https://example.test/api?token=secret" : undefined, credential_presence_used: operation === "credential_use" })) }, { mode: "unrestricted", explicit_confirmation: true, auto_accept: true, actor: { credential_present: true, id: "operator-1" }, source: "mcp", config: config(), workspaceRoot: b.root, goal_id: "goal-audit", session_id: "session-audit", task: "publish with token=secret", adapters: adapters(calls), auditPath: b.auditPath });
    assert.equal(result.success, true);
    assert.deepEqual(calls.map(item => item.operation), RISK_OPERATIONS);
    assert.equal(result.audits.length, RISK_OPERATIONS.length * 2);
    for (const audit of result.audits) {
      assert.equal(audit.execution_mode, "unrestricted");
      assert.equal(audit.policy_decision, "allowed");
      assert.equal(audit.approval_bypassed, true);
      assert.ok(audit.audit_id.startsWith("exec-audit-"));
      assert.doesNotMatch(JSON.stringify(audit), /secret|must-not-leak/i);
      assert.equal(Object.hasOwn(audit, "credential_presence_used"), true);
    }
    const persisted = auditRead(b.auditPath);
    assert.equal(persisted.length, RISK_OPERATIONS.length * 2);
  } finally { b.clean(); }
});

test("safe and supervised modes record denial without invoking adapters", async () => {
  for (const mode of ["safe", "supervised", "authorized_external"]) {
    const b = box(); let calls = 0;
    try {
      const result = await executeRiskOperations({ risk_operations: [{ operation: "publish", external_target: "https://registry.test/package" }] }, { mode, explicit_confirmation: true, auto_accept: true, actor: { credential_present: true }, config: config(), workspaceRoot: b.root, adapters: { publish: async () => { calls += 1; return { success: true }; } }, auditPath: b.auditPath });
      assert.equal(result.success, false);
      assert.equal(calls, 0);
      assert.equal(result.operations[0].status, "blocked");
      assert.equal(auditRead(b.auditPath).length, 1);
    } finally { b.clean(); }
  }
});

test("integrity gates remain blocked and produce redacted denial evidence", async () => {
  const cases = [
    { operation: "workspace_write", paths: ["../outside"] },
    { operation: "workspace_write", verifier_tampering: true },
    { operation: "protected_path_write" },
  ];
  for (const input of cases) {
    const b = box(); let calls = 0;
    try {
      const result = await executeRiskOperations({ risk_operations: [input] }, { mode: "unrestricted", explicit_confirmation: true, auto_accept: true, config: config(), workspaceRoot: b.root, adapters: { workspace_write: async () => { calls += 1; return { success: true }; } }, auditPath: b.auditPath, task: "authorization=secret" });
      assert.equal(result.success, false);
      assert.equal(calls, 0);
      assert.equal(result.audits[0].policy_decision, "denied");
      assert.doesNotMatch(JSON.stringify(result), /authorization=secret/i);
    } finally { b.clean(); }
  }
});

test("controller runs risk adapters before the task executor and persists audit references", async () => {
  const { GoalController } = require("./controller");
  const { createGoalSpec } = require("./spec");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "minitok-risk-controller-")); let order = [];
  const goal = createGoalSpec({ schema_version: 1, goal_id: "risk-controller", objective: "risk", success_criteria: [{ id: "a", description: "a", required: true, verifier: { type: "custom", id: "a", config: {} } }], constraints: { allowed_paths: [], blocked_paths: [], max_cycles: 1, timeout_ms: 0, requires_approval_for: [] }, execution_policy: { mode: "unrestricted" } });
  const auditPath = path.join(root, "audit.jsonl"); let evaluations = 0;
  try {
    const output = await new GoalController(goal, { mode: "unrestricted", capabilities: ["publish"], explicit_confirmation: true, auto_accept: true, config: config(), workspaceRoot: root, auditPath, adapters: { publish: async () => { order.push("adapter"); return { success: true, verification_result: "passed" }; } }, evaluator: async () => { evaluations += 1; const passed = evaluations > 1; return { goal_id: goal.goal_id, completed: passed, criteria: [{ id: "a", status: passed ? "passed" : "failed", evidence_ids: ["e"], reason: passed ? "ok" : "pending" }], evidence: [{ evidence_id: "e", valid: passed, executed: true, execution: { executed: true } }], remaining_criteria: passed ? [] : ["a"], unknown_criteria: [] }; }, taskProposer: async () => ({ next_task: "publish", target_criteria: ["a"], capabilities: ["publish"], risk_operations: [{ operation: "publish", external_target: "https://registry.test/package" }] }), taskExecutor: async () => { order.push("task"); return { success: true, status: "success", tokens: {} }; } }).run();
    assert.equal(output.completed, true);
    assert.deepEqual(order, ["adapter", "task"]);
    assert.ok(output.execution_audits.length >= 2);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("audit persistence failure blocks adapters before they are called", async () => {
  const b = box(); let calls = 0;
  try {
    const parentFile = path.join(b.root, "audit-parent"); fs.writeFileSync(parentFile, "not-a-directory");
    const result = await executeRiskOperations({ risk_operations: [{ operation: "publish" }] }, { mode: "unrestricted", explicit_confirmation: true, auto_accept: true, config: config(), workspaceRoot: b.root, adapters: { publish: async () => { calls += 1; return { success: true }; } }, auditPath: path.join(parentFile, "audit.jsonl") });
    assert.equal(result.success, false);
    assert.equal(calls, 0);
    assert.equal(result.error_code, "AUDIT_PERSISTENCE_REQUIRED");
  } finally { b.clean(); }
});

test("execution audit projection removes secrets, userinfo, query, and dangerous input", () => {
  const record = createExecutionAuditRecord({ goal_id: "g", session_id: "s", task: "password=hunter2 Bearer abc", external_target: "https://user:password@example.test/path?token=secret", requested_capabilities: ["publish"], granted_capabilities: ["publish"], execution_mode: "unrestricted", policy_decision: "allowed", approval_bypassed: true });
  assert.equal(record.external_target.hostname, "example.test");
  assert.equal(record.external_target.pathname, "/path");
  assert.doesNotMatch(JSON.stringify(record), /hunter2|password|secret|Bearer abc/i);
  assert.equal(redactExternalTarget("not-a-url?token=secret"), "not-a-url?[REDACTED]");
  const dangerous = {};
  Object.defineProperty(dangerous, "__proto__", { value: true, enumerable: true });
  assert.throws(() => createExecutionAuditRecord(dangerous), /Dangerous/);
});
