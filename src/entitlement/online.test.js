"use strict";
const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const { checkEntitlementOnline } = require("./online");
const { canonicalize } = require("./model");
const { clearKeys, registerKey } = require("./public-key");

const installationId = "12345678-1234-4123-a123-123456789abd";
function artifactFor(expiresAt = new Date(Date.now() + 86400000).toISOString()) {
  const keys = crypto.generateKeyPairSync("ed25519");
  const payload = { entitlement_id: "12345678-1234-4123-a123-123456789abc", installation_id: installationId, plan_id: "level1", features: ["autonomous-coding"], max_devices: 2, issued_at: new Date(Date.now() - 1000).toISOString(), expires_at: expiresAt, key_id: "online-test" };
  registerKey("online-test", keys.publicKey.export({ type: "spki", format: "pem" }));
  return { payload, signature: crypto.sign(null, Buffer.from(canonicalize(payload)), keys.privateKey).toString("base64url"), key_id: "online-test" };
}

beforeEach(() => clearKeys());

describe("Online entitlement enforcement", () => {
  it("blocks server cancellation, refund, chargeback, or revoked installation", async () => {
    const artifact = artifactFor();
    const result = await checkEntitlementOnline({
      serverUrl: "https://billing.example",
      installationId,
      _loadArtifact: () => artifact,
      _loadGateState: () => ({ latest_observed_at: 0, last_validated_at: null }),
      _saveGateState: () => {},
      _validate: async () => ({ ok: false, status: 403, body: { valid: false, error: "Subscription does not grant paid access" } }),
    });
    assert.equal(result.allowed, false);
    assert.equal(result.state, "SERVER_REJECTED");
  });

  it("blocks paid execution when online validation is unreachable", async () => {
    const artifact = artifactFor();
    const result = await checkEntitlementOnline({
      serverUrl: "https://billing.example",
      installationId,
      _loadArtifact: () => artifact,
      _loadGateState: () => ({ latest_observed_at: 0, last_validated_at: null }),
      _saveGateState: () => {},
      _validate: async () => { throw new Error("offline"); },
    });
    assert.equal(result.allowed, false);
    assert.equal(result.state, "SERVER_UNREACHABLE");
  });
});
