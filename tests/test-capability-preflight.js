"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { capabilityPreflight, capabilitySnapshot, sameCapabilitySnapshot } = require("../src/goal/capability-preflight");

test("capability preflight classifies grants, external operations, and always-blocked work", () => {
  const record = { profile: "full_test", installation_id: "11111111-1111-4111-8111-111111111111", expires_at: new Date(Date.now() + 3600000).toISOString(), capabilities: ["read", "workspace_write", "verify", "auto_accept"] };
  const result = capabilityPreflight({ record, requested: ["read", "workspace_write", "credential_use", "protected_path_write"], policyDecision: { allowed: false, approval_required: false, denied_capabilities: [] } });
  assert.equal(result.capability_token_valid, true);
  assert.ok(result.granted_capabilities.includes("workspace_write"));
  assert.ok(result.blocked_external_operations.includes("credential_use"));
  assert.deepEqual(result.always_blocked_capabilities, ["protected_path_write"]);
  assert.equal(result.policy_decision, "denied");
});

test("capability snapshot is stable and detects changed grants", () => {
  const base = { profile: "full_test", installation_id: "11111111-1111-4111-8111-111111111111", expires_at: "2030-01-01T00:00:00.000Z", capabilities: ["read", "verify"] };
  const one = capabilitySnapshot({ record: base });
  const same = capabilitySnapshot({ record: { ...base, capabilities: ["verify", "read"] } });
  const changed = capabilitySnapshot({ record: { ...base, capabilities: ["read"] } });
  assert.equal(sameCapabilitySnapshot(one, same), true);
  assert.equal(sameCapabilitySnapshot(one, changed), false);
});
