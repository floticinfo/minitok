"use strict";

const path = require("path");
const { compileGoal, compileModelGoal } = require("../../goal/compiler");
const { createGoalSession, loadGoalSession, resumeGoalSession } = require("../../goal/session");
const { runGoal } = require("../../goal/controller");
const { redactValue } = require("../../goal/evidence");

function repoPath(options = {}) { return path.resolve(options.repo || process.cwd()); }
function output(value, options = {}) { const safe = redactValue(value); if (options.json) console.log(JSON.stringify(safe)); else console.log(JSON.stringify(safe, null, 2)); }
function sessionResponse(session, extra = {}) {
  const state = session.state;
  const blockers = state.blockers || state.blocker_reports || [];
  const alternatives = state.alternatives || state.alternative_history || [];
  const blocker = blockers.at(-1) || null;
  const approvalRequired = Boolean(state.approval_requests?.length || blocker?.requires_user_decision || blocker?.requires_external_access || alternatives.some(item => item.status === "approval_required"));
  const resumeCheck = state.resume_check || { safe_to_resume: true, checkpoint_changed: false, requires_verification: false, reason: null };
  const verificationRequired = resumeCheck.requires_verification === true || state.status === "verification_required";
  return { state: state.status, current_state: state.status, goal_id: session.goalSpec.goal_id, objective: state.original_objective || session.goalSpec.objective, blocker, alternatives, recommended_action: blocker?.recommended_alternative || state.selected_alternative || null, approval_required: approvalRequired, verification_required: verificationRequired, resume_check: resumeCheck, resume_action: approvalRequired ? "minitok goal resume --repo <repo> --goal-id <goal_id>" : verificationRequired ? "Run the read-only verifier, then resume the goal" : state.status === "paused" ? "minitok goal resume --repo <repo> --goal-id <goal_id>" : null, resume_command: approvalRequired || verificationRequired ? "minitok goal resume" : null, evidence: state.verification_results || state.evaluator_results || [], final_outcome: state.final_outcome || null, ...extra };
}
function printHuman(value) { console.log(`state: ${value.state}`); console.log(`goal_id: ${value.goal_id}`); if (value.blocker) console.log(`blocker: ${value.blocker.category || "unknown"}`); if (value.approval_required) console.log(`approval_required: true\nresume_action: ${value.resume_action}`); if (value.recommended_action) console.log(`recommended_action: ${value.recommended_action}`); }

async function cmdGoalStart(goal, options = {}) {
  if (!goal) { console.error("Goal objective is required"); return 1; }
  const compiled = options.goalSpec ? compileModelGoal(options.goalSpec, { mode: options.mode }) : compileGoal(goal, { mode: options.mode, goalId: options.goalId });
  const compiledRecord = /** @type {Record<string, any>} */ (compiled);
  if (compiledRecord.status !== "ready") { output({ state: compiledRecord.status, objective: compiledRecord.objective || goal, questions: compiledRecord.questions || [], errors: compiledRecord.errors || [] }, options); return compiledRecord.status === "clarification_required" ? 2 : 1; }
  const goalSpec = compiledRecord.spec;
  const session = createGoalSession({ workspaceRoot: repoPath(options), goalSpec, model: options.model, provider: options.provider, approvalState: options.mode === "safe" ? "approval_required" : "not_requested" });
  try { const result = await runGoal(goalSpec, { session, releaseSessionOnExit: true, mode: options.mode || "safe" }); const response = sessionResponse(session, { result }); options.json ? output(response, options) : printHuman(response); return result.completed ? 0 : 1; } finally { session.lock?.release?.(); }
}
function cmdGoalStatus(goalId, options = {}) { if (!goalId) { console.error("goal_id is required"); return 1; } const session = loadGoalSession(repoPath(options), goalId, { lock: false }); const response = sessionResponse(session); options.json ? output(response, options) : printHuman(response); return 0; }
async function cmdGoalResume(goalId, options = {}) { return cmdGoalContinue(goalId, options); }
async function cmdGoalContinue(goalId, options = {}) { if (!goalId) { console.error("goal_id is required"); return 1; } const session = resumeGoalSession(repoPath(options), goalId, { model: options.model, provider: options.provider, migrate: true }); try { const result = await runGoal(session.goalSpec, { session, releaseSessionOnExit: true, mode: options.mode || "supervised" }); const response = sessionResponse(session, { result }); options.json ? output(response, options) : printHuman(response); return result.completed ? 0 : 1; } finally { session.lock?.release?.(); } }
function register(program) {
  const goal = program.command("goal").description("Manage persistent goal sessions");
  goal.command("start").argument("<objective>").option("--repo <path>").option("--goal-id <id>").option("--mode <mode>").option("--json").action((objective, options) => cmdGoalStart(objective, options).then(code => { process.exitCode = code; }));
  goal.command("status").requiredOption("--goal-id <id>").option("--repo <path>").option("--json").action((options) => { process.exitCode = cmdGoalStatus(options.goalId, options); });
  goal.command("continue").requiredOption("--goal-id <id>").option("--repo <path>").option("--mode <mode>").option("--json").action((options) => cmdGoalContinue(options.goalId, options).then(code => { process.exitCode = code; }));
  goal.command("resume").requiredOption("--goal-id <id>").option("--repo <path>").option("--mode <mode>").option("--json").action((options) => cmdGoalResume(options.goalId, options).then(code => { process.exitCode = code; }));
}
module.exports = { register, cmdGoalStart, cmdGoalStatus, cmdGoalContinue, cmdGoalResume, sessionResponse };
