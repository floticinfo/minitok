"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { resolveExecutionPolicy, normalizeMode, capabilitiesForSideEffects } = require("../src/goal/execution_policy");
const source = require("../src/goal/execution_policy");

const safe = ["read", "inspect", "verify"];

test("defaults to safe and allows read-only capabilities", () => {
  const result = resolveExecutionPolicy({ capabilities: safe });
  assert.equal(result.mode, "safe");
  assert.equal(result.allowed, true);
  assert.deepEqual(result.denied_capabilities, []);
});

test("safe denies workspace, external, credential, and mutation capabilities", () => {
  const result = resolveExecutionPolicy({ mode: "safe", capabilities: ["workspace_write", "external_call", "credential_use", "publish", "deploy", "database_mutation", "force_push", "tag_overwrite"] });
  assert.equal(result.allowed, false);
  assert.deepEqual(result.denied_capabilities, ["workspace_write", "external_call", "credential_use", "publish", "deploy", "database_mutation", "force_push", "tag_overwrite"]);
  assert.equal(result.approval_required, false);
});

test("supervised requires explicit confirmation for workspace mutation", () => {
  const denied = resolveExecutionPolicy({ mode: "supervised", capabilities: ["workspace_write"] });
  assert.equal(denied.allowed, false);
  assert.equal(denied.approval_required, true);
  const approved = resolveExecutionPolicy({ mode: "supervised", capabilities: ["workspace_write"], explicit_confirmation: true });
  assert.equal(approved.allowed, true);
});

test("authorized_external requires confirmation and credential presence", () => {
  const denied = resolveExecutionPolicy({ mode: "authorized_external", capabilities: ["publish", "credential_use"], explicit_confirmation: true });
  assert.equal(denied.allowed, false);
  assert.deepEqual(denied.denied_capabilities, ["credential_use"]);
  const approved = resolveExecutionPolicy({ mode: "authorized_external", capabilities: ["publish", "credential_use"], explicit_confirmation: true, actor: { credential_present: true } });
  assert.equal(approved.allowed, true);
});

test("unrestricted requires explicit confirmation and auto_accept", () => {
  const missingConfirmation = resolveExecutionPolicy({ mode: "unrestricted", capabilities: ["publish"], auto_accept: true });
  assert.equal(missingConfirmation.allowed, false);
  assert.ok(missingConfirmation.denied_capabilities.includes("explicit_confirmation"));
  const missingAutoAccept = resolveExecutionPolicy({ mode: "unrestricted", capabilities: ["publish"], explicit_confirmation: true });
  assert.equal(missingAutoAccept.allowed, false);
  assert.ok(missingAutoAccept.denied_capabilities.includes("auto_accept"));
  const allowed = resolveExecutionPolicy({ mode: "unrestricted", capabilities: ["publish"], explicit_confirmation: true, auto_accept: true });
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.approval_required, false);
});

test("unrestricted still rejects always-blocked and unknown capabilities", () => {
  const blocked = resolveExecutionPolicy({ mode: "unrestricted", capabilities: ["protected_path_write"], explicit_confirmation: true, auto_accept: true });
  assert.equal(blocked.allowed, false);
  assert.deepEqual(blocked.always_blocked_capabilities, ["protected_path_write"]);
  const unknown = resolveExecutionPolicy({ mode: "unrestricted", capabilities: ["made_up"], explicit_confirmation: true, auto_accept: true });
  assert.equal(unknown.allowed, false);
  assert.deepEqual(unknown.denied_capabilities, ["made_up"]);
});

test("legacy aliases never implicitly activate unrestricted", () => {
  assert.deepEqual(normalizeMode("workspace"), { mode: "supervised", legacy: true, invalid: false, requested: "workspace" });
  assert.deepEqual(normalizeMode("autonomous"), { mode: "supervised", legacy: true, invalid: false, requested: "autonomous" });
  assert.equal(resolveExecutionPolicy({ mode: "autonomous", capabilities: ["publish"], explicit_confirmation: true, auto_accept: true }).allowed, false);
  assert.equal(resolveExecutionPolicy({ mode: "never_autonomous", capabilities: ["read"] }).mode, "always_blocked");
});

test("dangerous policy input fails closed and side effects map to capabilities", () => {
  const value = { capabilities: ["read"] };
  Object.defineProperty(value, "__proto__", { value: true, enumerable: true });
  assert.equal(resolveExecutionPolicy(value).allowed, false);
  assert.deepEqual(capabilitiesForSideEffects(["file_change", "publish", "credential", "database_mutation"]), ["workspace_write", "publish", "credential_use", "database_mutation"]);
});

test("unrestricted rejects protected path writes even with explicit authorization", () => {
  const result = resolveExecutionPolicy({ mode: "unrestricted", capabilities: ["protected_path_write"], explicit_confirmation: true, auto_accept: true });
  assert.equal(result.allowed, false);
  assert.deepEqual(result.always_blocked_capabilities, ["protected_path_write"]);
});

test("configuration disables unrestricted and enforces its allowlist", () => {
  const disabled = resolveExecutionPolicy({ mode: "unrestricted", capabilities: ["publish"], explicit_confirmation: true, auto_accept: true, config: { goal: { unrestricted: { enabled: false, capabilities: ["publish"] } } } });
  assert.equal(disabled.allowed, false);
  assert.deepEqual(disabled.denied_capabilities, ["unrestricted_disabled"]);
  const outside = resolveExecutionPolicy({ mode: "unrestricted", capabilities: ["deploy"], explicit_confirmation: true, auto_accept: true, config: { goal: { unrestricted: { enabled: true, capabilities: ["publish"] } } } });
  assert.equal(outside.allowed, false);
  assert.deepEqual(outside.denied_capabilities, ["deploy"]);
  const allowed = resolveExecutionPolicy({ mode: "unrestricted", capabilities: ["publish"], explicit_confirmation: true, auto_accept: true, config: { goal: { unrestricted: { enabled: true, capabilities: ["publish"] } } } });
  assert.equal(allowed.allowed, true);
});

test("configured allowlist is used when unrestricted capabilities are omitted", () => {
  const allowed = resolveExecutionPolicy({ mode: "unrestricted", explicit_confirmation: true, auto_accept: true, config: { goal: { unrestricted: { enabled: true, capabilities: ["publish"] } } } });
  assert.deepEqual(allowed.capabilities, ["publish"]);
  assert.equal(allowed.allowed, true);
});

test("configured unrestricted requirements remain fail-closed", () => {
  const result = resolveExecutionPolicy({ mode: "unrestricted", capabilities: ["publish"], config: { goal: { unrestricted: { enabled: true, capabilities: ["publish"], require_explicit_confirmation: true, require_auto_accept: true } } } });
  assert.equal(result.allowed, false);
  assert.deepEqual(result.denied_capabilities, ["explicit_confirmation"]);
});

test("CLI run exposes the same resolver contract without implicit unrestricted access", () => {
  const { cmdRun } = require("../src/cli/commands/run");
  return cmdRun("policy test", { mode: "unrestricted", capabilities: ["publish"], explicitConfirmation: true }).then(code => assert.equal(code, 1));
});

test("source and extension runtime resolver contracts are in parity", () => {
  const runtimePath = path.join(__dirname, "..", "extension", "runtime", "src", "goal", "execution_policy.js");
  assert.equal(fs.existsSync(runtimePath), true);
  const runtime = require(runtimePath);
  assert.deepEqual(runtime.EXECUTION_POLICY_MODES, source.EXECUTION_POLICY_MODES);
  assert.deepEqual(runtime.resolveExecutionPolicy({ mode: "unrestricted", capabilities: ["publish"], explicit_confirmation: true, auto_accept: true }), source.resolveExecutionPolicy({ mode: "unrestricted", capabilities: ["publish"], explicit_confirmation: true, auto_accept: true }));
});
