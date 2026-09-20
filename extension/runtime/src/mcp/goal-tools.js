"use strict";

const path = require("path");
const { compileGoal, compileModelGoal } = require("../goal/compiler");
const { runGoal } = require("../goal/controller");
const { runTask } = require("../goal/task_executor");
const { createGoalSession, loadGoalSession, saveGoalSession, pauseGoalSession, resumeGoalSession, markGoalFailed } = require("../goal/session");

const ACTIVE_GOALS = new Map();
const GOAL_MODES = new Set(["safe", "supervised", "workspace", "autonomous"]);
function requireGoalRepo(value, workspaceRoot) {
  if (typeof value !== "string" || !path.isAbsolute(value)) throw Object.assign(new Error("goal repo must be an absolute path"), { code: "INVALID_PATH" });
  const resolved = path.resolve(value); const root = path.resolve(workspaceRoot || process.cwd()); const relative = path.relative(root, resolved);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw Object.assign(new Error("goal repo is outside the MCP workspace"), { code: "PATH_OUTSIDE_WORKSPACE" });
  return resolved;
}
function resultForSession(session, extra = {}) {
  const state = session.state; const evaluation = state.evaluator_results?.at(-1) || null;
  const blockers = state.blockers || state.blocker_reports || [];
  const blocker = blockers.at(-1) || null;
  const alternatives = blocker?.alternatives || state.alternatives || state.alternative_history || [];
  const alternativeHistory = state.resolution_attempts || state.alternative_history || state.alternatives || [];
  const approvalRequired = alternativeHistory.some(item => ["approval_required", "escalated"].includes(item.status)) || Boolean(blocker?.requires_user_decision || blocker?.requires_external_access);
  const resumeCheck = state.resume_check || { safe_to_resume: true, checkpoint_changed: false, requires_verification: false, reason: null };
  const verificationRequired = resumeCheck.requires_verification === true || state.status === "verification_required";
  const resumeAction = approvalRequired ? "Call minitok_goal_resume after explicit approval and required operator checks" : verificationRequired ? "Run the read-only verifier, then call minitok_goal_resume" : state.status === "paused" ? "Call minitok_goal_resume" : state.status === "running" ? "Call minitok_goal_status to observe progress" : null;
  return { goal_id: session.goalSpec.goal_id, state: state.status, current_state: state.status, goal: session.goalSpec, criteria: evaluation?.criteria || [], current_task: state.current_task || null, next_action: resumeAction, blocker, alternatives, recommended_action: blocker?.recommended_alternative || alternativeHistory.at(-1)?.alternative_id || null, approval_required: approvalRequired, verification_required: verificationRequired, resume_check: resumeCheck, resume_command: approvalRequired || verificationRequired ? "minitok_goal_resume" : null, resume_action: resumeAction, evidence: evaluation?.evidence || [], ...extra };
}
function launch(session, options = {}) {
  const goalId = session.goalSpec.goal_id; const controller = new AbortController(); const record = { controller, paused: false, promise: null, session }; ACTIVE_GOALS.set(goalId, record);
  const taskExecutor = options.taskExecutor || ((task, taskOptions) => runTask(task, { ...taskOptions, repoRoot: session.workspaceRoot, signal: controller.signal, providerOverride: options.providerOverride, autoAccept: options.mode === "autonomous" }));
  record.promise = runGoal(session.goalSpec, { ...options, session, signal: controller.signal, taskExecutor, recoveryEnabled: options.recoveryEnabled !== false });
  record.promise.then(result => { if (record.paused) session.state.status = "paused"; else if (result.state === "completed") session.state.status = "completed"; else if (result.state === "escalate") session.state.status = "escalated"; else if (result.completed !== true && !["paused", "running"].includes(session.state.status)) session.state.status = "failed"; saveGoalSession(session); }).catch(error => { if (!record.paused) markGoalFailed(session, { error: error.message }); }).finally(() => { ACTIVE_GOALS.delete(goalId); session.lock?.release?.(); });
  return record;
}
function compileInput(args) { return args.goal_spec && typeof args.goal_spec === "object" ? compileModelGoal(args.goal_spec, { mode: args.mode }) : compileGoal(args.goal, { mode: args.mode, goalId: args.goal_id }); }


async function startGoal(args, runtimeOptions = {}) {
  const mode = args.mode || "safe";
  if (!GOAL_MODES.has(mode)) throw Object.assign(new Error("Invalid goal mode"), { code: "INVALID_PARAMS" });
  if (mode === "autonomous" && !runtimeOptions.permissions?.has?.("auto_accept")) throw Object.assign(new Error("autonomous goal mode requires explicit auto_accept permission"), { code: "AUTO_ACCEPT_DENIED" });
  const repoRoot = requireGoalRepo(args.repo || runtimeOptions.workspaceRoot, runtimeOptions.workspaceRoot); const compiled = compileInput(args); const compiledRecord = /** @type {Record<string, any>} */ (compiled);
  if (compiled.status === "clarification_required") return { state: "clarification_required", current_state: "clarification_required", goal: { objective: compiledRecord.objective || args.goal || "" }, criteria: [], current_task: null, next_action: "Provide clarification", blocker: null, alternatives: [], recommended_action: "Provide clarification", approval_required: false, resume_command: null, resume_action: "Provide clarification before starting the goal", evidence: [], questions: compiledRecord.questions || [], question_details: compiledRecord.question_details || [] };
  if (compiled.status !== "ready") throw Object.assign(new Error(`Goal specification is ${compiled.status}`), { code: compiled.status === "unsupported" ? "GOAL_UNSUPPORTED" : "GOAL_INVALID", details: compiledRecord.errors || [{ path: "$", code: "UNSUPPORTED_GOAL", message: compiledRecord.reason || `Goal specification is ${compiled.status}` }] });
  const session = createGoalSession({ workspaceRoot: repoRoot, goalSpec: compiledRecord.spec, model: runtimeOptions.model, provider: args.provider_override, approvalState: mode === "safe" ? "approval_required" : "not_requested" });
  launch(session, { ...runtimeOptions, mode, providerOverride: args.provider_override });
  return resultForSession(session, { state: "running", next_action: "Call minitok_goal_status to observe progress" });
}
function readGoal(args, runtimeOptions = {}) { const repoRoot = requireGoalRepo(args.repo, runtimeOptions.workspaceRoot); return resultForSession(loadGoalSession(repoRoot, args.goal_id, { lock: false })); }
async function continueGoal(args, runtimeOptions = {}) {
  const repoRoot = requireGoalRepo(args.repo, runtimeOptions.workspaceRoot);
  if (ACTIVE_GOALS.has(args.goal_id)) throw Object.assign(new Error("Goal session is already running"), { code: "GOAL_SESSION_BUSY" });
  const session = resumeGoalSession(repoRoot, args.goal_id, { model: runtimeOptions.model, provider: args.provider_override, migrate: true });
  launch(session, { ...runtimeOptions, mode: args.mode || "supervised", providerOverride: args.provider_override }); return resultForSession(session, { state: "running" });
}
function pauseGoal(args, runtimeOptions = {}) { const repoRoot = requireGoalRepo(args.repo, runtimeOptions.workspaceRoot); const active = ACTIVE_GOALS.get(args.goal_id); const session = active?.session || loadGoalSession(repoRoot, args.goal_id); if (active) { active.paused = true; active.controller.abort(); ACTIVE_GOALS.delete(args.goal_id); } pauseGoalSession(session, args.reason || "paused by MCP client"); session.lock?.release?.(); return resultForSession(session, { state: "paused" }); }
function cancelGoal(args, runtimeOptions = {}) { const repoRoot = requireGoalRepo(args.repo, runtimeOptions.workspaceRoot); const active = ACTIVE_GOALS.get(args.goal_id); const session = active?.session || loadGoalSession(repoRoot, args.goal_id); if (active) { active.paused = true; active.controller.abort(); ACTIVE_GOALS.delete(args.goal_id); } markGoalFailed(session, { cancelled: true, reason: args.reason || "cancelled by MCP client" }); session.lock?.release?.(); return resultForSession(session, { state: "failed" }); }
function isActive(goalId) { return ACTIVE_GOALS.has(goalId); }
module.exports = { GOAL_MODES, ACTIVE_GOALS, startGoal, readGoal, continueGoal, pauseGoal, cancelGoal, resultForSession, isActive, requireGoalRepo };
