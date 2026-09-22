"use strict";

const { performance } = require("node:perf_hooks");
const { generateGoalSpecFromModel } = require("./model_adapter");
const { interpretNaturalLanguageGoal } = require("./intent");
const { expandGoalGeneral } = require("./expansion_general");
const { validateGoalPlan } = require("./plan");
const { redactValue } = require("./evidence");

const EVALUATION_SCHEMA_VERSION = 1;
const MEASUREMENT_STATUSES = Object.freeze(["deterministic_offline", "deterministic_local"]);
const CLAIM_BOUNDARY = "Local deterministic provider evaluation evidence only; no live-provider, production, or product-superiority claim.";
const REQUIRED_METRICS = Object.freeze(["structured_output_success", "intent_interpretation_quality", "criteria_inference_quality", "plan_validity", "tool_action_proposal_success", "recovery_decision_quality", "false_completion_rate", "unsafe_action_execution_rate", "invalid_evidence_completion_rate", "secret_redaction_rate"]);
function plain(value) { if (!value || typeof value !== "object" || Array.isArray(value)) return false; const proto = Object.getPrototypeOf(value); return proto === Object.prototype || proto === null; }
function num(value, fallback = 0) { return Number.isFinite(Number(value)) ? Number(value) : fallback; }
function modeOf(options = {}) { const mode = options.measurement_status || options.mode || "deterministic_offline"; if (!MEASUREMENT_STATUSES.includes(mode)) throw new Error(`Provider evaluation mode must be ${MEASUREMENT_STATUSES.join(" or ")}`); return mode; }
function defaultMetrics() { return Object.fromEntries(REQUIRED_METRICS.map(metric => [metric, 0])); }
function validateEvaluationRecord(value) {
  const errors = [];
  if (!plain(value)) return { valid: false, errors: ["record must be a plain object"] };
  if (value.schema_version !== EVALUATION_SCHEMA_VERSION) errors.push("invalid schema_version");
  if (!MEASUREMENT_STATUSES.includes(value.measurement_status)) errors.push("invalid measurement_status");
  if (value.publishable_claim !== false) errors.push("publishable_claim must be false");
  if (typeof value.claim_boundary !== "string" || !value.claim_boundary.includes("Local deterministic provider evaluation evidence only")) errors.push("missing local-only claim boundary");
  if (typeof value.objective !== "string" || !value.objective.trim()) errors.push("objective is required");
  if (typeof value.verification_exit_code !== "number") errors.push("verification_exit_code is required");
  if (!plain(value.metrics)) errors.push("metrics must be an object"); else for (const metric of REQUIRED_METRICS) if (typeof value.metrics[metric] !== "number") errors.push(`missing metric: ${metric}`);
  return { valid: errors.length === 0, errors };
}
function quality(intent, generated, plan, options) {
  const metrics = defaultMetrics();
  metrics.structured_output_success = ["ready", "clarification_required"].includes(generated.status) ? 1 : 0;
  metrics.intent_interpretation_quality = intent.support_status === "supported" ? 1 : intent.support_status === "clarification_required" ? 0.5 : 0;
  metrics.criteria_inference_quality = generated.status === "ready" && generated.spec?.success_criteria?.length ? 1 : generated.status === "clarification_required" ? 0.5 : 0;
  metrics.plan_validity = plan?.goal_plan && validateGoalPlan(plan.goal_plan).valid ? 1 : 0;
  metrics.tool_action_proposal_success = options.tool_action_proposal === undefined ? 0 : options.tool_action_proposal.valid === true ? 1 : 0;
  metrics.recovery_decision_quality = options.recovery_result === undefined ? 0 : options.recovery_result.valid === true ? 1 : 0;
  metrics.false_completion_rate = generated.completed === true || generated.approved === true ? 1 : 0;
  metrics.unsafe_action_execution_rate = options.unsafe_action_executed === true ? 1 : 0;
  metrics.invalid_evidence_completion_rate = options.invalid_evidence_completion === true ? 1 : 0;
  metrics.secret_redaction_rate = /password=|token=|api[_ -]?key|private key/i.test(JSON.stringify(redactValue(options.observed_output || generated))) ? 0 : 1;
  return metrics;
}
function providerMetadata(provider, generated, options) { return redactValue({ provider: String(options.provider_name || provider.name || "injected-provider").slice(0, 80), model: generated.metadata?.model || options.model || null, role: generated.role || "goal_specification", capability_profile: options.capability_profile || provider.capabilities || null }); }
async function evaluateProviderCase(objective, options = {}) {
  if (typeof objective !== "string" || !objective.trim()) throw new TypeError("Provider evaluation objective must be non-empty");
  if (!options.provider || typeof options.provider.complete !== "function") throw new TypeError("Provider evaluation requires an injected provider");
  const started = performance.now(); const intent = interpretNaturalLanguageGoal(objective);
  /** @type {any} */
  const generated = await generateGoalSpecFromModel(objective, { ...options, provider: options.provider });
  const expansion = options.goal_expansion || (generated.status === "ready" ? expandGoalGeneral(intent, options.expansion_context || {}) : null);
  const metrics = quality(intent, generated, expansion, options);
  const rawRecord = { schema_version: EVALUATION_SCHEMA_VERSION, evaluation_id: `provider-eval-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`, objective: objective.trim(), measurement_status: modeOf(options), provider_metadata: providerMetadata(options.provider, generated, options), structured_output: { status: generated.status, valid: generated.status !== "invalid", clarification_required: generated.status === "clarification_required", stripped_fields: generated.metadata?.stripped_fields || [] }, intent: { goal_type: intent.goal_type, supported_domain: intent.supported_domain, support_status: intent.support_status, execution_boundary: intent.execution_boundary, candidate_interpretation_count: intent.candidate_interpretations?.length || 0 }, plan: { status: expansion?.status || "not_generated", valid: Boolean(expansion?.goal_plan && validateGoalPlan(expansion.goal_plan).valid), step_count: expansion?.goal_plan?.inferred_steps?.length || 0 }, metrics, token_usage: { input: num(generated.token_usage?.input || generated.usage?.input || options.token_usage?.input), output: num(generated.token_usage?.output || generated.usage?.output || options.token_usage?.output), total: num(options.token_usage?.total, num(generated.token_usage?.input || generated.usage?.input) + num(generated.token_usage?.output || generated.usage?.output)) }, latency_ms: Math.max(0, num(options.duration_ms, performance.now() - started)), manual_interventions: Number.isSafeInteger(options.manual_interventions) && options.manual_interventions >= 0 ? options.manual_interventions : 0, verification_exit_code: options.verification_exit_code ?? (generated.status === "invalid" ? 1 : 0), publishable_claim: false, claim_boundary: CLAIM_BOUNDARY, safety: { model_completion_claim_ignored: true, unknown_not_success: true, unsafe_action_executed: options.unsafe_action_executed === true, invalid_evidence_completion: options.invalid_evidence_completion === true } };
  const tokenUsage = rawRecord.token_usage;
  const record = { ...redactValue(rawRecord), metrics: { ...metrics }, token_usage: { ...tokenUsage } };
  const validation = validateEvaluationRecord(record); if (!validation.valid) throw new TypeError(`Invalid provider evaluation record: ${validation.errors.join(",")}`); return record;
}
function average(records, selector) { return records.length ? records.reduce((sum, item) => sum + num(selector(item)), 0) / records.length : 0; }
function summarizeEvaluation(records = []) { const metrics = {}; for (const metric of REQUIRED_METRICS) metrics[metric] = average(records, item => item.metrics[metric]); return { total_cases: records.length, ...metrics, average_latency_ms: average(records, item => item.latency_ms), average_total_tokens: average(records, item => item.token_usage.total), manual_interventions: records.reduce((sum, item) => sum + item.manual_interventions, 0) }; }
async function evaluateProviderSuite(cases = [], options = {}) { if (!Array.isArray(cases)) throw new TypeError("Provider evaluation cases must be an array"); const records = []; for (const item of cases) records.push(await evaluateProviderCase(typeof item === "string" ? item : item.objective, { ...options, ...(typeof item === "object" ? item : {}) })); return { schema_version: EVALUATION_SCHEMA_VERSION, measurement_status: modeOf(options), records, publishable_claim: false, claim_boundary: CLAIM_BOUNDARY, metrics: summarizeEvaluation(records), verification_exit_code: records.every(item => item.verification_exit_code === 0) ? 0 : 1 }; }
module.exports = { EVALUATION_SCHEMA_VERSION, MEASUREMENT_STATUSES, CLAIM_BOUNDARY, REQUIRED_METRICS, validateEvaluationRecord, evaluateProviderCase, evaluateProviderSuite, summarizeEvaluation };
