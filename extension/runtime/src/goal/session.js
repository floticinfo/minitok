"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { setOwnerOnlyPermissions } = require("../utils/file-permissions");
const { assertValidGoalSpec } = require("./validator");
const { redactValue } = require("./evidence");
const { evaluationIsComplete } = require("./evaluator");

const GOAL_DIRECTORY = path.join(".minitok", "goals");
const SESSION_SCHEMA_VERSION = 2;
const STATE_SCHEMA_VERSION = 2;
const GOAL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function goalSessionPaths(workspaceRoot, goalId) {
  if (typeof workspaceRoot !== "string" || !workspaceRoot.trim()) throw new TypeError("workspaceRoot is required");
  if (typeof goalId !== "string" || !GOAL_ID_PATTERN.test(goalId)) throw new TypeError("Invalid goal_id for session path");
  const workspace = path.resolve(workspaceRoot);
  const root = path.resolve(workspace, GOAL_DIRECTORY, goalId);
  const expected = path.resolve(workspace, GOAL_DIRECTORY) + path.sep;
  if (!root.startsWith(expected)) throw new Error("Goal session path must stay inside the workspace");
  return { root, goal: path.join(root, "goal.json"), state: path.join(root, "state.json"), events: path.join(root, "events.jsonl"), checkpoints: path.join(root, "checkpoints"), evidence: path.join(root, "evidence"), locks: path.join(root, "locks"), lock: path.join(root, "locks", "session.lock") };
}

function normalizeExternalTarget(value) {
  if (value === undefined || value === null) return null;
  try {
    const url = new URL(String(value));
    return { protocol: url.protocol, hostname: url.hostname, port: url.port || null, pathname: url.pathname || "/" };
  } catch {
    return redactValue(String(value).replace(/(?:[?&](?:token|secret|password|key)=[^&]*)/gi, "[REDACTED]"), "external_target");
  }
}
function normalizeRollbackRecord(input = {}) {
  return redactValue({
    rollback_id: input.rollback_id || `rollback_${crypto.randomBytes(8).toString("hex")}`,
    step_id: input.step_id || null, operation: input.operation || null,
    pre_state: input.pre_state ?? null, post_state: input.post_state ?? null,
    rollback_adapter: input.rollback_adapter || null, rollback_conditions: input.rollback_conditions || [],
    rollback_status: input.rollback_status || "available", rollback_evidence: input.rollback_evidence || [],
    irreversible: input.irreversible === true, irreversibility_reason: input.irreversibility_reason || null,
    policy_allowed: input.policy_allowed === true, policy_evidence: input.policy_evidence || null,
    external_target: normalizeExternalTarget(input.external_target), recorded_at: input.recorded_at || new Date().toISOString(),
  });
}
function atomicWrite(filePath, value) {
  const temporary = `${filePath}.tmp.${process.pid}.${crypto.randomBytes(8).toString("hex")}`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    if (process.platform === "win32") { try { fs.unlinkSync(filePath); } catch (error) { if (error.code !== "ENOENT") throw error; } }
    fs.renameSync(temporary, filePath); setOwnerOnlyPermissions(filePath);
  } catch (error) { try { fs.unlinkSync(temporary); } catch {} throw error; }
}
function readJson(filePath, label) {
  try { return JSON.parse(fs.readFileSync(filePath, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw new Error(`Corrupt goal session ${label}: ${error.message}`, { cause: error }); }
}
function isPidAlive(pid) { if (!Number.isInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; } }
function acquireSessionLock(lockPath, attempt = 0) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const token = crypto.randomBytes(16).toString("hex");
  try { fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, host: os.hostname(), token, locked_at: new Date().toISOString() }), { encoding: "utf8", flag: "wx", mode: 0o600 }); }
  catch (error) {
    const code = /** @type {NodeJS.ErrnoException} */ (error).code;
    if (code !== "EEXIST") throw error;
    const existing = readJson(lockPath, "lock");
    const stale = existing && existing.host === os.hostname() && !isPidAlive(existing.pid);
    if (stale && attempt < 1) { try { fs.unlinkSync(lockPath); } catch {} return acquireSessionLock(lockPath, attempt + 1); }
    const busy = new Error(`Goal session is locked: ${lockPath}`);
    /** @type {NodeJS.ErrnoException} */ (busy).code = "goal_session_locked";
    throw busy;
  }
  setOwnerOnlyPermissions(lockPath);
  let released = false;
  return { path: lockPath, release() { if (released) return; released = true; const info = readJson(lockPath, "lock"); if (info?.pid === process.pid && info.token === token) { try { fs.unlinkSync(lockPath); } catch {} } } };
}
function hashFile(filePath) { try { return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex"); } catch (error) { if (error.code === "ENOENT") return null; throw error; } }
function fileSnapshot(workspaceRoot, trackedPaths = []) {
  const snapshot = {};
  for (const relative of trackedPaths) {
    if (typeof relative !== "string" || relative.trim() === "") throw new TypeError("Tracked paths must be non-empty strings");
    const normalized = relative.replace(/\\/g, "/");
    const resolved = path.resolve(workspaceRoot, normalized);
    const check = path.relative(path.resolve(workspaceRoot), resolved);
    if (check === ".." || check.startsWith(`..${path.sep}`) || path.isAbsolute(check)) throw new Error(`Tracked path escapes workspace: ${relative}`);
    snapshot[normalized] = hashFile(resolved);
  }
  return snapshot;
}
function snapshotChanged(workspaceRoot, snapshot = {}) { return Object.keys(snapshot).some(relative => hashFile(path.resolve(workspaceRoot, relative)) !== snapshot[relative]); }
function cloneRecord(value) { return JSON.parse(JSON.stringify(value)); }
function redactSessionValue(value, key = "") {
  if (key === "max_tokens") return value;
  if (key === "token_usage") return value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([name, item]) => [name, redactSessionValue(item, name)])) : value;
  if (Array.isArray(value)) return value.map(item => redactSessionValue(item));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, redactSessionValue(item, name)]));
  return redactValue(value, key);
}
function initialState(goalSpec, options) {
  return { schema_version: STATE_SCHEMA_VERSION, goal_id: goalSpec.goal_id, session_id: options.sessionId || `session_${crypto.randomBytes(10).toString("hex")}`, status: "running", workspace_root: path.resolve(options.workspaceRoot), model: options.model || null, provider: options.provider || null, original_objective: goalSpec.objective, raw_objective_redacted: redactValue(options.rawObjective || goalSpec.objective), general_execution: options.generalExecution === true, interpreted_intent: null, goal_hypotheses: [], assumption_ledger: [], candidate_criteria: [], provisional_criteria: [], goal_plan_versions: [], completed_steps: [], failed_steps: [], discarded_steps: [], replanning_traces: [], tool_observations: [], policy_decisions: [], execution_audits: [], execution_audit_refs: [], rollback_records: [], resume_provenance: [], external_state_drift: [], general_loop: null, explicit_steps: [], inferred_steps: [], assumptions: [], blockers: [], alternatives: [], selected_alternative: null, approval_requests: [], resolution_attempts: [], verification_results: [], resumed_from: null, resume_check: { safe_to_resume: true, checkpoint_changed: false, requires_verification: false, reason: null, verified_at: null, verification_evidence_ids: [] }, final_outcome: null, current_task: null, cycle_count: 0, task_history: [], action_history: [], evaluator_results: [], evidence_refs: [], checkpoints: [], approval_state: options.approvalState || "not_requested", failure_history: [], recovery_history: [], model_routing: [], progress_state: { last_fingerprint: "", stagnant_cycles: 0, current_progress: 0, previous_progress: 0 }, token_usage: { input: 0, output: 0 }, time_budget: { started_at: new Date().toISOString(), elapsed_ms: 0 }, last_checkpoint_id: null, updated_at: new Date().toISOString() };
}

function createGoalSession(options = {}) {
  assertValidGoalSpec(options.goalSpec);
  const paths = goalSessionPaths(options.workspaceRoot, options.goalSpec.goal_id);
  const lock = acquireSessionLock(paths.lock);
  try {
    fs.mkdirSync(paths.checkpoints, { recursive: true }); fs.mkdirSync(paths.evidence, { recursive: true });
    const session = { workspaceRoot: path.resolve(options.workspaceRoot), goalSpec: cloneRecord(options.goalSpec), state: initialState(options.goalSpec, options), paths, lock };
    atomicWrite(paths.goal, redactSessionValue(session.goalSpec)); atomicWrite(paths.state, redactSessionValue(session.state)); appendGoalEvent(session, { type: "session_created", model: options.model, provider: options.provider });
    return session;
  } catch (error) { lock.release(); throw error; }
}


function saveGoalSession(session) {
  if (!session?.paths || !session.goalSpec || !session.state) throw new TypeError("Invalid goal session");
  assertValidGoalSpec(session.goalSpec);
  if (session.state.goal_id !== session.goalSpec.goal_id) throw new Error("Goal session state/spec id mismatch");
  session.state.updated_at = new Date().toISOString(); atomicWrite(session.paths.goal, redactSessionValue(session.goalSpec)); atomicWrite(session.paths.state, redactSessionValue(session.state)); return session;
}
function appendGoalEvent(session, event) {
  if (!session?.paths?.events) throw new TypeError("Invalid goal session");
  const record = redactValue({ schema_version: 1, event_id: `event_${crypto.randomBytes(8).toString("hex")}`, recorded_at: new Date().toISOString(), ...event });
  fs.mkdirSync(path.dirname(session.paths.events), { recursive: true }); fs.appendFileSync(session.paths.events, `${JSON.stringify(record)}\n`, { encoding: "utf8", flag: "a" }); setOwnerOnlyPermissions(session.paths.events); return record;
}
function persistGeneralLoopState(session, loopState = {}, eventType = "general_loop_checkpoint") {
  if (!session?.state) throw new TypeError("Invalid goal session");
  const projection = redactValue({ schema_version: 1, ...loopState, updated_at: new Date().toISOString() });
  session.state.general_loop = projection;
  session.state.status = projection.state || session.state.status;
  session.state.final_outcome = projection.final_outcome || session.state.final_outcome;
  session.state.goal_plan_versions = projection.plan_versions || projection.plan_history || session.state.goal_plan_versions || [];
  session.state.replanning_traces = projection.replanning_traces || session.state.replanning_traces || [];
  session.state.tool_observations = projection.tool_observations || session.state.tool_observations || [];
  session.state.rollback_records = projection.rollback_records || session.state.rollback_records || [];
  session.state.policy_decisions = projection.policy_decisions || session.state.policy_decisions || [];
  session.state.execution_audits = projection.execution_audits || session.state.execution_audits || [];
  session.state.execution_audit_refs = session.state.execution_audits.map(item => item?.audit_id).filter(Boolean);
  saveGoalSession(session);
  appendGoalEvent(session, { type: eventType, checkpoint_id: projection.checkpoint_id || null, loop_state: projection.state || null, plan_version: projection.plan?.plan_version || null });
  return projection;
}
function recordRollback(session, input = {}) {
  if (!session?.state) throw new TypeError("Invalid goal session");
  const record = normalizeRollbackRecord(input);
  session.state.rollback_records = [...(Array.isArray(session.state.rollback_records) ? session.state.rollback_records : []), record];
  appendGoalEvent(session, { type: "rollback_recorded", rollback_id: record.rollback_id, rollback_status: record.rollback_status, irreversible: record.irreversible });
  saveGoalSession(session);
  return record;
}
async function rollbackMutation(session, rollbackId, options = {}) {
  if (!session?.state) throw new TypeError("Invalid goal session");
  const record = (session.state.rollback_records || []).find(item => item.rollback_id === rollbackId);
  if (!record) throw new Error("Rollback record not found");
  if (record.irreversible === true || !record.rollback_adapter) {
    record.rollback_status = "unavailable"; record.rollback_evidence = [{ valid: false, reason: "rollback adapter is unavailable" }]; record.rollback_failure = true;
    saveGoalSession(session); appendGoalEvent(session, { type: "rollback_failed", rollback_id: rollbackId, reason: "rollback adapter is unavailable" }); return { success: false, record };
  }
  const adapter = options.rollbackAdapters?.[record.rollback_adapter] || options.adapters?.[record.rollback_adapter];
  if (typeof adapter !== "function") { record.rollback_status = "failed"; record.rollback_failure = true; saveGoalSession(session); appendGoalEvent(session, { type: "rollback_failed", rollback_id: rollbackId, reason: "rollback adapter is not injected" }); return { success: false, record }; }
  try {
    const outcome = await adapter({ ...record, read_only: false });
    record.rollback_status = outcome?.success === true ? "completed" : "failed"; record.rollback_failure = outcome?.success !== true;
    record.rollback_evidence = redactValue(outcome?.evidence || outcome || []);
  } catch (error) { record.rollback_status = "failed"; record.rollback_failure = true; record.rollback_failure_reason = redactValue(error.message); }
  saveGoalSession(session); appendGoalEvent(session, { type: record.rollback_status === "completed" ? "rollback_completed" : "rollback_failed", rollback_id: rollbackId });
  return { success: record.rollback_status === "completed", record };
}
function validateResumePolicy(session, options = {}) {
  const requested = options.resumePolicy || options.policyDecision;
  const actualPlanVersion = session.state.general_loop?.plan?.plan_version || session.state.goal_plan_versions?.at(-1)?.plan_version || null;
  const planInvalidated = options.plan_version !== undefined && options.plan_version !== actualPlanVersion;
  const externalFingerprint = options.external_state === undefined ? null : crypto.createHash("sha256").update(JSON.stringify(redactValue(options.external_state))).digest("hex");
  const externalDrift = externalFingerprint !== null && session.state.external_state_fingerprint && session.state.external_state_fingerprint !== externalFingerprint;
  if (externalFingerprint !== null && !session.state.external_state_fingerprint) session.state.external_state_fingerprint = externalFingerprint;
  if (planInvalidated || externalDrift) {
    session.state.external_state_drift = [...(Array.isArray(session.state.external_state_drift) ? session.state.external_state_drift : []), redactValue({ plan_invalidated: planInvalidated, external_drift: externalDrift, expected_plan_version: options.plan_version, actual_plan_version: actualPlanVersion })];
    session.state.status = "verification_required"; session.state.resume_check = { safe_to_resume: false, checkpoint_changed: false, requires_verification: true, reason: planInvalidated ? "persisted plan version is invalidated" : "external state drift requires verification", verified_at: null, verification_evidence_ids: [] };
  }
  if (!requested && !planInvalidated && !externalDrift) return { valid: true, decision: null };
  const decision = requested ? (requested.allowed === undefined ? require("./execution_policy").resolveExecutionPolicy(requested) : requested) : { allowed: false, reason: "resume state changed and requires verification" };
  session.state.policy_decisions = [...(Array.isArray(session.state.policy_decisions) ? session.state.policy_decisions : []), redactValue({ phase: "resume", decision })];
  if (decision.allowed !== true || planInvalidated || externalDrift) { session.state.status = "verification_required"; session.state.resume_check = { safe_to_resume: false, checkpoint_changed: false, requires_verification: true, reason: decision.reason || session.state.resume_check?.reason || "resume state requires verification", verified_at: null, verification_evidence_ids: [] }; }
  return { valid: decision.allowed === true && !planInvalidated && !externalDrift, decision };
}
function markSessionCrashRecovery(session, error) {
  if (!session?.state) throw new TypeError("Invalid goal session");
  session.state.status = "crash_recovery_required"; session.state.crash_recovery = { required: true, recorded_at: new Date().toISOString(), error: redactValue(error?.message || String(error)) };
  appendGoalEvent(session, { type: "crash_recovery_required", reason: session.state.crash_recovery.error }); saveGoalSession(session); return session;
}
function migrateState(state, workspaceRoot = null) {
  return { schema_version: STATE_SCHEMA_VERSION, goal_id: state.goal_id, status: state.status || "paused", workspace_root: state.workspace_root || (workspaceRoot ? path.resolve(workspaceRoot) : null), model: state.model || null, provider: state.provider || null, raw_objective_redacted: state.raw_objective_redacted || state.original_objective || null, interpreted_intent: state.interpreted_intent || null, goal_hypotheses: state.goal_hypotheses || [], assumption_ledger: state.assumption_ledger || state.assumptions || [], candidate_criteria: state.candidate_criteria || [], provisional_criteria: state.provisional_criteria || [], goal_plan_versions: state.goal_plan_versions || [], completed_steps: state.completed_steps || [], failed_steps: state.failed_steps || [], discarded_steps: state.discarded_steps || [], replanning_traces: state.replanning_traces || [], tool_observations: state.tool_observations || [], policy_decisions: state.policy_decisions || [], execution_audits: state.execution_audits || [], execution_audit_refs: state.execution_audit_refs || [], rollback_records: state.rollback_records || [], resume_provenance: state.resume_provenance || [], external_state_drift: state.external_state_drift || [], general_loop: state.general_loop || null, original_objective: state.original_objective || null, goal_plan: state.goal_plan || null, requires_user_confirmation: state.requires_user_confirmation === true, questions: state.questions || [], explicit_steps: state.explicit_steps || [], inferred_steps: state.inferred_steps || [], optional_steps: state.optional_steps || [], out_of_scope_candidates: state.out_of_scope_candidates || [], missing_information: state.missing_information || [], expansion_confidence: state.expansion_confidence ?? null, assumptions: state.assumptions || [], blockers: state.blockers || state.blocker_reports || [], alternatives: state.alternatives || state.alternative_history || [], selected_alternative: state.selected_alternative || null, approval_requests: state.approval_requests || [], resolution_attempts: state.resolution_attempts || [], verification_results: state.verification_results || state.evaluator_results || [], resumed_from: state.resumed_from || null, resume_check: state.resume_check || { safe_to_resume: true, checkpoint_changed: false, requires_verification: false, reason: null, verified_at: null, verification_evidence_ids: [] }, final_outcome: state.final_outcome || null, current_task: state.current_task || null, cycle_count: Number(state.cycle_count) || 0, task_history: state.task_history || [], action_history: state.action_history || [], evaluator_results: state.evaluator_results || [], evidence_refs: state.evidence_refs || [], checkpoints: state.checkpoints || [], approval_state: state.approval_state || "not_requested", failure_history: state.failure_history || [], recovery_history: state.recovery_history || [], model_routing: state.model_routing || [], progress_state: state.progress_state || { last_fingerprint: "", stagnant_cycles: 0, current_progress: 0, previous_progress: 0 }, token_usage: state.token_usage || { input: 0, output: 0 }, time_budget: state.time_budget || { started_at: new Date().toISOString(), elapsed_ms: 0 }, last_checkpoint_id: state.last_checkpoint_id || null, updated_at: new Date().toISOString() };
}
function loadGoalSession(workspaceRoot, goalId, options = {}) {
  const paths = goalSessionPaths(workspaceRoot, goalId); const goalSpec = readJson(paths.goal, "goal"); let state = readJson(paths.state, "state");
  if (!goalSpec || !state) throw new Error(`Goal session is missing at ${paths.root}`); assertValidGoalSpec(goalSpec);
  if (state.schema_version === 1 && options.migrate) state = migrateState(state, workspaceRoot);
  if (state.schema_version !== STATE_SCHEMA_VERSION) throw new Error(`Unsupported goal session state schema: ${state.schema_version}`);
  state = { ...state, session_id: state.session_id || `session_${goalId}`, raw_objective_redacted: state.raw_objective_redacted || state.original_objective || goalSpec.objective, interpreted_intent: state.interpreted_intent || null, goal_hypotheses: state.goal_hypotheses || [], assumption_ledger: state.assumption_ledger || state.assumptions || [], candidate_criteria: state.candidate_criteria || [], provisional_criteria: state.provisional_criteria || [], goal_plan_versions: state.goal_plan_versions || [], completed_steps: state.completed_steps || [], failed_steps: state.failed_steps || [], discarded_steps: state.discarded_steps || [], replanning_traces: state.replanning_traces || [], tool_observations: state.tool_observations || [], policy_decisions: state.policy_decisions || [], execution_audits: state.execution_audits || [], execution_audit_refs: state.execution_audit_refs || [], rollback_records: state.rollback_records || [], resume_provenance: state.resume_provenance || [], external_state_drift: state.external_state_drift || [], general_loop: state.general_loop || null, original_objective: state.original_objective || goalSpec.objective, explicit_steps: state.explicit_steps || [], inferred_steps: state.inferred_steps || [], assumptions: state.assumptions || [], blockers: state.blockers || state.blocker_reports || [], alternatives: state.alternatives || state.alternative_history || [], selected_alternative: state.selected_alternative || null, approval_requests: state.approval_requests || [], resolution_attempts: state.resolution_attempts || [], verification_results: state.verification_results || state.evaluator_results || [], resumed_from: state.resumed_from || null, resume_check: state.resume_check || { safe_to_resume: true, checkpoint_changed: false, requires_verification: false, reason: null, verified_at: null, verification_evidence_ids: [] }, final_outcome: state.final_outcome || null };
  if (state.goal_id !== goalSpec.goal_id || state.goal_id !== goalId) throw new Error("Goal session goal_id mismatch");
  if (path.resolve(state.workspace_root) !== path.resolve(workspaceRoot)) throw new Error("Goal session workspace does not match requested workspace");
  if (state.status === "completed" && !evaluationIsComplete(goalSpec, state.evaluator_results?.at(-1))) {
    state.status = "blocked";
    state.terminal_detail = { reason: "Persisted completed state lacks valid evaluator evidence" };
  }
  const resumeCheck = state.resume_check || { safe_to_resume: true, checkpoint_changed: false, requires_verification: false, reason: null };
  return { workspaceRoot: path.resolve(workspaceRoot), goalSpec, state, paths, lock: options.lock === false ? null : acquireSessionLock(paths.lock), resumeCheck };
}
function createCheckpoint(session, options = {}) {
  const checkpointId = `checkpoint_${Date.now()}_${crypto.randomBytes(6).toString("hex")}`; const tracked = fileSnapshot(session.workspaceRoot, options.trackedPaths || []);
  const checkpoint = { checkpoint_id: checkpointId, created_at: new Date().toISOString(), label: options.label || null, state: cloneRecord(session.state), tracked_files: tracked }; const filePath = path.join(session.paths.checkpoints, `${checkpointId}.json`);
  atomicWrite(filePath, redactSessionValue(checkpoint)); session.state.checkpoints.push({ checkpoint_id: checkpointId, created_at: checkpoint.created_at, path: filePath, tracked_files: tracked }); session.state.last_checkpoint_id = checkpointId; appendGoalEvent(session, { type: "checkpoint_created", checkpoint_id: checkpointId }); saveGoalSession(session); return { ...checkpoint, path: filePath };
}
function restoreCheckpoint(session, checkpointId) {
  const record = readJson(path.join(session.paths.checkpoints, `${checkpointId}.json`), "checkpoint"); if (!record || record.checkpoint_id !== checkpointId) throw new Error("Checkpoint not found");
  const changed = snapshotChanged(session.workspaceRoot, record.tracked_files); session.state = cloneRecord(record.state); session.state.last_checkpoint_id = checkpointId; appendGoalEvent(session, { type: "checkpoint_restored", checkpoint_id: checkpointId, workspace_changed: changed }); saveGoalSession(session); return { checkpoint_id: checkpointId, state: session.state, workspace_changed: changed };
}


function releaseGoalSessionLock(session) {
  if (!session || !session.lock || typeof session.lock.release !== "function") return false;
  session.lock.release();
  session.lock = null;
  return true;
}
function pauseGoalSession(session, reason = "paused") { session.state.status = "paused"; session.state.pause_reason = reason; appendGoalEvent(session, { type: "paused", reason }); saveGoalSession(session); return session; }
function resumeGoalSession(workspaceRoot, goalId, options = {}) {
  const session = loadGoalSession(workspaceRoot, goalId, options);
  if (options.model !== undefined) session.state.model = options.model;
  if (options.provider !== undefined) session.state.provider = options.provider;
  const resumeProvenance = { status: session.state.status, checkpoint_id: session.state.last_checkpoint_id || null, resumed_at: new Date().toISOString(), policy_revalidated: options.resumePolicy !== undefined || options.policyDecision !== undefined, plan_version: options.plan_version ?? session.state.general_loop?.plan?.plan_version ?? null };
  session.state.resumed_from = session.state.resumed_from || resumeProvenance;
  session.state.resume_provenance = [...(Array.isArray(session.state.resume_provenance) ? session.state.resume_provenance : []), redactValue(resumeProvenance)];
  const checkpoint = session.state.last_checkpoint_id ? readJson(path.join(session.paths.checkpoints, `${session.state.last_checkpoint_id}.json`), "checkpoint") : null;
  const changed = checkpoint ? snapshotChanged(session.workspaceRoot, checkpoint.tracked_files) : false;
  session.resumeCheck = { safe_to_resume: !changed, checkpoint_changed: changed, requires_verification: changed, reason: changed ? "Tracked files changed after checkpoint; read-only verifier must run before actions" : null, verified_at: null, verification_evidence_ids: [] };
  session.state.resume_check = session.resumeCheck;
  const policy = validateResumePolicy(session, options);
  if (!policy.valid) session.resumeCheck = session.state.resume_check;
  session.state.status = changed || !policy.valid ? "verification_required" : "running"; appendGoalEvent(session, { type: "resumed", model: session.state.model, provider: session.state.provider, resume_check: session.state.resume_check, policy_revalidated: policy.decision !== null }); saveGoalSession(session); return session;
}
function terminal(session, status, detail) { session.state.status = status; session.state.final_outcome = redactValue({ state: status, detail, completed: status === "completed" }); session.state.terminal_detail = redactValue(detail); appendGoalEvent(session, { type: status, detail }); saveGoalSession(session); return session; }
function assertCompletionEvidence(session) {
  if (!session?.goalSpec || !session?.state) throw new TypeError("Invalid goal session");
  const evaluation = Array.isArray(session.state.evaluator_results) ? session.state.evaluator_results.at(-1) : null;
  if (!evaluationIsComplete(session.goalSpec, evaluation)) {
    throw Object.assign(new Error("Goal completion requires valid evaluator evidence for every required criterion"), { code: "GOAL_COMPLETION_NOT_VERIFIED" });
  }
  return evaluation;
}
function markGoalCompleted(session, detail = {}) { assertCompletionEvidence(session); return terminal(session, "completed", detail); }
function markGoalFailed(session, detail = {}) { return terminal(session, "failed", detail); }
function markGoalEscalated(session, detail = {}) { return terminal(session, "escalated", detail); }

module.exports = { GOAL_DIRECTORY, SESSION_SCHEMA_VERSION, STATE_SCHEMA_VERSION, goalSessionPaths, createGoalSession, loadGoalSession, saveGoalSession, appendGoalEvent, createCheckpoint, restoreCheckpoint, pauseGoalSession, releaseGoalSessionLock, resumeGoalSession, markGoalCompleted, markGoalFailed, markGoalEscalated, assertCompletionEvidence, fileSnapshot, snapshotChanged, migrateState, normalizeExternalTarget, normalizeRollbackRecord, persistGeneralLoopState, recordRollback, rollbackMutation, validateResumePolicy, markSessionCrashRecovery };
