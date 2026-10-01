"use strict";
/**
 * Client/Server Contract Test — Installation Binding E2E
 *
 * Signs with the exact server signing algorithm (canonical JSON + Ed25519 +
 * base64url, artifact { payload, signature, key_id }) so this suite is
 * self-contained and passes in CI / fresh clones. True cross-repository
 * compatibility (server signer.js → client verifier) is covered by the
 * server repo's test/signer.test.js, which loads the client in reverse.
 */
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const os = require("os");
const model = require("../src/entitlement/model");
const { verifyEntitlement, EntitlementState } = require("../src/entitlement/verify");
const pubKey = require("../src/entitlement/public-key");
function signEntitlement({ privateKeyPem, keyId, payload }) {
  const canonical = model.canonicalize(payload);
  const sig = crypto.sign(null, Buffer.from(canonical, "utf-8"), crypto.createPrivateKey(privateKeyPem));
  return { payload, signature: sig.toString("base64url"), key_id: keyId };
}
function genKeyPair() { const kp = crypto.generateKeyPairSync("ed25519"); return {
  privateKeyPem: kp.privateKey.export({ type: "pkcs8", format: "pem" }),
  publicKeyPem: kp.publicKey.export({ type: "spki", format: "pem" }),
}; }
function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), "mt-contract-")); }
function clean(d) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
function writeToken(iid, dir) {
  const tf = path.join(dir, "installation-token.json");
  fs.mkdirSync(path.dirname(tf), { recursive: true });
  fs.writeFileSync(tf, JSON.stringify({ token: "jwt-" + iid, installation_id: iid, saved_at: new Date().toISOString() }, null, 2), "utf-8");
}
let kp, dirA, dirB;
beforeEach(() => { pubKey.clearKeys(); kp = genKeyPair(); pubKey.registerKey("prod-key", kp.publicKeyPem); dirA = tmpDir(); dirB = tmpDir(); });
afterEach(() => { pubKey.clearKeys(); clean(dirA); clean(dirB); });
function signFor(installationId, overrides) {
  const now = new Date(); const expires = new Date(now.getTime() + 30 * 86400000);
  return signEntitlement({ privateKeyPem: kp.privateKeyPem, keyId: "prod-key", payload: Object.assign({
    entitlement_id: "11111111-1111-4111-8111-111111111111", installation_id: installationId,
    plan_id: "level1", features: ["autonomous_run"], max_devices: 3,
    issued_at: now.toISOString(), expires_at: expires.toISOString(), key_id: "prod-key"
  }, overrides || {}) });
}
describe("CLIENT/SERVER CONTRACT — Installation Binding", () => {
  it("C1: Server signs for A → Client A accepts", () => {
    const iidA = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
    const artifact = signFor(iidA);
    writeToken(iidA, dirA);
    const r = verifyEntitlement(artifact, new Date(), { entitlementDir: dirA });
    assert.equal(r.valid, true, `Client A should accept: ${r.state} — ${r.reason}`);
    assert.equal(r.state, EntitlementState.VALID);
  });

  it("C2: Server signs for A → Client B DENIED", () => {
    const iidA = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
    const iidB = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
    const artifact = signFor(iidA);
    writeToken(iidB, dirB);
    const r = verifyEntitlement(artifact, new Date(), { entitlementDir: dirB });
    assert.equal(r.valid, false, "Client B must reject A entitlement");
    assert.equal(r.state, EntitlementState.INSTALLATION_MISMATCH);
  });

  it("C3: Tampered installation_id → INVALID_SIGNATURE", () => {
    const iidA = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
    const iidB = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
    const artifact = signFor(iidA);
    artifact.payload.installation_id = iidB;
    const canonical = model.canonicalize(artifact.payload);
    const sigBuf = Buffer.from(artifact.signature, "base64url");
    const pk = crypto.createPublicKey(kp.publicKeyPem);
    assert.equal(crypto.verify(null, Buffer.from(canonical), pk, sigBuf), false);
  });

  it("C4: Cross-customer isolation", () => {
    const custA = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
    const custB = "cccccccc-cccc-4ccc-cccc-cccccccccccc";
    const artifact = signFor(custA);
    writeToken(custB, dirB);
    const r = verifyEntitlement(artifact, new Date(), { entitlementDir: dirB });
    assert.equal(r.valid, false);
    assert.equal(r.state, EntitlementState.INSTALLATION_MISMATCH);
  });

  it("C5: Offline grace enforces installation binding", () => {
    const iidA = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
    const iidB = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
    const now = new Date(); const expires = new Date(now.getTime() + 1000);
    const artifact = signFor(iidA, { expires_at: expires.toISOString(), issued_at: now.toISOString() });
    writeToken(iidB, dirB);
    const futureTime = new Date(expires.getTime() + 5000);
    const r = verifyEntitlement(artifact, futureTime, { entitlementDir: dirB });
    assert.equal(r.valid, false, "Different installation denied during grace");
  });

  it("C6: Legacy entitlement (no installation_id) remains parseable for migration diagnostics but is not runtime-authorized", () => {
    const now = new Date(); const expires = new Date(now.getTime() + 86400000);
    const payload = { entitlement_id: "66666666-6666-4666-8666-666666666666", plan_id: "level1",
      features: ["autonomous_run"], max_devices: 1, issued_at: now.toISOString(),
      expires_at: expires.toISOString(), key_id: "prod-key" };
    const canonical = model.canonicalize(payload);
    const pkObj = crypto.createPrivateKey(kp.privateKeyPem);
    const sig = crypto.sign(null, Buffer.from(canonical, "utf-8"), pkObj);
    const artifact = { payload, signature: sig.toString("base64url"), key_id: "prod-key" };
    const r = verifyEntitlement(artifact, new Date());
    assert.equal(r.valid, true, `Legacy artifact should remain parseable: ${r.state}`);
    assert.equal(r.legacy, true);
    const { checkEntitlement, GateState } = require("../src/entitlement/gate");
    const gate = checkEntitlement({ _loadArtifact: () => artifact, _loadGateState: () => ({ latest_observed_at: 0, last_validated_at: null }), _saveGateState: () => {} });
    assert.equal(gate.allowed, false);
    assert.equal(gate.state, GateState.LEGACY_UNBOUND);
  });
});
