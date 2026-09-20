"use strict";

const { expandGoal } = require("./expansion");
const { createBlockerReport } = require("./blocker");
const { redactValue } = require("./evidence");
const { assertValidGoalSpec } = require("./validator");
const { evaluateGoal: defaultEvaluator, evaluationIsComplete } = require("./evaluator");
const { runTask: defaultTaskExecutor } = require("./task_executor");
const { classifyFailure, failureSignature, patchSignature, detectStagnation, createTerminalResult } = require("./failure");
const { routeRole } = require("./capabilities");
const { resolveExecutionPolicy } = require("./execution_policy");
const { recoveryFor, selectBlockerRecovery, buildRecoveryTask } = require("./recovery");

function currentTime(options) { return (options.now || (() => new Date().toISOString()))(); }
function elapsedMs(startedAt, now) { return Math.max(0, new Date(now).getTime() - new Date(startedAt).getTime()); }
function tokenTotal(tokens = {}) { return (Number(tokens.input) || 0) + (Number(tokens.output) || 0); }
function normalizedPath(value) { return typeof value === "string" ? value.replace(/\\/g, "/").replace(/^\.\//, "") : ""; }
function pathAllowed(file, constraints) {
  const candidate = normalizedPath(file);
  if (!candidate || candidate.split("/").includes("..") || candidate.startsWith("/")) return false;
  const blocked = (constraints.blocked_paths || []).map(normalizedPath);
  const allowed = (constraints.allowed_paths || []).map(normalizedPath);
  if (blocked.some(prefix => candidate === prefix || candidate.startsWith(`${prefix}/`))) return false;
  return allowed.length === 0 || allowed.some(prefix => candidate === prefix || candidate.startsWith(`${prefix}/`));
}
function selectRemaining(spec, evaluation) {
  const remaining = new Set([...(evaluation?.remaining_criteria || []), ...(evaluation?.unknown_criteria || [])]);
  return spec.success_criteria.filter(criterion => remaining.has(criterion.id));
}
function safeTaskProposal(proposal, remaining) {
  const value = typeof proposal === "string" ? { next_task: proposal } : proposal && typeof proposal === "object" ? proposal : {};
  const task = typeof value.next_task === "string" ? value.next_task.trim() : "";
  const target = Array.isArray(value.target_criteria) ? value.target_criteria.filter(id => typeof id === "string") : [];
  const remainingIds = new Set(remaining.map(criterion => criterion.id));
  if (!task) return { valid: false, reason: "Task proposal is empty" };
  if (target.length > 0 && !target.some(id => remainingIds.has(id))) return { valid: false, reason: "Task proposal does not target a remaining criterion" };
  return { valid: true, task, target_criteria: target, rationale: value.rationale, expected_verification: Array.isArray(value.expected_verification) ? value.expected_verification : [], done: value.done === true };
}
function progressFromEvaluation(evaluation) {
  return evaluation?.criteria ? evaluation.criteria.filter(item => item.status === "passed").length : 0;
}
function failureRecordFromHistory(item = {}) {
  const result = item.result && typeof item.result === "object" ? item.result : item;
  const failureCategory = item.failure_category || classifyFailure({ ...result, task: item.task });
  const record = {
    task: item.task,
    status: item.status || result.status || "failure",
    failure_category: failureCategory,
    verifier_id: item.verifier_id,
    error: item.error || result.error || result.verification?.error || result.verification?.output,
    patch_signature: item.patch_signature || patchSignature(result),
    evidence_ids: Array.isArray(item.evidence_ids) ? item.evidence_ids : (Array.isArray(result.evidence) ? result.evidence.map(evidence => evidence.evidence_id).filter(Boolean) : []),
  };
  return { ...record, signature: item.signature || failureSignature(record) };
}

class GoalController {
  constructor(goalSpec, options = {}) {
    assertValidGoalSpec(goalSpec);
    this.goal = goalSpec;
    this.options = options;
    this.session = options.session || null;
    this.evaluator = options.evaluator || defaultEvaluator;
    this.taskExecutor = options.taskExecutor || defaultTaskExecutor;
    this.taskProposer = options.taskProposer || defaultTaskProposer;
    this.escalationEngine = options.escalationEngine || null;
    const requestedMode = options.mode || options.execution_policy?.mode || goalSpec.execution_policy?.mode || options.execution_policy || "safe";
    const requestedCapabilities = options.capabilities || options.execution_capabilities || ["read", "inspect", "verify"];
    this.policyDecision = resolveExecutionPolicy({ mode: requestedMode, capabilities: requestedCapabilities, explicit_confirmation: options.explicit_confirmation === true, auto_accept: options.auto_accept === true || options.autoAccept === true, source: options.source || "internal", actor: options.actor, config: options.config });
    this.options = /** @type {Record<string, any>} */ ({ ...options, mode: this.policyDecision.mode, policyDecision: this.policyDecision });
    this.startedAt = currentTime(options);
    const initial = options.initialState || options.session?.state || null;
    const progressState = initial?.progress_state && typeof initial.progress_state === "object" ? initial.progress_state : {};
    // A persisted completed state must be revalidated by the evaluator on the next run.
    this.state = initial?.status && initial.status !== "paused" && initial.status !== "completed" ? initial.status : "created";
    this.cycleCount = Number(initial?.cycle_count) || 0;
    this.tokenUsage = { input: Number(initial?.token_usage?.input) || 0, output: Number(initial?.token_usage?.output) || 0 };
    this.currentTask = initial?.current_task || null;
    this.evaluation = initial?.evaluator_results?.at(-1) || null;
    this.taskHistory = (Array.isArray(initial?.task_history) ? initial.task_history : []).map(item => item && typeof item === "object" ? { ...item, patch_signature: item.patch_signature || (item.result ? patchSignature(item.result) : "") } : item);
    this.actionHistory = Array.isArray(initial?.action_history) ? initial.action_history : [];
    this.evaluatorResults = Array.isArray(initial?.evaluator_results) ? initial.evaluator_results : [];
    this.evidence = Array.isArray(initial?.evidence) ? initial.evidence : [];
    this.taskCounts = new Map();
    for (const item of this.taskHistory) if (typeof item?.task === "string") this.taskCounts.set(item.task, (this.taskCounts.get(item.task) || 0) + 1);
    this.failureCounts = new Map();
    this.failureCategoryCounts = new Map();
    this.failureHistory = (Array.isArray(initial?.failure_history) && initial.failure_history.length > 0 ? initial.failure_history : this.taskHistory.filter(item => item?.success !== true && item?.status !== "success")).map(failureRecordFromHistory);
    for (const failure of this.failureHistory) {
      const key = failure.signature || failureSignature(failure);
      this.failureCounts.set(key, (this.failureCounts.get(key) || 0) + 1);
      if (failure.failure_category) this.failureCategoryCounts.set(failure.failure_category, (this.failureCategoryCounts.get(failure.failure_category) || 0) + 1);
    }
    this.recoveryHistory = Array.isArray(initial?.recovery_history) ? initial.recovery_history : [];
    this.blockerReports = Array.isArray(initial?.blocker_reports) ? initial.blocker_reports : [];
    this.alternativeHistory = Array.isArray(initial?.alternative_history) ? initial.alternative_history : [];
    this.activeRecovery = null;
    this.modelRouting = Array.isArray(initial?.model_routing) ? initial.model_routing : [];
    this.currentProgress = Number.isFinite(progressState.current_progress) ? progressState.current_progress : progressFromEvaluation(this.evaluation);
    this.previousProgress = Number.isFinite(progressState.previous_progress) ? progressState.previous_progress : this.currentProgress;
    const lastTask = this.taskHistory.at(-1);
    const lastPatch = lastTask?.patch_signature || (lastTask?.result ? patchSignature(lastTask.result) : "");
    const fallbackFingerprint = lastTask ? JSON.stringify({ evaluation: this.evaluation?.criteria, task: lastTask.task, result: lastTask.status, success: lastTask.success === true, patch: lastPatch }) : "";
    this.lastFingerprint = typeof progressState.last_fingerprint === "string" ? progressState.last_fingerprint : fallbackFingerprint;
    this.stagnantCycles = Number.isSafeInteger(progressState.stagnant_cycles) && progressState.stagnant_cycles >= 0 ? progressState.stagnant_cycles : 0;
    if (!progressState.last_fingerprint && this.taskHistory.length > 0) {
      const recent = this.taskHistory.slice(-2);
      if (recent.length === 2 && JSON.stringify(recent[0]) === JSON.stringify(recent[1])) this.stagnantCycles = Math.max(this.stagnantCycles, 1);
    }
    this.forcedTask = null;
  }

  limits() {
    const c = this.goal.constraints;
    return { maxCycles: c.max_cycles, maxTokens: c.max_tokens || 0, timeoutMs: c.timeout_ms || 0, stagnationLimit: c.stagnation_limit || 3, sameTaskLimit: c.same_task_limit || 2, sameFailureLimit: c.same_failure_limit || 2, maxChangedFiles: c.max_changed_files || 20, maxRetries: (this.options.maxRetries ?? this.options.execution?.max_retries ?? c.same_failure_limit ?? 2) };
  }

  persistSession(eventType = "state_updated") {
    if (!this.session) return;
    const { saveGoalSession, appendGoalEvent } = require("./session");
    this.session.state.status = this.state === "created" ? "running" : this.state;
    this.session.state.original_objective = this.goal.objective;
    this.session.state.explicit_steps = this.options.goalPlan?.explicit_steps || this.session.state.explicit_steps || [];
    this.session.state.inferred_steps = this.options.goalExpansion?.inferred_steps || this.session.state.inferred_steps || [];
    this.session.state.assumptions = this.options.goalExpansion?.assumptions || this.session.state.assumptions || [];
    this.session.state.blockers = this.blockerReports;
    this.session.state.alternatives = this.alternativeHistory;
    this.session.state.selected_alternative = this.alternativeHistory.at(-1)?.alternative_id || null;
    this.session.state.approval_requests = this.alternativeHistory.map(item => item.approval_request).filter(Boolean);
    this.session.state.resolution_attempts = this.alternativeHistory;
    this.session.state.verification_results = this.evaluatorResults;
    this.session.state.current_task = this.currentTask;
    this.session.state.cycle_count = this.cycleCount;
    this.session.state.task_history = this.taskHistory;
    this.session.state.action_history = this.actionHistory;
    this.session.state.evaluator_results = this.evaluatorResults;
    this.session.state.evidence_refs = this.evidence.map(item => item.evidence_id).filter(Boolean);
    this.session.state.failure_history = this.failureHistory;
    this.session.state.recovery_history = this.recoveryHistory;
    this.session.state.blocker_reports = this.blockerReports;
    this.session.state.alternative_history = this.alternativeHistory;
    this.session.state.model_routing = this.modelRouting;
    this.session.state.execution_policy = this.policyDecision;
    this.session.state.progress_state = { last_fingerprint: this.lastFingerprint, stagnant_cycles: this.stagnantCycles, current_progress: this.currentProgress || 0, previous_progress: this.previousProgress || 0 };
    this.session.state.token_usage = this.tokenUsage;
    this.session.state.model = this.options.model || this.session.state.model;
    this.session.state.provider = this.options.provider || this.session.state.provider;
    this.session.state.final_outcome = this.state === "completed" || ["escalate", "blocked", "failed", "timeout", "token_limit", "max_cycles", "stagnation", "repetition", "verification_required"].includes(this.state) ? { state: this.state, completed: this.state === "completed", cycle_count: this.cycleCount, selected_alternative: this.alternativeHistory.at(-1)?.alternative_id || null } : this.session.state.final_outcome || null;
    saveGoalSession(this.session);
    appendGoalEvent(this.session, { type: eventType, state: this.session.state.status, cycle: this.cycleCount, current_task: this.currentTask });
  }

  async observe() {
    const now = currentTime(this.options);
    const limit = this.limits();
    if (limit.timeoutMs > 0 && elapsedMs(this.startedAt, now) >= limit.timeoutMs) { this.state = "timeout"; return null; }
    this.evaluation = await this.evaluator(this.goal, { ...this.options, currentTask: this.currentTask, cycle: this.cycleCount });
    this.evaluatorResults.push(this.evaluation);
    this.evidence.push(...(Array.isArray(this.evaluation.evidence) ? this.evaluation.evidence : []));
    const progress = this.evaluation?.criteria ? this.evaluation.criteria.filter(item => item.status === "passed").length : 0;
    this.currentProgress = progress;
    this.persistSession("evaluation_recorded");
    return this.evaluation;
  }

  resumeVerification(evaluation) {
    const resumeCheck = this.session?.state?.resume_check;
    if (!resumeCheck?.requires_verification) return true;
    const evidence = new Map((Array.isArray(evaluation?.evidence) ? evaluation.evidence : []).map(item => [item.evidence_id, item]));
    const verified = this.goal.success_criteria.filter(criterion => criterion.required).every(criterion => {
      const result = evaluation?.criteria?.find(item => item.id === criterion.id);
      return result?.status === "passed" && Array.isArray(result.evidence_ids) && result.evidence_ids.length > 0 && result.evidence_ids.every(id => evidence.get(id)?.valid === true && evidence.get(id)?.executed === true && evidence.get(id)?.execution?.executed === true);
    });
    if (!verified) {
      this.state = "verification_required";
      this.actionHistory.push({ action: "resume_verification_required", reason: resumeCheck.reason || "Read-only verifier evidence is required before resumed actions" });
      return false;
    }
    const completedAt = currentTime(this.options);
    const updated = { ...resumeCheck, safe_to_resume: true, requires_verification: false, verified_at: completedAt, verification_evidence_ids: [...evidence.keys()] };
    this.session.state.resume_check = updated;
    this.session.resumeCheck = updated;
    this.actionHistory.push({ action: "resume_verification_passed", verification_evidence_ids: updated.verification_evidence_ids });
    return true;
  }

  checkEvaluation(evaluation) {
    const alternativeEntry = this.alternativeHistory.at(-1);
    if (evaluationIsComplete(this.goal, evaluation)) {
      if (alternativeEntry && ["running", "delegated_to_recovery"].includes(alternativeEntry.execution_status)) { alternativeEntry.execution_status = "completed"; alternativeEntry.verification_status = "passed"; }
      this.state = "completed";
      if (this.activeRecovery && this.activeRecovery.status === "executed") {
        this.activeRecovery.status = "completed";
        this.activeRecovery.recovery_status = "completed";
      }
      return true;
    }
    if (this.activeRecovery && this.activeRecovery.status === "executed" && this.currentTask && this.taskHistory.at(-1)?.success !== true) {
      this.activeRecovery.status = "failed";
      this.activeRecovery.recovery_status = "failed";
    }
    return false;
  }

  checkLimits() {
    const limit = this.limits();
    if (limit.timeoutMs > 0 && elapsedMs(this.startedAt, currentTime(this.options)) >= limit.timeoutMs) { this.state = "timeout"; return true; }
    if (limit.maxTokens > 0 && tokenTotal(this.tokenUsage) >= limit.maxTokens) { this.state = "token_limit"; return true; }
    if (this.cycleCount >= limit.maxCycles) { this.state = "max_cycles"; return true; }
    if (this.stagnantCycles >= limit.stagnationLimit) { this.state = "stagnation"; return true; }
    return false;
  }

  async propose(remaining) {
    if (this.forcedTask) {
      const forced = this.forcedTask;
      this.forcedTask = null;
      const safeForced = safeTaskProposal({ next_task: forced.task, target_criteria: forced.target_criteria, rationale: forced.rationale, expected_verification: forced.expected_verification }, remaining);
      if (this.activeRecovery) {
        this.activeRecovery.status = safeForced.valid ? "executed" : "failed";
        this.activeRecovery.recovery_status = this.activeRecovery.status;
      }
      this.actionHistory.push({ cycle: this.cycleCount + 1, action: "recovery_task", recovery_action: forced.action, alternative_id: forced.alternative_id || null, target_criteria: forced.target_criteria });
      const alternativeEntry = this.alternativeHistory.at(-1);
      if (alternativeEntry && forced.alternative_id && alternativeEntry.alternative_id === forced.alternative_id) alternativeEntry.execution_status = safeForced.valid ? "running" : "rejected";
      return safeForced;
    }
    const proposal = await this.taskProposer(this.goal, remaining, this.evaluation, { cycle: this.cycleCount, history: this.taskHistory, goalExpansion: this.options.goalExpansion, expansion: this.options.expansion });
    const safe = safeTaskProposal(proposal, remaining);
    this.actionHistory.push({ cycle: this.cycleCount + 1, action: "propose_task", proposal: { ...safe, model_done: proposal?.done === true } });
    return safe;
  }


  diagnoseBlocker(task, proposal, result, failureRecord) {
    if (result?.success === true) return { report: null, selection: null };
    const report = createBlockerReport({
      category: failureRecord.failure_category === "verification_failure" ? undefined : failureRecord.failure_category,
      stage: failureRecord.failure_stage || result?.stage || "environment",
      cause: failureRecord.error || "task executor reported failure",
      affected_step: task,
      evidence: result?.evidence || result?.cycle_evidence || [],
      retryable: failureRecord.failure_category === "timeout" || failureRecord.failure_category === "environment_failure",
      execution_policy: this.options.mode || this.options.execution_policy || this.goal.execution_policy,
      command: result?.verification?.command,
    });
    this.blockerReports.push(report);
    if (this.escalationEngine?.recordBlockerOutcome) {
      const escalation = this.escalationEngine.recordBlockerOutcome(this.goal.goal_id, report);
      if (escalation.humanEscalation) this.actionHistory.push({ cycle: this.cycleCount, action: "human_escalation_required", blocker_id: report.blocker_id, reason: escalation.reason });
    }
    const selection = selectBlockerRecovery(report, {
      execution_policy: this.options.mode || this.options.execution_policy || this.goal.execution_policy,
      explicit_confirmation: this.options.explicit_confirmation === true,
      auto_accept: this.options.auto_accept === true || this.options.autoAccept === true,
      actor: this.options.actor,
      used_alternative_ids: this.alternativeHistory.map(item => item.alternative_id).filter(Boolean),
      used_patch_signatures: this.taskHistory.map(item => item.patch_signature).filter(Boolean),
    });
    this.alternativeHistory.push({ blocker_id: report.blocker_id, alternative_id: selection.alternative?.alternative_id || null, execution_policy: selection.alternative?.execution_policy || null, status: selection.status, reason: selection.reason, approval_request: selection.approval_request || null, resume_action: selection.approval_request?.resume_action || (selection.status === "selected" ? "Run verifier after the alternative completes" : "Call minitok_goal_resume after approval and required operator checks"), execution_status: selection.status === "selected" ? "delegated_to_recovery" : selection.status, verification_status: "pending" });
    this.actionHistory.push({ cycle: this.cycleCount, action: "blocker_diagnosed", blocker_id: report.blocker_id, category: report.category, recommended_alternative: report.recommended_alternative, selected_alternative: selection.alternative?.alternative_id || null, selection_status: selection.status, reason: selection.reason });
    if (selection.status !== "selected") this.state = "escalate";
    return { report, selection };
  }

  async execute(task, proposal) {
    const count = (this.taskCounts.get(task) || 0) + 1;
    this.taskCounts.set(task, count);
    if (count > this.limits().sameTaskLimit) { this.state = "repetition"; return null; }
    this.currentTask = task;
    this.cycleCount += 1;
    const result = await this.taskExecutor(task, { ...this.options, cycle: this.cycleCount, target_criteria: proposal.target_criteria });
    const tokens = result?.tokens || {};
    this.tokenUsage.input += Number(tokens.input) || 0;
    this.tokenUsage.output += Number(tokens.output) || 0;
    const failureCategory = result?.success ? null : classifyFailure({ ...result, task });
    const terminal = createTerminalResult(result, { valid_evidence: result?.success === true && result?.terminal_status === "completed" });
    const failureRecord = { task, status: result?.status || "failure", terminal_status: terminal.terminal_status, failure_stage: terminal.failure_stage, failure_category: failureCategory, verifier_id: proposal.expected_verification?.[0], error: result?.error || result?.verification?.error || result?.verification?.output, patch_signature: patchSignature(result), evidence_ids: [...(result?.evidence?.map(item => item.evidence_id).filter(Boolean) || []), ...(result?.cycle_evidence?.map(item => item.evidence_id).filter(Boolean) || [])] };
    const failureKey = failureSignature(failureRecord);
    if (!result?.success) { this.failureCounts.set(failureKey, (this.failureCounts.get(failureKey) || 0) + 1); this.failureCategoryCounts.set(failureCategory, (this.failureCategoryCounts.get(failureCategory) || 0) + 1); this.failureHistory.push({ ...failureRecord, signature: failureKey }); }
    const blockerDecision = this.diagnoseBlocker(task, proposal, result, failureRecord);
    const blockerAlternative = blockerDecision.selection?.status === "selected" ? blockerDecision.selection.alternative : null;
    const recovery = failureCategory ? recoveryFor(failureCategory) : null;
    if (result?.success && Array.isArray(result.changes?.changed_files)) {
      const changedFiles = result.changes.changed_files;
      if (changedFiles.length > this.limits().maxChangedFiles) { this.state = "blocked"; result.status = "blocked"; result.error = "Changed file limit exceeded"; }
      else if (changedFiles.some(file => !pathAllowed(file, this.goal.constraints))) { this.state = "blocked"; result.status = "blocked"; result.error = "Changed file path violates GoalSpec constraints"; }
    }
    this.taskHistory.push({ cycle: this.cycleCount, task, target_criteria: proposal.target_criteria, status: result?.status || "failure", success: result?.success === true, patch_signature: failureRecord.patch_signature, result });
    this.actionHistory.push({ cycle: this.cycleCount, action: "execute_task", task, target_criteria: proposal.target_criteria, failure_category: failureCategory, recovery_action: recovery?.action || null });
    const fingerprint = JSON.stringify({ evaluation: this.evaluation?.criteria, task, result: result?.status, success: result?.success, patch: failureRecord.patch_signature });
    this.stagnantCycles = fingerprint === this.lastFingerprint ? this.stagnantCycles + 1 : 0;
    this.lastFingerprint = fingerprint;
    const stagnation = detectStagnation({ taskHistory: [...this.taskHistory, failureRecord], currentProgress: this.currentProgress || 0, previousProgress: this.previousProgress || 0, limit: this.limits().stagnationLimit });
    this.previousProgress = this.currentProgress || 0;
    if (stagnation.stagnant) this.stagnantCycles += 1;
    const repeated = [...this.failureCounts.values()].some(countValue => countValue >= this.limits().sameFailureLimit) || this.stagnantCycles >= this.limits().stagnationLimit;
    const effectiveRecovery = repeated ? recoveryFor("repeated_failure") : recovery;
    const modelBefore = this.options.model ?? this.session?.state?.model ?? null;
    const pipelineInternalRecovery = Boolean(result?.recovery?.scheduled || result?.recovery?.task_generated || Array.isArray(result?.cycles) && result.cycles.length > 1);
    if (this.activeRecovery && this.activeRecovery.status === "executed") {
      this.activeRecovery.recovery_patch_signature = failureRecord.patch_signature;
    }
    if (this.activeRecovery && this.activeRecovery.status === "executed" && !result?.success) {
      this.activeRecovery.status = "failed";
      this.activeRecovery.recovery_status = "failed";
    }
    const recoveryChanges = result?.changes?.changes || result?.changes?.changed_files || [];
    if (this.activeRecovery && result?.success === true && Array.isArray(recoveryChanges) && recoveryChanges.length > 0 && this.activeRecovery.previous_patch_signature && failureRecord.patch_signature === this.activeRecovery.previous_patch_signature) {
      this.activeRecovery.status = "failed";
      this.activeRecovery.recovery_status = "failed";
      this.activeRecovery.same_patch_repeated = true;
      this.activeRecovery.same_patch_rejected = true;
      result.success = false;
      result.status = "failure";
      this.state = "repeated_failure";
    }
    if (this.options.recoveryEnabled !== false && !result?.success && effectiveRecovery && this.cycleCount < this.limits().maxCycles) {
      let selectedModel = null;
      if (effectiveRecovery.action === "switch_model") {
        try {
          selectedModel = routeRole(this.options.models || [], effectiveRecovery.role, { exclude: [this.options.model], minimum: { error_recovery: "medium" } });
          this.options.model = selectedModel.model;
          this.options.provider = selectedModel.provider;
          this.modelRouting.push({ role: effectiveRecovery.role, provider: selectedModel.provider, model: selectedModel.model, reason: failureCategory });
        } catch (error) {
          this.state = "escalate";
          this.recoveryHistory.push({ failure_category: failureCategory, recovery_action: effectiveRecovery.action, recovery_task: null, previous_task: task, previous_patch_signature: failureRecord.patch_signature, recovery_patch_signature: null, model_before: modelBefore, model_after: null, recovery_status: "escalated", status: "escalated", pipeline_internal_recovery: pipelineInternalRecovery, controller_recovery: true, action: effectiveRecovery.action, error: error.message });
        }
      }
      if (this.state !== "escalate" && (repeated || this.failureCounts.get(failureKey) <= this.limits().maxRetries)) {
        const recoveryTask = blockerAlternative ? `Recovery alternative ${blockerAlternative.alternative_id}: ${blockerAlternative.description}. ${blockerAlternative.rationale}` : buildRecoveryTask(failureRecord, { previous_tasks: this.taskHistory.map(item => item.task), previous_patch_signatures: this.taskHistory.map(item => item.patch_signature).filter(Boolean) });
        this.forcedTask = { task: recoveryTask, target_criteria: proposal.target_criteria, expected_verification: proposal.expected_verification, rationale: blockerAlternative?.rationale || effectiveRecovery.detail, action: effectiveRecovery.action, alternative_id: blockerAlternative?.alternative_id || null };
        const recoveryEntry = { failure_category: failureCategory, recovery_action: effectiveRecovery.action, recovery_task: recoveryTask, previous_task: task, previous_patch_signature: failureRecord.patch_signature, recovery_patch_signature: null, model_before: modelBefore, model_after: selectedModel?.model || this.options.model || this.session?.state?.model || null, recovery_status: "scheduled", status: "scheduled", same_patch_repeated: false, same_patch_rejected: false, pipeline_internal_recovery: pipelineInternalRecovery, controller_recovery: true, action: effectiveRecovery.action, task: recoveryTask, model: selectedModel?.model || this.options.model || null };
        this.recoveryHistory.push(recoveryEntry);
        this.activeRecovery = recoveryEntry;
        this.state = "running";
      }
    }
    if (!this.forcedTask && ["created", "running", "repeated_failure"].includes(this.state)) this.state = repeated ? (this.stagnantCycles >= this.limits().stagnationLimit ? "stagnation" : "repeated_failure") : this.state;
    if (this.activeRecovery && !result?.success && this.state !== "running") {
      this.activeRecovery.status = this.state === "escalate" ? "escalated" : "failed";
      this.activeRecovery.recovery_status = this.activeRecovery.status;
    }
    this.persistSession("task_recorded");
    return result;
  }

  async run() {
    try {
      while (this.state !== "completed") {
        const evaluation = await this.observe();
        if (this.state === "timeout") break;
        if (!this.resumeVerification(evaluation)) break;
        if (this.checkEvaluation(evaluation)) break;
        if (this.checkLimits()) break;
        const remaining = selectRemaining(this.goal, evaluation || {});
        if (!remaining.length) { this.state = "blocked"; break; }
        let proposal;
        try { proposal = await this.propose(remaining); } catch (error) { this.state = "escalate"; this.actionHistory.push({ action: "propose_error", error: error.message }); break; }
        if (!proposal.valid) { this.state = "blocked"; this.actionHistory.push({ action: "blocked_proposal", reason: proposal.reason }); break; }
        if (this.checkLimits()) break;
        try { await this.execute(proposal.task, proposal); } catch (error) { this.taskHistory.push({ cycle: this.cycleCount + 1, task: proposal.task, status: "failure", success: false, error: error.message }); this.state = "recover"; }
        if (["repetition", "repeated_failure", "blocked", "recover", "escalate"].includes(this.state)) break;
      }
      this.persistSession("controller_terminal");
      return this.result();
    } finally {
      if (this.options.releaseSessionOnExit === true && this.session?.lock?.release) {
        this.session.lock.release();
        this.session.lock = null;
      }
    }
  }

  result() {
    const legacy = { goal_id: this.goal.goal_id, completed: this.state === "completed", state: this.state, state_version: 4, cycle_count: this.cycleCount, current_task: this.currentTask, task_history: this.taskHistory, action_history: this.actionHistory, evaluator_results: this.evaluatorResults, evaluation: this.evaluation, evidence: this.evidence, failure_history: this.failureHistory, recovery_history: this.recoveryHistory, model_routing: this.modelRouting, token_usage: this.tokenUsage, started_at: this.startedAt, evaluated_at: currentTime(this.options), approval_state: this.options.approvalState || "not_requested" };
    const terminal = createTerminalResult({ ...legacy, completed: this.state === "completed", blocked: this.state === "blocked", humanEscalation: ["escalate", "escalated"].includes(this.state), recovery_scheduled: this.recoveryHistory.some(item => item.status === "scheduled" && this.state === "running"), recovery_failed: this.state === "recover" && this.failureHistory.length > 0, stagnantCycles: this.stagnantCycles }, { state: this.state, stagnantCycles: this.stagnantCycles, valid_evidence: this.state === "completed" && evaluationIsComplete(this.goal, this.evaluation) });
    const approved = this.failureHistory.some(item => item.status === "success");
    const partial = this.state !== "completed" && approved;
    return redactValue({ ...legacy, ...terminal, partial, approved, blocker_reports: this.blockerReports, alternative_history: this.alternativeHistory });
  }
}

async function defaultTaskProposer(goal, remaining, _evaluation, options = {}) {
  const expansionInput = options.goalExpansion || options.expansion;
  if (expansionInput) {
    const expansion = expansionInput.goal_plan ? expansionInput : expandGoal({ objective: goal.objective, success_criteria: goal.success_criteria, repository_context: { repository_odd: goal.constraints.repository_odd || {} }, environment_state: options.environmentState, execution_policy: goal.execution_policy, ...expansionInput });
    const candidate = expansion.inferred_steps.find(step => step.required === true && step.status !== "deferred" && step.target_criteria.some(id => remaining.some(item => item.id === id)));
    if (candidate) return { next_task: candidate.description, target_criteria: candidate.target_criteria, expected_verification: candidate.verification?.id ? [candidate.verification.id] : [], rationale: candidate.rationale, goal_plan: expansion.goal_plan, inferred_step_id: candidate.id, requires_user_confirmation: expansion.requires_user_confirmation };
  }
  const criterion = remaining[0];
  return { next_task: `Address criterion: ${criterion.description}`, target_criteria: [criterion.id], expected_verification: [criterion.verifier.id], rationale: "Work on the first remaining criterion" };
}

async function runGoal(goalSpec, options = {}) { return new GoalController(goalSpec, options).run(); }

module.exports = { GoalController, runGoal, selectRemaining, safeTaskProposal };
