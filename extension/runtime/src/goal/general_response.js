"use strict";

const { redactValue } = require("./evidence");

const GENERAL_CAPABILITIES = Object.freeze(["goal_inference", "criteria_inference", "plan_expansion", "replanning", "tool_discovery"]);
function array(value) { return Array.isArray(value) ? value : []; }
function normalizeExecutionMode(value) {
  if (value === "unrestricted-general" || value === "unrestrictedGeneral") return "unrestricted_general";
  return value || "safe";
}
function planSteps(plan) { return array(plan?.inferred_steps || plan?.steps); }
function responseProjection(session, extra = {}) {
  const state = session?.state || {};
  const plan = state.goal_plan || state.general_loop?.plan || extra.goal_plan || null;
  const planVersions = state.goal_plan_versions || state.general_loop?.plan_versions || extra.plan_versions || [];
  const steps = planSteps(plan).length ? planSteps(plan) : [...array(state.inferred_steps), ...array(state.optional_steps)];
  const completed = array(state.completed_steps).length ? state.completed_steps : array(state.general_loop?.completed_steps);
  const completedSet = new Set(completed);
  const pending = steps.filter(step => step.required !== false && !completedSet.has(step.id) && step.status !== "completed" && step.status !== "skipped").map(step => step.id).filter(Boolean);
  const criteria = plan?.success_criteria || extra.candidate_success_criteria || [];
  const provisional = criteria.filter(item => item?.provisional === true || item?.status === "provisional");
  const blockers = state.blockers || state.blocker_reports || [];
  const alternatives = state.alternatives || state.alternative_history || [];
  const blocker = blockers.at(-1) || null;
  const policy = state.execution_policy || extra.policyDecision || null;
  const audits = state.execution_audits || state.execution_audit_refs || [];
  const verification = state.resume_check?.requires_verification ? "verification_required" : state.status === "completed" ? "verified" : state.evaluator_results?.at(-1)?.completed === true ? "verified" : "pending";
  const rollbackRecords = state.rollback_records || [];
  const confidence = state.expansion_confidence ?? extra.expansion_confidence ?? state.general_loop?.confidence ?? null;
  return redactValue({
    interpretation: state.interpreted_intent || extra.interpretation || null,
    goal_hypotheses: state.goal_hypotheses || extra.goal_hypotheses || extra.hypotheses || [],
    assumptions: state.assumption_ledger || state.assumptions || extra.assumptions || [],
    candidate_success_criteria: state.candidate_criteria || extra.candidate_criteria || criteria,
    provisional_success_criteria: state.provisional_criteria || extra.provisional_criteria || provisional,
    goal_plan: plan,
    plan_versions: planVersions,
    current_plan_version: plan?.plan_version || planVersions.at(-1)?.plan_version || null,
    inferred_steps: state.inferred_steps || extra.inferred_steps || steps.filter(step => step.required !== false),
    optional_steps: state.optional_steps || extra.optional_steps || steps.filter(step => step.required === false),
    completed_steps: completed,
    pending_steps: pending,
    replanning_trace: state.replanning_traces || state.replan_history || extra.replanning_trace || [],
    tool_observations: state.tool_observations || extra.tool_observations || [],
    blocker,
    alternatives,
    recommended_action: extra.recommended_action || blocker?.recommended_alternative || state.selected_alternative || null,
    policy_decision: policy?.policy_decision || (policy?.allowed === true ? "allowed" : policy ? "denied" : "unknown"),
    execution_mode: normalizeExecutionMode(policy?.mode || extra.execution_mode),
    execution_audits: audits,
    verification_status: verification,
    rollback_status: rollbackRecords.length ? rollbackRecords.at(-1)?.rollback_status || "pending" : "not_required",
    confidence,
    next_action: extra.next_action || (state.status === "paused" ? "resume" : state.status === "verification_required" ? "run_read_only_verifier" : pending.length ? `execute:${pending[0]}` : null),
    general_capabilities: GENERAL_CAPABILITIES,
  });
}
module.exports = { GENERAL_CAPABILITIES, normalizeExecutionMode, responseProjection };
