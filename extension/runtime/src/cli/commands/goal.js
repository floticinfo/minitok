"use strict";

const path = require("path");
const crypto = require("crypto");
const { compileGoal, compileModelGoal, goalIdFor } = require("../../goal/compiler");
const { createGoalSpec } = require("../../goal/spec");
const { createGoalSession, loadGoalSession, resumeGoalSession, saveGoalSession } = require("../../goal/session");
const { runTask } = require("../../goal/task_executor");
const { executeGoal } = require("../../goal/general_execution");
const { redactValue } = require("../../goal/evidence");
const { resolveExecutionPolicy } = require("../../goal/execution_policy");
const { loadConfig, redactGoalExecutionConfig } = require("../../config/loader");
const { prepareGoalExecution } = require("../../goal/integration");
const { recordGeneralPolicyPreflight } = require("../../goal/execution_audit");
const { responseProjection, normalizeExecutionMode } = require("../../goal/general_response");

function repoPath(options = {}) { return path.resolve(options.repo || process.cwd()); }
function capabilityOptions(options = {}) {
  const legacy = typeof options.capabilities === "string" ? options.capabilities.split(",") : Array.isArray(options.capabilities) ? options.capabilities : [];
  const repeated = Array.isArray(options.capability) ? options.capability : options.capability ? [options.capability] : [];
  return [...new Set([...legacy, ...repeated].map(item => String(item).trim()).filter(Boolean))];
}
function effectiveConfirmation(options = {}) { return options.confirmUnrestricted === true || options.confirmUnrestrictedGeneral === true || options.explicitConfirmation === true; }
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
  return { ...responseProjection(session, extra), state: state.status, current_state: state.status, goal_id: session.goalSpec.goal_id, objective: state.original_objective || session.goalSpec.objective, blocker, alternatives, recommended_action: blocker?.recommended_alternative || state.selected_alternative || null, execution_policy: policy, execution_audits: state.execution_audits || [], execution_audit_refs: state.execution_audit_refs || [], ...policyFields, goal_plan: state.goal_plan || extra.goal_plan || null, inferred_steps: state.inferred_steps || extra.inferred_steps || [], optional_steps: state.optional_steps || extra.optional_steps || [], missing_information: state.missing_information || extra.missing_information || [], out_of_scope_candidates: state.out_of_scope_candidates || extra.out_of_scope_candidates || [], expansion_confidence: state.expansion_confidence ?? extra.expansion_confidence ?? null, requires_user_confirmation: extra.requires_user_confirmation ?? state.requires_user_confirmation ?? false, questions: extra.questions || state.questions || [], approval_required: approvalRequired, verification_required: verificationRequired, resume_check: resumeCheck, resume_action: approvalRequired ? "minitok goal resume --repo <repo> --goal-id <goal_id>" : verificationRequired ? "Run the read-only verifier, then resume the goal" : state.status === "paused" ? "minitok goal resume --repo <repo> --goal-id <goal_id>" : null, resume_command: approvalRequired || verificationRequired ? "minitok goal resume" : null, evidence: state.verification_results || state.evaluator_results || [], evidence_complete: state.terminal_resolution?.blocker?.evidence_complete ?? false, terminal_resolution: state.terminal_resolution || null, attempted_alternatives: state.terminal_resolution?.attempted_alternatives || [], why_not_selected: state.terminal_resolution?.why_not_selected || [], required_external_action: state.terminal_resolution?.required_external_action || null, resume_conditions: state.terminal_resolution?.resume_conditions || null, next_user_action: state.terminal_resolution?.next_user_action || null, final_outcome: state.final_outcome || null, ...extra };
}
function printHuman(value) { console.log(`state: ${value.state}`); console.log(`goal_id: ${value.goal_id}`); if (value.blocker) console.log(`blocker: ${value.blocker.category || "unknown"}`); if (value.approval_required) console.log(`approval_required: true\nresume_action: ${value.resume_action}`); if (value.recommended_action) console.log(`recommended_action: ${value.recommended_action}`); }

async function cmdGoalStart(goal, options = {}) {
  if (!goal) { console.error("Goal objective is required"); return 1; }
  const generalRequested = normalizeExecutionMode(options.mode) === "unrestricted_general";
  const generalInference = generalRequested && !options.goalSpec;
  const compiled = options.goalSpec ? compileModelGoal(options.goalSpec, { mode: options.mode }) : generalInference ? { status: "ready", spec: createGoalSpec({ schema_version: 1, goal_id: options.goalId || goalIdFor(goal), objective: goal, success_criteria: [{ id: "general-placeholder", description: "A provisional observable outcome is identified and verified", required: true, provisional: true, verifier: { type: "custom", id: "general-placeholder-verifier", config: { source: "general_inference" } } }], execution_policy: { mode: "unrestricted_general" } }) } : compileGoal(goal, { mode: options.mode, goalId: options.goalId });
  const compiledRecord = /** @type {Record<string, any>} */ (compiled);
  if (compiledRecord.status !== "ready") { output({ state: compiledRecord.status, objective: compiledRecord.objective || goal, questions: compiledRecord.questions || [], errors: compiledRecord.errors || [] }, options); return compiledRecord.status === "clarification_required" ? 2 : 1; }
  const goalSpec = compiledRecord.spec;
  const config = loadConfig(path.join(repoPath(options), "minitok.yml"), { repoRoot: repoPath(options) });
  const requestedMode = normalizeExecutionMode(options.mode || config.goal?.default_mode || "safe");
  const confirmation = effectiveConfirmation(options);
  const autoAccept = options.autoAccept === true || options.auto_accept === true;
  const generalMode = requestedMode === "unrestricted_general";
  const runtimePermission = generalMode ? options.allowUnrestrictedGeneral === true || options.unrestrictedGeneralPermission === true : true;
  const integrityPreflight = generalMode;
  if (["unrestricted", "unrestricted_general"].includes(requestedMode) && confirmation !== true) { output({ state: "policy_denied", ...policyResponse(resolveExecutionPolicy({ mode: requestedMode, capabilities: capabilityOptions(options), explicit_confirmation: false, auto_accept: autoAccept, source: "cli", actor: options.actor, config })), reason: `explicit confirmation is required for ${requestedMode} mode` }, options); return 1; }
  if (autoAccept && !["unrestricted", "unrestricted_general"].includes(requestedMode)) { output({ state: "policy_denied", reason: "--auto-accept is only valid with an explicitly enabled unrestricted mode" }, options); return 1; }
  const requestedCapabilities = capabilityOptions(options);
  let persistedGeneralAudit = false;
  if (generalMode) {
    try { recordGeneralPolicyPreflight({ execution_mode: requestedMode, goal_id: goalSpec.goal_id, source: "cli", actor: options.actor, requested_capabilities: requestedCapabilities }, { auditPath: options.auditPath }); persistedGeneralAudit = true; } catch { persistedGeneralAudit = false; }
  }
  const initialPrepared = /** @type {any} */ (prepareGoalExecution({ goal_spec: goalSpec, mode: requestedMode, capabilities: requestedCapabilities, explicit_confirmation: confirmation, auto_accept: autoAccept, runtime_permission: runtimePermission, audit_persisted: persistedGeneralAudit, integrity_preflight: integrityPreflight, actor: options.actor, config, source: "cli", general_inference: generalInference }));
  if (initialPrepared.status !== "ready") { output({ state: initialPrepared.status, objective: goalSpec.objective, questions: initialPrepared.questions || [], errors: initialPrepared.errors || [], ...initialPrepared }, options); return initialPrepared.status === "clarification_required" ? 2 : 1; }
  const policyCapabilities = [...new Set([...requestedCapabilities, ...(initialPrepared.requested_capabilities || [])])];
  const policyDecision = resolveExecutionPolicy({ mode: requestedMode, capabilities: policyCapabilities, explicit_confirmation: confirmation, auto_accept: autoAccept, runtime_permission: runtimePermission, audit_persisted: persistedGeneralAudit, integrity_preflight: integrityPreflight, source: "cli", actor: options.actor, config });
  if (!policyDecision.allowed && !policyDecision.approval_required) { output({ state: "policy_denied", ...policyResponse(policyDecision), policy: policyDecision, config: redactGoalExecutionConfig(config) }, options); return 1; }
  const prepared = /** @type {any} */ (prepareGoalExecution({ goal_spec: goalSpec, existing_goal_plan: initialPrepared.goal_plan, mode: policyDecision.mode, capabilities: policyDecision.capabilities, explicit_confirmation: confirmation, auto_accept: autoAccept, runtime_permission: runtimePermission, audit_persisted: persistedGeneralAudit, integrity_preflight: integrityPreflight, actor: options.actor, config, source: "cli", general_inference: generalInference }));
  if (prepared.status !== "ready") { output({ state: prepared.status, objective: goalSpec.objective, questions: prepared.questions || [], errors: prepared.errors || [], ...prepared }, options); return prepared.status === "clarification_required" ? 2 : 1; }
  warnUnrestricted(options, policyDecision);
  const effectiveGoalSpec = prepared.goal_spec || goalSpec;
  const session = createGoalSession({ workspaceRoot: repoPath(options), goalSpec: effectiveGoalSpec, model: options.model, provider: options.provider, generalExecution: generalInference, approvalState: policyDecision.approval_required ? "approval_required" : "not_requested" });
  session.state.execution_policy = policyDecision;
  session.state.goal_plan = prepared.goal_plan;
  session.state.inferred_steps = prepared.inferred_steps;
  session.state.optional_steps = prepared.optional_steps;
  session.state.out_of_scope_candidates = prepared.out_of_scope_candidates;
  session.state.missing_information = prepared.missing_information || [];
  session.state.expansion_confidence = prepared.expansion_confidence ?? null;
  session.state.interpreted_intent = prepared.interpretation || initialPrepared.interpretation || prepared.expansion?.intent || initialPrepared.expansion?.intent || null;
  session.state.goal_hypotheses = prepared.hypotheses?.length ? prepared.hypotheses : (initialPrepared.hypotheses || prepared.expansion?.hypotheses || initialPrepared.expansion?.hypotheses || []);
  session.state.assumption_ledger = prepared.assumptions?.length ? prepared.assumptions : (initialPrepared.assumptions || prepared.expansion?.assumptions || initialPrepared.expansion?.assumptions || []);
  session.state.candidate_criteria = prepared.candidate_criteria?.length ? prepared.candidate_criteria : (initialPrepared.candidate_criteria || prepared.expansion?.candidate_criteria || initialPrepared.expansion?.candidate_criteria || []);
  session.state.provisional_criteria = (session.state.candidate_criteria || []).filter(item => item?.provisional === true || item?.status === "provisional");

  saveGoalSession(session);
  session.state.expansion_confidence = prepared.expansion_confidence ?? null;
  saveGoalSession(session);
  const executionRunner = options.runGoal || ((spec, executionOptions) => executeGoal(spec, { ...executionOptions, generalLoop: options.generalLoop }));
  const executionExpansion = { ...prepared.expansion, interpretation: prepared.interpretation || initialPrepared.interpretation, hypotheses: prepared.hypotheses?.length ? prepared.hypotheses : initialPrepared.hypotheses, assumptions: prepared.assumptions?.length ? prepared.assumptions : initialPrepared.assumptions, candidate_criteria: prepared.candidate_criteria?.length ? prepared.candidate_criteria : initialPrepared.candidate_criteria, provisional_criteria: prepared.provisional_criteria?.length ? prepared.provisional_criteria : initialPrepared.provisional_criteria };
  try { const result = await executionRunner(effectiveGoalSpec, { session, goalPlan: prepared.goal_plan, goalExpansion: executionExpansion, general_inference: generalInference, general_execution: generalInference, taskExecutor: options.taskExecutor || ((task, taskOptions) => runTask(task, { ...taskOptions, repoRoot: repoPath(options) })), evaluator: options.evaluator, workspaceRoot: repoPath(options), releaseSessionOnExit: true, mode: policyDecision.mode, capabilities: policyDecision.capabilities, explicit_confirmation: confirmation, auto_accept: autoAccept, runtime_permission: runtimePermission, audit_persisted: persistedGeneralAudit, integrity_preflight: integrityPreflight, actor: options.actor, source: "cli", config, policyDecision }); const response = sessionResponse(session, { result, goal_plan: prepared.goal_plan, inferred_steps: prepared.inferred_steps, optional_steps: prepared.optional_steps, out_of_scope_candidates: prepared.out_of_scope_candidates, expansion_confidence: prepared.expansion_confidence, requires_user_confirmation: prepared.requires_user_confirmation, ...policyResponse(policyDecision) }); options.json ? output(response, options) : printHuman(response); return result.completed ? 0 : 1; } finally { session.lock?.release?.(); }
}
function cmdGoalStatus(goalId, options = {}) { if (!goalId) { console.error("goal_id is required"); return 1; } const session = loadGoalSession(repoPath(options), goalId, { lock: false }); const response = sessionResponse(session); options.json ? output(response, options) : printHuman(response); return 0; }
async function cmdGoalResume(goalId, options = {}) { return cmdGoalContinue(goalId, options); }
async function cmdGoalContinue(goalId, options = {}) {
  if (!goalId) { console.error("goal_id is required"); return 1; }
  const config = loadConfig(path.join(repoPath(options), "minitok.yml"), { repoRoot: repoPath(options) });
  const stored = loadGoalSession(repoPath(options), goalId, { lock: false });
  const storedMode = stored.state.execution_policy?.mode || stored.goalSpec.execution_policy?.mode || "safe";
  const requestedMode = normalizeExecutionMode(options.mode || "safe");
  const generalMode = requestedMode === "unrestricted_general";
  const generalInference = stored.state.general_execution === true;
  const runtimePermission = generalMode ? options.allowUnrestrictedGeneral === true || options.unrestrictedGeneralPermission === true : true;
  const integrityPreflight = generalMode;
  const confirmation = effectiveConfirmation(options);
  if (["unrestricted", "unrestricted_general"].includes(storedMode) && !["unrestricted", "unrestricted_general"].includes(requestedMode)) { output({ state: "policy_denied", reason: `A previously ${storedMode} goal requires an explicit mode and reauthorization to continue or resume.` }, options); return 1; }
  const autoAccept = options.autoAccept === true || options.auto_accept === true;
  if (["unrestricted", "unrestricted_general"].includes(requestedMode) && confirmation !== true) { output({ state: "policy_denied", reason: `explicit confirmation is required when continuing or resuming ${requestedMode} mode` }, options); return 1; }
  if (autoAccept && !["unrestricted", "unrestricted_general"].includes(requestedMode)) { output({ state: "policy_denied", reason: "--auto-accept is only valid with an explicitly enabled unrestricted mode" }, options); return 1; }
  const session = resumeGoalSession(repoPath(options), goalId, { model: options.model, provider: options.provider, migrate: true });
  const requestedCapabilities = capabilityOptions(options);
  let persistedGeneralAudit = false;
  if (generalMode) {
    try { recordGeneralPolicyPreflight({ execution_mode: requestedMode, goal_id: session.goalSpec.goal_id, source: "cli", actor: options.actor, requested_capabilities: requestedCapabilities }, { auditPath: options.auditPath }); persistedGeneralAudit = true; } catch { persistedGeneralAudit = false; }
  }
  const initialPrepared = /** @type {any} */ (prepareGoalExecution({ goal_spec: session.goalSpec, existing_goal_plan: session.state.goal_plan, mode: requestedMode, capabilities: requestedCapabilities, explicit_confirmation: confirmation, auto_accept: autoAccept, runtime_permission: runtimePermission, audit_persisted: persistedGeneralAudit, integrity_preflight: integrityPreflight, actor: options.actor, config, source: "cli", general_inference: generalInference }));
  if (initialPrepared.status !== "ready") { session.lock?.release?.(); output({ state: initialPrepared.status, objective: session.goalSpec.objective, questions: initialPrepared.questions || [], errors: initialPrepared.errors || [], ...initialPrepared }, options); return initialPrepared.status === "clarification_required" ? 2 : 1; }
  const policyCapabilities = [...new Set([...requestedCapabilities, ...(initialPrepared.requested_capabilities || [])])];
  const policyDecision = resolveExecutionPolicy({ mode: requestedMode, capabilities: policyCapabilities, explicit_confirmation: confirmation, auto_accept: autoAccept, runtime_permission: runtimePermission, audit_persisted: persistedGeneralAudit, integrity_preflight: integrityPreflight, source: "cli", actor: options.actor, config });
  if (!policyDecision.allowed && !policyDecision.approval_required) { session.lock?.release?.(); output({ state: "policy_denied", ...policyResponse(policyDecision), policy: policyDecision, config: redactGoalExecutionConfig(config) }, options); return 1; }
  const prepared = /** @type {any} */ (prepareGoalExecution({ goal_spec: session.goalSpec, existing_goal_plan: initialPrepared.goal_plan, mode: policyDecision.mode, capabilities: policyDecision.capabilities, explicit_confirmation: confirmation, auto_accept: autoAccept, runtime_permission: runtimePermission, audit_persisted: persistedGeneralAudit, integrity_preflight: integrityPreflight, actor: options.actor, config, source: "cli", general_inference: generalInference }));
  if (prepared.status !== "ready") { session.lock?.release?.(); output({ state: prepared.status, objective: session.goalSpec.objective, questions: prepared.questions || [], errors: prepared.errors || [], ...prepared }, options); return prepared.status === "clarification_required" ? 2 : 1; }
  session.state.expansion_confidence = prepared.expansion_confidence ?? null;
  session.state.goal_hypotheses = prepared.hypotheses || prepared.expansion?.hypotheses || [];
  session.state.assumption_ledger = prepared.assumptions || prepared.expansion?.assumptions || [];
  session.state.candidate_criteria = prepared.candidate_criteria || prepared.expansion?.candidate_criteria || [];
  session.state.provisional_criteria = (session.state.candidate_criteria || []).filter(item => item?.provisional === true || item?.status === "provisional");
  saveGoalSession(session);
  session.state.execution_policy = policyDecision;
  session.state.goal_plan = prepared.goal_plan;
  session.state.inferred_steps = prepared.inferred_steps;
  session.state.optional_steps = prepared.optional_steps;
  session.state.out_of_scope_candidates = prepared.out_of_scope_candidates;
  session.state.missing_information = prepared.missing_information || [];
  session.state.expansion_confidence = prepared.expansion_confidence ?? null;
  saveGoalSession(session);
  warnUnrestricted(options, policyDecision);
  const executionRunner = options.runGoal || ((spec, executionOptions) => executeGoal(spec, { ...executionOptions, generalLoop: options.generalLoop }));
  try { const result = await executionRunner(session.goalSpec, { session, goalPlan: prepared.goal_plan, goalExpansion: prepared.expansion, general_inference: generalInference, general_execution: generalInference, taskExecutor: options.taskExecutor || ((task, taskOptions) => runTask(task, { ...taskOptions, repoRoot: repoPath(options) })), evaluator: options.evaluator, workspaceRoot: repoPath(options), releaseSessionOnExit: true, mode: policyDecision.mode, capabilities: policyDecision.capabilities, explicit_confirmation: confirmation, auto_accept: autoAccept, runtime_permission: runtimePermission, audit_persisted: persistedGeneralAudit, integrity_preflight: integrityPreflight, actor: options.actor, source: "cli", config, policyDecision }); const response = sessionResponse(session, { result, goal_plan: prepared.goal_plan, inferred_steps: prepared.inferred_steps, optional_steps: prepared.optional_steps, out_of_scope_candidates: prepared.out_of_scope_candidates, expansion_confidence: prepared.expansion_confidence, requires_user_confirmation: prepared.requires_user_confirmation, ...policyResponse(policyDecision) }); options.json ? output(response, options) : printHuman(response); return result.completed ? 0 : 1; } finally { session.lock?.release?.(); }
}
function register(program) {
  const goal = program.command("goal").description("Manage persistent goal sessions");
  const policyOptions = command => command.option("--mode <mode>").option("--capabilities <capabilities>", "comma-separated capabilities (legacy-compatible)").option("--capability <name>", "request one capability (repeatable)", (value, previous = []) => [...previous, value], []).option("--confirm-unrestricted", "explicitly confirm unrestricted autonomous execution").option("--confirm-unrestricted-general", "explicitly confirm unrestricted_general execution").option("--allow-unrestricted-general", "grant this request's unrestricted_general runtime permission").option("--explicit-confirmation", "legacy explicit confirmation alias").option("--auto-accept", "auto-accept only for explicitly enabled unrestricted mode").option("--json");
  policyOptions(goal.command("start").argument("<objective>").option("--repo <path>").option("--goal-id <id>")).action((objective, options) => cmdGoalStart(objective, options).then(code => { process.exitCode = code; }));
  goal.command("status").requiredOption("--goal-id <id>").option("--repo <path>").option("--json").action((options) => { process.exitCode = cmdGoalStatus(options.goalId, options); });
  policyOptions(goal.command("continue").requiredOption("--goal-id <id>").option("--repo <path>")).action((options) => cmdGoalContinue(options.goalId, options).then(code => { process.exitCode = code; }));
  policyOptions(goal.command("resume").requiredOption("--goal-id <id>").option("--repo <path>")).action((options) => cmdGoalResume(options.goalId, options).then(code => { process.exitCode = code; }));
}
module.exports = { register, cmdGoalStart, cmdGoalStatus, cmdGoalContinue, cmdGoalResume, sessionResponse, capabilityOptions, policyResponse, auditId };
