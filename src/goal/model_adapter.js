"use strict";

const path = require("path");
const { createProvider } = require("../llm/provider");
const { parseResponseJSON } = require("../pipeline/json_utils");
const { compileModelGoal, goalIdFor } = require("./compiler");
const { commandRequest } = require("./evaluator");
const { validateRelativePath } = require("./validator");
const { ROLE_REQUIREMENTS, normalizeCapabilityContract } = require("./capabilities");

const GOAL_SPECIFICATION_ROLE = "goal_specification";
const MODEL_METADATA_KEYS = ["done", "completed", "success", "approved", "confidence"];
const GOAL_SPECIFICATION_SYSTEM_PROMPT = `You are a GoalSpec specification analyst. Convert the user's objective into a JSON GoalSpec draft only when its success is observable and verifiable.
Return JSON only with objective, success_criteria, constraints, and clarification_questions.
Each criterion must have id, description, required, and a command, test, file, or executable custom verifier.
Do not invent acceptance criteria, paths, commands, deployment behavior, or completion status. If information is missing, return empty success_criteria and concrete clarification_questions.`;

function unavailable(reason, detail = null) {
  const question = "Provide a concrete acceptance condition and verifier, or configure a structured-output goal_specification provider.";
  return { status: "clarification_required", reason: "goal_specification_unavailable", detail: detail || reason, questions: [question], question_details: [{ id: "goal_specification_unavailable", question, reason, required: true }], metadata: { unavailable: true } };
}
function invalid(reason, errors = []) { return { status: "invalid", reason, errors }; }
function providerFromOptions(options = {}) {
  if (options.provider && typeof options.provider.complete === "function") return options.provider;
  if (typeof options.providerFactory === "function") return options.providerFactory(GOAL_SPECIFICATION_ROLE);
  if (typeof options.providerResolver === "function") return options.providerResolver(GOAL_SPECIFICATION_ROLE);
  if (options.providerName) return createProvider(options.providerName, options.providerConfig || {});
  return null;
}
function hasStructuredOutput(provider, options = {}) {
  const declared = options.modelCapabilities || provider?.capabilities || provider?.modelCapabilities;
  if (!declared) return false;
  const capabilities = normalizeCapabilityContract({ capabilities: declared.capabilities || declared }).capabilities;
  const requirements = ROLE_REQUIREMENTS[GOAL_SPECIFICATION_ROLE];
  return capabilities.structured_output === requirements.structured_output && ["low", "medium", "high"].indexOf(capabilities.repository_navigation) >= ["low", "medium", "high"].indexOf(requirements.repository_navigation);
}
function extractText(result) { return typeof result === "string" ? result : result?.text || result?.content || ""; }
function addClarifications(base, questions, metadata = {}) {
  const normalized = Array.isArray(questions) ? questions.filter(item => typeof item === "string" && item.trim()).map(item => item.trim()) : [];
  const fallback = ["What observable result proves this objective is complete?", "Which test, command, file state, or repository check should verify success?"];
  const selected = normalized.length ? normalized : fallback;
  return { status: "clarification_required", objective: base.objective, questions: selected, question_details: selected.map((question, index) => ({ id: `model_q${index + 1}`, question, reason: "model_clarification", required: true })), metadata };
}
function verifierPreflight(draft) {
  const errors = [];
  for (const [index, criterion] of (draft.success_criteria || []).entries()) {
    const verifier = criterion?.verifier;
    const prefix = `success_criteria[${index}].verifier`;
    if (!verifier || !["command", "test", "file", "custom"].includes(verifier.type)) { errors.push({ path: prefix, code: "UNSUPPORTED_VERIFIER", message: "Verifier is not supported by the GoalEvaluator" }); continue; }
    if (verifier.type === "command") {
      const parsed = commandRequest(verifier.config);
      if (parsed.error) errors.push({ path: `${prefix}.config`, code: "UNEXECUTABLE_VERIFIER", message: parsed.error });
    } else if (verifier.type === "test") {
      const script = verifier.config?.script_path;
      if (script && (typeof script !== "string" || path.isAbsolute(script) || script.split(/[\\/]/).includes(".."))) errors.push({ path: `${prefix}.config.script_path`, code: "INVALID_PATH", message: "Test script path must remain inside the workspace" });
      if (!script && typeof verifier.config?.command !== "string") errors.push({ path: `${prefix}.config`, code: "UNEXECUTABLE_VERIFIER", message: "Test verifier requires a safe script_path or command" });
    } else if (verifier.type === "file") {
      const pathErrors = [];
      validateRelativePath(verifier.config?.path, `${prefix}.config.path`, pathErrors);
      errors.push(...pathErrors);
    } else if (verifier.type === "custom" && !verifier.config?.application_check && !verifier.config?.repository_check) {
      errors.push({ path: `${prefix}.config`, code: "UNEXECUTABLE_VERIFIER", message: "Custom verifier requires an application_check or repository_check" });
    }
  }
  return errors;
}
function abstractCriterionErrors(draft) {
  return (draft.success_criteria || []).flatMap((criterion, index) => {
    const description = String(criterion?.description || "").trim().toLowerCase();
    if (!description || /\bworks correctly\b|\bworks well\b|\bproperly\b/.test(description) || /^(the )?(feature|function|system|application|login|api) (works|is correct|is complete)\.?$/.test(description)) return [{ path: `success_criteria[${index}].description`, code: "ABSTRACT_CRITERION", message: "Criterion must state an observable result" }];
    return [];
  });
}

async function generateGoalSpecFromModel(objective, options = {}) {
  if (typeof objective !== "string" || !objective.trim()) return invalid("objective_required", [{ path: "objective", code: "INVALID_STRING", message: "Objective must be a non-empty string" }]);
  let provider;
  try { provider = providerFromOptions(options); } catch (error) { return unavailable("provider_configuration", error.message); }
  if (!provider || typeof provider.complete !== "function") return unavailable("provider_not_configured");
  if (!hasStructuredOutput(provider, options)) return unavailable("structured_output_capability_missing");
  try { if (typeof provider.isAvailable === "function" && !(await provider.isAvailable())) return unavailable("provider_unavailable"); } catch (error) { return unavailable("provider_unavailable", error.message); }
  let result;
  try {
    result = await provider.complete([{ role: "system", content: GOAL_SPECIFICATION_SYSTEM_PROMPT }, { role: "user", content: `Objective:\n${objective.trim()}` }], { role: GOAL_SPECIFICATION_ROLE, model: options.model, max_tokens: options.max_tokens || 4096, temperature: 0 });
  } catch (error) { return unavailable("provider_request_failed", error.message); }
  const parsed = parseResponseJSON(extractText(result), {});
  if (!parsed.valid) return invalid(result?.truncated ? "truncated_json" : "invalid_json", [{ path: "$", code: result?.truncated ? "TRUNCATED_JSON" : "INVALID_JSON", message: result?.truncated ? "Provider output ended before a complete JSON object" : "Provider output did not contain valid JSON" }]);
  if (!parsed.parsed || typeof parsed.parsed !== "object" || Array.isArray(parsed.parsed)) return invalid("invalid_draft_shape", [{ path: "$", code: "INVALID_OBJECT", message: "GoalSpec draft must be an object" }]);
  const raw = parsed.parsed;
  const strippedFields = MODEL_METADATA_KEYS.filter(key => Object.prototype.hasOwnProperty.call(raw, key));
  const draft = { ...raw };
  for (const key of MODEL_METADATA_KEYS) delete draft[key];
  if (typeof draft.goal_id !== "string" || !draft.goal_id.trim()) draft.goal_id = options.goalId || goalIdFor(String(draft.objective || objective).trim());
  const clarificationQuestions = draft.clarification_questions;
  delete draft.clarification_questions;
  if (draft.constraints && typeof draft.constraints === "object" && Object.keys(draft.constraints).length === 0) delete draft.constraints;
  if (!Array.isArray(draft.success_criteria) || draft.success_criteria.length === 0) return addClarifications(draft, clarificationQuestions, { stripped_fields: [...strippedFields, "clarification_questions"].filter((key, index, list) => list.indexOf(key) === index), reason: "missing_success_criteria" });
  const errors = [...verifierPreflight(draft), ...abstractCriterionErrors(draft)];
  if (errors.length) return invalid("draft_validation_failed", errors);
  const compiled = compileModelGoal(draft, { goalId: options.goalId });
  if (compiled.status !== "ready") return compiled.status === "clarification_required" ? addClarifications(draft, clarificationQuestions, { stripped_fields: strippedFields, reason: "schema_clarification" }) : { ...compiled, metadata: { stripped_fields: strippedFields } };
  return { ...compiled, role: GOAL_SPECIFICATION_ROLE, metadata: { stripped_fields: strippedFields, provider: result?.provider || provider.name || null, model: result?.model || options.model || provider.config?.model || null } };
}
module.exports = { GOAL_SPECIFICATION_ROLE, GOAL_SPECIFICATION_SYSTEM_PROMPT, generateGoalSpecFromModel, verifierPreflight, abstractCriterionErrors };