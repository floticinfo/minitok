"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { expandGoal } = require("../src/goal/expansion");
const { createGoalPlan, validateGoalPlan } = require("../src/goal/plan");
const { BLOCKER_CATEGORIES, createBlockerReport, normalizeAlternative, selectAlternative, buildApprovalRequest } = require("../src/goal/blocker");
const { GoalController } = require("../src/goal/controller");
const { createGoalSpec } = require("../src/goal/spec");
const { createGoalSession, loadGoalSession, releaseGoalSessionLock, goalSessionPaths } = require("../src/goal/session");

function context(allowed = ["src", "tests"]) { return { repository_odd: { allowed_paths: allowed, blocked_paths: [".git"], protected_paths: ["VERIFY_CMD.mjs"], allow_external: false } }; }
function expansionInput(objective, criteria = [{ id: "goal", description: "Goal is verified", required: true }], extra = {}) { return { objective, success_criteria: criteria, repository_context: context(), execution_policy: "safe", ...extra }; }
function criterion(id) { return { id, description: id, required: true, verifier: { type: "custom", id: `v-${id}`, config: {} } }; }
function goalSpec() { return createGoalSpec({ schema_version: 1, goal_id: "phase8-goal", objective: "Phase 8 safety goal", success_criteria: [criterion("a")], constraints: { allowed_paths: [], blocked_paths: [".git"], max_cycles: 3, max_tokens: 0, timeout_ms: 0, stagnation_limit: 3, max_changed_files: 10, same_task_limit: 2, same_failure_limit: 2, requires_approval_for: [] }, execution_policy: { mode: "safe" } }); }

test("creates required related steps and defers optional release follow-up", () => {
  const result = expandGoal(expansionInput("Prepare a release with version bump, tests, and package verification"));
  assert.ok(result.goal_plan);
  assert.deepEqual(result.inferred_steps.slice(0, 3).map(step => step.id), ["release-version", "release-tests", "release-package"]);
  assert.ok(result.optional_steps.every(step => step.required === false && step.status === "deferred"));
  assert.equal(result.requires_user_confirmation, true);
  assert.equal(validateGoalPlan(result.goal_plan).valid, true);
});

test("does not auto-execute optional work or expand a simple file goal into release/deploy", () => {
  const release = expandGoal(expansionInput("Prepare a release only"));
  assert.equal(release.optional_steps.length, 0);
  const simple = expandGoal(expansionInput("Fix the bug in src/parser.js"));
  assert.deepEqual(simple.inferred_steps.map(step => step.id), ["goal-change"]);
  assert.equal(simple.inferred_steps.some(step => /release|deploy|publish/i.test(step.description)), false);
});

test("rejects unrelated or out-of-scope inferred work and asks for clarification", () => {
  const result = expandGoal(expansionInput("Fix the bug in outside/secret.js", [{ id: "fix", description: "Fix", required: true }], { repository_context: context(["src"]) }));
  assert.equal(result.goal_plan, null);
  assert.equal(result.inferred_steps.length, 0);
  assert.equal(result.out_of_scope_candidates[0].status, "not_added");
  assert.equal(result.requires_user_confirmation, true);
});

test("requires inferred rationale and asks questions for low confidence", () => {
  const plan = createGoalPlan({ objective: "goal", explicit_steps: [], inferred_steps: [{ id: "unrelated", description: "unrelated", required: true, depends_on: [], target_criteria: [], verification: {}, status: "proposed" }], dependencies: [], success_criteria: [{ id: "a" }], scope_boundary: { allowed_paths: [], blocked_paths: [], protected_paths: [], allow_external: false }, risk_level: "low", approval_requirements: [], assumptions: [], execution_policy: "safe" });
  assert.equal(validateGoalPlan(plan).valid, false);
  assert.ok(validateGoalPlan(plan).errors.some(error => error.code === "RATIONALE_REQUIRED"));
  const low = expandGoal(expansionInput("Improve things", []));
  assert.equal(low.requires_user_confirmation, true);
  assert.ok(low.questions.length > 0);
  assert.ok(low.expansion_confidence < 0.6);
});

test("generates required blocker alternatives for network, dependency, and metadata failures", () => {
  const network = createBlockerReport({ category: "network_failure", stage: "verify", cause: "connection reset", affected_step: "remote check" });
  const dependency = createBlockerReport({ category: "dependency_failure", stage: "implement", cause: "module not found", affected_step: "install" });
  const metadata = createBlockerReport({ category: "metadata_mismatch", stage: "verify", cause: "manifest mismatch", affected_step: "parity" });
  assert.ok(network.alternatives.some(item => item.alternative_id === "retry-backoff"));
  assert.ok(dependency.alternatives.some(item => item.alternative_id === "dependency-preparation"));
  assert.ok(metadata.alternatives.some(item => item.alternative_id === "metadata-sync"));
});

test("permission and publish blockers expose approval/manual action without execution", () => {
  const permission = createBlockerReport({ category: "permission_blocked", stage: "implement", cause: "permission denied", affected_step: "protected file" });
  const approval = permission.alternatives.find(item => item.alternative_id === "user-approval");
  assert.equal(approval.approval_required, true);
  assert.equal(approval.execution_policy, "authorized_external");
  const selected = selectAlternative(permission, { execution_policy: "safe", used_alternative_ids: ["scope-replan"] });
  assert.equal(selected.status, "approval_required");
  assert.equal(selected.alternative.alternative_id, "user-approval");
  assert.deepEqual(selected.approval_request.required_permissions, ["approval"]);
  assert.match(selected.approval_request.resume_action, /minitok_goal_resume/);

  const publish = normalizeAlternative({ alternative_id: "publish", description: "Publish package", rationale: "release", expected_benefit: "publication", risk_level: "critical", side_effects: ["publish"], required_permissions: ["approval"], estimated_cost: "high", reversible: false, verification_plan: { type: "publication_check" }, applicable: true });
  const request = buildApprovalRequest({ blocker_id: "blocker-test" }, publish, { resume_action: "After the operator publishes the approved artifact, call minitok_goal_resume and run the publication check." });
  assert.equal(request.approval_required, true);
  assert.equal(request.execution_policy, "authorized_external");
  assert.equal(request.required_permissions[0], "approval");
  assert.match(request.resume_action, /operator publishes.*minitok_goal_resume.*publication check/i);
  assert.doesNotMatch(JSON.stringify(request), /token|password|api.?key|private.?key/i);
});

test("every alternative exposes risk, permissions, side effects, policy, cost, reversibility, and verification", () => {
  for (const category of BLOCKER_CATEGORIES) {
    const report = createBlockerReport({ category, stage: "verify", cause: category, affected_step: "step" });
    for (const alternative of report.alternatives) {
      for (const field of ["risk_level", "required_permissions", "side_effects", "execution_policy", "estimated_cost", "reversible", "verification_plan", "approval_required", "applicable"]) assert.ok(Object.prototype.hasOwnProperty.call(alternative, field), `${category} missing ${field}`);
    }
  }
});

test("does not repeat alternatives and escalates after safe candidates are exhausted", () => {
  const report = createBlockerReport({ category: "verification_failure", stage: "verify", cause: "test failed", affected_step: "tests" });
  const first = selectAlternative(report, { execution_policy: "safe" });
  assert.equal(first.status, "selected");
  const second = selectAlternative(report, { execution_policy: "safe", used_alternative_ids: ["alternate-strategy", "alternate-command", "dry-run", "alternate-provider", "alternate-model"] });
  assert.equal(second.status, "escalate");
  assert.equal(second.alternative, null);
});

test("exhausted blocker alternatives escalate to a human instead of retrying", async () => {
  const goal = goalSpec();
  const result = await new GoalController(goal, {
    initialState: {
      alternative_history: ["alternate-strategy", "alternate-command", "dry-run", "alternate-provider", "alternate-model"].map(alternative_id => ({ alternative_id })),
    },
    evaluator: async () => ({ goal_id: goal.goal_id, completed: false, criteria: [{ id: "a", status: "failed", evidence_ids: [] }], remaining_criteria: ["a"], unknown_criteria: [], evidence: [] }),
    taskProposer: async () => ({ next_task: "verify", target_criteria: ["a"] }),
    taskExecutor: async () => ({ success: false, status: "failure", error: "test failed", stage: "verify", tokens: {} }),
  }).run();
  assert.equal(result.state, "escalate");
  assert.equal(result.human_escalation_required, true);
  assert.equal(result.alternative_history.at(-1).status, "escalate");
  assert.match(result.alternative_history.at(-1).resume_action, /minitok_goal_resume/);
});

test("blocks publish/deploy, force push, tag overwrite, and unapproved workspace changes", () => {
  for (const phrase of ["npm publish", "deploy to staging", "force push", "overwrite tag", "expose private key"]) {
    const alternative = normalizeAlternative({ alternative_id: phrase.replace(/\W/g, "-"), description: phrase, rationale: "unsafe", expected_benefit: "unsafe", risk_level: "critical", side_effects: ["external_call"], execution_policy: "never_autonomous", required_permissions: [], estimated_cost: "unknown", reversible: false, verification_plan: {}, applicable: true });
    assert.equal(alternative.applicable, false, phrase);
    assert.equal(selectAlternative({ alternatives: [alternative] }, { execution_policy: "safe" }).status, "escalate", phrase);
  }
  const workspace = normalizeAlternative({ alternative_id: "workspace", description: "Modify workspace file", rationale: "change", expected_benefit: "change", risk_level: "medium", side_effects: ["file_change"], required_permissions: ["write"], estimated_cost: "low", reversible: true, verification_plan: {}, applicable: true });
  assert.equal(workspace.execution_policy, "supervised");
  assert.equal(selectAlternative({ alternatives: [workspace] }, { execution_policy: "safe" }).status, "approval_required");
});

test("redacts credentials and preserves successful alternative evidence in controller output", async () => {
  let calls = 0;
  const goal = goalSpec();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "minitok-phase8-evidence-"));
  let session;
  try {
    session = createGoalSession({ workspaceRoot: root, goalSpec: goal });
    const result = await new GoalController(goal, {
      session,
      releaseSessionOnExit: true,
      execution_policy: "safe",
      evaluator: async () => ({ goal_id: goal.goal_id, completed: calls > 1, criteria: [{ id: "a", status: calls > 1 ? "passed" : "failed", evidence_ids: ["e1"], reason: "state" }], evidence: [{ evidence_id: "e1", valid: calls > 1, executed: true, execution: { executed: true }, stderr: "token=hidden" }], remaining_criteria: calls > 1 ? [] : ["a"], unknown_criteria: [] }),
      taskProposer: async () => ({ next_task: "verify", target_criteria: ["a"] }),
      taskExecutor: async () => { calls += 1; return calls === 1 ? { success: false, status: "failure", error: "connection reset", stage: "verify", tokens: {} } : { success: true, status: "success", tokens: {} }; },
    }).run();
    assert.equal(result.completed, true);
    assert.ok(result.blocker_reports.length > 0);
    assert.ok(result.alternative_history.some(item => item.verification_status === "passed"));
    assert.doesNotMatch(JSON.stringify(result), /token=hidden/);

    const loaded = loadGoalSession(root, goal.goal_id);
    const stateText = fs.readFileSync(goalSessionPaths(root, goal.goal_id).state, "utf8");
    assert.ok(loaded.state.resolution_attempts.length > 0);
    assert.ok(loaded.state.evidence_refs.includes("e1"));
    assert.doesNotMatch(stateText, /token=hidden/);
    releaseGoalSessionLock(loaded);
  } finally {
    session?.lock?.release?.();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("existing isolation and security test modules remain available", () => {
  assert.equal(fs.existsSync(path.join(__dirname, "../src/workspace/isolation.test.js")), true);
  assert.equal(fs.existsSync(path.join(__dirname, "../src/goal/security.test.js")), true);
  assert.equal(fs.existsSync(path.join(__dirname, "../tests/test-write-policy-boundaries.js")), true);
});
