"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createGoalSpec } = require("../src/goal/spec");
const { createGoalSession, loadGoalSession } = require("../src/goal/session");
const { GoalController } = require("../src/goal/controller");
const { createBlockerReport, selectAlternative } = require("../src/goal/blocker");

function criterion(id = "a") { return { id, description: id, required: true, verifier: { type: "custom", id: `v-${id}`, config: {} } }; }
function goal(overrides = {}) { return createGoalSpec({ schema_version: 1, goal_id: `phase5-${Math.random().toString(36).slice(2, 8)}`, objective: "Phase 5 policy goal", success_criteria: [criterion()], constraints: { allowed_paths: ["src"], blocked_paths: [".git"], max_cycles: 4, max_tokens: 0, timeout_ms: 0, stagnation_limit: 3, max_changed_files: 10, same_task_limit: 3, same_failure_limit: 3, requires_approval_for: [], ...overrides }, execution_policy: { mode: "safe" } }); }
function evaluation(goalSpec, status = "failed") { return { goal_id: goalSpec.goal_id, completed: status === "passed", criteria: [{ id: "a", status, evidence_ids: [`e-${status}`], reason: status }], evidence: [{ evidence_id: `e-${status}`, valid: status === "passed", executed: true, execution: { executed: true } }], remaining_criteria: status === "passed" ? [] : ["a"], unknown_criteria: [] }; }
const unrestrictedConfig = { goal: { unrestricted: { enabled: true, capabilities: ["workspace_write", "publish", "external_call", "verify"], require_explicit_confirmation: true, require_auto_accept: true } } };
function unrestrictedOptions(config, executor, proposer, evaluator) { return { mode: "unrestricted", capabilities: ["workspace_write", "publish", "external_call"], explicit_confirmation: true, auto_accept: true, config, evaluator, taskExecutor: executor, taskProposer: proposer, actor: { credential_present: true } }; }

test("safe mode denies a workspace capability before calling the task executor", async () => {
  const g = goal(); let calls = 0;
  const output = await new GoalController(g, { mode: "safe", evaluator: async () => evaluation(g), taskProposer: async () => ({ next_task: "edit src/a.js", target_criteria: ["a"], capabilities: ["workspace_write"], paths: ["src/a.js"] }), taskExecutor: async () => { calls += 1; return { success: true, status: "success" }; } }).run();
  assert.equal(calls, 0); assert.equal(output.state, "blocked"); assert.equal(output.action_history.some(item => item.policy_decision === "denied" && item.execution_mode === "safe"), true);
});

test("supervised and authorized_external preserve approval boundaries", async () => {
  for (const options of [{ mode: "supervised", capabilities: ["workspace_write"] }, { mode: "authorized_external", capabilities: ["publish"] }]) {
    const g = goal(); let calls = 0;
    const output = await new GoalController(g, { ...options, evaluator: async () => evaluation(g), taskProposer: async () => ({ next_task: "side effect", target_criteria: ["a"], capabilities: options.capabilities }), taskExecutor: async () => { calls += 1; return { success: true, status: "success" }; } }).run();
    assert.equal(calls, 0); assert.equal(output.action_history.some(item => item.policy_decision === "approval_required"), true);
  }
});

test("unrestricted executes an allowlisted capability without approval", async () => {
  const g = goal(); let calls = 0; let index = 0;
  const output = await new GoalController(g, unrestrictedOptions(unrestrictedConfig, async () => { calls += 1; return { success: true, status: "success", tokens: {} }; }, async () => ({ next_task: "edit src/a.js", target_criteria: ["a"], capabilities: ["workspace_write"], paths: ["src/a.js"] }), async () => evaluation(g, index++ === 0 ? "failed" : "passed"))).run();
  assert.equal(calls, 1); assert.equal(output.completed, true);
  const decision = output.action_history.find(item => item.action === "execution_policy_decision"); assert.equal(decision.policy_decision, "allowed"); assert.equal(decision.execution_mode, "unrestricted"); assert.equal(decision.auto_approved, true);
});

test("unrestricted denies capabilities outside the allowlist and always-blocked actions", async () => {
  for (const capabilities of [["deploy"], ["protected_path_write"]]) {
    const g = goal(); let calls = 0;
    const output = await new GoalController(g, { mode: "unrestricted", capabilities, explicit_confirmation: true, auto_accept: true, config: unrestrictedConfig, evaluator: async () => evaluation(g), taskProposer: async () => ({ next_task: "unsafe action", target_criteria: ["a"], capabilities }), taskExecutor: async () => { calls += 1; return { success: true, status: "success" }; } }).run();
    assert.equal(calls, 0); assert.equal(output.state, "blocked");
  }
});

test("unrestricted automatically selects an allowed blocker alternative and records policy evidence", async () => {
  const g = goal(); let index = 0; let calls = 0;
  const output = await new GoalController(g, unrestrictedOptions(unrestrictedConfig, async () => { calls += 1; return calls === 1 ? { success: false, status: "failure", error: "connection reset", stage: "verify", tokens: {} } : { success: true, status: "success", tokens: {} }; }, async () => ({ next_task: "verify remote state", target_criteria: ["a"], capabilities: ["external_call"] }), async () => evaluation(g, index++ === 0 ? "failed" : "passed"))).run();
  assert.equal(output.completed, true);
  const alternative = output.alternative_history.find(item => item.alternative_id === "retry-backoff");
  assert.ok(alternative); assert.equal(alternative.status, "selected"); assert.equal(alternative.auto_approved, true); assert.ok(Array.isArray(alternative.requested_capabilities)); assert.equal(alternative.policy_decision, "allowed"); assert.equal(alternative.execution_mode, "unrestricted"); assert.equal(alternative.verification_result, "passed");
});

test("unrestricted selection rejects always-blocked alternatives and supports exhaustion", () => {
  const blocked = createBlockerReport({ alternatives: [{ alternative_id: "blocked", description: "Force push", rationale: "unsafe", expected_benefit: "blocked action", risk_level: "critical", side_effects: ["external_call"], execution_policy: "always_blocked", required_permissions: [], estimated_cost: "unknown", reversible: false, verification_plan: {}, applicable: true }] });
  const denied = selectAlternative(blocked, { execution_policy: "unrestricted", explicit_confirmation: true, auto_accept: true, config: unrestrictedConfig });
  assert.equal(denied.status, "escalate");
  const report = createBlockerReport({ category: "verification_failure", stage: "verify", cause: "test failed", affected_step: "tests" });
  const exhausted = selectAlternative(report, { execution_policy: "safe", used_alternative_ids: report.alternatives.map(item => item.alternative_id) });
  assert.equal(exhausted.status, "escalate"); assert.equal(exhausted.alternative, null);
});

test("automatic inferred network step recovers through retry-backoff and persists blocker evidence", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "minitok-phase5-network-"));
  const g = goal({ max_cycles: 5, same_failure_limit: 3 });
  const session = createGoalSession({ workspaceRoot: root, goalSpec: g });
  let calls = 0;
  let index = 0;
  const expansion = { goal_plan: { objective: g.objective, inferred_steps: [{ id: "network-check", description: "Verify the remote dependency", required: true, target_criteria: ["a"], rationale: "The inferred verification step is required by the goal.", verification: { type: "custom", id: "remote-check", config: {} }, status: "proposed" }] }, inferred_steps: [{ id: "network-check", description: "Verify the remote dependency", required: true, target_criteria: ["a"], rationale: "The inferred verification step is required by the goal.", verification: { type: "custom", id: "remote-check", config: {} }, status: "proposed" }], optional_steps: [], assumptions: ["local scope"], expansion_confidence: 0.9 };
  try {
    const output = await new GoalController(g, { session, goalExpansion: expansion, mode: "unrestricted", capabilities: ["external_call"], explicit_confirmation: true, auto_accept: true, actor: { credential_present: true }, config: unrestrictedConfig, evaluator: async () => evaluation(g, index++ === 0 ? "failed" : "passed"), taskProposer: async () => ({ next_task: "Verify the remote dependency", target_criteria: ["a"], capabilities: ["external_call"], side_effects: ["external_call"], verification: { type: "custom", id: "remote-check", config: {} } }), taskExecutor: async task => { calls += 1; return calls === 1 ? { success: false, status: "failure", error: "connection reset", stage: "verify", tokens: {} } : { success: true, status: "success", tokens: {} }; }, releaseSessionOnExit: true }).run();
    assert.equal(output.completed, true);
    assert.ok(output.blocker_reports.some(item => item.category === "network_failure"));
    assert.ok(output.alternative_history.some(item => item.alternative_id === "retry-backoff" && item.status === "selected"));
    assert.ok(output.recovery_history.some(item => item.recovery_action === "alternative_strategy"));
    const loaded = loadGoalSession(root, g.goal_id, { lock: false });
    assert.ok(loaded.state.evidence_refs.length >= 0);
    assert.ok(loaded.state.blocker_reports.length > 0);
    assert.ok(loaded.state.alternative_history.length > 0);
  } finally { session.lock?.release?.(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("automatic inferred verification failure uses alternate strategy and rejects repeated patch", async () => {
  const g = goal({ max_cycles: 5, same_failure_limit: 3 });
  let calls = 0;
  let index = 0;
  const output = await new GoalController(g, { goalExpansion: { inferred_steps: [{ id: "test-step", description: "Run the inferred verification test", required: true, target_criteria: ["a"], rationale: "The inferred test is required to verify the goal.", verification: { type: "custom", id: "test-check", config: {} }, status: "proposed" }] }, mode: "unrestricted", capabilities: ["workspace_write"], explicit_confirmation: true, auto_accept: true, config: unrestrictedConfig, evaluator: async () => evaluation(g, index++ > 0 ? "passed" : "failed"), taskProposer: async () => ({ next_task: "Run the inferred verification test", target_criteria: ["a"], capabilities: ["workspace_write"], paths: ["src/a.js"], verification: { type: "custom", id: "test-check", config: {} } }), taskExecutor: async () => { calls += 1; return { success: calls > 1, status: calls > 1 ? "success" : "failure", error: calls > 1 ? undefined : "test failed", changes: { changes: [{ file: "src/a.js", action: "modify", content: "patch" }] }, tokens: {} }; } }).run();
  assert.equal(output.completed, true);
  assert.ok(output.blocker_reports.some(item => item.category === "verification_failure"));
  assert.ok(output.alternative_history.some(item => ["alternate-strategy", "dry-run"].includes(item.alternative_id)));
  assert.ok(output.recovery_history.length > 0);
});

test("recovery keeps the original scope and repeated patch guard", async () => {
  const g = goal({ blocked_paths: [".git", "src/protected"], repository_odd: { allowed_paths: ["src"], protected_paths: ["VERIFY_CMD.mjs"], required_checks: [], allow_external: false } }); let calls = 0; let index = 0;
  const output = await new GoalController(g, { mode: "unrestricted", capabilities: ["workspace_write"], explicit_confirmation: true, auto_accept: true, config: { goal: { unrestricted: { enabled: true, capabilities: ["workspace_write"], require_explicit_confirmation: true, require_auto_accept: true } } }, evaluator: async () => evaluation(g, index++ > 1 ? "passed" : "failed"), taskProposer: async () => ({ next_task: "edit src/a.js", target_criteria: ["a"], capabilities: ["workspace_write"], paths: ["src/a.js"] }), taskExecutor: async () => { calls += 1; return { success: calls > 1, status: calls > 1 ? "success" : "failure", error: calls > 1 ? undefined : "verification failed", changes: { changes: [{ file: "src/a.js", action: "modify", content: String(calls) }] }, tokens: {} }; } }).run();
  assert.equal(output.completed, true); assert.ok(output.recovery_history.length > 0); assert.equal(output.recovery_history[0].recovery_status, "completed"); assert.notEqual(output.recovery_history[0].previous_patch_signature, output.recovery_history[0].recovery_patch_signature); assert.doesNotMatch(JSON.stringify(output), /password=|token=|authorization:/i);
});
