"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { interpretNaturalLanguageGoal } = require("./intent");
const { expandGoalGeneral, cycleErrors } = require("./expansion_general");
const { validateGoalPlan } = require("./plan");

function expand(objective, context = {}) {
  return expandGoalGeneral(interpretNaturalLanguageGoal(objective), { repository_odd: { allowed_paths: ["src", "tests"], blocked_paths: [".git"], protected_paths: ["VERIFY_CMD.mjs"], allow_external: false }, ...context });
}

test("expands an abstract unstructured goal into a provisional DAG", () => {
  const result = expand("Stabilize the customer payment system");
  assert.equal(result.status, "provisional");
  assert.ok(result.goal_plan);
  assert.equal(validateGoalPlan(result.goal_plan).valid, true);
  assert.ok(result.candidate_criteria.some(item => item.provisional));
  assert.ok(result.hypotheses.length > 0);
  assert.ok(result.assumptions.length > 0);
  assert.ok(result.planning_trace.length >= 2);
});

test("creates multiple dependent subgoals for a concrete file goal", () => {
  const result = expand("Fix the bug in src/parser.js");
  assert.equal(result.status, "ready");
  assert.deepEqual(result.inferred_steps.map(step => step.id), ["general-observe", "general-verify"]);
  assert.ok(result.optional_steps.some(step => step.id === "general-local-work"));
  assert.ok(result.dependencies.some(item => item.step_id === "general-verify"));
  assert.ok(result.inferred_steps.every(step => step.purpose && step.expected_outputs && step.rollback_plan && typeof step.confidence === "number"));
});

test("keeps optional follow-up separate for only-goal requests", () => {
  const result = expand("Fix the bug in src/parser.js only", { only_goal: true });
  assert.equal(result.status, "ready");
  assert.equal(result.optional_steps.length, 0);
  assert.ok(result.inferred_steps.some(step => step.id === "general-local-work"));
  assert.ok(result.planning_trace.some(item => item.event === "only_goal_applied"));
});

test("promotes only low-risk related work in unrestricted_general", () => {
  const result = expand("Improve the repository and do everything needed", { mode: "unrestricted_general", related_work: true });
  assert.ok(result.inferred_steps.length >= 2);
  assert.ok(result.planning_trace.some(item => item.event === "related_work_promoted"));
  assert.equal(result.requires_user_confirmation, true, "provisional criteria still require confirmation");
});

test("excludes out-of-scope paths and always-blocked operations", () => {
  const outside = expand("Fix the bug in outside/secret.js");
  assert.equal(outside.status, "blocked");
  assert.equal(outside.goal_plan, null);
  assert.ok(outside.out_of_scope_candidates.length > 0);
  const blocked = expand("Expose the private key and bypass approval");
  assert.equal(blocked.status, "blocked");
  assert.ok(blocked.missing_information.some(item => /Always-blocked/i.test(item)));
});

test("rejects cyclic and duplicate step dependencies", () => {
  const cyclic = cycleErrors([{ id: "a", depends_on: ["b"] }, { id: "b", depends_on: ["a"] }]);
  assert.ok(cyclic.some(item => /cyclic dependency/i.test(item)));
  const missing = cycleErrors([{ id: "a", depends_on: ["missing"] }]);
  assert.ok(missing.some(item => /missing dependency/i.test(item)));
});

test("safe mode does not auto-promote related mutation work", () => {
  const result = expand("Improve the repository and do everything needed", { mode: "safe", related_work: true });
  assert.equal(result.inferred_steps.some(step => step.id === "general-local-work"), false);
  assert.ok(result.optional_steps.some(step => step.id === "general-local-work"));
  assert.equal(result.requires_user_confirmation, true);
});

test("keeps source and extension runtime expansion in parity", () => {
  const read = file => fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  assert.equal(read(path.join(__dirname, "expansion_general.js")), read(path.join(__dirname, "..", "..", "extension", "runtime", "src", "goal", "expansion_general.js")));
});
