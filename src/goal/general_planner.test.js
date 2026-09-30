"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { interpretNaturalLanguageGoal } = require("./intent");
const { expandGoalGeneral } = require("./expansion_general");
const { buildInitialPlan, validateGeneralPlan, serializeGeneralPlan, deserializeGeneralPlan } = require("./general_planner");
const { replan, detectNoProgress, signature } = require("./replanner");

function intent(objective) { return interpretNaturalLanguageGoal(objective); }
function initial(objective = "Fix the bug in src/parser.js") { const expansion = expandGoalGeneral(intent(objective), { repository_odd: { allowed_paths: ["src"], blocked_paths: [".git"], protected_paths: [], allow_external: false }, only_goal: true }); return buildInitialPlan({ intent: intent(objective), steps: expansion.inferred_steps, dependencies: expansion.dependencies, hypotheses: expansion.hypotheses, assumptions: expansion.assumptions, confidence: expansion.confidence, status: expansion.status, planning_trace: expansion.planning_trace }); }

test("builds and validates a two-step dynamic plan", () => { const plan = initial(); assert.equal(validateGeneralPlan(plan).valid, true); assert.equal(plan.plan_version, 1); assert.ok(plan.steps.length >= 2); assert.ok(plan.next_step); });
test("skips completed steps during partial replanning", () => { const plan = initial(); const completed = plan.steps[0].id; const next = replan(plan, { blocker_reports: [{ category: "environment_failure" }], completed_steps: [completed], new_steps: [{ id: "repair-observation", description: "Re-observe the repository after the blocker", depends_on: [], confidence: .8 }], evidence_ids: ["e1"] }); assert.equal(next.plan_version, 2); assert.ok(next.preserved_steps.includes(completed)); assert.equal(next.steps.some(step => step.id === completed), true); assert.notEqual(next.next_step, completed); });
test("performs full replanning after dependency discovery", () => { const plan = initial(); const next = replan(plan, { new_dependency: true, new_steps: [{ id: "dependency-check", description: "Check the newly discovered dependency", confidence: .8 }], completed_steps: [] }); assert.equal(next.plan_version, 2); assert.ok(next.discarded_steps.length > 0); assert.ok(next.new_steps.includes("dependency-check")); });
test("does not reuse failed patch signatures", () => { const plan = initial(); const failed = { id: "failed-patch", description: "Apply the failed patch", patch: "same patch" }; const next = replan(plan, { failed_steps: [failed.id], failed_patch_signatures: [signature(failed)], new_steps: [failed, { id: "different-patch", description: "Use a different repair strategy", confidence: .7 }] }); assert.equal(next.steps.some(step => step.id === "failed-patch"), false); assert.ok(next.steps.some(step => step.id === "different-patch")); });
test("detects assumption invalidation and no progress", () => { const plan = initial(); const noProgress = detectNoProgress({ completed_steps: plan.steps.slice(0, 1).map(step => step.id), prior_completed_steps: plan.steps.slice(0, 1).map(step => step.id), cycle_count: 2 }); assert.equal(noProgress.stagnant, true); const next = replan(plan, { assumption_invalidated: true, stagnation: true, completed_steps: [] }); assert.equal(next.status, "blocked"); assert.match(next.replanning_reason, /assumption_invalidated|stagnation/); });
test("rejects unrelated new steps and preserves plan version persistence", () => { const plan = initial(); const next = replan(plan, { new_steps: [{ id: "unrelated", description: "Publish an unrelated social media campaign", confidence: .9 }] }); assert.equal(next.steps.some(step => step.id === "unrelated"), false); assert.deepEqual(deserializeGeneralPlan(serializeGeneralPlan(plan)), plan); });
test("keeps source and runtime planner files in parity", () => { const read = file => fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n"); for (const name of ["general_planner.js", "replanner.js"]) assert.equal(read(path.join(__dirname, name)), read(path.join(__dirname, "..", "..", "extension", "runtime", "src", "goal", name))); });
