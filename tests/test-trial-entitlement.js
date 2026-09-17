"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { consumeTrialRun } = require("../src/entitlement/online");

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "minitok-trial-online-"));
}

function trialArtifact(overrides = {}) {
  const issued = new Date("2026-09-01T00:00:00.000Z");
  return {
    payload: {
      entitlement_id: "11111111-1111-4111-8111-111111111111",
      installation_id: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
      plan_id: "trial",
      features: ["autonomous_run"],
      max_devices: 1,
      issued_at: issued.toISOString(),
      expires_at: new Date("2026-09-08T00:00:00.000Z").toISOString(),
      key_id: "trial-key",
      telemetry_mode: "off",
      run_quota: 5,
      runs_used: 0,
      ...overrides,
    },
    signature: "test-signature",
    key_id: "trial-key",
  };
}

function withInstallationToken(dir) {
  fs.writeFileSync(path.join(dir, "installation-token.json"), JSON.stringify({
    token: "installation-jwt",
    installation_id: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
  }));
}

test("online trial consume posts the installation token and signed artifact once", async () => {
  const dir = tempDir();
  try {
    withInstallationToken(dir);
    const calls = [];
    const result = await consumeTrialRun({
      serverUrl: "https://api.example.test/",
      entitlementDir: dir,
      _loadArtifact: () => trialArtifact(),
      _consume: async (url, body) => {
        calls.push({ url, body });
        return { ok: true, body: { success: true, runs_used: 1, run_quota: 5, remaining_runs: 4 } };
      },
    });

    assert.deepEqual(result, { consumed: true, remainingRuns: 4, runsUsed: 1, runQuota: 5 });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api.example.test/v1/trial/consume");
    assert.deepEqual(calls[0].body, {
      token: "installation-jwt",
      entitlement: trialArtifact(),
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("trial consume fails closed without online credentials or with a paid artifact", async () => {
  const dir = tempDir();
  try {
    let calls = 0;
    const consume = (options) => consumeTrialRun({
      serverUrl: "https://api.example.test",
      entitlementDir: dir,
      _loadArtifact: () => options.artifact,
      _consume: async () => { calls += 1; return { ok: true, body: { success: true } }; },
    });

    const missingToken = await consume({ artifact: trialArtifact() });
    assert.equal(missingToken.consumed, false);
    assert.equal(missingToken.state, "SERVER_REJECTED");

    withInstallationToken(dir);
    const paid = await consume({ artifact: trialArtifact({ plan_id: "open" }) });
    assert.equal(paid.consumed, false);
    assert.equal(paid.state, "SERVER_REJECTED");
    assert.equal(calls, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("trial consume sends the same idempotency key in body and header", async () => {
  const dir = tempDir();
  try {
    withInstallationToken(dir);
    let received;
    const result = await consumeTrialRun({
      serverUrl: "https://api.example.test",
      entitlementDir: dir,
      _loadArtifact: () => trialArtifact(),
      idempotencyKey: "run-123",
      _consume: async function (...args) { received = args; return { ok: true, body: { success: true } }; },
    });
    assert.equal(result.consumed, true);
    assert.equal(received[1].idempotency_key, "run-123");
    assert.equal(received[3]["Idempotency-Key"], "run-123");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("server rejection and network failure never authorize a trial run", async () => {
  const dir = tempDir();
  try {
    withInstallationToken(dir);
    const rejected = await consumeTrialRun({
      serverUrl: "https://api.example.test",
      entitlementDir: dir,
      _loadArtifact: () => trialArtifact(),
      _consume: async () => ({ ok: false, body: { error: "Trial quota exhausted" } }),
    });
    assert.deepEqual(rejected, {
      consumed: false,
      state: "SERVER_REJECTED",
      message: "Trial quota exhausted",
    });

    const unreachable = await consumeTrialRun({
      serverUrl: "https://api.example.test",
      entitlementDir: dir,
      _loadArtifact: () => trialArtifact(),
      _consume: async () => { throw new Error("offline"); },
    });
    assert.equal(unreachable.consumed, false);
    assert.equal(unreachable.state, "SERVER_UNREACHABLE");
    assert.match(unreachable.message, /offline/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("pipeline consumes trial quota only after provider availability checks", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "pipeline", "loop.js"), "utf8");
  const availability = source.indexOf("await roleProviders[role].provider.isAvailable()");
  const consume = source.indexOf("consumeTrialRun({", availability);
  assert.ok(availability >= 0, "pipeline must perform provider availability checks");
  assert.ok(consume > availability, "trial quota must be consumed after provider checks");
  assert.match(source.slice(availability, consume), /throw new Error\(`Provider/);
});

test("CLI preflight consumes a trial run at most once before pipeline handoff", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "cli", "commands", "run.js"), "utf8");
  assert.match(source, /if \(!opts\.dryRun && opts\.trialEntitlement && !opts\.trialRunConsumed\)/);
  const pipeline = fs.readFileSync(path.join(__dirname, "..", "src", "pipeline", "loop.js"), "utf8");
  assert.match(pipeline, /if \(!opts\.dryRun && gateResult\?\.trial && opts\.trialEntitlement && !opts\.trialRunConsumed\)/);
  assert.match(source, /opts\.trialRunConsumed = true/);
  assert.match(source, /trialRunConsumed: opts\.trialRunConsumed === true/);
});
