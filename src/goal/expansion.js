"use strict";

const { createGoalPlan, validateGoalPlan, EXECUTION_POLICIES, capabilitiesForSteps, detectSideEffects } = require("./plan");
const { redactValue } = require("./evidence");

const RELEASE_PATTERN = /\b(release|publish|package|version\s*bump|tag|npm\s+publish|ship)\b/i;
const FILE_CHANGE_PATTERN = /\b(file|module|function|class|bug|feature|fix|refactor|documentation|readme|test)\b/i;
const DEPLOY_PATTERN = /\b(deploy|deployment|staging|production)\b/i;
const ONLY_GOAL_PATTERN = /\b(only|just|goal\s+only)\b|목표만|목표만\s*달성/i;
const PATH_PATTERN = /(?:^|\s)((?:[A-Za-z0-9._-]+[\\/])+[A-Za-z0-9._-]+)/g;

function nonEmptyString(value) { return typeof value === "string" && value.trim() !== ""; }
function asArray(value) { return Array.isArray(value) ? value : []; }
function criterionId(value) { return typeof value === "string" ? value : value?.id; }
function criterionIds(criteria) { return new Set(asArray(criteria).map(criterionId).filter(nonEmptyString)); }
function scopeFrom(context = {}) {
  const odd = context.repository_odd || context.scope_boundary || context;
  return { allowed_paths: asArray(odd.allowed_paths), blocked_paths: asArray(odd.blocked_paths), protected_paths: asArray(odd.protected_paths), allow_external: odd.allow_external === true };
}
function normalizePath(value) { return typeof value === "string" ? value.replace(/\\/g, "/").replace(/^\.\//, "") : ""; }
function pathMatches(file, prefix) { const item = normalizePath(file); const base = normalizePath(prefix); return item === base || item.startsWith(`${base}/`); }
function pathAllowed(file, scope) {
  const candidate = normalizePath(file);
  if (!candidate || candidate.split("/").includes("..") || candidate.startsWith("/")) return false;
  if (scope.blocked_paths.some(prefix => pathMatches(candidate, prefix))) return false;
  if (scope.protected_paths.some(prefix => pathMatches(candidate, prefix))) return false;
  return scope.allowed_paths.length === 0 || scope.allowed_paths.some(prefix => pathMatches(candidate, prefix));
}
function policyMode(value) { const mode = typeof value === "string" ? value : value?.mode; return EXECUTION_POLICIES.includes(mode) ? mode : "safe"; }
function onlyGoalRequested(input, objective) { return input.only_goal === true || ONLY_GOAL_PATTERN.test(objective); }
function extractPaths(text) { return [...String(text || "").matchAll(PATH_PATTERN)].map(match => normalizePath(match[1])); }
function step(id, description, options = {}) {
  return { id, description, required: options.required !== false, depends_on: options.depends_on || [], target_criteria: options.target_criteria || [], risk: options.risk || "low", side_effects: options.side_effects || [], verification: options.verification || { type: "repository_check" }, status: options.status || "proposed", rationale: options.rationale, execution_policy: options.execution_policy };
}
function releaseSteps(criteria, onlyGoal) {
  const ids = [...criteria];
  const steps = [
    step("release-version", "Update the package version according to the requested release objective", { target_criteria: ids, rationale: "A release objective requires the release version to be explicitly identified and verified.", side_effects: ["file_change"], risk: "medium", verification: { type: "version_metadata" } }),
    step("release-tests", "Run the repository release test and verification checks", { target_criteria: ids, depends_on: ["release-version"], rationale: "Release readiness requires deterministic checks after the version change.", verification: { type: "repository_check", checks: ["test", "lint", "typecheck"] } }),
    step("release-package", "Create or verify the package artifact without publishing it", { target_criteria: ids, depends_on: ["release-tests"], rationale: "The package artifact must be verified before any publication decision.", verification: { type: "package_dry_run" } }),
    step("release-tag-confirmation", "Confirm the intended release tag without creating or overwriting a tag", { required: false, status: "deferred", target_criteria: ids, depends_on: ["release-package"], rationale: "A tag may be part of release follow-up, but tag mutation is outside autonomous execution.", side_effects: ["external_call"], risk: "high", execution_policy: "supervised", verification: { type: "tag_confirmation" } }),
    step("release-publication-confirmation", "Confirm publication readiness without publishing to npm or an MCP registry", { required: false, status: "deferred", target_criteria: ids, depends_on: ["release-package"], rationale: "Publication is an external side effect and requires explicit user approval.", side_effects: ["publish", "external_call"], risk: "critical", execution_policy: "authorized_external", verification: { type: "publication_confirmation" } }),
  ];
  return onlyGoal ? steps.filter(item => item.required) : steps;
}


function fileSteps(objective, criteria) {
  const ids = [...criteria];
  const paths = extractPaths(objective);
  return [step("goal-change", objective.trim(), { target_criteria: ids, rationale: "This step directly represents the user's explicit objective and does not add unrelated work.", verification: { type: "goal_criteria", paths } })];
}
function candidateScopeViolations(steps, scope) {
  return steps.flatMap(item => asArray(item.paths || item.scope_paths || item.verification?.paths).filter(file => !pathAllowed(file, scope)).map(file => ({ step_id: item.id, path: file })));
}
function missingCriteria(criteria) { return criteria.length === 0 ? ["Provide at least one observable success criterion before automatic goal expansion"] : []; }
function environmentSummary(environmentState = {}) {
  if (!environmentState || typeof environmentState !== "object" || Array.isArray(environmentState)) return { missing_information: [], questions: [], assumptions: [], confidence_penalty: 0 };
  const state = /** @type {Record<string, any>} */ (environmentState);
  const missingInformation = [];
  const questions = [];
  const assumptions = [];
  let confidencePenalty = 0;
  const unavailableCommands = [...new Set([...asArray(state.missing_commands)].filter(nonEmptyString).map(command => command.replace(/.*[\\/]/, "").slice(0, 64)))];
  if (unavailableCommands.length > 0) {
    missingInformation.push("One or more required environment commands are unavailable");
    questions.push("Confirm or install the required local verification commands before execution");
    confidencePenalty = Math.max(confidencePenalty, 0.2);
  }
  if (state.filesystem_writable === false) {
    missingInformation.push("The workspace is not writable");
    questions.push("Provide a writable workspace or approve an operator action to restore write access");
    confidencePenalty = Math.max(confidencePenalty, 0.25);
  }
  if (state.verifier_available === false) {
    missingInformation.push("The configured verifier is unavailable");
    questions.push("Provide an available deterministic verifier before execution");
    confidencePenalty = Math.max(confidencePenalty, 0.2);
  }
  if (state.repository_clean === false || ["dirty", "changed", "modified"].includes(String(state.repository_status || "").toLowerCase())) {
    assumptions.push("The workspace contains pre-existing changes; scope and ownership must be confirmed before file changes");
    questions.push("Confirm that pre-existing workspace changes are in scope");
    confidencePenalty = Math.max(confidencePenalty, 0.1);
  }
  if (state.network_available === false) {
    assumptions.push("External network access is unavailable; external follow-up cannot be verified locally");
    if (state.provider_ready === false) questions.push("Confirm the local provider and network state before any external verification");
    confidencePenalty = Math.max(confidencePenalty, 0.1);
  }
  if (state.provider_ready === false) {
    missingInformation.push("The configured provider is not ready");
    questions.push("Configure or select an authorized provider before model-assisted execution");
    confidencePenalty = Math.max(confidencePenalty, 0.15);
  }
  return { missing_information: missingInformation, questions, assumptions, confidence_penalty: confidencePenalty };
}

function expandGoal(input = {}) {
  const value = redactValue(input);
  const objective = typeof value.objective === "string" ? value.objective.trim() : "";
  const criteria = asArray(value.success_criteria);
  const ids = criterionIds(criteria);
  const scope = scopeFrom(value.repository_context || {});
  const onlyGoal = onlyGoalRequested(value, objective);
  const missing = missingCriteria(criteria);
  const environment = environmentSummary(value.environment_state);
  const questions = [...environment.questions];
  if (!objective) questions.push("Provide a non-empty objective before expanding the goal");
  if (missing.length) questions.push(...missing);
  if (!scope.allow_external && RELEASE_PATTERN.test(objective)) questions.push("Release follow-up includes tag/publication confirmation; approve any external mutation separately before execution");
  const inferred = RELEASE_PATTERN.test(objective) ? releaseSteps(ids, onlyGoal) : FILE_CHANGE_PATTERN.test(objective) && !DEPLOY_PATTERN.test(objective) ? fileSteps(objective, ids) : [];
  const violations = candidateScopeViolations(inferred, scope);
  if (violations.length) questions.push("One or more inferred steps reference paths outside the repository ODD");
  const safeInferred = inferred.filter(item => !violations.some(violation => violation.step_id === item.id));
  const assumptions = ["Only repository-local, deterministic verification is autonomous", "Optional release follow-up is deferred unless explicitly approved", ...environment.assumptions];
  if (scope.allowed_paths.length) assumptions.push("Inferred file work is limited to the configured allowed paths");
  let confidence = objective && ids.size > 0 ? 0.82 : 0.35;
  if (RELEASE_PATTERN.test(objective)) confidence = ids.size > 0 ? 0.9 : 0.4;
  confidence = Math.max(0, confidence - environment.confidence_penalty);
  if (violations.length) confidence = Math.min(confidence, 0.25);
  const effectivePolicy = policyMode(value.execution_policy);
  const requestedCapabilities = [...new Set([...capabilitiesForSteps(safeInferred), ...(safeInferred.some(item => detectSideEffects({ description: item.description, verification: item.verification }).includes("file_change") || Array.isArray(item.verification?.paths) && item.verification.paths.length > 0) ? ["workspace_write"] : [])])];
  const alwaysBlockedActions = safeInferred.filter(item => ["never_autonomous", "always_blocked"].includes(item.execution_policy)).map(item => item.id);
  const grantedCapabilities = Array.isArray(value.granted_capabilities) ? value.granted_capabilities : effectivePolicy === "unrestricted" ? [] : requestedCapabilities.filter(capability => ["read", "inspect", "verify"].includes(capability));
  const deniedCapabilities = requestedCapabilities.filter(capability => !grantedCapabilities.includes(capability));
  const requiresConfirmation = questions.length > 0 || confidence < 0.6 || requestedCapabilities.some(capability => !["read", "inspect", "verify", "workspace_write"].includes(capability)) || safeInferred.some(item => item.status === "deferred");
  const planInput = { objective, explicit_steps: [], inferred_steps: safeInferred, dependencies: safeInferred.flatMap(item => item.depends_on.length ? [{ step_id: item.id, depends_on: item.depends_on }] : []), success_criteria: criteria, scope_boundary: scope, risk_level: safeInferred.some(item => item.risk === "critical") ? "critical" : safeInferred.some(item => item.risk === "high") ? "high" : "low", approval_requirements: [], assumptions, execution_policy: effectivePolicy, requested_capabilities: requestedCapabilities, granted_capabilities: grantedCapabilities, denied_capabilities: deniedCapabilities, requires_explicit_confirmation: effectivePolicy === "unrestricted" || requiresConfirmation, always_blocked_actions: alwaysBlockedActions };
  let goalPlan = null;
  if (!missing.length && objective && !violations.length) {
    const candidate = createGoalPlan(planInput);
    const validation = validateGoalPlan(candidate);
    if (validation.valid) goalPlan = candidate;
    else questions.push("The inferred plan did not pass GoalPlan validation and requires clarification");
  }
  const optionalSteps = (goalPlan?.inferred_steps || []).filter(item => item.required === false).map(item => ({ ...item, capability_status: item.execution_policy === "never_autonomous" || item.execution_policy === "always_blocked" ? "always_blocked" : item.execution_policy === "safe" ? "safe" : effectivePolicy === "unrestricted" ? "unrestricted_eligible" : "approval_required" }));
  return { goal_plan: goalPlan, inferred_steps: goalPlan?.inferred_steps || [], assumptions, missing_information: [...environment.missing_information, ...missing, ...violations.map(item => `Path is outside the repository ODD: ${normalizePath(item.path)}`)], expansion_confidence: confidence, requires_user_confirmation: requiresConfirmation || environment.missing_information.length > 0 || environment.questions.length > 0 || !goalPlan, requested_capabilities: goalPlan?.requested_capabilities || requestedCapabilities, granted_capabilities: goalPlan?.granted_capabilities || grantedCapabilities, denied_capabilities: goalPlan?.denied_capabilities || deniedCapabilities, requires_explicit_confirmation: goalPlan?.requires_explicit_confirmation === true || effectivePolicy === "unrestricted", questions, optional_steps: optionalSteps, out_of_scope_candidates: violations.map(item => ({ step_id: item.step_id, path: normalizePath(item.path), status: "not_added", reason: "repository_odd_scope" })), only_goal: onlyGoal };
}

module.exports = { expandGoal, pathAllowed, scopeFrom, extractPaths, onlyGoalRequested };
