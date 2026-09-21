"use strict";

const { runGoal } = require("./controller");
const { runGeneralGoalLoop } = require("./general_loop");
const { interpretNaturalLanguageGoal } = require("./intent");
const { evaluateGoal } = require("./evaluator");
const { observeEnvironment } = require("./environment_observer");
const { createAdapterRegistry } = require("./adapter_registry");

function array(value) { return Array.isArray(value) ? value : []; }
function isGeneralExecution(options = {}) {
  return options.mode === "unrestricted_general" && options.general_inference === true && options.general_execution !== false;
}
function intentFor(spec, options) {
  return options.interpreted_intent || options.intent || interpretNaturalLanguageGoal({ objective: spec?.objective || "" });
}
function evidenceVerifier(spec, options) {
  if (typeof options.verify === "function") return options.verify;
  if (typeof options.evaluator === "function") return async value => options.evaluator(spec, { ...options, general_result: value });
  return async value => {
    if (value?.verification?.status === "passed" && value.verification.valid === true && value.verification.executed === true) return { completed: false, results: [value.verification] };
    return evaluateGoal(spec, { repoRoot: options.workspaceRoot, changedFiles: value?.changes?.changed_files || [], commandRunner: options.commandRunner });
  };
}
function executionCallbacks(spec, options) {
  const taskExecutor = options.execute || options.taskExecutor;
  return {
    observeEnvironment: options.observeEnvironment || (options.environmentObserver ? input => options.environmentObserver(input) : async input => observeEnvironment({ workspaceRoot: options.workspaceRoot, ...(options.environment_options || {}), ...input })),
    plan: options.plan || (options.goalPlan ? async () => ({ goal_plan: options.goalPlan, status: "ready" }) : undefined),
    execute: typeof taskExecutor === "function" ? async step => taskExecutor(step.description || step.purpose || step.id, { ...options, step, goalSpec: spec }) : undefined,
    verify: evidenceVerifier(spec, options),
    replan: options.replan,
  };
}
async function executeGoal(spec, options = {}) {
  if (typeof options.runGoal === "function") return options.runGoal(spec, options);
  if (!isGeneralExecution(options)) return runGoal(spec, options);
  const intent = intentFor(spec, options);
  const callbacks = executionCallbacks(spec, options);
  const loopOptions = { ...options, ...callbacks, intent, session: options.session, goal_plan: options.goalPlan, interpreted_intent: intent, hypotheses: array(options.hypotheses || options.goalExpansion?.hypotheses), assumptions: array(options.assumptions || options.goalExpansion?.assumptions), candidate_criteria: array(options.candidate_criteria || options.goalExpansion?.candidate_criteria), provisional_criteria: array(options.provisional_criteria || options.goalExpansion?.provisional_criteria), execution_policy: options.policyDecision, adapter_registry: options.adapterRegistry || createAdapterRegistry(), tool_registry: options.toolRegistry || [], environment_observer: options.environmentObserver || null, audit_context: options.audit_context || options.policyDecision?.audit_context || null, max_cycles: options.max_cycles ?? spec.constraints?.max_cycles, max_tokens: options.max_tokens ?? spec.constraints?.max_tokens, timeout_ms: options.timeout_ms ?? spec.constraints?.timeout_ms, stagnation_limit: options.stagnation_limit ?? spec.constraints?.stagnation_limit, explicit_confirmation: options.explicit_confirmation === true, allow_general: options.runtime_permission === true && options.audit_persisted === true && options.integrity_preflight === true };
  return (options.generalLoop || runGeneralGoalLoop)(intent, loopOptions);
}

module.exports = { executeGoal, isGeneralExecution, executionCallbacks };
