"use strict";

/**
 * Regression coverage for the provider verification cache.
 *
 * The cache was keyed by provider name and endpoint only, so a credential the
 * user had replaced kept the previous verdict until the TTL expired: a 401
 * rejection survived the fix, and `resetVerifyCache` had no caller at all.
 */

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { verifyCredentials, resetVerifyCache } = require("./provider");

const state = { accept: false, requests: 0 };
let server;
let baseUrl;

before(async () => {
  server = http.createServer((req, res) => {
    state.requests += 1;
    res.writeHead(state.accept ? 200 : 401, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: state.accept }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => { server.close(); });

describe("provider verification cache", () => {
  it("reuses a verdict for the same credential", async () => {
    resetVerifyCache();
    state.accept = false;
    state.requests = 0;
    const first = await verifyCredentials("mockprov", { base_url: baseUrl, api_key: "key-one" });
    const second = await verifyCredentials("mockprov", { base_url: baseUrl, api_key: "key-one" });
    assert.equal(first.status, "invalid");
    assert.equal(second.status, "invalid");
    assert.equal(state.requests, 1, "a repeated check of the same key must not re-probe");
  });

  it("does not serve the old verdict after the key was replaced", async () => {
    resetVerifyCache();
    state.accept = false;
    state.requests = 0;
    const rejected = await verifyCredentials("mockprov", { base_url: baseUrl, api_key: "key-old" });
    assert.equal(rejected.status, "invalid");

    // The user fixes the key (the provider now accepts the new one).
    state.accept = true;
    const stale = await verifyCredentials("mockprov", { base_url: baseUrl, api_key: "key-old" });
    assert.equal(stale.status, "invalid", "the same key legitimately keeps its cached verdict");

    const fresh = await verifyCredentials("mockprov", { base_url: baseUrl, api_key: "key-new" });
    assert.equal(fresh.status, "ok", "a replaced credential must be probed again");
    assert.equal(state.requests, 2);
  });

  it("resetVerifyCache forces a fresh probe for the same credential", async () => {
    resetVerifyCache();
    state.accept = false;
    state.requests = 0;
    await verifyCredentials("mockprov", { base_url: baseUrl, api_key: "key-reset" });
    assert.equal(state.requests, 1);
    state.accept = true;
    resetVerifyCache();
    const refreshed = await verifyCredentials("mockprov", { base_url: baseUrl, api_key: "key-reset" });
    assert.equal(refreshed.status, "ok");
    assert.equal(state.requests, 2);
  });

  it("keys the cache per endpoint as well as per credential", async () => {
    resetVerifyCache();
    state.accept = true;
    state.requests = 0;
    await verifyCredentials("mockprov", { base_url: baseUrl, api_key: "key-endpoint" });
    await verifyCredentials("mockprov", { base_url: `${baseUrl}/other`, api_key: "key-endpoint" });
    assert.equal(state.requests, 2, "a different endpoint is a different provider target");
  });
});
