"use strict";
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { ReadableStream } = require("node:stream/web");

const { cmdTrial, _httpPost } = require("./trial");

function jsonResponse(body, status = 200) {
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  return {
    status,
    headers: { get: name => name === "content-length" ? String(bytes.byteLength) : null },
    body: new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } }),
  };
}

function withFetchStub(responder, fn) {
  const saved = global.fetch;
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url, options, body: JSON.parse(options.body) });
    return responder();
  };
  return Promise.resolve(fn(calls)).finally(() => { global.fetch = saved; });
}

function captureConsole(fn) {
  const logs = [];
  const errors = [];
  const savedLog = console.log;
  const savedError = console.error;
  console.log = (...args) => logs.push(args.join(" "));
  console.error = (...args) => errors.push(args.join(" "));
  return Promise.resolve()
    .then(() => fn())
    .then(result => ({ result, logs, errors }), error => ({ result: error, logs, errors }))
    .finally(() => {
    console.log = savedLog;
    console.error = savedError;
    });
}

const SERVER_ENV_KEY = "minitok_server_url";

function withServerEnv(url, fn) {
  const saved = process.env[SERVER_ENV_KEY];
  process.env[SERVER_ENV_KEY] = url;
  return Promise.resolve(fn()).finally(() => {
    if (saved === undefined) delete process.env[SERVER_ENV_KEY];
    else process.env[SERVER_ENV_KEY] = saved;
  });
}

describe("minitok trial command", () => {
  it("rejects an invalid email without making an HTTP request", async () => {
    let fetched = 0;
    await withFetchStub(() => { fetched += 1; return jsonResponse({}); }, async () => {
      const run = await captureConsole(() => cmdTrial({ email: "not-an-email" }));
      assert.equal(run.result, 1);
      assert.ok(run.errors.some(line => line.includes("valid email")));
    });
    assert.equal(fetched, 0);
  });

  it("requests a key with email + idempotency_key, displays it once, prints activate hint", async () => {
    await withServerEnv("https://api.example", async () => {
      await withFetchStub(() => jsonResponse({
        activation_key: "trial-EXAMPLE-KEY",
        plan_id: "trial",
        run_quota: 5,
        trial_days: 14,
        expires_at: "2026-10-14T00:00:00.000Z",
      }, 201), async (calls) => {
        const run = await captureConsole(() => cmdTrial({ email: " User@Example.COM " }));
        assert.equal(run.result, 0);
        assert.equal(calls.length, 1);
        assert.equal(calls[0].url, "https://api.example/v1/trial/request");
        assert.equal(calls[0].options.method, "POST");
        assert.equal(calls[0].body.email, "user@example.com");
        assert.ok(typeof calls[0].body.idempotency_key === "string");
        assert.ok(calls[0].body.idempotency_key.length > 10);
        const out = run.logs.join("\n");
        assert.ok(out.includes("trial-EXAMPLE-KEY"));
        assert.ok(out.includes("minitok activate trial-EXAMPLE-KEY"));
        assert.ok(out.includes("5 runs"));
      });
    });
  });

  it("handles already_issued without redisplaying a key", async () => {
    await withServerEnv("https://api.example", async () => {
      await withFetchStub(() => jsonResponse({ already_issued: true, activation_key: null }, 201), async () => {
        const run = await captureConsole(() => cmdTrial({ email: "a@example.com" }));
        assert.equal(run.result, 0);
        const out = run.logs.join("\n");
        assert.ok(out.includes("already issued"));
        assert.ok(!out.includes("trial-"));
      });
    });
  });

  it("surfaces server rejection errors with exit code 1", async () => {
    await withServerEnv("https://api.example", async () => {
      await withFetchStub(() => jsonResponse({ error: "trial_already_used" }, 409), async () => {
        const run = await captureConsole(() => cmdTrial({ email: "a@example.com" }));
        assert.equal(run.result, 1);
        assert.ok(run.errors.some(line => line.includes("trial_already_used")));
      });
    });
  });

  it("uses the same wire helper as other activation commands", async () => {
    await withFetchStub(() => jsonResponse({ activation_key: "k" }, 201), async (calls) => {
      const result = await _httpPost("https://api.example/v1/trial/request", { email: "a@example.com" });
      assert.equal(result.ok, true);
      assert.equal(result.body.activation_key, "k");
      assert.equal(calls[0].options.method, "POST");
      assert.equal(typeof calls[0].options.body, "string");
    });
  });
});