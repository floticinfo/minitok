"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { expandGoal } = require("./expansion");
const { validateGoalPlan } = require("./plan");
const { generateNextTask } = require("../pipeline/next_task");
const { GoalController } = require("./controller");

function input(objective, overrides = {}) {
  return {
    objective,
    success_criteria: [{ id: "release", description: "The requested objective is verified", required: true }],
    repository_context: { repository_odd: { allowed_paths: ["src", "tests", "docs"], blocked_paths: [".git"], protected_paths: ["VERIFY_CMD.mjs"], allow_external: false } },
    execution_policy: "safe",
    ...overrides,
  };
}

test("expands a release objective into required local checks and deferred release follow-up", () => {
  const result = expandGoal(input("Prepare a release with version bump, tests, and package verification"));
  assert.ok(result.goal_plan);
  assert.equal(validateGoalPlan(result.goal_plan).valid, true);
  const ids = result.inferred_steps.map(step => step.id);
  assert.deepEqual(ids.slice(0, 3), ["release-version", "release-tests", "release-package"]);
  assert.ok(result.optional_steps.some(step => step.id === "release-tag-confirmation"));
  assert.ok(result.optional_steps.some(step => step.id === "release-publication-confirmation"));
  assert.equal(result.requires_user_confirmation, true);
  assert.ok(result.questions.some(question => /external mutation/i.test(question)));
  assert.ok(result.goal_plan.approval_requirements.includes("publish"));
});

test("objective-only requests do not include optional release work", () => {
  const result = expandGoal(input("Prepare a release only"));
  assert.ok(result.goal_plan);
  assert.equal(result.optional_steps.length, 0);
  assert.equal(result.inferred_steps.some(step => step.id.includes("tag") || step.id.includes("publication")), false);
});

test("simple file changes do not expand into release or deployment work", () => {
  const result = expandGoal(input("Fix the bug in src/parser.js", { success_criteria: [{ id: "bug-fixed", description: "The parser bug is fixed", required: true }] }));
  assert.ok(result.goal_plan);
  assert.deepEqual(result.inferred_steps.map(step => step.id), ["goal-change"]);
  assert.equal(result.inferred_steps.some(step => /release|deploy|publish/i.test(step.description)), false);
  assert.equal(result.requires_user_confirmation, false);
});

test("environment state turns unavailable prerequisites into confirmation questions without exposing raw values", () => {
  const result = expandGoal(input("Fix the bug in src/parser.js", {
    environment_state: {
      repository_clean: false,
      repository_status: "dirty",
      missing_commands: ["C:\\tools\\npm.cmd"],
      filesystem_writable: false,
      verifier_available: false,
      provider_ready: false,
      network_available: false,
      API_KEY: "do-not-record",
      token: "do-not-record",
    },
  }));
  assert.equal(result.requires_user_confirmation, true);
  assert.ok(result.missing_information.some(item => /verifier|workspace|provider|commands/i.test(item)));
  assert.ok(result.questions.length >= 3);
  assert.ok(result.assumptions.some(item => /pre-existing|network/i.test(item)));
  assert.ok(result.expansion_confidence < 0.82);
  assert.doesNotMatch(JSON.stringify(result), /do-not-record|API_KEY|token/);
});

test("omitting environment state preserves the existing expansion contract", () => {
  const baseline = expandGoal(input("Fix the bug in src/parser.js"));
  const explicitDefaults = expandGoal(input("Fix the bug in src/parser.js", { environment_state: {} }));
  assert.deepEqual(explicitDefaults.inferred_steps, baseline.inferred_steps);
  assert.deepEqual(explicitDefaults.missing_information, baseline.missing_information);
  assert.equal(explicitDefaults.requires_user_confirmation, baseline.requires_user_confirmation);
});

test("missing criteria creates a clarification request instead of an executable plan", () => {
  const result = expandGoal({ objective: "Improve the parser", success_criteria: [], repository_context: { repository_odd: { allowed_paths: ["src"], blocked_paths: [], protected_paths: [], allow_external: false } } });
  assert.equal(result.goal_plan, null);
  assert.equal(result.requires_user_confirmation, true);
  assert.ok(result.missing_information.length > 0);
  assert.ok(result.questions.length > 0);
});

test("inferred scope violations are rejected and retained only as candidates", () => {
  const result = expandGoal(input("Fix the bug in outside/secret.js", { success_criteria: [{ id: "bug-fixed", description: "The bug is fixed", required: true }], repository_context: { repository_odd: { allowed_paths: ["src"], blocked_paths: [], protected_paths: [], allow_external: false } } }));
  assert.equal(result.goal_plan, null);
  assert.equal(result.inferred_steps.length, 0);
  assert.equal(result.out_of_scope_candidates.length, 1);
  assert.equal(result.out_of_scope_candidates[0].status, "not_added");
  assert.equal(result.requires_user_confirmation, true);
});

test("low-confidence ambiguous objectives request confirmation", () => {
  const result = expandGoal(input("Improve things", { success_criteria: [] }));
  assert.equal(result.goal_plan, null);
  assert.equal(result.expansion_confidence < 0.6, true);
  assert.equal(result.requires_user_confirmation, true);
});

test("GoalController uses required inferred steps only when expansion context is explicit", async () => {
  const goal = {
    schema_version: 1,
    goal_id: "goal-expansion-controller",
    objective: "Prepare a release",
    success_criteria: [{ id: "release", description: "Release checks pass", required: true, verifier: { type: "custom", id: "release", config: {} } }],
    constraints: { allowed_paths: [], blocked_paths: [], max_cycles: 1, max_tokens: 0, timeout_ms: 0, stagnation_limit: 2, max_changed_files: 5, same_task_limit: 2, same_failure_limit: 2, requires_approval_for: [], repository_odd: { allowed_paths: [], protected_paths: [], required_checks: [], allow_external: false } },
    execution_policy: { mode: "safe" },
  };
  const controller = new GoalController(goal, { goalExpansion: { success_criteria: goal.success_criteria, repository_context: { repository_odd: goal.constraints.repository_odd }, only_goal: true } });
  const proposal = await controller.taskProposer(goal, goal.success_criteria, null, { goalExpansion: controller.options.goalExpansion });
  assert.equal(proposal.inferred_step_id, "release-version");
  assert.equal(/tag|publish/i.test(proposal.next_task), false);
});

test("next_task expansion passes environment state without changing legacy responses", async () => {
  const provider = { complete: async () => ({ text: JSON.stringify({ done: false, next_task: "continue", remaining_goals: ["x"] }), tokens: { input: 1, output: 1 } }) };
  const expanded = await generateNextTask(provider, "Fix src/parser.js", [], null, { expandGoal: true, success_criteria: [{ id: "fix", description: "Fixed", required: true }], environment_state: { verifier_available: false } });
  assert.equal(expanded.requires_user_confirmation, true);
  assert.ok(expanded.missing_information.some(item => /verifier/i.test(item)));
});

test("next_task preserves its legacy shape unless expansion is explicitly requested", async () => {
  const provider = { complete: async () => ({ text: JSON.stringify({ done: false, next_task: "continue", remaining_goals: ["x"] }), tokens: { input: 1, output: 1 } }) };
  const legacy = await generateNextTask(provider, "baseline goal", [], null);
  assert.deepEqual(Object.keys(legacy).sort(), ["done", "next_task", "remaining_goals", "summary", "tokens"].sort());
  const expanded = await generateNextTask(provider, "Fix src/parser.js", [], null, { expandGoal: true, success_criteria: [{ id: "fix", description: "Fixed", required: true }], repository_context: { repository_odd: { allowed_paths: ["src"], blocked_paths: [], protected_paths: [], allow_external: false } } });
  assert.ok(Array.isArray(expanded.inferred_steps));
  assert.equal(expanded.next_task, "continue");
});
