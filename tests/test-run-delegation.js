"use strict";

const assert = require("assert");
const { test } = require("node:test");

const { DELEGATION_ENV, takeDelegationTokenFromEnv, verifyRunDelegation } = require("../src/entitlement/delegation");
const { authorizeEntitlement } = require("../src/entitlement/policy");

function setEnv(token) { process.env[DELEGATION_ENV] = token; }

test("delegation: a valid token authorizes with plan admin and runId binding", async () => {
  const seen = [];
  const result = await verifyRunDelegation("tok-valid", {
    serverUrl: "https://server.example",
    runIds: ["run-1"],
    _verify: async (url, body) => {
      seen.push({ url, body });
      return { ok: true, body: { valid: true, run_id: "run-1" } };
    },
  });
  assert.equal(result.allowed, true);
  assert.equal(result.state, "ALLOWED");
  assert.equal(result.delegated, true);
  assert.equal(result.delegationRunId, "run-1");
  assert.equal(result.entitlement.plan_id, "admin");
  assert.equal(seen[0].url, "https://server.example/v1/run-delegation/verify");
  assert.deepEqual(seen[0].body, { token: "tok-valid", run_ids: ["run-1"] });
});

test("delegation: a rejected token fails closed", async () => {
  const result = await verifyRunDelegation("tok-bad", {
    serverUrl: "https://server.example",
    _verify: async () => ({ ok: false, status: 401, body: { error: "burned" } }),
  });
  assert.equal(result.allowed, false);
  assert.equal(result.state, "SERVER_REJECTED");
  assert.match(result.message, /burned|rejected/);
});

test("delegation: network failure is SERVER_UNREACHABLE (no offline grace)", async () => {
  const result = await verifyRunDelegation("tok-net", {
    serverUrl: "https://server.example",
    _verify: async () => { throw new Error("socket hang up"); },
  });
  assert.equal(result.allowed, false);
  assert.equal(result.state, "SERVER_UNREACHABLE");
});

test("delegation: no server url fails closed", async () => {
  const result = await verifyRunDelegation("tok", {});
  assert.equal(result.allowed, false);
  assert.equal(result.state, "SERVER_REJECTED");
});

test("delegation: takeDelegationTokenFromEnv reads once and scrubs", () => {
  setEnv("  tok-once  ");
  assert.equal(takeDelegationTokenFromEnv(), "tok-once");
  assert.equal(process.env[DELEGATION_ENV], undefined, "the env var must be deleted after the first read");
  assert.equal(takeDelegationTokenFromEnv(), null);
  setEnv("   ");
  assert.equal(takeDelegationTokenFromEnv(), null, "blank tokens are not delegation attempts");
  assert.equal(process.env[DELEGATION_ENV], undefined);
});

test("delegation: authorizeEntitlement routes the env token to verification", async () => {
  setEnv("tok-flow");
  const calls = [];
  const result = await authorizeEntitlement({
    serverUrl: "https://server.example",
    delegationRunIds: ["run-9"],
    _verify: async (url, body) => {
      calls.push({ url, body });
      return { ok: true, body: { valid: true, run_id: "run-9" } };
    },
  });
  assert.equal(result.allowed, true);
  assert.equal(result.entitlement.plan_id, "admin");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.token, "tok-flow");
  assert.deepEqual(calls[0].body.run_ids, ["run-9"]);
  assert.equal(process.env[DELEGATION_ENV], undefined, "the gate must scrub the token from its own env");
});

test("delegation: without a token the policy falls back to the signed entitlement path", async () => {
  delete process.env[DELEGATION_ENV];
  // A missing artifact must produce the usual MISSING gate, not a delegation result.
  const os = require("os");
  const path = require("path");
  const fs = require("fs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "minitok-delegation-"));
  try {
    const result = await authorizeEntitlement({ entitlementDir: dir });
    assert.equal(result.allowed, false);
    assert.equal(result.state, "MISSING");
    assert.equal(result.delegated, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});