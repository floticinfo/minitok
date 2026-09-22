"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createGoalSession, releaseGoalSessionLock } = require("../src/goal/session");
const { responseProjection } = require("../src/goal/general_response");
const { sessionResponse } = require("../src/cli/commands/goal");
const { resultForSession } = require("../src/mcp/goal-tools");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function session() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "minitok-general-response-"));
  const value = createGoalSession({ workspaceRoot: root, goalSpec: { schema_version: 1, goal_id: "general-response", objective: "Improve the service", success_criteria: [{ id: "outcome", description: "An observable outcome is verified", required: true, verifier: { type: "custom", id: "verify", config: {} } }], constraints: { allowed_paths: [], blocked_paths: [".git"], max_cycles: 2, max_tokens: 0, timeout_ms: 0, stagnation_limit: 2, max_changed_files: 5, same_task_limit: 2, same_failure_limit: 2, requires_approval_for: [] }, execution_policy: { mode: "unrestricted_general" } } });
  value.state.execution_policy = { mode: "unrestricted_general", allowed: true, capabilities: ["goal_inference"], denied_capabilities: [] };
  value.state.interpreted_intent = { normalized_objective: "Improve the service", interpretation_status: "partially_interpreted" };
  value.state.goal_hypotheses = [{ statement: "The outcome is observable" }];
  value.state.assumption_ledger = [{ statement: "The workspace is authorized", secret: "password=hidden" }];
  value.state.candidate_criteria = [{ id: "candidate", description: "Candidate outcome", provisional: true }];
  value.state.provisional_criteria = value.state.candidate_criteria;
  value.state.goal_plan = { plan_version: 2, inferred_steps: [{ id: "observe", required: true, status: "proposed" }, { id: "optional", required: false, status: "deferred" }], success_criteria: value.state.candidate_criteria };
  value.state.inferred_steps = value.state.goal_plan.inferred_steps;
  value.state.optional_steps = [{ id: "optional", required: false, status: "deferred" }];
  value.state.replanning_traces = [{ reason: "blocker", from_plan_version: 1, to_plan_version: 2 }];
  value.state.tool_observations = [{ command: "git status", output: "password=hidden" }];
  value.state.execution_audits = [{ audit_id: "audit-general-response" }];
  return { value, root };
}

test("general response projection exposes additive evidence fields and redacts secrets", () => {
  const box = session();
  try {
    const projection = responseProjection(box.value);
    for (const field of ["interpretation", "candidate_interpretations", "supported_domain", "support_status", "support_reasons", "execution_boundary", "goal_hypotheses", "assumptions", "candidate_success_criteria", "provisional_success_criteria", "goal_plan", "plan_versions", "current_plan_version", "inferred_steps", "optional_steps", "completed_steps", "pending_steps", "replanning_trace", "tool_observations", "blocker", "alternatives", "recommended_action", "policy_decision", "execution_mode", "execution_audits", "verification_status", "rollback_status", "confidence", "next_action"]) assert.ok(Object.prototype.hasOwnProperty.call(projection, field), field);
    assert.equal(projection.current_plan_version, 2);
    assert.deepEqual(projection.pending_steps, ["observe"]);
    assert.doesNotMatch(JSON.stringify(projection), /password=hidden/i);
  } finally { releaseGoalSessionLock(box.value); fs.rmSync(box.root, { recursive: true, force: true }); }
});

test("CLI and MCP session response projections expose the same general field set", () => {
  const box = session();
  try {
    const cli = sessionResponse(box.value);
    const mcp = resultForSession(box.value);
    const fields = ["interpretation", "candidate_interpretations", "supported_domain", "support_status", "support_reasons", "execution_boundary", "goal_hypotheses", "assumptions", "candidate_success_criteria", "provisional_success_criteria", "goal_plan", "plan_versions", "current_plan_version", "inferred_steps", "optional_steps", "completed_steps", "pending_steps", "replanning_trace", "tool_observations", "blocker", "alternatives", "recommended_action", "policy_decision", "execution_mode", "execution_audits", "verification_status", "rollback_status", "confidence", "next_action"];
    for (const field of fields) { assert.ok(Object.prototype.hasOwnProperty.call(cli, field), `CLI ${field}`); assert.ok(Object.prototype.hasOwnProperty.call(mcp, field), `MCP ${field}`); }
    assert.equal(cli.execution_mode, mcp.execution_mode);
    assert.equal(cli.current_plan_version, mcp.current_plan_version);
  } finally { releaseGoalSessionLock(box.value); fs.rmSync(box.root, { recursive: true, force: true }); }
});
