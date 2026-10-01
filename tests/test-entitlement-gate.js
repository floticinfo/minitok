"use strict";
const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const p = require("path");
const os = require("os");

function tmpDir() { return fs.mkdtempSync(p.join(os.tmpdir(), "mt-gate-")); }
function clean(d) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
function genKeyPair() { return crypto.generateKeyPairSync("ed25519"); }

function makePayload(overrides = {}) {
  const now = new Date();
  const expires = new Date(now.getTime() + 30 * 24 * 3600 * 1000);
  return {
    entitlement_id: "12345678-1234-4123-a123-123456789abc",
    plan_id: "level1", features: ["autonomous-coding"], max_devices: 3,
    issued_at: now.toISOString(), expires_at: expires.toISOString(),
    key_id: "test-key-1",
    installation_id: "12345678-1234-4123-a123-123456789abd",
    ...overrides,
  };
}

function signPayload(payload, privateKeyPem, keyId) {
  const { canonicalize } = require("../src/entitlement/model");
  payload.key_id = keyId;
  const sig = crypto.sign(null, Buffer.from(canonicalize(payload), "utf-8"), privateKeyPem);
  return { payload, signature: sig.toString("base64url"), key_id: keyId };
}

let kp;
beforeEach(() => {
  const { clearKeys, registerKey } = require("../src/entitlement/public-key");
  clearKeys();
  kp = genKeyPair();
  registerKey("test-key-1", kp.publicKey.export({ type: "spki", format: "pem" }));
});

// ============================================================
// MISSING
// ============================================================
describe("Gate: MISSING", () => {
  const { checkEntitlement, GateState } = require("../src/entitlement/gate");

  it("blocks when no entitlement exists", () => {
    const r = checkEntitlement({ _loadArtifact: () => null, _loadGateState: () => ({ latest_observed_at: 0, last_validated_at: null }), _saveGateState: () => {}, installationId: "12345678-1234-4123-a123-123456789abd" });
    assert.equal(r.allowed, false);
    assert.equal(r.state, GateState.MISSING);
  });
  it("blocks when artifact is undefined", () => {
    const r = checkEntitlement({ _loadArtifact: () => undefined, _loadGateState: () => ({ latest_observed_at: 0, last_validated_at: null }), _saveGateState: () => {}, installationId: "12345678-1234-4123-a123-123456789abd" });
    assert.equal(r.allowed, false);
    assert.equal(r.state, GateState.MISSING);
  });
});

// ============================================================
// VALID
// ============================================================
describe("Gate: VALID", () => {
  const { checkEntitlement, GateState } = require("../src/entitlement/gate");

  it("allows valid unexpired entitlement", () => {
    const artifact = signPayload(makePayload(), kp.privateKey, "test-key-1");
    let savedState = null;
    const r = checkEntitlement({
      _loadArtifact: () => artifact,
      _loadGateState: () => ({ latest_observed_at: 0, last_validated_at: null }),
      _saveGateState: (s) => { savedState = s; },
      installationId: "12345678-1234-4123-a123-123456789abd",
      now: new Date(),
    });
    assert.equal(r.allowed, true);
    assert.equal(r.state, GateState.ALLOWED);
    assert.ok(savedState !== null);
    // last_validated_at is reserved for ONLINE validation successes; a local
    // gate pass updates only the monotonic clock-rollback watermark.
    assert.ok(savedState.latest_observed_at > 0, "monotonic watermark must advance on valid entitlement");
  });
});

// ============================================================
// INVALID SIGNATURE
// ============================================================
describe("Gate: INVALID_SIGNATURE", () => {
  const { checkEntitlement, GateState } = require("../src/entitlement/gate");

  it("blocks tampered payload", () => {
    const artifact = signPayload(makePayload(), kp.privateKey, "test-key-1");
    artifact.payload.plan_id = "invalid-plan";
    const r = checkEntitlement({ _loadArtifact: () => artifact, _loadGateState: () => ({ latest_observed_at: 0, last_validated_at: null }), _saveGateState: () => {}, installationId: "12345678-1234-4123-a123-123456789abd" });
    assert.equal(r.allowed, false);
    assert.ok([GateState.MALFORMED, GateState.INVALID_SIGNATURE].includes(r.state), `expected MALFORMED or INVALID_SIGNATURE, got ${r.state}`);
  });
  it("blocks tampered signature", () => {
    const artifact = signPayload(makePayload(), kp.privateKey, "test-key-1");
    artifact.signature = "AAAA" + artifact.signature.slice(4);
    const r = checkEntitlement({ _loadArtifact: () => artifact, _loadGateState: () => ({ latest_observed_at: 0, last_validated_at: null }), _saveGateState: () => {}, installationId: "12345678-1234-4123-a123-123456789abd" });
    assert.equal(r.allowed, false);
    assert.equal(r.state, GateState.INVALID_SIGNATURE);
  });
  it("blocks unknown key_id", () => {
    const artifact = signPayload(makePayload(), kp.privateKey, "unknown-key");
    const r = checkEntitlement({ _loadArtifact: () => artifact, _loadGateState: () => ({ latest_observed_at: 0, last_validated_at: null }), _saveGateState: () => {}, installationId: "12345678-1234-4123-a123-123456789abd" });
    assert.equal(r.allowed, false);
    assert.equal(r.state, GateState.INVALID_SIGNATURE);
  });
});

// ============================================================
// MALFORMED
// ============================================================
describe("Gate: MALFORMED", () => {
  const { checkEntitlement, GateState } = require("../src/entitlement/gate");

  it("blocks invalid JSON structure", () => {
    const r = checkEntitlement({ _loadArtifact: () => ({ payload: "bad", signature: "x", key_id: "k" }), _loadGateState: () => ({ latest_observed_at: 0, last_validated_at: null }), _saveGateState: () => {}, installationId: "12345678-1234-4123-a123-123456789abd" });
    assert.equal(r.allowed, false);
    assert.equal(r.state, GateState.MALFORMED);
  });
  it("blocks missing required field", () => {
    const r = checkEntitlement({ _loadArtifact: () => ({ payload: { entitlement_id: "bad" }, signature: "x", key_id: "k" }), _loadGateState: () => ({ latest_observed_at: 0, last_validated_at: null }), _saveGateState: () => {}, installationId: "12345678-1234-4123-a123-123456789abd" });
    assert.equal(r.allowed, false);
    assert.equal(r.state, GateState.MALFORMED);
  });
});

// ============================================================
// EXPIRED
// ============================================================
describe("Gate: EXPIRED", () => {
  const { checkEntitlement, GateState } = require("../src/entitlement/gate");

  it("blocks expired entitlement", () => {
    const past = new Date(Date.now() - 1000).toISOString();
    const earlier = new Date(Date.now() - 200000).toISOString();
    const artifact = signPayload(makePayload({ issued_at: earlier, expires_at: past }), kp.privateKey, "test-key-1");
    const r = checkEntitlement({ _loadArtifact: () => artifact, _loadGateState: () => ({ latest_observed_at: 0, last_validated_at: null }), _saveGateState: () => {}, installationId: "12345678-1234-4123-a123-123456789abd" });
    assert.equal(r.allowed, false);
    assert.equal(r.state, GateState.EXPIRED);
  });
  it("blocks expired even with old last_validated_at beyond grace", () => {
    const past = new Date(Date.now() - 1000).toISOString();
    const earlier = new Date(Date.now() - 200000).toISOString();
    const oldValidated = new Date(Date.now() - 40 * 24 * 3600 * 1000).toISOString();
    const artifact = signPayload(makePayload({ issued_at: earlier, expires_at: past }), kp.privateKey, "test-key-1");
    const r = checkEntitlement({ _loadArtifact: () => artifact, _loadGateState: () => ({ latest_observed_at: 0, last_validated_at: oldValidated }), _saveGateState: () => {}, installationId: "12345678-1234-4123-a123-123456789abd" });
    assert.equal(r.allowed, false);
    assert.equal(r.state, GateState.EXPIRED);
  });
});

// ============================================================
// OFFLINE GRACE
// ============================================================
describe("Gate: OFFLINE_GRACE", () => {
  const { checkEntitlement, GateState } = require("../src/entitlement/gate");

  it("blocks expired even when mutable gate state claims recent validation", () => {
    const past = new Date(Date.now() - 1000).toISOString();
    const earlier = new Date(Date.now() - 200000).toISOString();
    const recent = new Date(Date.now() - 86400000).toISOString();
    const artifact = signPayload(makePayload({ issued_at: earlier, expires_at: past }), kp.privateKey, "test-key-1");
    const r = checkEntitlement({ _loadArtifact: () => artifact, _loadGateState: () => ({ latest_observed_at: Date.now(), last_validated_at: recent }), _saveGateState: () => {}, installationId: "12345678-1234-4123-a123-123456789abd" });
    assert.equal(r.allowed, false);
    assert.equal(r.state, GateState.EXPIRED);
  });
  it("blocks expired beyond grace", () => {
    const past = new Date(Date.now() - 1000).toISOString();
    const earlier = new Date(Date.now() - 200000).toISOString();
    const old = new Date(Date.now() - 31 * 86400000).toISOString();
    const artifact = signPayload(makePayload({ issued_at: earlier, expires_at: past }), kp.privateKey, "test-key-1");
    const r = checkEntitlement({ _loadArtifact: () => artifact, _loadGateState: () => ({ latest_observed_at: Date.now(), last_validated_at: old }), _saveGateState: () => {}, installationId: "12345678-1234-4123-a123-123456789abd" });
    assert.equal(r.allowed, false);
    assert.equal(r.state, GateState.EXPIRED);
  });
  it("blocks expired with no last_validated_at", () => {
    const past = new Date(Date.now() - 1000).toISOString();
    const earlier = new Date(Date.now() - 200000).toISOString();
    const artifact = signPayload(makePayload({ issued_at: earlier, expires_at: past }), kp.privateKey, "test-key-1");
    const r = checkEntitlement({ _loadArtifact: () => artifact, _loadGateState: () => ({ latest_observed_at: 0, last_validated_at: null }), _saveGateState: () => {}, installationId: "12345678-1234-4123-a123-123456789abd" });
    assert.equal(r.allowed, false);
    assert.equal(r.state, GateState.EXPIRED);
  });
});

// ============================================================
// CLOCK ROLLBACK
// ============================================================
describe("Gate: CLOCK_ROLLBACK", () => {
  const { checkEntitlement, GateState } = require("../src/entitlement/gate");

  it("allows normal forward time", () => {
    const artifact = signPayload(makePayload(), kp.privateKey, "test-key-1");
    const r = checkEntitlement({ _loadArtifact: () => artifact, _loadGateState: () => ({ latest_observed_at: Date.now() - 1000, last_validated_at: null }), _saveGateState: () => {}, installationId: "12345678-1234-4123-a123-123456789abd" });
    assert.equal(r.allowed, true);
  });
  it("blocks significant backward movement", () => {
    const artifact = signPayload(makePayload(), kp.privateKey, "test-key-1");
    const future = Date.now() + 3600000;
    const r = checkEntitlement({ _loadArtifact: () => artifact, _loadGateState: () => ({ latest_observed_at: future, last_validated_at: null }), _saveGateState: () => {}, installationId: "12345678-1234-4123-a123-123456789abd", now: new Date() });
    assert.equal(r.allowed, false);
    assert.equal(r.state, GateState.CLOCK_ROLLBACK);
  });
  it("allows small adjustments within threshold", () => {
    const artifact = signPayload(makePayload(), kp.privateKey, "test-key-1");
    const now = Date.now();
    const r = checkEntitlement({ _loadArtifact: () => artifact, _loadGateState: () => ({ latest_observed_at: now - 120000, last_validated_at: null }), _saveGateState: () => {}, installationId: "12345678-1234-4123-a123-123456789abd", now: new Date(now) });
    assert.equal(r.allowed, true);
  });
  it("rollback persists across calls", () => {
    const artifact = signPayload(makePayload(), kp.privateKey, "test-key-1");
    let saved = { latest_observed_at: 0, last_validated_at: null };
    const future = Date.now() + 3600000;
    checkEntitlement({ _loadArtifact: () => artifact, _loadGateState: () => saved, _saveGateState: (s) => { saved = s; }, installationId: "12345678-1234-4123-a123-123456789abd", now: new Date(future) });
    const r = checkEntitlement({ _loadArtifact: () => artifact, _loadGateState: () => saved, _saveGateState: () => {}, installationId: "12345678-1234-4123-a123-123456789abd", now: new Date(Date.now()) });
    assert.equal(r.allowed, false);
    assert.equal(r.state, GateState.CLOCK_ROLLBACK);
  });
});

// ============================================================
// PIPELINE ORDER + SECURITY
// ============================================================
describe("Gate: Pipeline Order + Security", () => {
  const { checkEntitlement, GateState, GateMessages } = require("../src/entitlement/gate");

  it("blocked returns allowed:false with state and message", () => {
    const r = checkEntitlement({ _loadArtifact: () => null, _loadGateState: () => ({ latest_observed_at: 0, last_validated_at: null }), _saveGateState: () => {}, installationId: "12345678-1234-4123-a123-123456789abd" });
    assert.equal(r.allowed, false);
    assert.ok(typeof r.state === "string" && typeof r.message === "string");
  });
  it("valid returns allowed:true with entitlement", () => {
    const artifact = signPayload(makePayload(), kp.privateKey, "test-key-1");
    const r = checkEntitlement({ _loadArtifact: () => artifact, _loadGateState: () => ({ latest_observed_at: 0, last_validated_at: null }), _saveGateState: () => {}, installationId: "12345678-1234-4123-a123-123456789abd", now: new Date() });
    assert.equal(r.allowed, true);
    assert.equal(r.entitlement.plan_id, "level1");
  });
  it("every blocked state has a message", () => {
    for (const s of [GateState.MISSING, GateState.MALFORMED, GateState.INVALID_SIGNATURE, GateState.EXPIRED, GateState.CLOCK_ROLLBACK]) {
      assert.ok(GateMessages[s] && GateMessages[s].length > 10, `${s} needs message`);
    }
  });
  it("completely invalid input fails closed", () => {
    const r = checkEntitlement({ _loadArtifact: () => "invalid", _loadGateState: () => ({ latest_observed_at: 0, last_validated_at: null }), _saveGateState: () => {}, installationId: "12345678-1234-4123-a123-123456789abd" });
    assert.equal(r.allowed, false);
  });
  it("disk error throws (does not fail open)", () => {
    assert.throws(() => checkEntitlement({ _loadArtifact: () => { throw new Error("disk"); }, _loadGateState: () => ({ latest_observed_at: 0, last_validated_at: null }), _saveGateState: () => {}, installationId: "12345678-1234-4123-a123-123456789abd" }));
  });
});
