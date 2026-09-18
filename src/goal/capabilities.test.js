"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { normalizeCapabilityContract, selectModel, routeRole, capabilityScore, observeCapabilityProfile, isExcludedByObservedFailure } = require("./capabilities");

const models = [
  { provider: "cheap", model: "small", capabilities: { structured_output: true, tool_calling: false, repository_navigation: "low", code_editing: "low", error_recovery: "low", long_horizon: "low" } },
  { provider: "strong", model: "large", capabilities: { structured_output: true, tool_calling: true, repository_navigation: "high", code_editing: "high", error_recovery: "high", long_horizon: "high" } },
];

test("normalizes capability contracts and scores models by role", () => {
  const contract = normalizeCapabilityContract({ provider: "p", model: "m", capabilities: { structured_output: true, repository_navigation: "high" } });
  assert.equal(contract.capabilities.structured_output, true);
  assert.equal(contract.capabilities.tool_calling, false);
  assert.ok(capabilityScore(models[1], "recovery") > capabilityScore(models[0], "recovery"));
  assert.ok(capabilityScore(models[1], "goal_specification") > capabilityScore(models[0], "goal_specification"));
  assert.equal(selectModel(models, "plan").model, "large");
});

test("routes roles and escalates when no model meets requirements", () => {
  assert.equal(routeRole(models, "intel").model, "small");
  assert.equal(routeRole(models, "work").model, "large");
  assert.throws(() => routeRole([models[0]], "recovery", { minimum: { error_recovery: "high" } }), /escalat|capabil/i);
});

test("uses a different stronger model after repeated failure", () => {
  const selected = selectModel(models, "work", { exclude: ["small"], minimum: { error_recovery: "medium" } });
  assert.equal(selected.model, "large");
});

test("keeps declared capability separate from observed capability and marks sparse data insufficient", () => {
  const profile = observeCapabilityProfile(models[1], [{ model_profile: "large", behavior_observations: { structured_json_output_success: true } }]);
  assert.equal(profile.declared_capabilities.structured_output, true);
  assert.equal(profile.observed_capabilities.structured_output, null);
  assert.equal(profile.confidence.overall, "insufficient_observations");
  assert.equal(profile.observation_counts.structured_output, 1);
});

test("excludes a model from roles only after repeated observed failures", () => {
  const failed = { ...models[1], observation_counts: { structured_output: 3 }, observed_capabilities: { structured_output: false }, observed_failures: { structured_output: 3 } };
  assert.equal(isExcludedByObservedFailure(failed, "specification"), true);
  assert.throws(() => routeRole([failed], "specification"), /No model capability/);
  const sparse = { ...failed, observation_counts: { structured_output: 1 } };
  assert.equal(isExcludedByObservedFailure(sparse, "specification"), false);
});

test("excludes false-completion models from completion authority", () => {
  const failed = { ...models[1], observation_counts: { completion_authority: 3 }, observed_capabilities: { completion_authority: false }, observed_failures: { false_completion: 1 } };
  assert.equal(isExcludedByObservedFailure(failed, "completion_authority"), true);
  assert.throws(() => routeRole([failed], "completion_authority"), /No model capability/);
});

test("escalates when every recovery fallback has repeated observed recovery failures", () => {
  const failed = { ...models[1], observation_counts: { error_recovery: 3 }, observed_capabilities: { error_recovery: false }, observed_failures: { verifier_failure_recovery: 3 } };
  assert.throws(() => routeRole([failed], "recovery"), /No model capability/);
});
