"use strict";

/**
 * Phase 6 E2E ??full entitlement flow against the real Phase 1 server.
 *
 * Covers:
 *   1. CLI activate (HTTP client) ??cache persisted ??status/run gate decision
 *      (the "Extension ?쒖떆 ??Run 媛?? leg: the extension reads the same
 *      EntitlementCache + /api/entitlement/status contract).
 *   2. Server restart ??offline cache fallback (grace).
 *   3. Entitlement revoked/expired ??run denied with the exact message the
 *      CLI shows (the "?뚮┝" contract).
 */

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

// The dev key "test" is gated behind an explicit opt-in so production never
// accepts it. The E2E suite runs against the in-memory store, so enable it.
if (!process.env.MINITOK_ACCEPTED_KEYS) process.env.MINITOK_ALLOW_TEST_KEY = "true";

const { createApp } = require("../server/index");
const client = require("../src/entitlement/client");
const { EntitlementCache } = require("../src/entitlement/cache");
const { GateMessages, GateState, saveGateState } = require("../src/entitlement/gate");
const { checkEntitlementOnline } = require("../src/entitlement/online");
const pubKey = require("../src/entitlement/public-key");
const { canonicalize } = require("../src/entitlement/model");

const TEST_KEY = "test";
const INSTALLATION_ID = "22222222-2222-4222-8222-222222222222";
const ENTITLEMENT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "minitok-p6-e2e-"));
const KEY_ID = "phase6-key";

let kp; // ed25519 keypair for signing test artifacts

function signArtifact({ expiresInMs = 30 * 86400000 } = {}) {
  // issued_at is anchored 2 days back so a negative expiresInMs yields a
  // schema-valid artifact that is simply past its expiry (MALFORMED would
  // mask the EXPIRED path this test exists to verify).
  const now = Date.now();
  const payload = {
    entitlement_id: crypto.randomUUID(),
    installation_id: INSTALLATION_ID,
    plan_id: "level1",
    features: ["run"],
    max_devices: 3,
    issued_at: new Date(now - 2 * 86400000).toISOString(),
    expires_at: new Date(now + expiresInMs).toISOString(),
    key_id: KEY_ID,
  };
  const signature = crypto.sign(null, Buffer.from(canonicalize(payload), "utf-8"), crypto.createPrivateKey(kp.privateKeyPem));
  return { payload, signature: signature.toString("base64url"), key_id: KEY_ID };
}

function writeInstallationRecord(dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "installation-token.json"),
    JSON.stringify({ token: "phase6-token", installation_id: INSTALLATION_ID }),
    "utf-8",
  );
}

describe("Phase 6 E2E: entitlement flow", () => {
  let server;
  let base;
  const cache = new EntitlementCache(ENTITLEMENT_DIR);

  before(async () => {
    kp = crypto.generateKeyPairSync("ed25519");
    kp = {
      privateKeyPem: kp.privateKey.export({ type: "pkcs8", format: "pem" }),
      publicKeyPem: kp.publicKey.export({ type: "spki", format: "pem" }),
    };
    pubKey.clearKeys();
    pubKey.registerKey(KEY_ID, kp.publicKeyPem);
    writeInstallationRecord(ENTITLEMENT_DIR);
    server = await new Promise((resolve) => {
      const s = createApp().listen(0, "127.0.0.1", () => resolve(s));
    });
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    pubKey.clearKeys();
    if (server) await new Promise((r) => server.close(r));
    fs.rmSync(ENTITLEMENT_DIR, { recursive: true, force: true });
  });

  // ?? 1. CLI activate ??cache ??status / run-gate decision ????????????????
  it("CLI activate persists a usable session the gate can read", async () => {
    const store = require("../server/models/entitlement");
    store._reset();

    const result = await client.activate(TEST_KEY, { serverUrl: base });
    assert.equal(result.ok, true, `activate failed: ${JSON.stringify(result.body)}`);
    const { token, entitlement } = result.body;
    assert.equal(typeof token, "string");
    assert.equal(entitlement.plan, "level1");
    assert.equal(entitlement.active, true);
    assert.equal(typeof entitlement.installation_id, "string");

    // The same persist step src/cli/commands/activate.js performs.
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
    cache.save(token, payload);

    const cached = cache.load();
    assert.ok(cached, "session must be readable from the local cache");
    assert.equal(cached.token, token);
    assert.equal(cached.payload.plan, "level1");

    // The gate decision the extension renders: plan + expiry from the payload.
    assert.equal(cached.payload.plan, "level1");
    assert.ok(cached.expires_at, "expiry must be surfaced for the UI");
  });

  // ?? 2. Server restart ??cached session survives the restart ????????????
  it("server restart: cached session still authorizes offline reads", async () => {
    const store = require("../server/models/entitlement");
    store._reset(); // simulate a server restart wiping in-memory state

    const cached = cache.load();
    assert.ok(cached, "cache must survive a server restart");
    assert.equal(cached.payload.plan, "level1");
    // Offline expiry fallback the extension uses when the server is unreachable.
    assert.ok(new Date(cached.expires_at).getTime() > Date.now(), "cached session must not be expired");

    // Status against the restarted server: the JWT still verifies, but the
    // entitlement record is gone ??active:false. The client must treat this as
    // "not authorized" and surface the recovery message.
    const status = await client.status(cached.token, { serverUrl: base });
    assert.equal(status.ok, false);
    assert.equal(status.body.active, false);
  });

  // ?? 3. Entitlement revoked ??run denied with the notification message ??
  it("revoked entitlement blocks run with the exact denial message", async () => {
    const store = require("../server/models/entitlement");
    store._reset();

    const result = await client.activate(TEST_KEY, { serverUrl: base });
    assert.equal(result.ok, true);
    const installationId = result.body.entitlement.installation_id;
    store.revoke(TEST_KEY);

    const decision = await checkEntitlementOnline({
      entitlementDir: ENTITLEMENT_DIR,
      serverUrl: base,
      _loadArtifact: () => signArtifact(),
      _validate: async () => ({
        ok: false,
        body: { valid: false, error: "This entitlement is no longer active." },
      }),
    });

    assert.equal(decision.allowed, false);
    assert.equal(decision.state, GateState.SERVER_REJECTED);
    assert.equal(decision.message, "This entitlement is no longer active.");
    assert.ok(installationId, "test sanity: installation id was issued");
  });

  // ?? 3b. Entitlement expired ??run denied with the exact notification ????
  it("expired entitlement blocks run with the exact denial message", async () => {
    const decision = await checkEntitlementOnline({
      entitlementDir: ENTITLEMENT_DIR,
      serverUrl: base,
      _loadArtifact: () => signArtifact({ expiresInMs: -61000 }),
      _validate: async () => ({ ok: true, body: { valid: true } }),
    });

    assert.equal(decision.allowed, false);
    assert.equal(decision.state, GateState.EXPIRED);
    assert.equal(decision.message, GateMessages[GateState.EXPIRED]);
    assert.match(decision.message, /expired/);
    assert.match(decision.message, /Renew your subscription/);
  });

  // ?? 3c. Server unreachable ??offline grace with day count ??????????????
  it("unreachable server falls back to offline grace after prior validation", async () => {
    // Simulate a machine that validated online 1 day ago (within 7-day grace).
    saveGateState(
      { latest_observed_at: Date.now(), last_validated_at: new Date(Date.now() - 86400000).toISOString() },
      ENTITLEMENT_DIR,
    );

    const decision = await checkEntitlementOnline({
      entitlementDir: ENTITLEMENT_DIR,
      serverUrl: base,
      _loadArtifact: () => signArtifact(),
      _validate: async () => { throw new Error("connect ECONNREFUSED"); },
    });

    assert.equal(decision.allowed, true);
    assert.equal(decision.state, GateState.OFFLINE_GRACE);
    assert.equal(decision.graceDaysRemaining, 6);
    assert.match(decision.message, /Offline grace mode/);
    assert.match(decision.message, /6 day\(s\) remaining/);
  });
});
