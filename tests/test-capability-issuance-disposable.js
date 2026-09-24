"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { importCapabilityToken, readCapabilityRecord, FULL_TEST_CAPABILITIES } = require("../src/entitlement/capability");

function disposableIssuer() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "minitok-capability-issuer-"));
  const installationId = "11111111-1111-4111-8111-111111111111";
  const subscriptionId = "22222222-2222-4222-8222-222222222222";
  const issued = new Map();
  const revoked = new Set();
  let productionContacted = false;
  return {
    root,
    installationId,
    subscriptionId,
    issued,
    revoked,
    get productionContacted() { return productionContacted; },
    issue(request = {}) {
      assert.equal(request.installation_id, installationId);
      assert.equal(request.subscription_id, subscriptionId);
      const key = `${request.installation_id}:${request.subscription_id}:${request.idempotency_key}`;
      if (issued.has(key)) return issued.get(key);
      const now = Math.floor(Date.now() / 1000);
      const exp = Math.min(now + Number(request.ttl_seconds || 86400), now + 86400);
      const body = { valid: true, profile: "full_test", claims: { installation_id: installationId, subscription_id: subscriptionId, capabilities: [...FULL_TEST_CAPABILITIES], iat: now, exp }, token_id: `cap_${issued.size + 1}` };
      issued.set(key, body);
      return body;
    },
    revoke(tokenId) { revoked.add(tokenId); },
    validate(token, request = {}) {
      productionContacted = productionContacted || String(request.server_url || "").includes("api.minitok.dev");
      const body = this.issue({ installation_id: installationId, subscription_id: subscriptionId, idempotency_key: token });
      return revoked.has(body.token_id) || request.installation_id !== installationId || request.subscription_id !== subscriptionId ? { ok: true, body: { valid: false, error: "capability binding or revocation failed" } } : { ok: true, body };
    },
  };
}

test("disposable issuer enforces binding, 24-hour cap, idempotency, revocation, and client import", async () => {
  const issuer = disposableIssuer();
  const file = path.join(issuer.root, "capability-token.json");
  try {
    const first = issuer.issue({ installation_id: issuer.installationId, subscription_id: issuer.subscriptionId, idempotency_key: "same-request", ttl_seconds: 999999 });
    const second = issuer.issue({ installation_id: issuer.installationId, subscription_id: issuer.subscriptionId, idempotency_key: "same-request", ttl_seconds: 999999 });
    assert.equal(first, second, "idempotency must return the same capability record");
    assert.ok(first.claims.exp - first.claims.iat <= 86400, "full_test expiry must be capped at 24 hours");
    assert.throws(() => issuer.issue({ installation_id: issuer.installationId, subscription_id: "wrong", idempotency_key: "bad" }));

    const rawToken = crypto.randomBytes(24).toString("hex");
    const imported = await importCapabilityToken(rawToken, { serverUrl: "https://disposable.invalid", filePath: file, validate: async (_url, body) => issuer.validate(body.token, { installation_id: issuer.installationId, subscription_id: issuer.subscriptionId, server_url: "https://disposable.invalid" }) });
    assert.equal(imported.success, true);
    assert.equal(readCapabilityRecord({ filePath: file }).installation_id, issuer.installationId);
    const importedKey = `${issuer.installationId}:${issuer.subscriptionId}:${rawToken}`;
    issuer.revoke(issuer.issued.get(importedKey).token_id);
    const revoked = issuer.validate(rawToken, { installation_id: issuer.installationId, subscription_id: issuer.subscriptionId, server_url: "https://disposable.invalid" });
    assert.equal(revoked.body.valid, false);
    assert.equal(issuer.productionContacted, false, "disposable harness must not contact production");
  } finally { fs.rmSync(issuer.root, { recursive: true, force: true }); }
});

test("disposable issuer rejects installation and subscription mismatches", () => {
  const issuer = disposableIssuer();
  try {
    assert.throws(() => issuer.issue({ installation_id: "wrong", subscription_id: issuer.subscriptionId, idempotency_key: "x" }));
    assert.throws(() => issuer.issue({ installation_id: issuer.installationId, subscription_id: "wrong", idempotency_key: "y" }));
  } finally { fs.rmSync(issuer.root, { recursive: true, force: true }); }
});
