"use strict";
const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const p = require("path");
const os = require("os");

function tmpDir() { return fs.mkdtempSync(p.join(os.tmpdir(), "mt-ent-")); }
function clean(d) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
function genKeyPair() { return crypto.generateKeyPairSync("ed25519"); }

function makePayload(overrides = {}) {
  const now = new Date();
  const expires = new Date(now.getTime() + 30 * 24 * 3600 * 1000);
  return {
    entitlement_id: "12345678-1234-4123-a123-123456789abc",
    plan_id: "open",
    features: ["autonomous-coding", "multi-provider"],
    max_devices: 3,
    issued_at: now.toISOString(),
    expires_at: expires.toISOString(),
    key_id: "test-key-1",
    ...overrides,
  };
}

function signPayload(payload, privateKeyPem, keyId) {
  const { canonicalize } = require("../src/entitlement/model");
  // Ensure payload.key_id matches the artifact key_id
  payload.key_id = keyId;
  const sig = crypto.sign(null, Buffer.from(canonicalize(payload), "utf-8"), privateKeyPem);
  return { payload, signature: sig.toString("base64url"), key_id: keyId };
}

// ============================================================
// MODEL TESTS
// ============================================================

describe("Entitlement Model", () => {
  const { validatePayload, validateArtifact, canonicalize, VALID_PLAN_IDS } = require("../src/entitlement/model");

  it("valid payload passes", () => {
    assert.equal(validatePayload(makePayload()).valid, true);
  });
  it("rejects null", () => { assert.equal(validatePayload(null).valid, false); });
  it("rejects array", () => { assert.equal(validatePayload([]).valid, false); });
  it("rejects string", () => { assert.equal(validatePayload("x").valid, false); });
  it("rejects missing plan_id", () => {
    const p = makePayload(); delete p.plan_id;
    assert.equal(validatePayload(p).valid, false);
  });
  it("rejects unexpected field", () => {
    assert.equal(validatePayload(makePayload({ extra: 1 })).valid, false);
  });
  it("rejects invalid UUID", () => {
    assert.equal(validatePayload(makePayload({ entitlement_id: "bad" })).valid, false);
  });
  it("rejects invalid plan_id", () => {
    assert.equal(validatePayload(makePayload({ plan_id: "free" })).valid, false);
  });
  it("rejects non-array features", () => {
    assert.equal(validatePayload(makePayload({ features: "x" })).valid, false);
  });
  it("rejects non-string features", () => {
    assert.equal(validatePayload(makePayload({ features: [1] })).valid, false);
  });
  it("rejects zero max_devices", () => {
    assert.equal(validatePayload(makePayload({ max_devices: 0 })).valid, false);
  });
  it("rejects float max_devices", () => {
    assert.equal(validatePayload(makePayload({ max_devices: 1.5 })).valid, false);
  });
  it("rejects invalid issued_at", () => {
    assert.equal(validatePayload(makePayload({ issued_at: "bad" })).valid, false);
  });
  it("rejects expires_at <= issued_at", () => {
    const t = new Date().toISOString();
    assert.equal(validatePayload(makePayload({ issued_at: t, expires_at: t })).valid, false);
  });
  it("rejects empty key_id", () => {
    assert.equal(validatePayload(makePayload({ key_id: "" })).valid, false);
  });
  it("accepts all valid paid plan_ids", () => {
    for (const plan of VALID_PLAN_IDS.filter((plan) => plan !== "trial")) {
      assert.equal(validatePayload(makePayload({ plan_id: plan })).valid, true);
    }
  });
  it("accepts a complete server-issued trial payload", () => {
    const payload = makePayload({
      plan_id: "trial",
      telemetry_mode: "off",
      run_quota: 5,
      runs_used: 0,
      installation_id: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
      expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
    });
    assert.equal(validatePayload(payload).valid, true);
  });
  it("rejects a trial that grants telemetry", () => {
    const payload = makePayload({
      plan_id: "trial",
      telemetry_mode: "off",
      run_quota: 5,
      runs_used: 0,
      features: ["autonomous_run", "evolution_upload"],
    });
    assert.equal(validatePayload(payload).valid, false);
  });
  it("accepts empty features", () => {
    assert.equal(validatePayload(makePayload({ features: [] })).valid, true);
  });
});

// ============================================================
// ARTIFACT VALIDATION + CANONICALIZATION
// ============================================================

describe("Artifact Validation + Canonicalization", () => {
  const { validateArtifact, canonicalize } = require("../src/entitlement/model");
  const kp = genKeyPair();

  it("valid artifact passes", () => {
    const a = signPayload(makePayload(), kp.privateKey, "k1");
    assert.equal(validateArtifact(a).valid, true);
  });
  it("rejects null artifact", () => { assert.equal(validateArtifact(null).valid, false); });
  it("rejects missing signature", () => {
    assert.equal(validateArtifact({ payload: makePayload(), key_id: "k" }).valid, false);
  });
  it("rejects key_id mismatch", () => {
    const a = signPayload(makePayload({ key_id: "a" }), kp.privateKey, "a");
    a.key_id = "b";
    assert.equal(validateArtifact(a).valid, false);
  });
  it("canonicalize is deterministic", () => {
    const pl = makePayload();
    assert.equal(canonicalize(pl), canonicalize(pl));
  });
  it("canonicalize sorts keys", () => {
    const c = canonicalize(makePayload());
    assert.deepEqual(Object.keys(JSON.parse(c)).sort(), Object.keys(JSON.parse(c)));
  });
  it("canonicalize has no whitespace", () => {
    assert.ok(!canonicalize(makePayload()).includes(" "));
  });
  it("same values different order produce same canonical", () => {
    assert.equal(canonicalize({ z: 1, a: 2 }), canonicalize({ a: 2, z: 1 }));
  });
});

// ============================================================
// SIGNATURE VERIFICATION
// ============================================================

describe("Signature Verification", () => {
  const { verifyEntitlement, EntitlementState } = require("../src/entitlement/verify");
  const { registerKey, clearKeys } = require("../src/entitlement/public-key");
  let kp;
  beforeEach(() => {
    clearKeys();
    kp = genKeyPair();
    registerKey("k1", kp.publicKey.export({ type: "spki", format: "pem" }));
  });

  it("valid unexpired passes", () => {
    const a = signPayload(makePayload(), kp.privateKey, "k1");
    assert.equal(verifyEntitlement(a).valid, true);
    assert.equal(verifyEntitlement(a).state, EntitlementState.VALID);
  });
  it("tampered signature fails", () => {
    const a = signPayload(makePayload(), kp.privateKey, "k1");
    a.signature = "AAAA" + a.signature.slice(4);
    assert.equal(verifyEntitlement(a).state, EntitlementState.INVALID_SIGNATURE);
  });
  it("tampered payload fails", () => {
    const a = signPayload(makePayload(), kp.privateKey, "k1");
    a.payload.plan_id = "private";
    assert.equal(verifyEntitlement(a).state, EntitlementState.INVALID_SIGNATURE);
  });
  it("unknown key_id fails", () => {
    const a = signPayload(makePayload(), kp.privateKey, "unknown");
    assert.equal(verifyEntitlement(a).state, EntitlementState.INVALID_SIGNATURE);
  });
  it("malformed base64url signature fails", () => {
    const a = { payload: makePayload({ key_id: "k1" }), signature: "!!!bad!!!", key_id: "k1" };
    assert.equal(verifyEntitlement(a).state, EntitlementState.INVALID_SIGNATURE);
  });
  it("expired entitlement fails", () => {
    const past = new Date(Date.now() - 1000).toISOString();
    const earlier = new Date(Date.now() - 200000).toISOString();
    const a = signPayload(makePayload({ issued_at: earlier, expires_at: past }), kp.privateKey, "k1");
    assert.equal(verifyEntitlement(a).state, EntitlementState.EXPIRED);
  });
  it("malformed artifact returns MALFORMED", () => {
    assert.equal(verifyEntitlement({ payload: "bad", signature: "x", key_id: "k" }).state, EntitlementState.MALFORMED);
  });
  it("null returns MISSING", () => {
    assert.equal(verifyEntitlement(null).state, EntitlementState.MISSING);
  });
  it("wrong key fails", () => {
    const kp2 = genKeyPair();
    registerKey("k2", kp2.publicKey.export({ type: "spki", format: "pem" }));
    const a = signPayload(makePayload(), kp.privateKey, "k2");
    assert.equal(verifyEntitlement(a).state, EntitlementState.INVALID_SIGNATURE);
  });
});

// ============================================================
// KEY ROTATION
// ============================================================

describe("Key Rotation", () => {
  const { registerKey, clearKeys } = require("../src/entitlement/public-key");
  const { verifyEntitlement, EntitlementState } = require("../src/entitlement/verify");

  it("key A verifies with key A", () => {
    clearKeys();
    const kpA = genKeyPair();
    registerKey("A", kpA.publicKey.export({ type: "spki", format: "pem" }));
    assert.equal(verifyEntitlement(signPayload(makePayload(), kpA.privateKey, "A")).valid, true);
  });
  it("key B verifies with key B", () => {
    clearKeys();
    const kpB = genKeyPair();
    registerKey("B", kpB.publicKey.export({ type: "spki", format: "pem" }));
    assert.equal(verifyEntitlement(signPayload(makePayload(), kpB.privateKey, "B")).valid, true);
  });
  it("unknown key ID fails", () => {
    clearKeys();
    const kp = genKeyPair();
    registerKey("known", kp.publicKey.export({ type: "spki", format: "pem" }));
    assert.equal(verifyEntitlement(signPayload(makePayload(), kp.privateKey, "unknown")).state, EntitlementState.INVALID_SIGNATURE);
  });
  it("old key remains verifiable when retained", () => {
    clearKeys();
    const kpOld = genKeyPair();
    const kpNew = genKeyPair();
    registerKey("old", kpOld.publicKey.export({ type: "spki", format: "pem" }));
    registerKey("new", kpNew.publicKey.export({ type: "spki", format: "pem" }));
    assert.equal(verifyEntitlement(signPayload(makePayload(), kpOld.privateKey, "old")).valid, true);
  });
  it("rotated-away key fails when removed", () => {
    clearKeys();
    const kpOld = genKeyPair();
    registerKey("old", kpOld.publicKey.export({ type: "spki", format: "pem" }));
    const a = signPayload(makePayload(), kpOld.privateKey, "old");
    clearKeys();
    registerKey("new", genKeyPair().publicKey.export({ type: "spki", format: "pem" }));
    assert.equal(verifyEntitlement(a).state, EntitlementState.INVALID_SIGNATURE);
  });
});

// ============================================================
// STORAGE
// ============================================================

describe("Entitlement Store", () => {
  const { EntitlementStore } = require("../src/entitlement/store");
  const { registerKey, clearKeys } = require("../src/entitlement/public-key");
  const { verifyEntitlement, EntitlementState } = require("../src/entitlement/verify");
  let kp, tmpHome, store;

  beforeEach(() => {
    clearKeys();
    kp = genKeyPair();
    registerKey("k1", kp.publicKey.export({ type: "spki", format: "pem" }));
    tmpHome = tmpDir();
    store = new EntitlementStore(p.join(tmpHome, ".minitok", "entitlement"));
  });
  function cleanTmp() { try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {} }

  it("save/load round trip", () => {
    const a = signPayload(makePayload(), kp.privateKey, "k1");
    store.save(a);
    assert.deepEqual(store.load().payload, a.payload);
    cleanTmp();
  });
  it("load null for missing", () => { assert.equal(store.load(), null); cleanTmp(); });
  it("load null for corrupted", () => {
    store._ensureDir(); fs.writeFileSync(store._filePath, "!!!", "utf-8");
    assert.equal(store.load(), null); cleanTmp();
  });
  it("load null for invalid structure", () => {
    store._ensureDir(); fs.writeFileSync(store._filePath, JSON.stringify({x:1}), "utf-8");
    assert.equal(store.load(), null); cleanTmp();
  });
  it("atomic replacement", () => {
    store.save(signPayload(makePayload({ entitlement_id: "11111111-1111-4111-a111-111111111111" }), kp.privateKey, "k1"));
    store.save(signPayload(makePayload({ entitlement_id: "22222222-2222-4222-a222-222222222222" }), kp.privateKey, "k1"));
    assert.equal(store.load().payload.entitlement_id, "22222222-2222-4222-a222-222222222222");
    assert.ok(!fs.readdirSync(p.join(tmpHome, ".minitok", "entitlement")).some(f => f.endsWith(".tmp")));
    cleanTmp();
  });
  it("directory creation", () => {
    const deep = new EntitlementStore(p.join(tmpHome, "a", "b", "c"));
    deep.save(signPayload(makePayload(), kp.privateKey, "k1"));
    assert.equal(deep.exists(), true); cleanTmp();
  });
  it("clear removes entitlement", () => {
    store.save(signPayload(makePayload(), kp.privateKey, "k1"));
    store.clear(); assert.equal(store.exists(), false); cleanTmp();
  });
  it("clear safe when missing", () => { store.clear(); cleanTmp(); });
  it("exists false for missing", () => { assert.equal(store.exists(), false); cleanTmp(); });
  it("end-to-end save then verify", () => {
    store.save(signPayload(makePayload(), kp.privateKey, "k1"));
    const r = verifyEntitlement(store.load());
    assert.equal(r.valid, true); assert.equal(r.state, EntitlementState.VALID); cleanTmp();
  });
  it("POSIX permissions", () => {
    if (process.platform === "win32") return;
    store.save(signPayload(makePayload(), kp.privateKey, "k1"));
    assert.equal((fs.statSync(store._filePath).mode & 0o777).toString(8), "600"); cleanTmp();
  });
});

// ============================================================
// SECURITY PROPERTIES
// ============================================================

describe("Security Properties", () => {
  it("no private key in public-key.js", () => {
    const src = fs.readFileSync(p.join(__dirname, "..", "src", "entitlement", "public-key.js"), "utf-8");
    assert.ok(!src.includes("privateKey")); assert.ok(!src.includes("private_key"));
  });
  it("entitlement path outside repository", () => {
    const { DEFAULT_ENTITLEMENT_DIR } = require("../src/entitlement/store");
    assert.ok(!DEFAULT_ENTITLEMENT_DIR.startsWith(p.join(__dirname, "..")));
  });
  it("no eval/child_process in entitlement modules", () => {
    for (const f of ["model.js", "verify.js", "store.js", "public-key.js"]) {
      const src = fs.readFileSync(p.join(__dirname, "..", "src", "entitlement", f), "utf-8");
      assert.ok(!src.includes("eval("), f); assert.ok(!src.includes("child_process"), f);
      assert.ok(!src.includes("execSync"), f);
    }
  });
  it("verify uses native crypto only", () => {
    const src = fs.readFileSync(p.join(__dirname, "..", "src", "entitlement", "verify.js"), "utf-8");
    assert.ok(src.includes('require("crypto")'));
  });
});
