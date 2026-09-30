"use strict";

const { compileGoal, compileModelGoal, goalIdFor } = require("./compiler");
const { createGoalSpec, DEFAULT_CONSTRAINTS } = require("./spec");
const { interpretNaturalLanguageGoal } = require("./intent");
const { expandGoalGeneral } = require("./expansion_general");
const { assertValidGoalSpec } = require("./validator");
const { expandGoal } = require("./expansion");
const { createGoalPlan, validateGoalPlan, capabilitiesForSteps } = require("./plan");
const { resolveExecutionPolicy } = require("./execution_policy");

function list(value) { return Array.isArray(value) ? value : []; }
function text(value) { return typeof value === "string" && value.trim() !== ""; }
function modeOf(input, spec, plan) { return input.mode || input.execution_policy?.mode || input.execution_policy || spec?.execution_policy?.mode || plan?.execution_policy || "safe"; }
function contextOf(input, spec) {
  if (input.repository_context && typeof input.repository_context === "object") return input.repository_context;
  const odd = spec?.constraints?.repository_odd || {};
  return { repository_odd: { allowed_paths: list(odd.allowed_paths || spec?.constraints?.allowed_paths), blocked_paths: list(odd.blocked_paths || spec?.constraints?.blocked_paths), protected_paths: list(odd.protected_paths), allow_external: odd.allow_external === true } };
}
function compileGeneralInput(input) {
  if (!text(input.objective)) return { status: "clarification_required", objective: "", questions: ["Provide a non-empty objective before preparing general goal execution"] };
  const intent = interpretNaturalLanguageGoal({ objective: input.objective });
  const expansion = expandGoalGeneral(intent, { ...contextOf(input), mode: "unrestricted_general", execution_policy: { mode: "unrestricted_general" }, objective: input.objective, environment_state: input.environment_state });
  if (!expansion.goal_plan) return { status: "clarification_required", objective: input.objective, questions: expansion.missing_information || ["General goal interpretation did not produce a valid plan"], intent, expansion };
  const criteria = (expansion.goal_plan.success_criteria || []).map(item => ({ ...item, verifier: item.verifier || { type: "custom", id: `general-${item.id}`, config: { criterion: item.id, source: "general_inference" } } }));
  const spec = createGoalSpec({ schema_version: 1, goal_id: input.goal_id || goalIdFor(input.objective.trim()), objective: input.objective.trim(), success_criteria: criteria, constraints: { ...DEFAULT_CONSTRAINTS, ...(input.constraints || {}), repository_odd: input.repository_context?.repository_odd || DEFAULT_CONSTRAINTS.repository_odd }, execution_policy: { mode: "unrestricted_general" } });
  return { status: "ready", spec, source: "general-inference", intent, expansion };
}
function compileInput(input) {
  if (input.mode === "unrestricted_general" && input.general_inference === true && text(input.objective || input.goal_spec?.objective)) return compileGeneralInput({ ...input, objective: input.objective || input.goal_spec.objective });
  if (input.goal_spec && typeof input.goal_spec === "object") return { status: "ready", spec: input.goal_spec, source: "goal-spec" };
  if (text(input.objective) && Array.isArray(input.success_criteria)) {
    const constraints = { ...DEFAULT_CONSTRAINTS, ...(input.constraints || {}) };
    if (input.repository_context?.repository_odd) constraints.repository_odd = input.repository_context.repository_odd;
    const mode = modeOf(input);
    return compileModelGoal({ schema_version: 1, goal_id: input.goal_id || goalIdFor(input.objective.trim()), objective: input.objective.trim(), success_criteria: input.success_criteria, constraints, execution_policy: { mode } }, { mode });
  }
  if (text(input.objective)) return compileGoal(input.objective, { mode: modeOf(input), goalId: input.goal_id });
  return { status: "clarification_required", objective: "", questions: ["Provide a non-empty objective before preparing goal execution"] };
}
function clarification(record, extra = {}) { return { status: "clarification_required", goal_spec: null, goal_plan: null, expansion: record, execution_policy: null, requested_capabilities: [], granted_capabilities: [], denied_capabilities: [], questions: list(record.questions), requires_user_confirmation: true, ...extra }; }
function invalid(errors, extra = {}) { return { status: "invalid", goal_spec: extra.goal_spec || null, goal_plan: null, expansion: extra.expansion || null, execution_policy: null, requested_capabilities: [], granted_capabilities: [], denied_capabilities: [], questions: [], errors: list(errors), requires_user_confirmation: true, ...extra }; }
function decision(input, mode, capabilities) {
  const general = mode === "unrestricted_general" && input.config?.goal?.unrestricted_general || {};
  return resolveExecutionPolicy({ mode, capabilities, explicit_confirmation: input.explicit_confirmation === true, auto_accept: input.auto_accept === true || input.autoAccept === true, config: input.config, source: input.source || "internal", actor: input.actor, runtime_permission: input.runtime_permission === true, audit_persisted: input.audit_persisted === true, integrity_preflight: input.integrity_preflight === true, max_plan_depth: input.max_plan_depth ?? general.max_plan_depth, max_replan_count: input.max_replan_count ?? general.max_replan_count, max_assumption_count: input.max_assumption_count ?? general.max_assumption_count });
}

/** @returns {any} */
function prepareGoalExecution(input = {}) {
  /** @type {any} */ const compiled = compileInput(input);
  if (compiled.status === "clarification_required") return clarification(compiled);
  if (compiled.status !== "ready" || !compiled.spec) return invalid(compiled.errors || [{ path: "$", code: "GOAL_NOT_READY", message: `Goal specification is ${compiled.status}` }]);
  let goalSpec;
  try { assertValidGoalSpec(compiled.spec); goalSpec = compiled.spec; } catch (error) { return invalid([{ path: "$", code: "INVALID_GOAL_SPEC", message: error.message }]); }

  const existing = input.existing_goal_plan || input.goal_plan || null;
  let plan;
  let expansion;
  if (existing) {
    const validation = validateGoalPlan(existing);
    if (!validation.valid) return invalid(validation.errors, { goal_spec: goalSpec });
    if (existing.objective !== goalSpec.objective) return invalid([{ path: "goal_plan.objective", code: "PLAN_GOAL_MISMATCH", message: "Existing GoalPlan objective does not match GoalSpec" }], { goal_spec: goalSpec });
    const criterionIds = new Set(list(goalSpec.success_criteria).map(item => item?.id).filter(text));
    if (list(existing.success_criteria).some(item => item?.id && !criterionIds.has(item.id))) return invalid([{ path: "goal_plan.success_criteria", code: "PLAN_CRITERIA_MISMATCH", message: "Existing GoalPlan contains a criterion outside the GoalSpec" }], { goal_spec: goalSpec });
    plan = existing;
    expansion = { goal_plan: plan, inferred_steps: list(plan.inferred_steps), optional_steps: list(plan.inferred_steps).filter(step => step.required === false), assumptions: list(plan.assumptions), requested_capabilities: list(plan.requested_capabilities), granted_capabilities: list(plan.granted_capabilities), denied_capabilities: list(plan.denied_capabilities), questions: [], missing_information: [], out_of_scope_candidates: [], expansion_confidence: 1, requires_user_confirmation: plan.requires_explicit_confirmation === true, already_expanded: true };
  } else if (compiled.source === "general-inference" && compiled.expansion) {
    expansion = compiled.expansion;
    plan = expansion.goal_plan;
  } else {
    expansion = expandGoal({ objective: goalSpec.objective, success_criteria: goalSpec.success_criteria, repository_context: contextOf(input, goalSpec), environment_state: input.environment_state, execution_policy: modeOf(input, goalSpec), only_goal: input.only_goal });
    if (!expansion.goal_plan) return clarification(expansion, { goal_spec: goalSpec, missing_information: list(expansion.missing_information), out_of_scope_candidates: list(expansion.out_of_scope_candidates) });
    plan = expansion.goal_plan;
    const validation = validateGoalPlan(plan);
    if (!validation.valid) return invalid(validation.errors, { goal_spec: goalSpec, expansion });
  }

  const allCapabilities = [...new Set(list(plan.requested_capabilities))];
  const generalCapabilities = modeOf(input, goalSpec, plan) === "unrestricted_general" && (compiled.source === "general-inference" || input.general_inference === true) ? ["goal_inference", "criteria_inference", "plan_expansion", "replanning"] : [];
  const requiredSteps = list(plan.inferred_steps).filter(step => step.required !== false && step.status !== "deferred");
  const optionalSteps = list(plan.inferred_steps).filter(step => step.required === false);
  const optionalCapabilities = capabilitiesForSteps(optionalSteps);
  const requiredCapabilities = allCapabilities.filter(capability => !optionalCapabilities.includes(capability));
  const mode = modeOf(input, goalSpec, plan);
  const policyCapabilities = [...new Set([...(requiredCapabilities.length ? requiredCapabilities : []), ...generalCapabilities])];
  /** @type {any} */ const requiredDecision = decision(input, mode, policyCapabilities);
  /** @type {any} */ const optionalDecision = optionalCapabilities.length ? decision(input, mode, optionalCapabilities) : { allowed: true, approval_required: false, capabilities: [], granted_capabilities: [], denied_capabilities: [], mode: requiredDecision.mode, reason: "no optional capabilities requested" };
  const missingRequired = requiredCapabilities.filter(capability => !(requiredDecision.capabilities || []).includes(capability));
  const granted = [...new Set([...(requiredDecision.allowed ? requiredCapabilities : requiredDecision.granted_capabilities || []), ...(optionalDecision.allowed ? optionalCapabilities : optionalDecision.granted_capabilities || [])])];
  const denied = [...new Set([...(requiredDecision.denied_capabilities || []), ...(optionalDecision.denied_capabilities || []), ...missingRequired])];
  const planGranted = granted.filter(capability => allCapabilities.includes(capability));
  const finalPolicy = { ...requiredDecision, capabilities: [...new Set([...allCapabilities, ...generalCapabilities])], requested_capabilities: [...new Set([...allCapabilities, ...generalCapabilities])], granted_capabilities: [...new Set([...planGranted, ...generalCapabilities])], denied_capabilities: denied, allowed: requiredDecision.allowed, approval_required: requiredDecision.approval_required, optional_policy_decision: optionalDecision };
  const requiredNeedsConfirmation = requiredDecision.approval_required || denied.some(capability => requiredCapabilities.includes(capability));
  const expansionNeedsClarification = list(expansion.missing_information).length > 0 || list(expansion.out_of_scope_candidates).length > 0;
  const requiresUserConfirmation = requiredNeedsConfirmation || expansionNeedsClarification || (requiredSteps.length === 0 && expansion.requires_user_confirmation === true);

  if (!existing) {
    plan = createGoalPlan({ ...plan, granted_capabilities: planGranted, denied_capabilities: denied.filter(capability => allCapabilities.includes(capability)), requires_explicit_confirmation: finalPolicy.mode === "unrestricted" || requiresUserConfirmation });
    const validation = validateGoalPlan(plan);
    if (!validation.valid) return invalid(validation.errors, { goal_spec: goalSpec, expansion });
    expansion = { ...expansion, goal_plan: plan, inferred_steps: plan.inferred_steps, requested_capabilities: allCapabilities, granted_capabilities: plan.granted_capabilities, denied_capabilities: plan.denied_capabilities };
  }
  return { status: "ready", goal_spec: goalSpec, goal_plan: plan, expansion, interpretation: compiled.intent || null, hypotheses: list(expansion.hypotheses), assumptions: list(expansion.assumptions), candidate_criteria: list(expansion.candidate_criteria), provisional_criteria: list(expansion.candidate_criteria).filter(item => item?.provisional === true), planning_trace: list(expansion.planning_trace), execution_policy: finalPolicy, requested_capabilities: [...new Set([...allCapabilities, ...generalCapabilities])], granted_capabilities: finalPolicy.granted_capabilities, denied_capabilities: finalPolicy.denied_capabilities, questions: list(expansion.questions), requires_user_confirmation: requiresUserConfirmation, optional_steps: optionalSteps, inferred_steps: list(plan.inferred_steps), out_of_scope_candidates: list(expansion.out_of_scope_candidates), missing_information: list(expansion.missing_information), expansion_confidence: expansion.expansion_confidence ?? expansion.confidence ?? null };
}

module.exports = { prepareGoalExecution };
