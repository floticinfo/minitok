"use strict";

const path = require("path");
const crypto = require("crypto");
const { compileGoal, compileModelGoal } = require("../../goal/compiler");
const { createGoalSession, loadGoalSession, resumeGoalSession } = require("../../goal/session");
const { runGoal } = require("../../goal/controller");
const { redactValue } = require("../../goal/evidence");
const { resolveExecutionPolicy } = require("../../goal/execution_policy");
const { loadConfig, redactGoalExecutionConfig } = require("../../config/loader");

function repoPath(options = {}) { return path.resolve(options.repo || process.cwd()); }
function capabilityOptions(options = {}) {
  const legacy = typeof options.capabilities === "string" ? options.capabilities.split(",") : Array.isArray(options.capabilities) ? options.capabilities : [];
  const repeated = Array.isArray(options.capability) ? options.capability : options.capability ? [options.capability] : [];
  return [...new Set([...legacy, ...repeated].map(item => String(item).trim()).filter(Boolean))];
}
function effectiveConfirmation(options = {}) { return options.confirmUnrestricted === true || options.explicitConfirmation === true; }
function auditId(policyDecision) { return `audit-${crypto.createHash("sha256").update(JSON.stringify({ mode: policyDecision.mode, capabilities: policyDecision.capabilities, denied: policyDecision.denied_capabilities, decision: policyDecision.allowed ? "allowed" : policyDecision.approval_required ? "approval_required" : "denied" })).digest("hex").slice(0, 16)}`; }
function policyResponse(policyDecision) { return { execution_mode: policyDecision.mode, requested_capabilities: policyDecision.capabilities || [], granted_capabilities: policyDecision.allowed ? policyDecision.capabilities || [] : [], denied_capabilities: policyDecision.denied_capabilities || [], policy_decision: policyDecision.allowed ? "allowed" : policyDecision.approval_required ? "approval_required" : "denied", audit_id: auditId(policyDecision) }; }
function warnUnrestricted(options, policyDecision) { if (!options.json && policyDecision.mode === "unrestricted") console.error("WARNING: unrestricted autonomous execution is enabled only for the explicitly requested and configured capabilities; always-blocked operations remain denied."); }
function output(value, options = {}) { const safe = redactValue(value); if (options.json) console.log(JSON.stringify(safe)); else console.log(JSON.stringify(safe, null, 2)); }
function sessionResponse(session, extra = {}) {
  const state = session.state;
  const blockers = state.blockers || state.blocker_reports || [];
  const alternatives = state.alternatives || state.alternative_history || [];
  const blocker = blockers.at(-1) || null;
  const approvalRequired = Boolean(state.approval_requests?.length || blocker?.requires_user_decision || blocker?.requires_external_access || alternatives.some(item => item.status === "approval_required"));
  const resumeCheck = state.resume_check || { safe_to_resume: true, checkpoint_changed: false, requires_verification: false, reason: null };
  const verificationRequired = resumeCheck.requires_verification === true || state.status === "verification_required";
  const policy = state.execution_policy || extra.policyDecision || null;
  const policyFields = policy ? policyResponse(policy) : { execution_mode: "safe", requested_capabilities: [], granted_capabilities: [], denied_capabilities: [], policy_decision: "unknown", audit_id: "audit-unknown" };
  return { state: state.status, current_state: state.status, goal_id: session.goalSpec.goal_id, objective: state.original_objective || session.goalSpec.objective, blocker, alternatives, recommended_action: blocker?.recommended_alternative || state.selected_alternative || null, execution_policy: policy, execution_audits: state.execution_audits || [], execution_audit_refs: state.execution_audit_refs || [], ...policyFields, approval_required: approvalRequired, verification_required: verificationRequired, resume_check: resumeCheck, resume_action: approvalRequired ? "minitok goal resume --repo <repo> --goal-id <goal_id>" : verificationRequired ? "Run the read-only verifier, then resume the goal" : state.status === "paused" ? "minitok goal resume --repo <repo> --goal-id <goal_id>" : null, resume_command: approvalRequired || verificationRequired ? "minitok goal resume" : null, evidence: state.verification_results || state.evaluator_results || [], final_outcome: state.final_outcome || null, ...extra };
}
function printHuman(value) { console.log(`state: ${value.state}`); console.log(`goal_id: ${value.goal_id}`); if (value.blocker) console.log(`blocker: ${value.blocker.category || "unknown"}`); if (value.approval_required) console.log(`approval_required: true\nresume_action: ${value.resume_action}`); if (value.recommended_action) console.log(`recommended_action: ${value.recommended_action}`); }

async function cmdGoalStart(goal, options = {}) {
  if (!goal) { console.error("Goal objective is required"); return 1; }
  const compiled = options.goalSpec ? compileModelGoal(options.goalSpec, { mode: options.mode }) : compileGoal(goal, { mode: options.mode, goalId: options.goalId });
  const compiledRecord = /** @type {Record<string, any>} */ (compiled);
  if (compiledRecord.status !== "ready") { output({ state: compiledRecord.status, objective: compiledRecord.objective || goal, questions: compiledRecord.questions || [], errors: compiledRecord.errors || [] }, options); return compiledRecord.status === "clarification_required" ? 2 : 1; }
  const goalSpec = compiledRecord.spec;
  const config = loadConfig(path.join(repoPath(options), "minitok.yml"), { repoRoot: repoPath(options) });
  const requestedMode = options.mode || config.goal?.default_mode || "safe";
  const confirmation = effectiveConfirmation(options);
  const autoAccept = options.autoAccept === true || options.auto_accept === true;
  if (requestedMode === "unrestricted" && options.confirmUnrestricted !== true) { output({ state: "policy_denied", ...policyResponse(resolveExecutionPolicy({ mode: "unrestricted", capabilities: capabilityOptions(options), explicit_confirmation: false, auto_accept: autoAccept, source: "cli", actor: options.actor, config })), reason: "--confirm-unrestricted is required for unrestricted mode" }, options); return 1; }
  if (autoAccept && requestedMode !== "unrestricted") { output({ state: "policy_denied", reason: "--auto-accept is only valid with --mode unrestricted" }, options); return 1; }
  const policyDecision = resolveExecutionPolicy({ mode: requestedMode, capabilities: capabilityOptions(options), explicit_confirmation: confirmation, auto_accept: autoAccept, source: "cli", actor: options.actor, config });
  if (!policyDecision.allowed && !policyDecision.approval_required) { output({ state: "policy_denied", ...policyResponse(policyDecision), policy: policyDecision, config: redactGoalExecutionConfig(config) }, options); return 1; }
  warnUnrestricted(options, policyDecision);
  const session = createGoalSession({ workspaceRoot: repoPath(options), goalSpec, model: options.model, provider: options.provider, approvalState: policyDecision.approval_required ? "approval_required" : "not_requested" });
  try { const result = await runGoal(goalSpec, { session, releaseSessionOnExit: true, mode: policyDecision.mode, capabilities: policyDecision.capabilities, explicit_confirmation: confirmation, auto_accept: autoAccept, actor: options.actor, source: "cli", config, policyDecision }); const response = sessionResponse(session, { result, ...policyResponse(policyDecision) }); options.json ? output(response, options) : printHuman(response); return result.completed ? 0 : 1; } finally { session.lock?.release?.(); }
}
function cmdGoalStatus(goalId, options = {}) { if (!goalId) { console.error("goal_id is required"); return 1; } const session = loadGoalSession(repoPath(options), goalId, { lock: false }); const response = sessionResponse(session); options.json ? output(response, options) : printHuman(response); return 0; }
async function cmdGoalResume(goalId, options = {}) { return cmdGoalContinue(goalId, options); }
async function cmdGoalContinue(goalId, options = {}) {
  if (!goalId) { console.error("goal_id is required"); return 1; }
  const config = loadConfig(path.join(repoPath(options), "minitok.yml"), { repoRoot: repoPath(options) });
  const stored = loadGoalSession(repoPath(options), goalId, { lock: false });
  const storedMode = stored.state.execution_policy?.mode || stored.goalSpec.execution_policy?.mode || "safe";
  const requestedMode = options.mode || "safe";
  const confirmation = effectiveConfirmation(options);
  if (storedMode === "unrestricted" && options.mode !== "unrestricted") { output({ state: "policy_denied", reason: "A previously unrestricted goal requires an explicit --mode unrestricted and --confirm-unrestricted request to continue or resume." }, options); return 1; }
  const autoAccept = options.autoAccept === true || options.auto_accept === true;
  if (requestedMode === "unrestricted" && options.confirmUnrestricted !== true) { output({ state: "policy_denied", reason: "--confirm-unrestricted is required when continuing or resuming unrestricted mode" }, options); return 1; }
  if (autoAccept && requestedMode !== "unrestricted") { output({ state: "policy_denied", reason: "--auto-accept is only valid with --mode unrestricted" }, options); return 1; }
  const policyDecision = resolveExecutionPolicy({ mode: requestedMode, capabilities: capabilityOptions(options), explicit_confirmation: confirmation, auto_accept: autoAccept, source: "cli", actor: options.actor, config });
  if (!policyDecision.allowed && !policyDecision.approval_required) { output({ state: "policy_denied", ...policyResponse(policyDecision), policy: policyDecision, config: redactGoalExecutionConfig(config) }, options); return 1; }
  warnUnrestricted(options, policyDecision);
  const session = resumeGoalSession(repoPath(options), goalId, { model: options.model, provider: options.provider, migrate: true });
  try { const result = await runGoal(session.goalSpec, { session, releaseSessionOnExit: true, mode: policyDecision.mode, capabilities: policyDecision.capabilities, explicit_confirmation: confirmation, auto_accept: autoAccept, actor: options.actor, source: "cli", config, policyDecision }); const response = sessionResponse(session, { result, ...policyResponse(policyDecision) }); options.json ? output(response, options) : printHuman(response); return result.completed ? 0 : 1; } finally { session.lock?.release?.(); }
}
function register(program) {
  const goal = program.command("goal").description("Manage persistent goal sessions");
  const policyOptions = command => command.option("--mode <mode>").option("--capabilities <capabilities>", "comma-separated capabilities (legacy-compatible)").option("--capability <name>", "request one capability (repeatable)", (value, previous = []) => [...previous, value], []).option("--confirm-unrestricted", "explicitly confirm unrestricted autonomous execution").option("--explicit-confirmation", "legacy explicit confirmation alias").option("--auto-accept", "auto-accept only for explicitly enabled unrestricted mode").option("--json");
  policyOptions(goal.command("start").argument("<objective>").option("--repo <path>").option("--goal-id <id>")).action((objective, options) => cmdGoalStart(objective, options).then(code => { process.exitCode = code; }));
  goal.command("status").requiredOption("--goal-id <id>").option("--repo <path>").option("--json").action((options) => { process.exitCode = cmdGoalStatus(options.goalId, options); });
  policyOptions(goal.command("continue").requiredOption("--goal-id <id>").option("--repo <path>")).action((options) => cmdGoalContinue(options.goalId, options).then(code => { process.exitCode = code; }));
  policyOptions(goal.command("resume").requiredOption("--goal-id <id>").option("--repo <path>")).action((options) => cmdGoalResume(options.goalId, options).then(code => { process.exitCode = code; }));
}
module.exports = { register, cmdGoalStart, cmdGoalStatus, cmdGoalContinue, cmdGoalResume, sessionResponse, capabilityOptions, policyResponse, auditId };
