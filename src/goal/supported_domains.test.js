"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { interpretNaturalLanguageGoal } = require("./intent");
const { DOMAIN_PROFILES, assessGoalSupport, candidateGoalTypes, supportedDomainNames } = require("./supported_domains");
const { expandGoalGeneral } = require("./expansion_general");

test("domain registry exposes bounded local, approval, clarification, and unknown profiles", () => {
  assert.deepEqual(supportedDomainNames(), ["repository_local", "repository_improvement", "external_operation", "unknown"]);
  assert.equal(DOMAIN_PROFILES.repository_local.execution_boundary, "local_bounded");
  assert.equal(DOMAIN_PROFILES.external_operation.status, "approval_required");
});

test("support assessment requires clarification for low confidence and ambiguity", () => {
  assert.equal(assessGoalSupport({ goal_type: "ambiguous", confidence: 0.9 }).status, "clarification_required");
  assert.equal(assessGoalSupport({ goal_type: "bug_fix", confidence: 0.42 }).status, "clarification_required");
  assert.equal(assessGoalSupport({ goal_type: "bug_fix", confidence: 0.76 }).status, "supported");
});

test("intent records supported domain, execution boundary, and candidate interpretations", () => {
  const local = interpretNaturalLanguageGoal("Fix the bug in src/parser.js");
  assert.equal(local.support_status, "supported");
  assert.equal(local.supported_domain, "repository_local");
  assert.equal(local.execution_boundary, "local_bounded");
  assert.equal(local.candidate_interpretations.length, 1);
  const ambiguous = interpretNaturalLanguageGoal("Improve the service");
  assert.equal(ambiguous.support_status, "clarification_required");
  assert.equal(ambiguous.execution_boundary, "clarification_only");
  assert.ok(ambiguous.candidate_interpretations.length >= 2);
});

test("external intent is classified as approval-required rather than unsupported", () => {
  const intent = interpretNaturalLanguageGoal("Deploy the service to staging");
  assert.equal(intent.support_status, "approval_required");
  assert.equal(intent.execution_boundary, "authorized_external");
  assert.ok(intent.support_reasons.includes("external_authorization_required"));
});

test("unsafe intent and unsupported status fail closed during expansion", () => {
  const unsafe = interpretNaturalLanguageGoal("Use password=hidden to deploy");
  assert.equal(unsafe.support_status, "unsupported");
  const result = expandGoalGeneral(unsafe, { mode: "unrestricted_general" });
  assert.equal(result.status, "blocked");
  assert.equal(result.goal_plan, null);
  assert.equal(result.execution_boundary, "unsupported");
});

test("ambiguous candidate types remain additive and do not grant authority", () => {
  assert.deepEqual(candidateGoalTypes("ambiguous", "Improve the service"), ["abstract_improvement", "refactoring", "feature_addition"]);
  const intent = interpretNaturalLanguageGoal("Improve the service");
  assert.equal(intent.constraints.external_access, false);
  assert.equal(intent.support_status, "clarification_required");
  assert.equal(intent.execution_boundary, "clarification_only");
});

test("source and extension runtime domain contracts remain identical", () => {
  const read = file => fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  for (const relative of ["supported_domains.js", "intent.js", "expansion_general.js"]) {
    assert.equal(read(path.join(__dirname, relative)), read(path.join(__dirname, "..", "..", "extension", "runtime", "src", "goal", relative)), relative);
  }
});
