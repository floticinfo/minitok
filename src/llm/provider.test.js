"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { createProvider, CustomProvider } = require("./provider");
const { discoverModels } = require("./models");
const dns = require("dns").promises;

describe("generic custom provider", () => {
  it("supports arbitrary provider names and endpoint aliases", async () => {
    const provider = createProvider("any-provider", { endpoint: "https://example.test/v1", auth: { type: "api_key", key: "key", scheme: "raw", header: "X-Token" }, models: [{ id: "model" }] });
    assert.equal(provider.name, "any-provider");
    assert.equal(provider.baseUrl, "https://example.test/v1");
    const auth = await provider._resolveAuth();
    assert.equal(auth.headers["X-Token"], "key");
  });

  it("blocks unsafe custom HTTPS hosts and resolved addresses", async () => {
    assert.throws(() => createProvider("custom", { base_url: "https://127.0.0.1:8443" }), /blocked/);
    assert.throws(() => createProvider("custom", { base_url: "https://metadata.google.internal" }), /blocked/);
    const originalLookup = dns.lookup;
    dns.lookup = async () => [{ address: "10.0.0.7", family: 4 }];
    try {
      const provider = createProvider("custom", { base_url: "https://public.example" });
      await assert.rejects(() => provider.complete([{ role: "user", content: "test" }]), /blocked internal address/);
    } finally {
      dns.lookup = originalLookup;
    }
  });

  it("blocks all special IPv4 and IPv6 ranges, including mapped IPv6", () => {
    const addresses = [
      "0.0.0.0", "10.0.0.1", "100.64.0.1", "127.0.0.1", "169.254.1.1", "172.16.0.1", "192.0.0.1", "192.0.0.9", "192.0.2.1", "192.168.1.1", "198.18.0.1", "198.51.100.1", "203.0.113.1", "224.0.0.1", "255.255.255.255",
      "::", "::1", "fc00::1", "fe80::1", "ff02::1", "2001:db8::1", "2001:10::1", "::ffff:10.0.0.1", "::ffff:127.0.0.1",
    ];
    for (const address of addresses) {
      const host = address.includes(":") ? `[${address}]` : address;
      assert.throws(() => createProvider("custom", { base_url: `https://${host}` }), /blocked/, address);
    }
  });

  it("pins the validated address when DNS changes before a direct HTTPS request", async () => {
    const originalLookup = dns.lookup;
    const originalFetch = global.fetch;
    let lookupCalls = 0;
    let requestOptions;
    dns.lookup = async () => {
      lookupCalls++;
      return [{ address: lookupCalls === 1 ? "93.184.216.34" : "10.0.0.7", family: 4 }];
    };
    global.fetch = async (_url, options) => {
      requestOptions = options;
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ choices: [{ message: { content: "ok" } }] }) };
    };
    const oldNoProxy = process.env.NO_PROXY;
    process.env.NO_PROXY = "public.example";
    try {
      const provider = createProvider("custom", { base_url: "https://public.example", api_key: "key" });
      await provider.complete([{ role: "user", content: "test" }]);
      assert.equal(lookupCalls, 1);
      assert.equal(typeof requestOptions.dispatcher, "object");
      const dispatcherOptions = requestOptions.dispatcher[Object.getOwnPropertySymbols(requestOptions.dispatcher).find(symbol => String(symbol).includes("options"))];
      await new Promise((resolve, reject) => dispatcherOptions.connect.lookup("public.example", { family: 4 }, (error, address) => error ? reject(error) : (assert.equal(address, "93.184.216.34"), resolve())));
    } finally {
      dns.lookup = originalLookup;
      global.fetch = originalFetch;
      if (oldNoProxy === undefined) delete process.env.NO_PROXY;
      else process.env.NO_PROXY = oldNoProxy;
    }
  });

  it("uses configured auth.key and environment-backed credentials for model discovery", async () => {
    const originalLookup = dns.lookup;
    const originalFetch = global.fetch;
    const originalEnv = process.env.MINITOK_CUSTOM_DISCOVERY_KEY;
    const requests = [];
    dns.lookup = async () => [{ address: "93.184.216.34", family: 4 }];
    global.fetch = async (_url, options) => {
      requests.push(options);
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ data: [{ id: "discovered-model" }] }) };
    };
    process.env.MINITOK_CUSTOM_DISCOVERY_KEY = "env-secret";
    try {
      const configured = await CustomProvider.fetchModels("https://public.example", "", { type: "api_key", key: "configured-secret", scheme: "Bearer" }, "custom");
      const environmentBacked = await CustomProvider.fetchModels("https://public.example", "", { type: "api_key", key: "${MINITOK_CUSTOM_DISCOVERY_KEY}", scheme: "Bearer" }, "custom");
      assert.equal(configured[0].id, "discovered-model");
      assert.equal(environmentBacked[0].id, "discovered-model");
      assert.equal(requests[0].headers.Authorization, "Bearer configured-secret");
      assert.equal(requests[1].headers.Authorization, "Bearer env-secret");
    } finally {
      dns.lookup = originalLookup;
      global.fetch = originalFetch;
      if (originalEnv === undefined) delete process.env.MINITOK_CUSTOM_DISCOVERY_KEY;
      else process.env.MINITOK_CUSTOM_DISCOVERY_KEY = originalEnv;
    }
  });

  it("applies DNS validation to model discovery and returns safe failures", async () => {
    const originalLookup = dns.lookup;
    const originalFetch = global.fetch;
    dns.lookup = async () => { throw new Error("resolver detail"); };
    global.fetch = async () => { throw new Error("must not fetch"); };
    try { assert.deepEqual(await CustomProvider.fetchModels("https://public.example", "key"), []); }
    finally { dns.lookup = originalLookup; global.fetch = originalFetch; }
  });

  it("validates custom endpoints before proxy forwarding", async () => {
    const originalLookup = dns.lookup;
    const originalFetch = global.fetch;
    const oldProxy = process.env.HTTPS_PROXY;
    process.env.HTTPS_PROXY = "http://proxy.example:8080";
    dns.lookup = async () => [{ address: "169.254.169.254", family: 4 }];
    global.fetch = async () => { throw new Error("must not fetch"); };
    try { assert.deepEqual(await CustomProvider.fetchModels("https://public.example", "key"), []); }
    finally {
      dns.lookup = originalLookup;
      global.fetch = originalFetch;
      if (oldProxy === undefined) delete process.env.HTTPS_PROXY;
      else process.env.HTTPS_PROXY = oldProxy;
    }
  });

  it("pins the validated address before proxy routing", async () => {
    const originalLookup = dns.lookup;
    const originalFetch = global.fetch;
    const oldProxy = process.env.HTTPS_PROXY;
    let requestUrl;
    process.env.HTTPS_PROXY = "http://proxy.example:8080";
    dns.lookup = async () => [{ address: "93.184.216.34", family: 4 }];
    global.fetch = async (url) => {
      requestUrl = url;
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ choices: [{ message: { content: "ok" } }] }) };
    };
    try {
      const provider = createProvider("custom", { base_url: "https://public.example", api_key: "key" });
      await provider.complete([{ role: "user", content: "test" }]);
      assert.match(requestUrl, /^https:\/\/93\.184\.216\.34\//);
    } finally {
      dns.lookup = originalLookup;
      global.fetch = originalFetch;
      if (oldProxy === undefined) delete process.env.HTTPS_PROXY;
      else process.env.HTTPS_PROXY = oldProxy;
    }
  });

  it("discovers models from a supported provider through configured auth.key", async () => {
    const originalFetch = global.fetch;
    let authorization;
    global.fetch = async (_url, options) => {
      authorization = options.headers.Authorization;
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ data: [{ id: "gpt-5.6-sol" }] }) };
    };
    try {
      const result = await discoverModels({ openai: { auth: { type: "api_key", key: "openai-secret", scheme: "Bearer" } } });
      assert.deepEqual(result.live.openai, ["gpt-5.6-sol"]);
      assert.equal(authorization, "Bearer openai-secret");
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("applies DNS SSRF validation consistently to built-in providers", async () => {
    const originalLookup = dns.lookup;
    dns.lookup = async () => [{ address: "169.254.169.254", family: 4 }];
    const originalFetch = global.fetch;
    global.fetch = async () => { throw new Error("must not fetch"); };
    try {
      for (const name of ["anthropic", "openai", "google"]) {
        const provider = createProvider(name, { api_key: "key", endpoint: "https://public.example" });
        await assert.rejects(() => provider.complete([{ role: "user", content: "test" }]), /blocked internal address/);
      }
    } finally {
      dns.lookup = originalLookup;
      global.fetch = originalFetch;
    }
  });

  it("applies endpoint validation consistently to built-in providers", () => {
    for (const name of ["anthropic", "openai", "google"]) {
      assert.throws(() => createProvider(name, { endpoint: "http://remote.example/v1" }), /HTTP endpoints are limited to localhost/);
      assert.throws(() => createProvider(name, { endpoint: "https://example.test/v1?key=secret" }), /query or fragment/);
    }
    assert.doesNotThrow(() => createProvider("openai", { endpoint: "http://127.0.0.1:8080/v1" }));
  });
});
describe("provider error reporting", () => {
  it("surfaces the API error message instead of only the status code", async () => {
    const originalFetch = global.fetch;
    global.fetch = async () => new Response(JSON.stringify({ error: { message: "model 'ghost-1' does not exist" } }), { status: 404, headers: { "content-type": "application/json" } });
    try {
      const provider = createProvider("custom", { base_url: "http://localhost:11434/v1", api_key: "key", allow_insecure_local_endpoint: true });
      await assert.rejects(
        () => provider.complete([{ role: "user", content: "hi" }]),
        error => {
          assert.match(error.message, /API request failed \(404\)/);
          assert.match(error.message, /model 'ghost-1' does not exist/);
          return true;
        }
      );
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("falls back to a truncated body when the error is not JSON", async () => {
    const originalFetch = global.fetch;
    global.fetch = async () => new Response("upstream\n   gateway   timeout", { status: 400, headers: { "content-type": "text/plain" } });
    try {
      const provider = createProvider("custom", { base_url: "http://localhost:11434/v1", api_key: "key", allow_insecure_local_endpoint: true });
      await assert.rejects(() => provider.complete([{ role: "user", content: "hi" }]), /upstream gateway timeout/);
    } finally {
      global.fetch = originalFetch;
    }
  });
});

describe("provider request headers", () => {
  function stubFetch(body) {
    const calls = [];
    const original = global.fetch;
    global.fetch = async (url, options) => {
      calls.push({ url, options });
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    };
    return { calls, restore: () => { global.fetch = original; } };
  }

  async function withStubbedDns(run) {
    const originalLookup = dns.lookup;
    dns.lookup = async () => [{ address: "93.184.216.34", family: 4 }];
    try { return await run(); } finally { dns.lookup = originalLookup; }
  }

  it("honours an explicit auth header instead of the provider default", async () => {
    const stub = stubFetch({ choices: [{ message: { content: "ok" } }] });
    try {
      await withStubbedDns(async () => {
        const provider = createProvider("openai", { model: "gpt-4o", api_key: "key", auth: { type: "api_key", key: "key", header: "X-Token", scheme: "raw" } });
        await provider.complete([{ role: "user", content: "hi" }]);
      });
      const headers = stub.calls[0].options.headers;
      assert.equal(headers["X-Token"], "key");
      assert.equal(headers.Authorization, undefined, "no second credential header");
    } finally { stub.restore(); }
  });

  it("sends a bearer token once when the auth block resolves an OAuth style credential", async () => {
    const stub = stubFetch({ content: [{ type: "text", text: "ok" }] });
    try {
      await withStubbedDns(async () => {
        const provider = createProvider("anthropic", { model: "claude-sonnet-5", api_key: "key", auth: { type: "api_key", key: "key", scheme: "Bearer" } });
        await provider.complete([{ role: "user", content: "hi" }]);
      });
      const headers = stub.calls[0].options.headers;
      assert.equal(headers.Authorization, "Bearer key");
      assert.equal(headers["x-api-key"], undefined, "the OAuth token is not also sent as x-api-key");
      assert.equal(headers["anthropic-version"], "2023-06-01", "provider specific headers survive");
    } finally { stub.restore(); }
  });

  it("keeps the provider default header for the legacy api_key path", async () => {
    const stub = stubFetch({ choices: [{ message: { content: "ok" } }] });
    try {
      await withStubbedDns(async () => {
        const provider = createProvider("openai", { model: "gpt-4o", api_key: "key" });
        await provider.complete([{ role: "user", content: "hi" }]);
      });
      const headers = stub.calls[0].options.headers;
      // The legacy resolver returns x-api-key for every provider; it must not
      // replace the credential header OpenAI actually accepts.
      assert.equal(headers.Authorization, "Bearer key");
      assert.equal(headers["x-api-key"], undefined);
    } finally { stub.restore(); }
  });
});

describe("provider reasoning parameters", () => {
  function stubFetch(body = { choices: [{ message: { content: "ok" } }] }) {
    const calls = [];
    const original = global.fetch;
    global.fetch = async (url, options) => {
      calls.push({ url, options });
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    };
    return { calls, restore: () => { global.fetch = original; } };
  }

  async function bodyFor(model, config = {}) {
    const originalLookup = dns.lookup;
    dns.lookup = async () => [{ address: "93.184.216.34", family: 4 }];
    const stub = stubFetch();
    try {
      const provider = createProvider("openai", { api_key: "key", ...config });
      await provider.complete([{ role: "user", content: "hi" }], { model });
      return JSON.parse(stub.calls[0].options.body);
    } finally {
      stub.restore();
      dns.lookup = originalLookup;
    }
  }

  it("uses max_completion_tokens for reasoning models on the official endpoint", async () => {
    const body = await bodyFor("o3-mini");
    assert.equal(body.max_completion_tokens, 4096);
    assert.equal(body.max_tokens, undefined);
    assert.equal(body.temperature, undefined);
  });

  it("keeps max_tokens and temperature for non-reasoning models", async () => {
    const body = await bodyFor("gpt-4o");
    assert.equal(body.max_tokens, 4096);
    assert.equal(body.max_completion_tokens, undefined);
    assert.equal(body.temperature, 0.7);
  });

  it("keeps max_tokens for reasoning models behind a compatible gateway", async () => {
    const body = await bodyFor("o3-mini", { endpoint: "https://gateway.example" });
    assert.equal(body.max_tokens, 4096);
    assert.equal(body.max_completion_tokens, undefined);
  });

  it("sends reasoning_effort only for reasoning models", async () => {
    const reasoning = await bodyFor("o3-mini", { reasoning_effort: "low" });
    assert.equal(reasoning.reasoning_effort, "low");
    const plain = await bodyFor("gpt-4o", { reasoning_effort: "low" });
    assert.equal(plain.reasoning_effort, undefined);
  });
});
describe("provider finish reason", () => {
  function stubFetch(body) {
    const calls = [];
    const original = global.fetch;
    global.fetch = async (url, options) => {
      calls.push({ url, options });
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    };
    return { calls, restore: () => { global.fetch = original; } };
  }

  /** Complete one request against a stubbed provider response. */
  async function completeWith(name, config, body, options = {}) {
    const originalLookup = dns.lookup;
    dns.lookup = async () => [{ address: "93.184.216.34", family: 4 }];
    const stub = stubFetch(body);
    try {
      const provider = createProvider(name, config);
      return await provider.complete([{ role: "user", content: "hi" }], options);
    } finally {
      stub.restore();
      dns.lookup = originalLookup;
    }
  }

  // Without the stop reason a reply cut off by the output budget was
  // indistinguishable from a model that ignored the requested format, so the run
  // retried, escalated, and paid for the same overflow again.

  it("reports an Anthropic reply cut off by max_tokens", async () => {
    const truncated = await completeWith("anthropic", { model: "claude-sonnet-5", api_key: "key" }, { model: "claude-sonnet-5", stop_reason: "max_tokens", content: [{ type: "text", text: "{\"changes\":[" }], usage: { input_tokens: 1, output_tokens: 2 } });
    assert.equal(truncated.finish_reason, "max_tokens");
    assert.equal(truncated.truncated, true);
    const complete = await completeWith("anthropic", { model: "claude-sonnet-5", api_key: "key" }, { model: "claude-sonnet-5", stop_reason: "end_turn", content: [{ type: "text", text: "{}" }] });
    assert.equal(complete.finish_reason, "end_turn");
    assert.equal(complete.truncated, false);
  });

  it("reports an OpenAI reply cut off by the output budget", async () => {
    const truncated = await completeWith("openai", { model: "gpt-4o", api_key: "key" }, { model: "gpt-4o", choices: [{ message: { content: "{\"changes\":[" }, finish_reason: "length" }] });
    assert.equal(truncated.finish_reason, "length");
    assert.equal(truncated.truncated, true);
    const complete = await completeWith("openai", { model: "gpt-4o", api_key: "key" }, { model: "gpt-4o", choices: [{ message: { content: "{}" }, finish_reason: "stop" }] });
    assert.equal(complete.truncated, false);
  });

  it("reports a Google reply cut off by MAX_TOKENS", async () => {
    const truncated = await completeWith("google", { model: "gemini-2.5-pro", api_key: "key" }, { candidates: [{ content: { parts: [{ text: "{\"changes\":[" }] }, finishReason: "MAX_TOKENS" }] });
    assert.equal(truncated.finish_reason, "MAX_TOKENS");
    assert.equal(truncated.truncated, true);
    const complete = await completeWith("google", { model: "gemini-2.5-pro", api_key: "key" }, { candidates: [{ content: { parts: [{ text: "{}" }] }, finishReason: "STOP" }] });
    assert.equal(complete.truncated, false);
  });

  it("reports an OpenAI-compatible gateway reply cut off by the output budget", async () => {
    const truncated = await completeWith("custom", { base_url: "https://gateway.example/v1", model: "local", api_key: "key" }, { model: "local", choices: [{ message: { content: "{\"changes\":[" }, finish_reason: "length" }] });
    assert.equal(truncated.finish_reason, "length");
    assert.equal(truncated.truncated, true);
  });

  it("surfaces the stop reason instead of an empty successful response", async () => {
    // A refusal, a tool-only turn, and a Google safety block all arrive with an
    // empty text: returning "" surfaced downstream as "No JSON in response".
    await assert.rejects(
      () => completeWith("anthropic", { model: "claude-sonnet-5", api_key: "key" }, { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t", name: "x", input: {} }] }),
      /returned no text \(stop_reason: tool_use\)/
    );
    await assert.rejects(
      () => completeWith("openai", { model: "gpt-4o", api_key: "key" }, { choices: [{ message: { content: "" }, finish_reason: "content_filter" }] }),
      /returned no text \(finish_reason: content_filter\)/
    );
    await assert.rejects(
      () => completeWith("google", { model: "gemini-2.5-pro", api_key: "key" }, { promptFeedback: { blockReason: "SAFETY" }, candidates: [] }),
      /blocked \(blockReason: SAFETY\)/
    );
  });
});


