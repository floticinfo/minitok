"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { fetchWithTimeout, FallbackProvider, _estimateCost, LLMProvider } = require("./provider");

function jsonResponse(status, body, headers = {}) {
  const response = {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[name.toLowerCase()] || null },
    arrayBuffer: async () => new ArrayBuffer(0),
    json: async () => body,
    text: async () => JSON.stringify(body),
    clone: () => ({ text: async () => JSON.stringify(body) }),
  };
  return response;
}

describe("fetchWithTimeout retry policy", () => {
  it("retries 429 and 5xx with Retry-After and succeeds", async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      if (calls === 1) return jsonResponse(429, { error: "slow down" }, { "retry-after": "0" });
      return jsonResponse(200, { ok: true });
    };
    const originalFetch = global.fetch;
    global.fetch = fetchImpl;
    try {
      const res = await fetchWithTimeout("https://example.test/v1", {}, 1000, { maxRetries: 3, backoffMs: 250, maxBackoffMs: 250 });
      assert.equal(res.status, 200);
      assert.equal(calls, 2);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("does not retry terminal quota 429 responses", async () => {
    let calls = 0;
    const originalFetch = global.fetch;
    global.fetch = async () => {
      calls++;
      return jsonResponse(429, { error: { message: "You have no credits remaining. Add credits to continue." } }, { "retry-after": "90" });
    };
    try {
      const res = await fetchWithTimeout("https://example.test/v1", {}, 1000, { maxRetries: 3, backoffMs: 250, maxBackoffMs: 250 });
      assert.equal(res.status, 429);
      assert.equal(calls, 1, "quota errors must fail fast instead of waiting through backoff retries");
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("keeps retrying transient rate-limit 429 responses", async () => {
    let calls = 0;
    const originalFetch = global.fetch;
    global.fetch = async () => {
      calls++;
      return calls === 1 ? jsonResponse(429, { error: { message: "Rate limit exceeded; retry later" } }, { "retry-after": "0" }) : jsonResponse(200, { ok: true });
    };
    try {
      const res = await fetchWithTimeout("https://example.test/v1", {}, 1000, { maxRetries: 3, backoffMs: 250, maxBackoffMs: 250 });
      assert.equal(res.status, 200);
      assert.equal(calls, 2);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("gives up after the configured attempt budget", async () => {
    let calls = 0;
    const originalFetch = global.fetch;
    global.fetch = async () => { calls++; return jsonResponse(500, { error: "boom" }); };
    try {
      const res = await fetchWithTimeout("https://example.test/v1", {}, 1000, { maxRetries: 2, backoffMs: 250, maxBackoffMs: 250 });
      assert.equal(res.status, 500);
      assert.equal(calls, 3, "1 initial + 2 retries");
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("does not retry non-transient statuses", async () => {
    let calls = 0;
    const originalFetch = global.fetch;
    global.fetch = async () => { calls++; return jsonResponse(400, { error: "bad request" }); };
    try {
      const res = await fetchWithTimeout("https://example.test/v1", {}, 1000, { maxRetries: 3, backoffMs: 250, maxBackoffMs: 250 });
      assert.equal(res.status, 400);
      assert.equal(calls, 1);
    } finally {
      global.fetch = originalFetch;
    }
  });
});

describe("FallbackProvider", () => {
  class Fake extends LLMProvider {
    constructor(failures) { super("fake", {}); this.failures = failures; this.calls = []; }
    async complete(messages, options = {}) {
      this.calls.push(options.model);
      if (this.failures.length) {
        const failed = this.failures.shift();
        throw new Error(`model ${options.model} failed: ${failed}`);
      }
      return { text: `ok:${options.model}`, tokens: { input: 1, output: 1 } };
    }
  }

  it("falls through to fallback models on failure", async () => {
    const primary = new Fake(["quota", "context"]);
    const p = new FallbackProvider(primary, ["fallback-a", "fallback-b"]);
    const r = await p.complete([], { model: "primary" });
    assert.equal(r.text, "ok:fallback-b");
    assert.deepEqual(primary.calls, ["primary", "fallback-a", "fallback-b"]);
  });

  it("returns the primary result when it succeeds", async () => {
    const primary = new Fake([]);
    const p = new FallbackProvider(primary, ["fallback-a"]);
    const r = await p.complete([], { model: "primary" });
    assert.equal(r.text, "ok:primary");
    assert.deepEqual(primary.calls, ["primary"]);
  });

  it("throws the original error when all fallbacks fail", async () => {
    const primary = new Fake(["a", "b", "c"]);
    const p = new FallbackProvider(primary, ["fallback-a", "fallback-b"]);
    await assert.rejects(() => p.complete([], { model: "primary" }), /model primary failed: a/);
  });
});

describe("_estimateCost", () => {
  it("computes per-mtok pricing", () => {
    const cost = _estimateCost({ input: 1000000, output: 500000 }, { input_per_mtok: 3, output_per_mtok: 15 });
    assert.equal(cost.input, 3);
    assert.equal(cost.output, 7.5);
    assert.equal(cost.total, 10.5);
    assert.deepEqual(_estimateCost(null, null).total, 0);
  });
});
