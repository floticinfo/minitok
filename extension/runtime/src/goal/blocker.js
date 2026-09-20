"use strict";

const crypto = require("crypto");
const { redactValue, redactText } = require("./evidence");
const { EXECUTION_POLICIES, SIDE_EFFECTS } = require("./plan");
const { resolveExecutionPolicy, capabilitiesForSideEffects, normalizeMode } = require("./execution_policy");

const BLOCKER_CATEGORIES = Object.freeze([
  "environment_failure", "network_failure", "authentication_failure", "permission_blocked",
  "verification_failure", "dependency_failure", "metadata_mismatch", "external_service_failure",
  "timeout", "scope_violation", "novel_blocker", "assumption_failure", "goal_ambiguity",
  "missing_capability", "tool_unavailable", "external_state_conflict", "insufficient_evidence",
  "verification_conflict", "unknown",
]);
const ALTERNATIVE_RISKS = Object.freeze(["low", "medium", "high", "critical"]);
const COST_LEVELS = Object.freeze(["none", "low", "medium", "high", "unknown"]);
const ALTERNATIVE_FIELDS = new Set([
  "alternative_id", "description", "rationale", "expected_benefit", "risk_level", "side_effects",
  "required_permissions", "required_capabilities", "estimated_cost", "reversible", "verification_plan", "rollback_plan", "approval_required", "applicable", "execution_policy",
  "source", "confidence", "patch_signature", "external_target",
]);
const BLOCKER_FIELDS = new Set([
  "blocker_id", "category", "stage", "cause", "affected_step", "evidence", "retryable",
  "requires_permission", "requires_external_access", "requires_user_decision", "alternatives",
  "recommended_alternative", "attempted_alternatives", "why_not_selected", "required_external_action", "resume_conditions", "next_user_action", "evidence_complete", "alternative_exhausted", "rollback_failure", "terminal_reason",
]);
const COST_FIELDS = new Set(["level", "estimate", "currency", "details"]);
const TERMINAL_FIELDS = new Set(["why", "required_external_action", "user_command", "resume_conditions", "next_user_action"]);
const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const EXTERNAL_EFFECTS = new Set(["external_call", "publish", "deploy", "credential", "database_mutation"]);

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function issue(path, code, message) { return { path, code, message }; }
function nonEmptyString(value) { return typeof value === "string" && value.trim() !== ""; }
function stableId(prefix, value) { return `${prefix}_${crypto.createHash("sha256").update(JSON.stringify(redactValue(value))).digest("hex").slice(0, 16)}`; }
function unknownFields(value, allowed, path, errors) {
  if (!isPlainObject(value)) return;
  for (const key of Object.keys(value)) {
    if (DANGEROUS_KEYS.has(key)) errors.push(issue(`${path}.${key}`, "DANGEROUS_FIELD", "Dangerous object key is not allowed"));
    else if (!allowed.has(key)) errors.push(issue(`${path}.${key}`, "UNKNOWN_FIELD", "Unknown blocker field is not allowed"));
  }
}
function validateSafeValue(value, path, errors) {
  if (Array.isArray(value)) { value.forEach((item, index) => validateSafeValue(item, `${path}[${index}]`, errors)); return; }
  if (!value || typeof value !== "object") return;
  if (!isPlainObject(value)) { errors.push(issue(path, "INVALID_OBJECT", "Nested blocker values must be plain objects")); return; }
  for (const [key, child] of Object.entries(value)) {
    if (DANGEROUS_KEYS.has(key)) errors.push(issue(`${path}.${key}`, "DANGEROUS_FIELD", "Dangerous object key is not allowed"));
    else validateSafeValue(child, `${path}.${key}`, errors);
  }
}
function textOf(value = {}) { return `${value.category || ""} ${value.stage || ""} ${value.cause || ""} ${value.error || ""} ${value.reason || ""} ${value.output || ""}`.toLowerCase(); }

function classifyBlocker(input = {}) {
  const text = textOf(input);
  if (input.category === "verification_failure" && /network|dns|socket|connection refused|connection reset|offline|enotfound|econnreset/.test(text)) return "network_failure";
  if (Array.isArray(input.evidence) && input.evidence.length > 0 && input.evidence.some(item => item && item.valid === false)) return "insufficient_evidence";
  if (BLOCKER_CATEGORIES.includes(input.category)) return input.category;
  if (/ambigu|unclear|underspecified|clarif|which .*prefer|not enough context/.test(text)) return "goal_ambiguity";
  if (/assumption|assumed .*but|assumption failed|premise/.test(text)) return "assumption_failure";
  if (/missing capability|capability unavailable|not granted|unsupported capability/.test(text)) return "missing_capability";
  if (/tool unavailable|tool not found|adapter unavailable|no such tool/.test(text)) return "tool_unavailable";
  if (/external state|state conflict|concurrent|already changed|conflict with remote/.test(text)) return "external_state_conflict";
  if (/insufficient evidence|not enough evidence|evidence missing|cannot prove/.test(text)) return "insufficient_evidence";
  if (/verification conflict|verifier conflict|contradictory verification|criteria conflict/.test(text)) return "verification_conflict";
  if (/novel blocker|new blocker|unrecognized blocker|unexpected failure/.test(text)) return "novel_blocker";
  if (/credential|authentication|unauthorized|unauthenticated|invalid token|login|401|403/.test(text)) return "authentication_failure";
  if (/permission denied|eacces|approval required|not authorized|forbidden/.test(text)) return "permission_blocked";
  if (/scope violation|outside workspace|path traversal|protected path|blocked path/.test(text)) return "scope_violation";
  if (/timeout|timed out|etimedout/.test(text) || input.code === "ETIMEDOUT") return "timeout";
  if (/network|dns|socket|connection refused|connection reset|offline|enotfound|econnreset/.test(text)) return "network_failure";
  if (/external service|service unavailable|upstream|rate limit|502|503|504/.test(text)) return "external_service_failure";
  if (/dependency|module not found|cannot find package|lockfile|install/.test(text)) return "dependency_failure";
  if (/metadata|version mismatch|manifest mismatch|parity|out of sync/.test(text)) return "metadata_mismatch";
  if (/verification|assertion|test failed|lint failed|typecheck failed|gate failed/.test(text)) return "verification_failure";
  if (/environment|enoent|not found|runtime|executable/.test(text)) return "environment_failure";
  return "unknown";
}

function normalizeSideEffects(value) { return [...new Set((Array.isArray(value) ? value : []).filter(effect => SIDE_EFFECTS.includes(effect)))]; }
function hasExternalEffect(sideEffects) { return sideEffects.some(effect => EXTERNAL_EFFECTS.has(effect)); }
function normalizeCost(value) {
  if (typeof value === "string") return { level: COST_LEVELS.includes(value) ? value : "unknown", estimate: redactText(value) };
  const cost = isPlainObject(value) ? value : {};
  return { level: COST_LEVELS.includes(cost.level) ? cost.level : "unknown", estimate: cost.estimate == null ? null : redactText(String(cost.estimate)), currency: cost.currency || null, details: cost.details ? redactText(String(cost.details)) : null };
}
function inferExecutionPolicy(sideEffects, requested) {
  if (requested === "never_autonomous" || requested === "always_blocked" || requested === "unrestricted" || requested === "unrestricted_general") return requested;
  if (sideEffects.some(effect => EXTERNAL_EFFECTS.has(effect))) return "authorized_external";
  if (requested === "authorized_external") return requested;
  if (requested === "supervised") return requested;
  if (sideEffects.includes("file_change")) return "supervised";
  return "safe";
}
function normalizeAlternative(input = {}) {
  const value = redactValue(input);
  const sideEffects = normalizeSideEffects(value.side_effects);
  const external = hasExternalEffect(sideEffects);
  const permissions = Array.isArray(value.required_permissions) ? value.required_permissions.filter(nonEmptyString) : [];
  const executionPolicy = inferExecutionPolicy(sideEffects, value.execution_policy);
  const neverAutonomous = ["never_autonomous", "always_blocked"].includes(executionPolicy);
  const approvalRequired = value.approval_required === true || external || ["supervised", "authorized_external", "never_autonomous", "unrestricted"].includes(executionPolicy);
  const source = ["catalog", "planner", "environment", "local_fallback", "reduced_scope", "deferred", "user_decision"].includes(value.source) ? value.source : "catalog";
  const capabilities = Array.isArray(value.required_capabilities) ? value.required_capabilities.filter(nonEmptyString) : [];
  const confidence = Number.isFinite(value.confidence) ? Math.max(0, Math.min(1, value.confidence)) : (source === "planner" || source === "environment" ? 0.5 : 0.8);
  return { alternative_id: value.alternative_id || stableId("alternative", { description: value.description, side_effects: sideEffects }), description: redactText(String(value.description || "")), rationale: redactText(String(value.rationale || "")), expected_benefit: redactText(String(value.expected_benefit || "")), risk_level: ALTERNATIVE_RISKS.includes(value.risk_level) ? value.risk_level : "unknown", side_effects: sideEffects, required_permissions: [...new Set(permissions)], required_capabilities: [...new Set(capabilities)], estimated_cost: normalizeCost(value.estimated_cost), reversible: value.reversible === true, verification_plan: value.verification_plan === undefined ? {} : redactValue(value.verification_plan), rollback_plan: value.rollback_plan === undefined ? null : redactValue(value.rollback_plan), approval_required: approvalRequired, applicable: value.applicable !== false && !neverAutonomous, execution_policy: executionPolicy, source, confidence, patch_signature: nonEmptyString(value.patch_signature) ? redactText(value.patch_signature) : null, external_target: nonEmptyString(value.external_target) ? redactText(value.external_target) : null };
}
function alternative(id, description, rationale, options = {}) {
  return normalizeAlternative({ alternative_id: id, description, rationale, expected_benefit: options.expected_benefit || "Reduce blocker impact while preserving the goal boundary", risk_level: options.risk_level || "low", side_effects: options.side_effects || [], required_permissions: options.required_permissions || [], estimated_cost: options.estimated_cost || "low", reversible: options.reversible !== false, verification_plan: options.verification_plan || { type: "local_recheck" }, approval_required: options.approval_required, applicable: options.applicable, execution_policy: options.execution_policy });
}

function alternativesFor(category, context = {}) {
  const command = nonEmptyString(context.command) ? redactText(context.command) : null;
  const local = (id, description, rationale, options = {}) => alternative(id, description, rationale, { ...options, verification_plan: { ...(options.verification_plan || { type: "local_recheck" }), ...(command ? { command } : {}) } });
  const map = {
    environment_failure: [local("local-validation", "Re-observe the local environment and validate required executables", "The environment may be recoverable without external access", { verification_plan: { type: "local_validation" } }), local("manual-environment", "Ask the operator to repair the local environment", "The runtime state cannot be changed safely by the goal agent", { required_permissions: ["operator"], approval_required: true, risk_level: "medium", reversible: false })],
    network_failure: [local("retry-backoff", "Retry the read-only operation with bounded backoff", "Transient network failures may resolve without changing repository state", { verification_plan: { type: "retry_with_backoff", max_attempts: 3 } }), local("local-dry-run", "Use a local dry-run or cached validation instead of the network operation", "Preserve progress without external access", { verification_plan: { type: "local_dry_run" } })],
    authentication_failure: [local("local-validation", "Run local validation without using credentials", "Credential failures must not be bypassed automatically", { verification_plan: { type: "local_validation" } }), local("approval-credential", "Request the operator to authenticate the approved provider or service", "Credentials require explicit operator action and must not be collected or logged", { side_effects: ["credential", "external_call"], required_permissions: ["approval", "credential"], approval_required: true, execution_policy: "authorized_external", reversible: false })],
    permission_blocked: [local("scope-replan", "Replan within the existing allowed and unprotected paths", "A narrower local change may satisfy the goal without elevating permissions", { verification_plan: { type: "repository_scope" } }), local("user-approval", "Request approval for the blocked operation", "Permission changes require an explicit user decision", { side_effects: ["external_call"], required_permissions: ["approval"], approval_required: true, execution_policy: "supervised", reversible: false })],
    verification_failure: [local("alternate-strategy", "Apply an alternate implementation strategy based on verifier evidence", "A different patch may address the verified failure without repeating the same change", { verification_plan: { type: "rerun_verifier" } }), local("alternate-command", "Run an alternate allowlisted verification command", "A compatible local command may isolate the failure without widening repository scope", { verification_plan: { type: "alternate_command" } }), local("dry-run", "Run a dry-run and inspect the failing verification evidence", "A dry-run can isolate the failure without adding side effects", { verification_plan: { type: "dry_run" } }), local("alternate-provider", "Request approval to use another configured provider for verification", "Provider changes may require external access and must not bypass approval", { side_effects: ["external_call"], required_permissions: ["approval", "provider"], approval_required: true, execution_policy: "authorized_external", reversible: true, verification_plan: { type: "alternate_provider" } }), local("alternate-model", "Request approval to route verification to another capable model", "Model changes may change provider usage and require an explicit decision", { side_effects: ["external_call"], required_permissions: ["approval", "model"], approval_required: true, execution_policy: "authorized_external", reversible: true, verification_plan: { type: "alternate_model" } })],
  };
  if (map[category]) return map[category];
  if (["novel_blocker", "assumption_failure", "goal_ambiguity", "missing_capability", "tool_unavailable", "external_state_conflict", "insufficient_evidence", "verification_conflict"].includes(category)) return [local("catalog-evidence", "Collect bounded local evidence before changing scope or side effects", "The new blocker must be understood before selecting a risky workaround", { verification_plan: { type: "evidence_collection" } })];
  return [];
}

function additionalAlternatives(category, context = {}) {
  const command = nonEmptyString(context.command) ? redactText(context.command) : null;
  const local = (id, description, rationale, options = {}) => alternative(id, description, rationale, { ...options, verification_plan: { ...(options.verification_plan || { type: "local_recheck" }), ...(command ? { command } : {}) } });
  const map = {
    dependency_failure: [local("dependency-preparation", "Prepare or validate dependencies using the repository lockfile and local cache", "Dependency state may be repaired locally without changing application behavior", { side_effects: ["file_change"], required_permissions: ["write"], verification_plan: { type: "dependency_check" } }), local("manual-dependency", "Ask the operator to prepare the dependency environment", "The dependency source or credential may be outside the safe boundary", { required_permissions: ["operator"], approval_required: true, risk_level: "medium", reversible: false })],
    metadata_mismatch: [local("metadata-sync", "Synchronize local version or runtime metadata and verify the generated diff", "Repository parity metadata can be regenerated locally", { side_effects: ["file_change"], required_permissions: ["write"], verification_plan: { type: "metadata_check" } }), local("manual-metadata", "Ask the operator to review and approve the metadata change", "Release identity changes require a human decision", { required_permissions: ["operator", "approval"], approval_required: true, risk_level: "high", reversible: false })],
    external_service_failure: [local("local-dry-run", "Use a local dry-run or mock verification", "External service failure should not trigger repeated side effects", { verification_plan: { type: "local_dry_run" } }), local("manual-service", "Ask the operator to inspect the external service status", "The service owner must resolve availability or quota issues", { required_permissions: ["operator"], approval_required: true, risk_level: "medium", reversible: false })],
    timeout: [local("retry-backoff", "Retry with a bounded timeout and backoff", "A bounded retry may recover a transient timeout", { verification_plan: { type: "retry_with_backoff", max_attempts: 2 } }), local("reduce-scope", "Reduce the local task scope and verify incrementally", "Smaller work can stay within the execution budget", { verification_plan: { type: "incremental_validation" } })],
    scope_violation: [local("scope-replan", "Discard the out-of-scope action and replan inside the repository ODD", "The existing scope boundary must remain authoritative", { verification_plan: { type: "repository_scope" } }), local("manual-scope", "Ask the operator to define an approved scope change", "Protected or external scope changes require an explicit decision", { required_permissions: ["approval", "operator"], approval_required: true, risk_level: "high", reversible: false })],
    unknown: [local("local-validation", "Collect additional local evidence before selecting an action", "The cause is not known well enough for risky recovery", { verification_plan: { type: "evidence_collection" } }), local("manual-investigation", "Ask the operator to investigate the blocker and provide a resume condition", "No safe autonomous action can be justified from the available evidence", { required_permissions: ["operator"], approval_required: true, risk_level: "medium", reversible: false })],
  };
  return map[category] || [];
}
function allAlternativesFor(category, context = {}) { return [...alternativesFor(category, context), ...additionalAlternatives(category, context)]; }
const ALTERNATIVE_SOURCE_ORDER = Object.freeze(["catalog", "planner", "environment", "local_fallback", "reduced_scope", "deferred", "user_decision"]);
function alternativeList(value) { return Array.isArray(value) ? value.filter(isPlainObject) : []; }
function generatedAlternatives(context = {}) {
  const sourceGroups = [
    ["planner", context.planner_alternatives || context.planner_generated_alternatives],
    ["environment", context.environment_alternatives || context.environment_workarounds],
    ["local_fallback", context.local_fallbacks || context.local_fallback_alternatives],
    ["reduced_scope", context.reduced_scope_alternatives],
    ["deferred", context.deferred_alternatives],
    ["user_decision", context.user_decision_alternatives],
  ];
  return sourceGroups.flatMap(([source, values]) => alternativeList(values).map(item => ({ ...item, source: item.source || source })));
}
function alternativeKey(item) {
  return item.patch_signature ? `patch:${item.patch_signature}` : item.external_target ? `external:${item.external_target}` : `id:${item.alternative_id}`;
}
function synthesizeAlternatives(category, context = {}) {
  const catalog = alternativeList(context.catalog_alternatives).length ? context.catalog_alternatives : allAlternativesFor(category, context);
  const supplied = alternativeList(context.alternatives).map(item => ({ ...item, source: item.source || "planner" }));
  const candidates = [...catalog.map(item => ({ ...item, source: item.source || "catalog" })), ...supplied, ...generatedAlternatives(context)];
  const seen = new Set();
  return candidates.map(normalizeAlternative).filter(item => {
    const key = alternativeKey(item);
    if (!item.alternative_id || seen.has(key)) return false;
    seen.add(key); return true;
  });
}


function validateCost(value, path, errors) {
  if (!isPlainObject(value)) { errors.push(issue(path, "INVALID_COST", "estimated_cost must be an object")); return; }
  unknownFields(value, COST_FIELDS, path, errors);
  if (!COST_LEVELS.includes(value.level)) errors.push(issue(`${path}.level`, "INVALID_COST_LEVEL", `level must be one of: ${COST_LEVELS.join(", ")}`));
}
function validateAlternative(value, path, errors) {
  if (!isPlainObject(value)) { errors.push(issue(path, "INVALID_ALTERNATIVE", "AlternativePlan must be an object")); return; }
  unknownFields(value, ALTERNATIVE_FIELDS, path, errors);
  for (const field of ["alternative_id", "description", "rationale", "expected_benefit"]) if (!nonEmptyString(value[field])) errors.push(issue(`${path}.${field}`, "INVALID_STRING", `${field} must be a non-empty string`));
  if (!ALTERNATIVE_RISKS.includes(value.risk_level)) errors.push(issue(`${path}.risk_level`, "INVALID_RISK", `risk_level must be one of: ${ALTERNATIVE_RISKS.join(", ")}`));
  if (!Array.isArray(value.side_effects)) errors.push(issue(`${path}.side_effects`, "INVALID_LIST", "side_effects must be an array"));
  else value.side_effects.forEach((effect, index) => { if (!SIDE_EFFECTS.includes(effect)) errors.push(issue(`${path}.side_effects[${index}]`, "INVALID_SIDE_EFFECT", "Unknown side effect")); });
  if (!Array.isArray(value.required_permissions)) errors.push(issue(`${path}.required_permissions`, "INVALID_LIST", "required_permissions must be an array"));
  if (!Array.isArray(value.required_capabilities)) errors.push(issue(`${path}.required_capabilities`, "INVALID_LIST", "required_capabilities must be an array"));
  if (typeof value.reversible !== "boolean") errors.push(issue(`${path}.reversible`, "INVALID_BOOLEAN", "reversible must be boolean"));
  if (value.rollback_plan !== null) validateSafeValue(value.rollback_plan, `${path}.rollback_plan`, errors);
  if (!ALTERNATIVE_SOURCE_ORDER.includes(value.source)) errors.push(issue(`${path}.source`, "INVALID_SOURCE", "source must identify how the alternative was synthesized"));
  if (!Number.isFinite(value.confidence) || value.confidence < 0 || value.confidence > 1) errors.push(issue(`${path}.confidence`, "INVALID_CONFIDENCE", "confidence must be a number between 0 and 1"));
  for (const field of ["patch_signature", "external_target"]) if (value[field] !== null && value[field] !== undefined && !nonEmptyString(value[field])) errors.push(issue(`${path}.${field}`, "INVALID_STRING", `${field} must be a non-empty string or null`));
  if (typeof value.approval_required !== "boolean") errors.push(issue(`${path}.approval_required`, "INVALID_BOOLEAN", "approval_required must be boolean"));
  if (typeof value.applicable !== "boolean") errors.push(issue(`${path}.applicable`, "INVALID_BOOLEAN", "applicable must be boolean"));
  if (!EXECUTION_POLICIES.includes(value.execution_policy)) errors.push(issue(`${path}.execution_policy`, "INVALID_EXECUTION_POLICY", `execution_policy must be one of: ${EXECUTION_POLICIES.join(", ")}`));
  validateCost(value.estimated_cost, `${path}.estimated_cost`, errors);
  validateSafeValue(value.verification_plan, `${path}.verification_plan`, errors);
  if (hasExternalEffect(value.side_effects) && !["authorized_external", "unrestricted", "unrestricted_general", "never_autonomous", "always_blocked"].includes(value.execution_policy)) errors.push(issue(`${path}.execution_policy`, "POLICY_SIDE_EFFECT_MISMATCH", "External side effects require authorized_external, unrestricted, or stronger policy"));
  if (value.side_effects.includes("file_change") && !["supervised", "authorized_external", "unrestricted", "never_autonomous", "always_blocked"].includes(value.execution_policy)) errors.push(issue(`${path}.execution_policy`, "POLICY_SIDE_EFFECT_MISMATCH", "File changes require supervised or stronger policy"));
  if (hasExternalEffect(value.side_effects) && value.approval_required !== true) errors.push(issue(`${path}.approval_required`, "APPROVAL_REQUIRED", "External side effects require approval"));
}
function validateTerminalReason(value, errors) {
  if (value == null) return;
  if (!isPlainObject(value)) { errors.push(issue("terminal_reason", "INVALID_TERMINAL_REASON", "terminal_reason must be an object")); return; }
  unknownFields(value, TERMINAL_FIELDS, "terminal_reason", errors);
  for (const field of ["why", "required_external_action", "resume_conditions"]) if (!nonEmptyString(value[field])) errors.push(issue(`terminal_reason.${field}`, "INVALID_STRING", `${field} must be a non-empty string`));
  if (value.user_command !== undefined && value.user_command !== null && !nonEmptyString(value.user_command)) errors.push(issue("terminal_reason.user_command", "INVALID_COMMAND", "user_command must be non-empty when provided"));
  if (value.next_user_action !== undefined && !nonEmptyString(value.next_user_action)) errors.push(issue("terminal_reason.next_user_action", "INVALID_STRING", "next_user_action must be non-empty when provided"));
}


function validateBlockerReport(report) {
  const errors = [];
  if (!isPlainObject(report)) return { valid: false, errors: [issue("$", "INVALID_OBJECT", "BlockerReport must be a plain object")] };
  unknownFields(report, BLOCKER_FIELDS, "$", errors);
  for (const field of ["blocker_id", "stage", "cause", "affected_step"]) if (!nonEmptyString(report[field])) errors.push(issue(field, "INVALID_STRING", `${field} must be a non-empty string`));
  if (!BLOCKER_CATEGORIES.includes(report.category)) errors.push(issue("category", "INVALID_CATEGORY", `category must be one of: ${BLOCKER_CATEGORIES.join(", ")}`));
  for (const field of ["retryable", "requires_permission", "requires_external_access", "requires_user_decision"]) if (typeof report[field] !== "boolean") errors.push(issue(field, "INVALID_BOOLEAN", `${field} must be boolean`));
  if (!Array.isArray(report.evidence)) errors.push(issue("evidence", "INVALID_LIST", "evidence must be an array"));
  else report.evidence.forEach((item, index) => validateSafeValue(item, `evidence[${index}]`, errors));
  if (!Array.isArray(report.alternatives)) errors.push(issue("alternatives", "INVALID_LIST", "alternatives must be an array"));
  else report.alternatives.forEach((item, index) => validateAlternative(item, `alternatives[${index}]`, errors));
  if (report.recommended_alternative !== null && !nonEmptyString(report.recommended_alternative)) errors.push(issue("recommended_alternative", "INVALID_REFERENCE", "recommended_alternative must be an alternative id or null"));
  if (report.recommended_alternative && !report.alternatives.some(item => item.alternative_id === report.recommended_alternative)) errors.push(issue("recommended_alternative", "UNKNOWN_ALTERNATIVE", "Recommended alternative must reference an alternative"));
  for (const field of ["attempted_alternatives", "why_not_selected"]) if (report[field] !== undefined && !Array.isArray(report[field])) errors.push(issue(field, "INVALID_LIST", `${field} must be an array`));
  for (const field of ["evidence_complete", "alternative_exhausted", "rollback_failure"]) if (report[field] !== undefined && typeof report[field] !== "boolean") errors.push(issue(field, "INVALID_BOOLEAN", `${field} must be boolean`));
  validateTerminalReason(report.terminal_reason, errors);
  if (report.requires_external_access && !report.requires_user_decision) errors.push(issue("requires_user_decision", "DECISION_REQUIRED", "External access requires a user decision"));
  return { valid: errors.length === 0, errors };
}
function assertValidBlockerReport(report) {
  const result = validateBlockerReport(report);
  if (!result.valid) throw new TypeError(`Invalid BlockerReport: ${result.errors.map(item => `${item.path}: ${item.message}`).join("; ")}`);
  return report;
}
function noAlternativeReason(category, context = {}) {
  return { why: `No safe applicable alternative was identified for ${category}`, required_external_action: redactText(String(context.required_external_action || "Operator investigation and explicit decision are required")), user_command: context.user_command ? redactText(String(context.user_command)) : null, resume_conditions: redactText(String(context.resume_conditions || "Provide new redacted evidence and verify the blocker condition has cleared")), next_user_action: redactText(String(context.next_user_action || "Review the blocker evidence, choose an approved alternative, then resume")) };
}
function modeForSelection(policy) { return normalizeMode(typeof policy === "string" ? policy : policy?.mode).mode; }
function isAlternativeAutonomousSafe(alternativePlan, policy = "safe", options = {}) {
  if (!alternativePlan || alternativePlan.applicable !== true || ["never_autonomous", "always_blocked"].includes(alternativePlan.execution_policy)) return false;
  const policyValue = /** @type {any} */ (policy);
  const mode = normalizeMode(typeof policyValue === "string" ? policyValue : policyValue?.mode).mode;
  if (mode === "safe") return alternativePlan.approval_required !== true && alternativePlan.execution_policy === "safe" && alternativePlan.side_effects.length === 0;
  if (["unrestricted", "unrestricted_general"].includes(mode) && alternativePlan.execution_policy === "safe" && alternativePlan.side_effects.length === 0) return true;
  const capabilities = [...new Set([...(alternativePlan.required_capabilities || []), ...capabilitiesForSideEffects(alternativePlan.side_effects)])];
  const decision = resolveExecutionPolicy({ mode, capabilities, explicit_confirmation: options.explicit_confirmation === true, auto_accept: options.auto_accept === true, actor: options.actor, source: "internal", config: options.config, runtime_permission: options.runtime_permission === true, audit_persisted: options.audit_persisted === true, integrity_preflight: options.integrity_preflight === true });
  return decision.allowed;
}
function buildApprovalRequest(report, alternativePlan, context = {}) {
  if (!alternativePlan || ["never_autonomous", "always_blocked"].includes(alternativePlan.execution_policy)) return null;
  return {
    type: "goal_alternative_approval_request",
    blocker_id: report?.blocker_id || null,
    alternative_id: alternativePlan.alternative_id,
    execution_policy: alternativePlan.execution_policy,
    description: redactText(String(alternativePlan.description || "")),
    required_permissions: (alternativePlan.required_permissions || []).filter(nonEmptyString),
    credential_presence_confirmation_required: alternativePlan.execution_policy === "authorized_external" && alternativePlan.side_effects.includes("credential"),
    approval_required: true,
    resume_action: redactText(String(context.resume_action || "Call minitok_goal_resume after approval and required operator checks")),
  };
}
function alternativeLooksReadOnly(item) { return item.side_effects.length === 0 && /read|dry.?run|verify|inspect|observe|validation|recheck|evidence/i.test(`${item.description} ${JSON.stringify(item.verification_plan)}`); }
function selectAlternative(report, options = {}) {
  const policy = options.execution_policy?.mode || options.execution_policy || "safe";
  const mode = modeForSelection(policy);
  const policyOptions = { explicit_confirmation: options.explicit_confirmation === true, auto_accept: options.auto_accept === true, actor: options.actor, config: options.config, runtime_permission: options.runtime_permission === true, audit_persisted: options.audit_persisted === true, integrity_preflight: options.integrity_preflight === true };
  const repeated = new Set([...(options.used_alternative_ids || []), ...(options.usedAlternativeIds || [])]);
  const usedPatches = new Set([...(options.used_patch_signatures || []), ...(options.usedPatchSignatures || [])]);
  const usedTargets = new Set([...(options.used_external_targets || []), ...(options.usedExternalTargets || [])]);
  const candidates = (report?.alternatives || []).filter(item => item.applicable !== false && !["never_autonomous", "always_blocked"].includes(item.execution_policy) && !repeated.has(item.alternative_id) && (!item.patch_signature || !usedPatches.has(item.patch_signature)) && (!item.external_target || !usedTargets.has(item.external_target)) && (options.require_evidence !== true || item.verification_plan && Object.keys(item.verification_plan).length > 0));
  const rank = item => {
    if (item.source === "local_fallback" || (item.source === "catalog" && item.side_effects.length === 0)) return 0;
    if (item.source === "reduced_scope") return 1;
    if (alternativeLooksReadOnly(item)) return 2;
    if (item.source === "deferred") return 4;
    if (item.source === "user_decision" || item.approval_required || hasExternalEffect(item.side_effects)) return 5;
    return mode === "unrestricted_general" ? 3 : 4;
  };
  const ordered = [...candidates].sort((a, b) => rank(a) - rank(b));
  const safe = ordered.find(item => isAlternativeAutonomousSafe(item, policy, policyOptions));
  if (safe) return { status: "selected", alternative: safe, requires_approval: false, approval_request: null, auto_approved: ["unrestricted", "unrestricted_general"].includes(mode), reason: ["unrestricted", "unrestricted_general"].includes(mode) ? `${mode} policy allowed the selected alternative` : "safe alternative permitted by the current execution policy" };
  const approval = ordered.find(item => item.approval_required === true || hasExternalEffect(item.side_effects) || item.source === "user_decision");
  if (approval) return { status: "approval_required", alternative: approval, requires_approval: true, approval_request: buildApprovalRequest(report, approval, options), reason: "alternative requires approval or an external side effect", why_not_selected: ordered.filter(item => item.alternative_id !== approval.alternative_id).map(item => ({ alternative_id: item.alternative_id, reason: "not autonomous under current policy or gate" })) };
  const exhausted = repeated.size > 0 || usedPatches.size > 0 || usedTargets.size > 0;
  return { status: "escalate", alternative: null, requires_approval: true, approval_request: null, reason: exhausted ? "all alternatives, patch signatures, or external targets were already used" : candidates.length === 0 ? "no applicable alternative is available" : "no alternative is safe under the current execution policy", why_not_selected: ordered.map(item => ({ alternative_id: item.alternative_id, reason: "policy, evidence, or rollback gate rejected the alternative" })) };
}

function createBlockerReport(input = {}) {
  const value = redactValue(input);
  const category = classifyBlocker(value);
  const dynamicSources = ["planner_alternatives", "planner_generated_alternatives", "environment_alternatives", "environment_workarounds", "local_fallbacks", "local_fallback_alternatives", "reduced_scope_alternatives", "deferred_alternatives", "user_decision_alternatives", "catalog_alternatives"].some(key => Array.isArray(value[key]));
  const alternatives = (Array.isArray(value.alternatives) && !dynamicSources ? value.alternatives.map(item => normalizeAlternative({ ...item, source: item.source || "planner" })) : synthesizeAlternatives(category, value));
  const applicableAlternatives = alternatives.filter(item => item.applicable);
  const recommended = value.recommended_alternative || applicableAlternatives.find(item => !item.approval_required)?.alternative_id || applicableAlternatives[0]?.alternative_id || null;
  const external = value.requires_external_access === true || alternatives.some(item => hasExternalEffect(item.side_effects));
  const permission = value.requires_permission === true || alternatives.some(item => item.required_permissions.length > 0);
  const decision = value.requires_user_decision === true || external || permission || alternatives.some(item => item.approval_required) || alternatives.some(item => item.execution_policy === "never_autonomous");
  const evidence = Array.isArray(value.evidence) ? value.evidence.map(redactValue) : [];
  const evidenceComplete = value.evidence_complete === true || (evidence.length > 0 && evidence.every(item => item?.valid === true && (item?.executed === true || item?.execution?.executed === true)));
  const attempted = Array.isArray(value.attempted_alternatives) ? value.attempted_alternatives.filter(nonEmptyString) : [];
  const exhausted = value.alternative_exhausted === true || (alternatives.length > 0 && applicableAlternatives.length === 0) || (attempted.length > 0 && alternatives.every(item => attempted.includes(item.alternative_id)));
  const terminal = alternatives.length ? (value.terminal_reason || null) : noAlternativeReason(category, value);
  const report = { blocker_id: value.blocker_id || stableId("blocker", { category, stage: value.stage, cause: value.cause, affected_step: value.affected_step }), category, stage: value.stage || "unknown", cause: redactText(String(value.cause || value.error || "unknown")), affected_step: redactText(String(value.affected_step || value.task || "unknown")), evidence, retryable: value.retryable === true || ["network_failure", "timeout", "environment_failure"].includes(category), requires_permission: permission, requires_external_access: external, requires_user_decision: decision, alternatives, recommended_alternative: recommended, attempted_alternatives: attempted, why_not_selected: Array.isArray(value.why_not_selected) ? value.why_not_selected.map(redactValue) : [], required_external_action: value.required_external_action ? redactText(String(value.required_external_action)) : null, resume_conditions: value.resume_conditions ? redactText(String(value.resume_conditions)) : null, next_user_action: value.next_user_action ? redactText(String(value.next_user_action)) : null, evidence_complete: evidenceComplete, alternative_exhausted: exhausted, rollback_failure: value.rollback_failure === true, terminal_reason: terminal };
  assertValidBlockerReport(report);
  return report;
}
function serializeBlockerReport(report) { assertValidBlockerReport(report); return JSON.stringify(redactValue(report)); }
function deserializeBlockerReport(serialized) {
  if (typeof serialized !== "string" || serialized.trim() === "") throw new TypeError("Serialized BlockerReport must be a non-empty JSON string");
  let parsed;
  try { parsed = JSON.parse(serialized); } catch (error) { throw new TypeError(`Serialized BlockerReport is invalid JSON: ${error.message}`, { cause: error }); }
  const report = redactValue(parsed);
  assertValidBlockerReport(report);
  return report;
}
module.exports = { BLOCKER_CATEGORIES, ALTERNATIVE_RISKS, COST_LEVELS, ALTERNATIVE_SOURCE_ORDER, classifyBlocker, alternativesFor: allAlternativesFor, synthesizeAlternatives, createBlockerReport, validateBlockerReport, assertValidBlockerReport, serializeBlockerReport, deserializeBlockerReport, normalizeAlternative, noAlternativeReason, isAlternativeAutonomousSafe, selectAlternative, buildApprovalRequest };
