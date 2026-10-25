"use strict";

/**
 * Phase 6 E2E — the full entitlement flow against the canonical API.
 *
 * Covers:
 *   1. CLI activate (HTTP client) → artifact + installation record + cache
 *      persisted → the local gate authorizes a real run.
 *   2. Server restart → the cached session survives and the offline fallback
 *      still authorizes reads.
 *   3. Entitlement revoked → run denied with the exact message the CLI shows
 *      (the "denial" contract).
 *
 * [2026-10-22 E단계] This file used to drive the client against the in-repo
 * Phase 1 express server under `server/`, which only serves the retired
 * `/api/entitlement/*` routes. Production answers those routes with 404, so
 * the client could not activate at all. The flow is now driven through the
 * canonical /v1 contract, which is what the server actually serves.
 */

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { ReadableStream } = require("node:stream/web");

const { cmdActivate } = require("../src/cli/commands/activate");
const client = require("../src/entitlement/client");
const { EntitlementCache } = require("../src/entitlement/cache");
const { EntitlementStore } = require("../src/entitlement/store");
const { checkEntitlement } = require("../src/entitlement/gate");
const { GateMessages, GateState, saveGateState } = require("../src/entitlement/gate");
const { checkEntitlementOnline } = require("../src/entitlement/online");
const pubKey = require("../src/entitlement/public-key");
const { canonicalize } = require("../src/entitlement/model");

const TEST_KEY = "test";
const ENTITLEMENT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "minitok-p6-e2e-"));
const KEY_ID = "phase6-key";
const SERVER_URL = "https://api.minitok.test";

let kp; // ed25519 keypair for signing test artifacts
let installationId; // the id the client generated for this machine

function jsonResponse(body, status = 200) {
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  return {
    status,
    headers: { get: name => (name === "content-length" ? String(bytes.byteLength) : null) },
    body: new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } }),
  };
}

function signArtifact({ expiresInMs = 30 * 86400000, installation_id } = {}) {
  // issued_at is anchored 2 days back so a negative expiresInMs yields a
  // schema-valid artifact that is simply past its expiry (MALFORMED would
  // mask the EXPIRED path this test exists to verify).
  const now = Date.now();
  const payload = {
    entitlement_id: crypto.randomUUID(),
    installation_id: installation_id || installationId,
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

function issueInstallationToken() {
  const payload = {
    sub: "phase6-customer",
    installation_id: installationId,
    subscription_id: "phase6-subscription",
    iss: "minitok-server",
    aud: "minitok:installation",
    exp: Math.floor(Date.now() / 1000) + 30 * 86400,
  };
  const encode = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode(payload)}.sig`;
}

/**
 * A canonical server, in memory.
 *
 * `state.serverRunning` models a server restart: while it is false the
 * validate route reports that the installation is unknown, exactly as a
 * restarted server with an empty in-memory store would.
 */
const state = { serverRunning: true, revoked: false };

function withFetchStub(fn) {
  const saved = global.fetch;
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url, method: options.method, body: options.body ? JSON.parse(options.body) : null });
    const body = String(url);
    if (body.endsWith("/v1/activate")) {
      const artifact = signArtifact({ installation_id: calls[calls.length - 1].body.installation_id });
      return jsonResponse({ entitlement: artifact, installation_token: issueInstallationToken() });
    }
    if (body.endsWith("/v1/validate")) {
      if (!state.serverRunning || state.revoked) {
        return jsonResponse({ valid: false, error: "This entitlement is no longer active.", reason: "installation_not_found" });
      }
      return jsonResponse({
        valid: true,
        installation: { installation_id: installationId, status: "active", subscription_id: "phase6-subscription" },
        subscription: { status: "active", plan_id: "level1", current_period_end: new Date(Date.now() + 30 * 86400000).toISOString() },
      });
    }
    return jsonResponse({ error: "not found" }, 404);
  };
  return Promise.resolve(fn(calls)).finally(() => { global.fetch = saved; });
}

describe("Phase 6 E2E: entitlement flow", () => {
  const cache = new EntitlementCache(ENTITLEMENT_DIR);

  before(() => {
    kp = crypto.generateKeyPairSync("ed25519");
    kp = {
      privateKeyPem: kp.privateKey.export({ type: "pkcs8", format: "pem" }),
      publicKeyPem: kp.publicKey.export({ type: "spki", format: "pem" }),
    };
    pubKey.clearKeys();
    pubKey.registerKey(KEY_ID, kp.publicKeyPem);
  });

  after(() => {
    pubKey.clearKeys();
    fs.rmSync(ENTITLEMENT_DIR, { recursive: true, force: true });
  });

  // ── 1. CLI activate → persisted state → the gate authorizes a run ─────────
  it("CLI activate persists a usable session the gate can read", async () => {
    await withFetchStub(async (calls) => {
      const code = await cmdActivate(TEST_KEY, { server: SERVER_URL, entitlementDir: ENTITLEMENT_DIR });
      assert.equal(code, 0);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, `${SERVER_URL}/v1/activate`);
      assert.equal(calls[0].body.key, TEST_KEY);
      assert.ok(calls[0].body.installation_id, "the activation must carry an installation id");
      installationId = calls[0].body.installation_id;
    });

    // The signed entitlement the server issued must be on disk, verifiable,
    // and bound to this machine.
    const artifact = new EntitlementStore(ENTITLEMENT_DIR).load();
    assert.ok(artifact, "the entitlement artifact must be persisted");
    assert.equal(artifact.payload.plan_id, "level1");

    const cached = cache.load();
    assert.ok(cached, "session must be readable from the local cache");
    assert.equal(typeof cached.token, "string");
    assert.ok(cached.expires_at, "expiry must be surfaced for the UI");

    // The gate decision the extension renders: the artifact verifies, so a
    // real run is authorized.
    const decision = checkEntitlement({ entitlementDir: ENTITLEMENT_DIR });
    assert.equal(decision.allowed, true, `gate denied an activated machine: ${decision.message}`);
    assert.equal(decision.state, GateState.ALLOWED);
  });

  // ── 2. Server restart → the cached session survives ──────────────────────
  it("server restart: cached session still authorizes offline reads", async () => {
    state.serverRunning = false;
    try {
      const cached = cache.load();
      assert.ok(cached, "cache must survive a server restart");
      assert.ok(new Date(cached.expires_at).getTime() > Date.now(), "cached session must not be expired");

      // Status against the restarted server: the installation is unknown, so
      // the server refuses. The client must treat this as "not authorized" and
      // the local gate must still authorize the signed artifact offline.
      await withFetchStub(async () => {
        const status = await client.status(cached.token, { serverUrl: SERVER_URL });
        assert.equal(status.ok, true);
        assert.equal(status.body.valid, false);
        assert.equal(status.body.reason, "installation_not_found");
      });

      const decision = checkEntitlement({ entitlementDir: ENTITLEMENT_DIR });
      assert.equal(decision.allowed, true, "a signed, unexpired artifact must still authorize a run offline");
    } finally {
      state.serverRunning = true;
    }
  });

  // ── 3. Entitlement revoked → run denied with the exact message ───────────
  it("revoked entitlement blocks run with the exact denial message", async () => {
    state.revoked = true;
    try {
      const decision = await checkEntitlementOnline({
        entitlementDir: ENTITLEMENT_DIR,
        serverUrl: SERVER_URL,
        _loadArtifact: () => signArtifact(),
        _validate: async () => ({
          ok: true,
          body: { valid: false, error: "This entitlement is no longer active." },
        }),
      });

      assert.equal(decision.allowed, false);
      assert.equal(decision.state, GateState.SERVER_REJECTED);
      assert.equal(decision.message, "This entitlement is no longer active.");
      assert.ok(installationId, "test sanity: an installation id was issued");
    } finally {
      state.revoked = false;
    }
  });

  // ── 3b. Entitlement expired → run denied with the exact notification ──────
  it("expired entitlement blocks run with the exact denial message", async () => {
    const decision = await checkEntitlementOnline({
      entitlementDir: ENTITLEMENT_DIR,
      serverUrl: SERVER_URL,
      _loadArtifact: () => signArtifact({ expiresInMs: -61000 }),
      _validate: async () => ({ ok: true, body: { valid: true } }),
    });

    assert.equal(decision.allowed, false);
    assert.equal(decision.state, GateState.EXPIRED);
    assert.equal(decision.message, GateMessages[GateState.EXPIRED]);
    assert.match(decision.message, /expired/);
    assert.match(decision.message, /Renew your subscription/);
  });

  // ── 3c. Server unreachable → offline grace with day count ─────────────────
  it("unreachable server falls back to offline grace after prior validation", async () => {
    // Simulate a machine that validated online 1 day ago (within 7-day grace).
    saveGateState(
      { latest_observed_at: Date.now(), last_validated_at: new Date(Date.now() - 86400000).toISOString() },
      ENTITLEMENT_DIR,
    );

    const decision = await checkEntitlementOnline({
      entitlementDir: ENTITLEMENT_DIR,
      serverUrl: SERVER_URL,
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
