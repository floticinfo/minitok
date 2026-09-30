"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const source = require("../src/goal/capabilities");
const plan = require("../src/goal/plan");

const EXPECTED = [
  "read", "inspect", "verify", "workspace_write", "local_mutation", "external_call",
  "credential_use", "publish", "deploy", "database_mutation", "force_push", "tag_overwrite",
  "protected_path_write",
];

test("execution capability contract has the canonical vocabulary and metadata", () => {
  assert.deepEqual(source.EXECUTION_CAPABILITIES, EXPECTED);
  assert.equal(source.validateCapabilityContract().valid, true);
  for (const capability of EXPECTED) {
    const metadata = source.getCapabilityMetadata(capability);
    assert.ok(metadata, capability);
    assert.equal(typeof metadata.side_effect, "boolean");
    assert.equal(typeof metadata.default_approval, "boolean");
    assert.equal(typeof metadata.default_execution_policy, "string");
    assert.equal(typeof metadata.unrestricted_allowed, "boolean");
    assert.equal(typeof metadata.always_blocked, "boolean");
    assert.equal(typeof metadata.verification_required, "boolean");
  }
});

test("unknown, empty, duplicate, and always-blocked capabilities are rejected", () => {
  assert.equal(source.validateCapabilities(["read", "verify"]).valid, true);
  assert.equal(source.validateCapabilities(["unknown_capability"]).errors[0].code, "UNKNOWN_CAPABILITY");
  assert.equal(source.validateCapabilities([""]).errors[0].code, "INVALID_CAPABILITY");
  assert.equal(source.validateCapabilities(["read", "read"]).errors[0].code, "DUPLICATE_CAPABILITY");
  assert.equal(source.validateCapabilities(["protected_path_write"]).errors[0].code, "ALWAYS_BLOCKED_CAPABILITY");
  assert.throws(() => source.assertValidCapabilities(["unknown_capability"]), /Unknown capability/);
});

test("dangerous capability object keys fail closed", () => {
  for (const key of ["__proto__", "prototype", "constructor"]) {
    const value = { capabilities: ["read"] };
    Object.defineProperty(value, key, { value: true, enumerable: true, configurable: true });
    const result = source.validateCapabilities(value);
    assert.equal(result.valid, false, key);
    assert.ok(result.errors.some(error => error.code === "DANGEROUS_FIELD"), key);
  }
});

test("external and mutation capabilities are approval-required but unrestricted-eligible", () => {
  for (const capability of ["workspace_write", "local_mutation", "external_call", "credential_use", "publish", "deploy", "database_mutation", "force_push", "tag_overwrite"]) {
    const metadata = source.getCapabilityMetadata(capability);
    assert.equal(metadata.default_approval, true, capability);
    assert.equal(metadata.unrestricted_allowed, true, capability);
    assert.equal(metadata.always_blocked, false, capability);
  }
  assert.equal(source.isAlwaysBlockedCapability("protected_path_write"), true);
  assert.equal(source.getCapabilityMetadata("protected_path_write").unrestricted_allowed, false);
  for (const operation of ["private_key_exposure", "credential_value_logging", "authorization_header_logging", "password_logging", "token_logging", "approval_bypass"]) assert.ok(source.ALWAYS_BLOCKED_OPERATIONS[operation]);
});

test("existing side-effect and approval contracts remain backward compatible", () => {
  assert.deepEqual(plan.SIDE_EFFECTS, ["file_change", "external_call", "publish", "deploy", "credential", "database_mutation"]);
  assert.deepEqual(plan.APPROVAL_REQUIREMENTS, plan.SIDE_EFFECTS);
  assert.deepEqual(plan.EXECUTION_CAPABILITIES, EXPECTED);
});

test("source and extension runtime execution capability contracts are in parity", () => {
  const runtimePath = path.join(__dirname, "..", "extension", "runtime", "src", "goal", "capabilities.js");
  assert.equal(fs.existsSync(runtimePath), true);
  const runtime = require(runtimePath);
  assert.deepEqual(runtime.EXECUTION_CAPABILITIES, source.EXECUTION_CAPABILITIES);
  assert.deepEqual(runtime.CAPABILITY_METADATA, source.CAPABILITY_METADATA);
  assert.deepEqual(runtime.ALWAYS_BLOCKED_OPERATIONS, source.ALWAYS_BLOCKED_OPERATIONS);
  assert.deepEqual(runtime.validateCapabilityContract(), source.validateCapabilityContract());
});
