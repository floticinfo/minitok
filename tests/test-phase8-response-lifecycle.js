"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createGoalSession, releaseGoalSessionLock } = require("../src/goal/session");
const { responseProjection } = require("../src/goal/general_response");
const { sessionResponse } = require("../src/cli/commands/goal");
const { resultForSession } = require("../src/mcp/goal-tools");
function box() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "minitok-phase8-response-"));
  const value = createGoalSession({ workspaceRoot: root, goalSpec: { schema_version: 1, goal_id: "phase8-response", objective: "Expose lifecycle", success_criteria: [{ id: "done", description: "verified", required: true, verifier: { type: "custom", id: "done", config: {} } }], constraints: { allowed_paths: [], blocked_paths: [".git"], max_cycles: 2, max_tokens: 0, timeout_ms: 0, stagnation_limit: 2, max_changed_files: 5, same_task_limit: 2, same_failure_limit: 2, requires_approval_for: [] }, execution_policy: { mode: "unrestricted_general" } } });
  value.state.execution_policy = { mode: "unrestricted_general", allowed: true, capabilities: ["goal_inference"], denied_capabilities: [] };
  value.state.interpreted_intent = { normalized_objective: "Expose lifecycle" };
  value.state.goal_hypotheses = [{ statement: "The result is observable" }];
  value.state.assumption_ledger = [{ statement: "Workspace is authorized", password: "password=hidden" }];
  value.state.candidate_criteria = [{ id: "candidate", description: "candidate", provisional: true }]; value.state.provisional_criteria = value.state.candidate_criteria;
  value.state.goal_plan = { plan_version: 2, steps: [{ id: "observe", status: "running", required: true }, { id: "verify", status: "proposed", required: true }, { id: "optional", status: "deferred", required: false }], success_criteria: value.state.candidate_criteria };
  value.state.current_task = "observe"; value.state.completed_steps = []; value.state.replanning_traces = [{ from_plan_version: 1, to_plan_version: 2 }];
  value.state.tool_observations = [{ command: "inspect", raw_adapter_response: { token: "secret" }, output: "password=hidden" }];
  value.state.execution_audits = [{ audit_id: "audit-phase8" }]; value.state.rollback_records = [{ rollback_status: "available" }];
  value.state.blockers = [{ category: "approval", requires_user_decision: true, next_user_action: "Approve the local fallback" }];
  value.state.alternatives = [{ alternative_id: "local-fallback", status: "approval_required" }];
  return { root, value };
}
const FIELDS = ["interpretation", "goal_hypotheses", "assumptions", "candidate_success_criteria", "provisional_success_criteria", "goal_plan", "current_plan", "plan_versions", "current_plan_version", "current_step", "inferred_steps", "optional_steps", "completed_steps", "pending_steps", "replanning_trace", "tool_observations", "blocker", "alternatives", "recommended_action", "required_user_action", "resume_action", "resume_command", "execution_audits", "verification_status", "rollback_status", "confidence", "next_action"];
test("CLI and MCP expose the same verified lifecycle field set", () => {
  const b = box();
  try { const cli = sessionResponse(b.value); const mcp = resultForSession(b.value); for (const field of FIELDS) { assert.ok(Object.hasOwn(cli, field), `CLI ${field}`); assert.ok(Object.hasOwn(mcp, field), `MCP ${field}`); } for (const field of ["current_plan_version", "current_step", "required_user_action", "resume_action", "verification_status", "rollback_status"]) assert.deepEqual(cli[field], mcp[field], field); assert.equal(cli.current_step, "observe"); assert.equal(cli.required_user_action, "Approve the local fallback"); assert.match(cli.resume_action, /Approve/); assert.equal(cli.pending_steps.includes("verify"), true); } finally { releaseGoalSessionLock(b.value); b.value.lock = null; fs.rmSync(b.root, { recursive: true, force: true }); }
});
test("lifecycle projection redacts secrets and removes raw adapter responses", () => {
  const b = box();
  try { const projection = responseProjection(b.value); const text = JSON.stringify(projection); assert.doesNotMatch(text, /password=hidden|secret/i); assert.doesNotMatch(text, /raw_adapter_response|adapter_response|raw_adapter|adapter_result/i); assert.equal(projection.tool_observations[0].command, "inspect"); assert.equal(projection.tool_observations[0].raw_adapter_response, undefined); } finally { releaseGoalSessionLock(b.value); b.value.lock = null; fs.rmSync(b.root, { recursive: true, force: true }); }
});
test("verification-required lifecycle exposes a read-only resume action", () => {
  const b = box();
  try { b.value.state.blockers = []; b.value.state.status = "verification_required"; b.value.state.resume_check = { requires_verification: true, safe_to_resume: false }; const cli = sessionResponse(b.value); const mcp = resultForSession(b.value); assert.equal(cli.verification_status, "verification_required"); assert.equal(mcp.verification_status, "verification_required"); assert.match(cli.resume_action, /read-only verifier/i); assert.match(mcp.resume_action, /read-only verifier/i); assert.equal(cli.resume_command, "minitok goal resume"); assert.equal(mcp.resume_command, "minitok_goal_resume"); } finally { releaseGoalSessionLock(b.value); b.value.lock = null; fs.rmSync(b.root, { recursive: true, force: true }); }
});
