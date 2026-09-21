"use strict";

const { runGoal } = require("./controller");
const { runGeneralGoalLoop } = require("./general_loop");
const { interpretNaturalLanguageGoal } = require("./intent");
const { evaluateGoal } = require("./evaluator");
const { observeEnvironment, isObservationStale, preflightEnvironment } = require("./environment_observer");
const { createAdapterRegistry, executeAdapter, adapterFailureToBlockerInput, getAdapter } = require("./adapter_registry");
const { redactValue } = require("./evidence");

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
async function routeGeneralStep(step, context = {}, options = {}) {
  const observation = context.environment || {};
  const requirements = { commands: step.required_commands || step.verification?.commands || [], tools: step.required_tools || [], external: step.external === true || step.side_effects?.includes?.("external_call") };
  const preflight = preflightEnvironment(observation, requirements, { capabilities: options.capabilities, external_capability: options.external_capability === true, now: Date.now() });
  if (!preflight.ready) return redactValue({ status: "blocked", success: false, executed: false, category: preflight.reasons.some(item => /stale/.test(item)) ? "environment_failure" : preflight.reasons.some(item => /capability|approval/.test(item)) ? "missing_capability" : "tool_unavailable", reason: preflight.reasons.join("; "), step_id: step.id, blocker: { category: preflight.reasons.some(item => /stale/.test(item)) ? "environment_failure" : "tool_unavailable", reasons: preflight.reasons } });
  const adapterName = step.adapter || step.adapter_name;
  if (adapterName) {
    const adapter = getAdapter(options.adapterRegistry, adapterName);
    if (!adapter) return redactValue({ status: "blocked", success: false, executed: false, category: "tool_unavailable", code: "ADAPTER_NOT_FOUND", reason: `adapter not found: ${adapterName}`, step_id: step.id });
    const externalAdapter = adapter.side_effects?.includes?.("external_call") || adapter.execution_policy === "authorized_external" || adapter.execution_policy === "unrestricted";
    if (externalAdapter && !(options.external_capability === true && options.explicit_confirmation === true && options.runtime_permission === true && options.audit_persisted === true && options.integrity_preflight === true)) return redactValue({ status: "blocked", success: false, executed: false, category: "permission_blocked", code: "EXTERNAL_CAPABILITY_REQUIRED", reason: "external adapter requires explicit capability, confirmation, runtime permission, audit persistence, and integrity preflight", step_id: step.id });
    const result = executeAdapter(options.adapterRegistry, adapterName, step.adapter_input || step.inputs || {}, { ...options, environment_observation: observation, capabilities: options.capabilities || [], external_capability: options.external_capability === true, production_adapter_opt_in: options.production_adapter_opt_in === true, audit_persisted: options.audit_persisted === true, integrity_preflight: options.integrity_preflight === true });
    if (result.completed === true) return redactValue({ ...result, status: "passed", success: true, valid: true, executed: true, step_id: step.id, verification: { status: "passed", valid: true, executed: true, evidence: (Array.isArray(result.verifier_evidence) ? result.verifier_evidence : Array.isArray(result.evidence) ? result.evidence : []).find(item => item?.valid === true && item?.executed === true) || null } });
    const failure = adapterFailureToBlockerInput(result, { step_id: step.id });
    return redactValue({ ...result, step_id: step.id, category: failure.category, blocker: failure });
  }
  if (typeof options.taskExecutor !== "function") return redactValue({ status: "blocked", success: false, executed: false, category: "environment_failure", code: "TASK_EXECUTOR_MISSING", reason: "injected executor is required", step_id: step.id });
  return options.taskExecutor(step.description || step.purpose || step.id, { ...options, step, environment: observation });
}
function executionCallbacks(spec, options) {
  const taskExecutor = options.execute || options.taskExecutor;
  const rawObserver = options.observeEnvironment || (options.environmentObserver ? input => options.environmentObserver(input) : async input => observeEnvironment({ workspaceRoot: options.workspaceRoot, ...(options.environment_options || {}), ...input }));
  const observeFresh = async input => { let observation = await rawObserver(input); if (isObservationStale(observation, Date.now())) observation = await rawObserver({ ...input, reobserve: true }); return observation; };
  return {
    observeEnvironment: observeFresh,
    plan: options.plan || (options.goalPlan ? async () => ({ goal_plan: options.goalPlan, status: "ready" }) : undefined),
    execute: async (step, context) => routeGeneralStep(step, context, { ...options, taskExecutor }),
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
