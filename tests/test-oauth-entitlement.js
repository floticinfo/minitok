"use strict";

/**
 * OAuth-based entitlement contract.
 *
 * GET /me and POST /bind resolve a customer from a JWT the auth server issued.
 * The failure this suite guards against is a skipped signature check: a token
 * anyone can hand-craft must never resolve a customer.
 */

const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

process.env.OAUTH_JWT_SECRET = process.env.OAUTH_JWT_SECRET || "test-oauth-secret";
process.env.OAUTH_JWT_ISSUER = process.env.OAUTH_JWT_ISSUER || "minitok-server";
process.env.OAUTH_JWT_AUDIENCE = process.env.OAUTH_JWT_AUDIENCE || "minitok:customer";

const { sign } = require("../server/services/jwt");
const { verifyOAuthToken } = require("../server/middleware/oauth-auth");
const store = require("../server/models/entitlement");

const SECRET = process.env.OAUTH_JWT_SECRET;
const CUSTOMER = "550e8400-e29b-41d4-a716-446655440000";
const OTHER_CUSTOMER = "660e8400-e29b-41d4-a716-446655440000";

function token(claims, secret = SECRET, options = {}) {
  return sign(
    { sub: CUSTOMER, iss: "minitok-server", aud: "minitok:customer", ...claims },
    secret,
    { expiresInSeconds: 3600, ...options },
  );
}

describe("OAuth entitlement token verification", () => {
  beforeEach(() => store._reset());

  it("accepts a token signed with the shared secret", () => {
    const result = verifyOAuthToken(token({}));
    assert.equal(result.valid, true);
    assert.equal(result.customerId, CUSTOMER);
  });

  it("rejects a token signed with the wrong secret", () => {
    const result = verifyOAuthToken(token({}, "attacker-secret"));
    assert.equal(result.valid, false, "a forged signature must never resolve a customer");
    assert.equal(result.customerId, undefined);
  });

  it("rejects a token whose payload was edited after signing", () => {
    const [header, payload, signature] = token({}).split(".");
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    claims.sub = OTHER_CUSTOMER;
    const forged = header + "." + Buffer.from(JSON.stringify(claims), "utf8").toString("base64url") + "." + signature;
    const result = verifyOAuthToken(forged);
    assert.equal(result.valid, false, "swapping the subject must invalidate the signature");
    assert.equal(result.customerId, undefined);
  });

  it("rejects a wrong issuer", () => {
    assert.equal(verifyOAuthToken(token({ iss: "someone-else" })).valid, false);
  });

  it("rejects a wrong audience", () => {
    assert.equal(verifyOAuthToken(token({ aud: "minitok:installation" })).valid, false);
  });

  it("rejects an expired token", () => {
    assert.equal(verifyOAuthToken(token({}, SECRET, { expiresInSeconds: -60 })).valid, false);
  });

  it("rejects a subject that is not a customer UUID", () => {
    assert.equal(verifyOAuthToken(token({ sub: "not-a-uuid" })).valid, false);
  });

  it("rejects an installation token", () => {
    assert.equal(
      verifyOAuthToken(token({ installation_id: "inst-abc" })).valid,
      false,
      "installation tokens must not pass as customer tokens",
    );
  });

  it("rejects a malformed token", () => {
    assert.equal(verifyOAuthToken("header.payload.signature").valid, false);
  });

  it("rejects a missing token", () => {
    assert.equal(verifyOAuthToken(undefined).valid, false);
    assert.equal(verifyOAuthToken("").valid, false);
  });
});

describe("entitlement binding", () => {
  beforeEach(() => store._reset());

  it("binds an activated key to the verified customer", () => {
    store.create({ key: "bind-key", installationId: "inst-1", planId: "level1" });
    assert.equal(store.findByCustomerId(CUSTOMER), null);
    const bound = store.bindCustomerId("bind-key", CUSTOMER);
    assert.equal(bound.customerId, CUSTOMER);
    assert.equal(store.findByCustomerId(CUSTOMER).key, "bind-key");
  });

  it("does not create a record for an unknown key", () => {
    assert.equal(store.bindCustomerId("never-activated", CUSTOMER), null);
  });

  it("re-binding to another customer overwrites the previous value", () => {
    store.create({ key: "bind-key", installationId: "inst-1", planId: "level1" });
    store.bindCustomerId("bind-key", CUSTOMER);
    store.bindCustomerId("bind-key", OTHER_CUSTOMER);
    assert.equal(store.findByCustomerId(CUSTOMER), null);
    assert.equal(store.findByCustomerId(OTHER_CUSTOMER).key, "bind-key");
  });
});
