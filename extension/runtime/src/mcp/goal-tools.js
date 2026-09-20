"use strict";

const path = require("path");
const crypto = require("crypto");
const { compileGoal, compileModelGoal, goalIdFor } = require("../goal/compiler");
const { DEFAULT_CONSTRAINTS } = require("../goal/spec");
const { runGoal } = require("../goal/controller");
const { runTask } = require("../goal/task_executor");
const { createGoalSession, loadGoalSession, saveGoalSession, pauseGoalSession, resumeGoalSession, markGoalFailed } = require("../goal/session");
const { resolveExecutionPolicy } = require("../goal/execution_policy");
const { loadConfig, redactGoalExecutionConfig } = require("../config/loader");
const { prepareGoalExecution } = require("../goal/integration");
const { recordGeneralPolicyPreflight } = require("../goal/execution_audit");
const { responseProjection, normalizeExecutionMode } = require("../goal/general_response");

const ACTIVE_GOALS = new Map();
const GOAL_MODES = new Set(["safe", "supervised", "authorized_external", "unrestricted", "unrestricted_general", "unrestricted-general", "workspace", "autonomous"]);
function capabilityGrants(args = {}, runtimeOptions = {}) {
  if (Array.isArray(args.capabilities)) return args.capabilities;
  const permissions = runtimeOptions.permissions;
  const grants = [];
  if (permissions?.has?.("read") || permissions?.has?.("write")) grants.push("read", "inspect");
  if (permissions?.has?.("verify_exec")) grants.push("verify");
  return [...new Set(grants)];
}
function policyInput(args = {}, runtimeOptions = {}, source = "mcp", config) {
  const general = config?.goal?.unrestricted_general || {};
  const generalMode = normalizeExecutionMode(args.mode) === "unrestricted_general";
  const mode = normalizeExecutionMode(args.mode);
  return { mode, capabilities: Array.isArray(args.capabilities) ? args.capabilities : (["unrestricted", "unrestricted_general"].includes(mode) ? undefined : capabilityGrants(args, runtimeOptions)), explicit_confirmation: ["unrestricted", "unrestricted_general"].includes(mode) ? args.confirm_unrestricted === true || args.confirm_unrestricted_general === true : args.explicit_confirmation === true, auto_accept: ["unrestricted", "unrestricted_general"].includes(mode) ? runtimeOptions.permissions?.has?.("auto_accept") === true || args.auto_accept === true : args.auto_accept === true && runtimeOptions.permissions?.has?.("auto_accept"), runtime_permission: generalMode && runtimeOptions.permissions?.has?.("unrestricted_general_autonomous") === true || args.mode === "unrestricted" && runtimeOptions.permissions?.has?.("unrestricted_autonomous") === true, audit_persisted: generalMode && runtimeOptions.general_audit_persisted === true, integrity_preflight: generalMode && runtimeOptions.general_integrity_preflight === true, max_plan_depth: args.max_plan_depth ?? general.max_plan_depth, max_replan_count: args.max_replan_count ?? general.max_replan_count, max_assumption_count: args.max_assumption_count ?? general.max_assumption_count, source, actor: runtimeOptions.actor, config };
}
function auditId(policyDecision) { return `audit-${crypto.createHash("sha256").update(JSON.stringify({ mode: policyDecision.mode, capabilities: policyDecision.capabilities, denied: policyDecision.denied_capabilities, decision: policyDecision.allowed ? "allowed" : policyDecision.approval_required ? "approval_required" : "denied" })).digest("hex").slice(0, 16)}`; }
function policyResponse(policyDecision) { return { execution_mode: policyDecision.mode, requested_capabilities: policyDecision.capabilities || [], granted_capabilities: policyDecision.allowed ? policyDecision.capabilities || [] : [], denied_capabilities: policyDecision.denied_capabilities || [], policy_decision: policyDecision.allowed ? "allowed" : policyDecision.approval_required ? "approval_required" : "denied", audit_id: auditId(policyDecision) }; }
function capabilityRequest(args = {}, prepared = {}) { return [...new Set([...(Array.isArray(args.capabilities) ? args.capabilities : []), ...(Array.isArray(prepared.requested_capabilities) ? prepared.requested_capabilities : [])])]; }
function prepareInput(args, mode, existingGoalPlan, config, runtimeOptions = {}) {
  const goalSpec = args.goal_spec && typeof args.goal_spec === "object" ? args.goal_spec : undefined;
  const policy = policyInput({ ...args, mode }, runtimeOptions, "mcp", config);
  const input = { goal_spec: goalSpec, objective: args.goal, success_criteria: args.success_criteria, repository_context: args.repository_context, environment_state: args.environment_state, existing_goal_plan: existingGoalPlan, mode, general_inference: args.general_inference === true, capabilities: args.capabilities, explicit_confirmation: policy.explicit_confirmation, auto_accept: policy.auto_accept, runtime_permission: policy.runtime_permission, audit_persisted: policy.audit_persisted, integrity_preflight: policy.integrity_preflight, max_plan_depth: policy.max_plan_depth, max_replan_count: policy.max_replan_count, max_assumption_count: policy.max_assumption_count, actor: runtimeOptions.actor, config, source: "mcp" };
  return prepareGoalExecution(input);
}
function policyForPrepared(args, runtimeOptions, config, mode, prepared) {
  const requested = capabilityRequest(args, prepared);
  return resolveExecutionPolicy({ ...policyInput(args, runtimeOptions, "mcp", config), mode, capabilities: requested });
}
function persistPreparedSession(session, prepared, policyDecision) {
  session.state.interpreted_intent = prepared.interpretation || prepared.expansion?.intent || null;
  session.state.execution_policy = policyDecision;
  session.state.goal_plan = prepared.goal_plan;
  session.state.inferred_steps = prepared.inferred_steps || [];
  session.state.optional_steps = prepared.optional_steps || [];
  session.state.out_of_scope_candidates = prepared.out_of_scope_candidates || [];
  session.state.missing_information = prepared.missing_information || [];
  session.state.expansion_confidence = prepared.expansion_confidence ?? null;
  session.state.goal_hypotheses = prepared.hypotheses || prepared.expansion?.hypotheses || [];
  session.state.assumption_ledger = prepared.assumptions || prepared.expansion?.assumptions || [];
  session.state.candidate_criteria = prepared.candidate_criteria || prepared.expansion?.candidate_criteria || [];
  session.state.provisional_criteria = (session.state.candidate_criteria || []).filter(item => item?.provisional === true || item?.status === "provisional");
  session.state.requires_user_confirmation = prepared.requires_user_confirmation === true;
  session.state.questions = prepared.questions || [];
  saveGoalSession(session);
}
function clarificationResponse(goalSpec, prepared) {
  const safe = { state: "clarification_required", original_objective: goalSpec?.objective || "", candidate_criteria: prepared.candidate_criteria || prepared.expansion?.candidate_criteria || [], assumptions: prepared.assumptions || prepared.expansion?.assumptions || [], goal_hypotheses: prepared.hypotheses || prepared.expansion?.hypotheses || [], inferred_steps: prepared.inferred_steps || [], optional_steps: prepared.optional_steps || [] };
  return { ...responseProjection({ goalSpec: goalSpec || { goal_id: null }, state: safe }, prepared), goal_id: goalSpec?.goal_id || null, state: "clarification_required", current_state: "clarification_required", goal: goalSpec || { objective: "" }, criteria: goalSpec?.success_criteria || [], current_task: null, next_action: "Provide clarification", blocker: null, alternatives: [], recommended_action: "Provide clarification", approval_required: false, resume_command: null, resume_action: "Provide clarification before starting the goal", evidence: [], goal_plan: null, inferred_steps: [], optional_steps: [], requested_capabilities: [], granted_capabilities: [], denied_capabilities: [], execution_mode: "safe", policy_decision: "clarification_required", requires_user_confirmation: true, questions: prepared.questions || [], question_details: prepared.question_details || [], missing_information: prepared.missing_information || [], out_of_scope_candidates: prepared.out_of_scope_candidates || [] };
}
function unrestrictedError(args, runtimeOptions) {
  const mode = normalizeExecutionMode(args.mode);
  if (!["unrestricted", "unrestricted_general"].includes(mode)) return null;
  const general = mode === "unrestricted_general";
  const permission = general ? "unrestricted_general_autonomous" : "unrestricted_autonomous";
  const confirmed = args.confirm_unrestricted === true || args.confirm_unrestricted_general === true;
  const denied = !runtimeOptions.permissions?.has?.(permission) ? [permission] : !confirmed ? [general ? "confirm_unrestricted_general" : "confirm_unrestricted"] : [];
  if (!denied.length) return null;
  const policy = { mode, capabilities: Array.isArray(args.capabilities) ? args.capabilities : [], allowed: false, approval_required: false, denied_capabilities: denied, always_blocked_capabilities: [], reason: denied[0] === permission ? `${mode} runtime permission is required` : "unrestricted request confirmation is required" };
  const code = denied[0] === permission ? (general ? "UNRESTRICTED_GENERAL_PERMISSION_DENIED" : "UNRESTRICTED_PERMISSION_DENIED") : "UNRESTRICTED_CONFIRMATION_REQUIRED";
  return Object.assign(new Error(policy.reason), { code, policy });
}
function policyError(policyDecision, config) { return Object.assign(new Error(policyDecision.reason), { code: policyDecision.always_blocked_capabilities.length ? "ALWAYS_BLOCKED" : "EXECUTION_POLICY_DENIED", policy: policyDecision, config: redactGoalExecutionConfig(config) }); }
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
  const policy = state.execution_policy || extra.policyDecision;
  const policyFields = policy ? policyResponse(policy) : { execution_mode: "safe", requested_capabilities: [], granted_capabilities: [], denied_capabilities: [], policy_decision: "unknown", audit_id: "audit-unknown" };
  return { ...responseProjection(session, { ...extra, policyDecision: policy }), goal_id: session.goalSpec.goal_id, state: state.status, current_state: state.status, goal: session.goalSpec, criteria: evaluation?.criteria || [], current_task: state.current_task || null, next_action: resumeAction, blocker, alternatives, recommended_action: blocker?.recommended_alternative || alternativeHistory.at(-1)?.alternative_id || null, goal_plan: state.goal_plan || extra.goal_plan || null, inferred_steps: state.inferred_steps || extra.inferred_steps || [], optional_steps: state.optional_steps || extra.optional_steps || [], missing_information: state.missing_information || extra.missing_information || [], out_of_scope_candidates: state.out_of_scope_candidates || extra.out_of_scope_candidates || [], expansion_confidence: state.expansion_confidence ?? extra.expansion_confidence ?? null, requires_user_confirmation: state.requires_user_confirmation ?? extra.requires_user_confirmation ?? false, questions: state.questions || extra.questions || [], approval_required: approvalRequired, verification_required: verificationRequired, resume_check: resumeCheck, resume_command: approvalRequired || verificationRequired ? "minitok_goal_resume" : null, resume_action: resumeAction, evidence: evaluation?.evidence || [], evidence_complete: state.terminal_resolution?.blocker?.evidence_complete ?? false, terminal_resolution: state.terminal_resolution || null, attempted_alternatives: state.terminal_resolution?.attempted_alternatives || [], why_not_selected: state.terminal_resolution?.why_not_selected || [], required_external_action: state.terminal_resolution?.required_external_action || null, resume_conditions: state.terminal_resolution?.resume_conditions || null, next_user_action: state.terminal_resolution?.next_user_action || null, execution_audits: state.execution_audits || [], execution_audit_refs: state.execution_audit_refs || [], ...policyFields, ...extra };
}
function launch(session, options = {}) {
  const goalId = session.goalSpec.goal_id; const controller = new AbortController(); const record = { controller, paused: false, promise: null, session }; ACTIVE_GOALS.set(goalId, record);
  const taskExecutor = options.taskExecutor || ((task, taskOptions) => runTask(task, { ...taskOptions, repoRoot: session.workspaceRoot, signal: controller.signal, providerOverride: options.providerOverride, autoAccept: options.policyDecision?.allowed === true && ["unrestricted", "unrestricted_general"].includes(options.mode) }));
  record.promise = runGoal(session.goalSpec, { ...options, session, signal: controller.signal, taskExecutor, recoveryEnabled: options.recoveryEnabled !== false });
  record.promise.then(result => { if (record.paused) session.state.status = "paused"; else if (result.state === "completed") session.state.status = "completed"; else if (result.state === "escalate") session.state.status = "escalated"; else if (result.completed !== true && !["paused", "running"].includes(session.state.status)) session.state.status = "failed"; saveGoalSession(session); }).catch(error => { if (!record.paused) markGoalFailed(session, { error: error.message }); }).finally(() => { ACTIVE_GOALS.delete(goalId); session.lock?.release?.(); });
  return record;
}
function compileInput(args) {
  if (normalizeExecutionMode(args.mode) === "unrestricted_general" && typeof args.goal === "string" && args.goal.trim()) return { status: "ready", source: "general-inference", spec: { schema_version: 1, goal_id: args.goal_id || goalIdFor(args.goal.trim()), objective: args.goal.trim(), success_criteria: [{ id: "general-placeholder", description: "A provisional observable outcome is identified and verified", required: true, provisional: true, verifier: { type: "custom", id: "general-placeholder-verifier", config: { source: "general_inference" } } }], constraints: { ...DEFAULT_CONSTRAINTS }, execution_policy: { mode: "unrestricted_general" } } };
  if (args.goal_spec && typeof args.goal_spec === "object") return compileModelGoal(args.goal_spec, { mode: args.mode });
  if (Array.isArray(args.success_criteria)) {
    const constraints = { ...DEFAULT_CONSTRAINTS, ...(args.constraints || {}) };
    if (args.repository_context?.repository_odd) constraints.repository_odd = args.repository_context.repository_odd;
    return compileModelGoal({ schema_version: 1, goal_id: args.goal_id || goalIdFor(args.goal || "goal"), objective: args.goal, success_criteria: args.success_criteria, constraints, execution_policy: { mode: args.mode || "safe" } }, { mode: args.mode });
  }
  return compileGoal(args.goal, { mode: args.mode, goalId: args.goal_id });
}


async function startGoal(args, runtimeOptions = {}) {
  const mode = normalizeExecutionMode(args.mode || "safe");
  if (!GOAL_MODES.has(mode) && !GOAL_MODES.has(args.mode)) throw Object.assign(new Error("Invalid goal mode"), { code: "INVALID_PARAMS" });
  if (mode === "autonomous" && !runtimeOptions.permissions?.has?.("auto_accept")) throw Object.assign(new Error("autonomous goal mode requires explicit auto_accept permission"), { code: "AUTO_ACCEPT_DENIED" });
  const unrestrictedFailure = unrestrictedError(args, runtimeOptions);
  if (unrestrictedFailure) throw unrestrictedFailure;
  const repoRoot = requireGoalRepo(args.repo || runtimeOptions.workspaceRoot, runtimeOptions.workspaceRoot);
  const config = loadConfig(path.join(repoRoot, "minitok.yml"), { repoRoot });
  const compiled = compileInput({ ...args, mode }); const compiledRecord = /** @type {Record<string, any>} */ (compiled); const compiledSource = /** @type {any} */ (compiled).source;
  if (compiled.status === "clarification_required") return clarificationResponse(null, compiledRecord);
  if (compiled.status !== "ready") throw Object.assign(new Error(`Goal specification is ${compiled.status}`), { code: compiled.status === "unsupported" ? "GOAL_UNSUPPORTED" : "GOAL_INVALID", details: compiledRecord.errors || [{ path: "$", code: "UNSUPPORTED_GOAL", message: compiledRecord.reason || `Goal specification is ${compiled.status}` }] });
  let generalAuditPersisted = false;
  if (mode === "unrestricted_general") {
    try { recordGeneralPolicyPreflight({ execution_mode: mode, goal_id: compiledRecord.spec.goal_id, source: "mcp", actor: runtimeOptions.actor, requested_capabilities: args.capabilities }, { auditPath: args.audit_path }); generalAuditPersisted = true; } catch { generalAuditPersisted = false; }
  }
  const preparedRuntime = { ...runtimeOptions, general_audit_persisted: generalAuditPersisted, general_integrity_preflight: mode === "unrestricted_general" };
  const initialPrepared = prepareInput({ ...args, mode, general_inference: compiledSource === "general-inference", goal_spec: compiledRecord.spec }, mode, null, config, preparedRuntime);
  if (initialPrepared.status !== "ready") return clarificationResponse(compiledRecord.spec, initialPrepared);
  const policyDecision = policyForPrepared(args, { ...preparedRuntime, general_audit_persisted: generalAuditPersisted }, config, mode, initialPrepared);
  if (!policyDecision.allowed && !policyDecision.approval_required) throw policyError(policyDecision, config);
  const prepared = prepareInput({ ...args, mode: policyDecision.mode, general_inference: compiledSource === "general-inference", goal_spec: compiledRecord.spec }, policyDecision.mode, initialPrepared.goal_plan, config, { ...preparedRuntime, general_audit_persisted: generalAuditPersisted });
  if (prepared.status !== "ready") return clarificationResponse(compiledRecord.spec, prepared);
  const session = createGoalSession({ workspaceRoot: repoRoot, goalSpec: prepared.goal_spec || compiledRecord.spec, model: runtimeOptions.model, provider: args.provider_override, approvalState: policyDecision.approval_required ? "approval_required" : "not_requested" });
  const persistedPrepared = { ...prepared, interpretation: prepared.interpretation || initialPrepared.interpretation, hypotheses: prepared.hypotheses?.length ? prepared.hypotheses : initialPrepared.hypotheses, assumptions: prepared.assumptions?.length ? prepared.assumptions : initialPrepared.assumptions, candidate_criteria: prepared.candidate_criteria?.length ? prepared.candidate_criteria : initialPrepared.candidate_criteria, provisional_criteria: prepared.provisional_criteria?.length ? prepared.provisional_criteria : initialPrepared.provisional_criteria };
  persistPreparedSession(session, persistedPrepared, policyDecision);
  launch(session, { ...runtimeOptions, mode: policyDecision.mode, capabilities: policyDecision.capabilities, goalPlan: prepared.goal_plan, goalExpansion: prepared.expansion, explicit_confirmation: policyDecision.audit_context.explicit_confirmation, auto_accept: policyDecision.audit_context.auto_accept, runtime_permission: policyDecision.audit_context.runtime_permission, audit_persisted: policyDecision.audit_context.audit_persisted, integrity_preflight: policyDecision.audit_context.integrity_preflight, max_plan_depth: args.max_plan_depth, max_replan_count: args.max_replan_count, max_assumption_count: args.max_assumption_count, policyDecision, config, providerOverride: args.provider_override });
  return resultForSession(session, { state: "running", next_action: "Call minitok_goal_status to observe progress", goal_plan: prepared.goal_plan, inferred_steps: prepared.inferred_steps, optional_steps: prepared.optional_steps, out_of_scope_candidates: prepared.out_of_scope_candidates, expansion_confidence: prepared.expansion_confidence, requires_user_confirmation: prepared.requires_user_confirmation, questions: prepared.questions, missing_information: prepared.missing_information, policyDecision });
}
function readGoal(args, runtimeOptions = {}) { const repoRoot = requireGoalRepo(args.repo, runtimeOptions.workspaceRoot); return resultForSession(loadGoalSession(repoRoot, args.goal_id, { lock: false })); }
async function continueGoal(args, runtimeOptions = {}) {
  const repoRoot = requireGoalRepo(args.repo, runtimeOptions.workspaceRoot);
  if (ACTIVE_GOALS.has(args.goal_id)) throw Object.assign(new Error("Goal session is already running"), { code: "GOAL_SESSION_BUSY" });
  const config = loadConfig(path.join(repoRoot, "minitok.yml"), { repoRoot });
  const unrestrictedFailure = unrestrictedError(args, runtimeOptions);
  if (unrestrictedFailure) throw unrestrictedFailure;
  const session = resumeGoalSession(repoRoot, args.goal_id, { model: runtimeOptions.model, provider: args.provider_override, migrate: true });
  const storedMode = normalizeExecutionMode(session.state.execution_policy?.mode || session.goalSpec.execution_policy?.mode || "safe");
  const mode = normalizeExecutionMode(args.mode || "safe");
  if (["unrestricted", "unrestricted_general"].includes(storedMode) && !["unrestricted", "unrestricted_general"].includes(mode)) { session.lock?.release?.(); throw Object.assign(new Error(`A previously ${storedMode} goal requires explicit mode reauthorization`), { code: "GOAL_REAUTHORIZATION_REQUIRED" }); }
  let generalAuditPersisted = false;
  if (mode === "unrestricted_general") {
    try { recordGeneralPolicyPreflight({ execution_mode: mode, goal_id: session.goalSpec.goal_id, source: "mcp", actor: runtimeOptions.actor, requested_capabilities: args.capabilities }, { auditPath: args.audit_path }); generalAuditPersisted = true; } catch { generalAuditPersisted = false; }
  }
  const preparedRuntime = { ...runtimeOptions, general_audit_persisted: generalAuditPersisted, general_integrity_preflight: mode === "unrestricted_general" };
  const initialPrepared = prepareInput({ ...args, mode, general_inference: false, goal_spec: session.goalSpec, existing_goal_plan: session.state.goal_plan }, mode, session.state.goal_plan, config, preparedRuntime);
  if (initialPrepared.status !== "ready") { session.lock?.release?.(); return resultForSession(session, { state: initialPrepared.status, current_state: initialPrepared.status, questions: initialPrepared.questions || [], errors: initialPrepared.errors || [], goal_plan: initialPrepared.goal_plan, inferred_steps: initialPrepared.inferred_steps || [], optional_steps: initialPrepared.optional_steps || [], out_of_scope_candidates: initialPrepared.out_of_scope_candidates || [], requires_user_confirmation: initialPrepared.requires_user_confirmation }); }
  const policyDecision = policyForPrepared(args, preparedRuntime, config, mode, initialPrepared);
  if (!policyDecision.allowed && !policyDecision.approval_required) { session.lock?.release?.(); throw policyError(policyDecision, config); }
  const prepared = prepareInput({ ...args, mode: policyDecision.mode, general_inference: false, goal_spec: session.goalSpec, existing_goal_plan: initialPrepared.goal_plan }, policyDecision.mode, initialPrepared.goal_plan, config, preparedRuntime);
  if (prepared.status !== "ready") { session.lock?.release?.(); return resultForSession(session, { state: prepared.status, current_state: prepared.status, goal_plan: prepared.goal_plan, questions: prepared.questions || [], errors: prepared.errors || [], inferred_steps: prepared.inferred_steps || [], optional_steps: prepared.optional_steps || [], out_of_scope_candidates: prepared.out_of_scope_candidates || [], requires_user_confirmation: prepared.requires_user_confirmation }); }
  const persistedPrepared = { ...prepared, interpretation: prepared.interpretation || initialPrepared.interpretation, hypotheses: prepared.hypotheses?.length ? prepared.hypotheses : initialPrepared.hypotheses, assumptions: prepared.assumptions?.length ? prepared.assumptions : initialPrepared.assumptions, candidate_criteria: prepared.candidate_criteria?.length ? prepared.candidate_criteria : initialPrepared.candidate_criteria, provisional_criteria: prepared.provisional_criteria?.length ? prepared.provisional_criteria : initialPrepared.provisional_criteria };
  persistPreparedSession(session, persistedPrepared, policyDecision);
  launch(session, { ...runtimeOptions, mode: policyDecision.mode, capabilities: policyDecision.capabilities, goalPlan: prepared.goal_plan, goalExpansion: prepared.expansion, explicit_confirmation: policyDecision.audit_context.explicit_confirmation, auto_accept: policyDecision.audit_context.auto_accept, runtime_permission: policyDecision.audit_context.runtime_permission, audit_persisted: policyDecision.audit_context.audit_persisted, integrity_preflight: policyDecision.audit_context.integrity_preflight, max_plan_depth: args.max_plan_depth, max_replan_count: args.max_replan_count, max_assumption_count: args.max_assumption_count, policyDecision, config, providerOverride: args.provider_override }); return resultForSession(session, { state: "running", goal_plan: prepared.goal_plan, inferred_steps: prepared.inferred_steps, optional_steps: prepared.optional_steps, out_of_scope_candidates: prepared.out_of_scope_candidates, expansion_confidence: prepared.expansion_confidence, requires_user_confirmation: prepared.requires_user_confirmation, questions: prepared.questions, missing_information: prepared.missing_information, policyDecision });
}
function pauseGoal(args, runtimeOptions = {}) { const repoRoot = requireGoalRepo(args.repo, runtimeOptions.workspaceRoot); const active = ACTIVE_GOALS.get(args.goal_id); const session = active?.session || loadGoalSession(repoRoot, args.goal_id); if (active) { active.paused = true; active.controller.abort(); ACTIVE_GOALS.delete(args.goal_id); } pauseGoalSession(session, args.reason || "paused by MCP client"); session.lock?.release?.(); return resultForSession(session, { state: "paused" }); }
function cancelGoal(args, runtimeOptions = {}) { const repoRoot = requireGoalRepo(args.repo, runtimeOptions.workspaceRoot); const active = ACTIVE_GOALS.get(args.goal_id); const session = active?.session || loadGoalSession(repoRoot, args.goal_id); if (active) { active.paused = true; active.controller.abort(); ACTIVE_GOALS.delete(args.goal_id); } markGoalFailed(session, { cancelled: true, reason: args.reason || "cancelled by MCP client" }); session.lock?.release?.(); return resultForSession(session, { state: "failed" }); }
function isActive(goalId) { return ACTIVE_GOALS.has(goalId); }
module.exports = { GOAL_MODES, ACTIVE_GOALS, startGoal, readGoal, continueGoal, pauseGoal, cancelGoal, resultForSession, policyResponse, isActive, requireGoalRepo };
