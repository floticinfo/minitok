"use strict";

const crypto = require("crypto");
const { createGoalSpec, isPlainObject } = require("./spec");
const { assertValidGoalSpec, validateGoalSpec } = require("./validator");

function goalIdFor(value) {
  return `goal-${crypto.createHash("sha256").update(value).digest("hex").slice(0, 16)}`;
}

function clarification(objective, questions, metadata = {}) {
  const normalized = questions.map(item => typeof item === "string" ? item : item.question).filter(Boolean);
  return { status: "clarification_required", objective, questions: normalized, question_details: questions.map((item, index) => typeof item === "string" ? { id: `q${index + 1}`, question: item, required: true } : item), ...metadata };
}
function unsupported(objective, reason, goalKind = "unsupported") {
  return { status: "unsupported", objective, goal_kind: goalKind, reason, questions: [] };
}
function ready(spec, source = "deterministic", metadata = {}) {
  assertValidGoalSpec(spec);
  return { status: "ready", source, spec, ...metadata };
}
function classifyObjective(objective) {
  const lower = objective.toLowerCase();
  if (/\b(?:add|implement|introduce|build|create)\b.*\b(?:feature|functionality|support)\b/.test(lower)) return "feature_addition";
  if (/\b(?:fix|resolve|repair|correct)\b.*\b(?:bug|issue|error|defect|failure)\b/.test(lower) || /\bbug\b/.test(lower)) return "bug_fix";
  if (/\b(?:add|write|create|increase|improve)\b.*\btests?\b|\btests?\b.*\b(?:add|write|create)\b/.test(lower)) return "test_addition";
  if (/\b(?:api|http|rest)\b.*\b(?:endpoint|route)\b|\b(?:endpoint|route)\b.*\b(?:api|http|rest)\b/.test(lower)) return "api_endpoint";
  if (/\b(?:document|documentation|docs|readme)\b/.test(lower)) return "documentation";
  if (/\b(?:refactor|restructure|reorganize|clean up)\b/.test(lower)) return "refactoring";
  if (/\b(?:file|module|class|function)\b/.test(lower) && /\b(?:change|modify|update|edit|replace|move)\b/.test(lower)) return "file_or_module_change";
  return "ambiguous";
}
function clarificationForObjective(objective) {
  const goalKind = classifyObjective(objective);
  const common = [{ id: "acceptance", question: "What observable result proves this objective is complete?", reason: "success_condition", required: true }, { id: "verifier", question: "Which test, command, file state, or repository check should verify success?", reason: "verifier", required: true }];
  const specific = {
    feature_addition: [{ id: "scope", question: "Which user-visible behavior and repository paths are in scope for the feature?", reason: "scope", required: true }],
    bug_fix: [{ id: "reproduction", question: "What current behavior is wrong, and what expected behavior or regression test should prove the fix?", reason: "acceptance", required: true }],
    test_addition: [{ id: "target", question: "Which behavior or failure mode must the new test cover?", reason: "scope", required: true }],
    api_endpoint: [{ id: "contract", question: "What HTTP method, path, request shape, response status, and response body define success?", reason: "acceptance", required: true }, { id: "deployment", question: "Should this include only local code and tests, or any deployment/configuration change?", reason: "scope", required: true }],
    documentation: [{ id: "document", question: "Which documentation file and required content should be changed?", reason: "scope", required: true }],
    refactoring: [{ id: "behavior", question: "Which behavior must remain unchanged, and what test or command verifies the refactor?", reason: "acceptance", required: true }],
    file_or_module_change: [{ id: "file", question: "What exact file or module should change, and what observable state should it have afterward?", reason: "scope", required: true }],
    ambiguous: [],
  }[goalKind];
  return clarification(objective, [...specific, ...common], { goal_kind: goalKind, missing: common.map(item => item.id).concat(specific.map(item => item.id)) });
}

function deterministicCommandGoal(objective, goalId, command, args, criterionId, description, options) {
  return ready(createGoalSpec({
    schema_version: 1,
    goal_id: goalId,
    objective,
    success_criteria: [{ id: criterionId, description, required: true, verifier: { type: "command", id: criterionId, config: { command, args } } }],
    constraints: { allowed_paths: [], blocked_paths: [".git", ".env"], max_cycles: options.maxCycles ?? 30, timeout_ms: options.timeoutMs ?? 0, requires_approval_for: ["file-write"] },
    execution_policy: { mode: options.mode || "safe" },
  }));
}
function compileGoal(input, options = {}) {
  if (isPlainObject(input)) return compileModelGoal(input, options);
  if (typeof input !== "string" || input.trim() === "") return clarification("", [{ id: "objective", question: "What objective should be achieved?", reason: "objective", required: true }]);
  const objective = input.trim();
  const goalId = options.goalId || goalIdFor(objective);
  const lower = objective.toLowerCase();

  if (/\b(?:deploy|deployment|publish|browser|database|cloud|release)\b/.test(lower)) return unsupported(objective, "This objective requires an external or production environment that the deterministic compiler cannot verify safely.", classifyObjective(objective));
  if (/\b(?:npm\s+test|the\s+test\s+suite)\b/.test(lower)) return deterministicCommandGoal(objective, goalId, "npm", ["test"], "command-npm-test", "The project test suite exits successfully", options);
  if (/\b(?:npm\s+(?:run\s+)?lint|(?:run|execute)\s+lint|lint(?:ing)?\s+(?:the\s+)?(?:project|repository|codebase))\b/.test(lower)) return deterministicCommandGoal(objective, goalId, "npm", ["run-script", "lint"], "command-npm-lint", "The project lint command exits successfully", options);
  if (/\b(?:npm\s+(?:run\s+)?typecheck|(?:run|execute)\s+type[- ]?check|type[- ]?check(?:ing)?\s+(?:the\s+)?(?:project|repository|codebase))\b/.test(lower)) return deterministicCommandGoal(objective, goalId, "npm", ["run-script", "typecheck"], "command-npm-typecheck", "The project typecheck command exits successfully", options);

  const fileMatch = objective.match(/\b(?:ensure|verify|check)\s+(?:that\s+)?(?:the\s+)?file\s+([A-Za-z0-9._/-]+)\s+exists\b/i);
  if (fileMatch) {
    const file = fileMatch[1].replace(/\\/g, "/");
    if (file.startsWith("/") || file.split("/").includes("..") || /^[A-Za-z]:/.test(file)) return { status: "invalid", errors: [{ path: "success_criteria[0].verifier.config.path", code: "INVALID_PATH", message: "Compiled file path must remain inside the workspace" }] };
    return ready(createGoalSpec({
      schema_version: 1,
      goal_id: goalId,
      objective,
      success_criteria: [{ id: "file-exists", description: `File ${file} exists`, required: true, verifier: { type: "file", id: "file-exists", config: { path: file, exists: true } } }],
      constraints: { allowed_paths: [], blocked_paths: [".git", ".env"], max_cycles: options.maxCycles ?? 30, timeout_ms: options.timeoutMs ?? 0, requires_approval_for: ["file-write"] },
      execution_policy: { mode: options.mode || "safe" },
    }));
  }

  return clarificationForObjective(objective);
}

function compileModelGoal(draft, options = {}) {
  if (!isPlainObject(draft)) return { status: "invalid", errors: [{ path: "$", code: "INVALID_OBJECT", message: "Model GoalSpec draft must be an object" }] };
  if (!Array.isArray(draft.success_criteria) || draft.success_criteria.length === 0) return clarification(draft.objective || "", ["Provide at least one success criterion with a verifier"]);

  const candidate = { ...draft };
  // These are model conversation metadata, never completion authority.
  delete candidate.done;
  delete candidate.completed;
  if (options.goalId) candidate.goal_id = options.goalId;
  let spec;
  try {
    spec = createGoalSpec(candidate);
  } catch (error) {
    return { status: "invalid", errors: [{ path: "$", code: "INVALID_OBJECT", message: error.message }] };
  }
  const validation = validateGoalSpec(spec);
  if (!validation.valid) return { status: "invalid", errors: validation.errors };
  return ready(spec, "model-draft");
}

function adaptTaskToGoalSpec(task, options = {}) {
  if (typeof task !== "string" || task.trim() === "") return clarification("", ["A non-empty task is required"]);
  const objective = task.trim();
  const spec = createGoalSpec({
    schema_version: 1,
    goal_id: options.goalId || goalIdFor(objective),
    objective,
    success_criteria: [{
      id: "legacy-task-complete",
      description: "The existing minitok task workflow reports a terminal successful result",
      required: true,
      verifier: { type: "custom", id: "legacy-minitok-run", config: { task: objective, legacy_api: "minitok_run(task)" } },
    }],
    constraints: { allowed_paths: [], blocked_paths: [".git", ".env"], max_cycles: options.maxCycles ?? 30, timeout_ms: options.timeoutMs ?? 0, requires_approval_for: ["file-write"] },
    execution_policy: { mode: options.mode || "safe" },
  });
  return ready(spec, "legacy-task-adapter");
}

module.exports = { compileGoal, compileModelGoal, adaptTaskToGoalSpec, goalIdFor };
