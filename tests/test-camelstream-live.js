"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const dns = require("dns").promises;
const { createProvider } = require("../src/llm/provider");
const { loadConfig } = require("../src/config/loader");
const { camelstreamPreset, CAMELSTREAM_BASE_URL, CAMELSTREAM_MODEL, CAMELSTREAM_CREDENTIAL_HANDLE } = require("../src/llm/camelstream");
const { runCamelstreamLiveSmoke, discoverCamelstreamLive, liveGate, LIVE_MODE } = require("../src/llm/live_provider");

function response(body, status = 200) { return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, body: null, json: async () => body, text: async () => JSON.stringify(body) }; }
function liveOptions(extra = {}) { return { mode: LIVE_MODE, confirmation: true, network_enabled: true, live_endpoint_opt_in: true, ...extra }; }

test("camelstream preset is endpoint/model fixed and credential-handle-only", () => {
  const preset = camelstreamPreset();
  assert.equal(preset.base_url, CAMELSTREAM_BASE_URL);
  assert.equal(preset.api_key_env, CAMELSTREAM_CREDENTIAL_HANDLE);
  assert.equal(preset.models[0].id, CAMELSTREAM_MODEL);
  assert.equal(preset.response_api, "responses");
  assert.throws(() => camelstreamPreset({ api_key: "raw-secret" }), /credential handles only/);
  assert.throws(() => camelstreamPreset({ base_url: "https://evil.example/v1" }), /base_url/);
  assert.throws(() => camelstreamPreset({ api_key_env: "OTHER_KEY" }), /api_key_env/);
  assert.throws(() => camelstreamPreset({ models: [{ id: "other" }] }), /allowlist/);
});

test("camelstream config normalizes through the loader without exposing credentials", () => {
  const config = loadConfig(require("node:path").join(require("node:os").tmpdir(), "minitok-no-camelstream-config.yml"), { providers: { camelstream: {} } });
  assert.equal(config.providers.camelstream.base_url, CAMELSTREAM_BASE_URL);
  assert.equal(config.providers.camelstream.api_key_env, CAMELSTREAM_CREDENTIAL_HANDLE);
  assert.equal(config.providers.camelstream.api_key, undefined);
});

test("live gate fails closed before network or credential use", async () => {
  const original = process.env.CAMEL_API_KEY;
  delete process.env.CAMEL_API_KEY;
  try {
    assert.equal(liveGate({}).code, "LIVE_MODE_REQUIRED");
    assert.equal(liveGate(liveOptions({ confirmation: false })).code, "LIVE_CONFIRMATION_REQUIRED");
    assert.equal(liveGate(liveOptions({ network_enabled: false })).code, "LIVE_NETWORK_DISABLED");
    assert.equal(liveGate(liveOptions({ live_endpoint_opt_in: false })).code, "LIVE_ENDPOINT_OPT_IN_REQUIRED");
    assert.equal(liveGate(liveOptions()).code, "CAMELSTREAM_CREDENTIAL_MISSING");
    const result = await runCamelstreamLiveSmoke(liveOptions());
    assert.equal(result.status, "blocked"); assert.equal(result.live_contacted, false); assert.equal(result.publishable_claim, false);
  } finally { if (original === undefined) delete process.env.CAMEL_API_KEY; else process.env.CAMEL_API_KEY = original; }
});

test("supervised live smoke uses Responses API with one mocked canary request", async () => {
  const originalKey = process.env.CAMEL_API_KEY; const originalFetch = global.fetch; const originalLookup = dns.lookup; let calls = 0; let request;
  process.env.CAMEL_API_KEY = "mock-secret-not-output";
  dns.lookup = async () => [{ address: "93.184.216.34", family: 4 }];
  global.fetch = async (url, options) => { calls += 1; request = { url: String(url), options }; return response({ id: "resp_mock", model: CAMELSTREAM_MODEL, status: "completed", output_text: "READY", usage: { input_tokens: 4, output_tokens: 2 } }); };
  try {
    const result = await runCamelstreamLiveSmoke(liveOptions({ max_requests: 1, max_tokens: 32, timeout_ms: 1000 }));
    assert.equal(result.status, "passed"); assert.equal(result.live_contacted, true); assert.equal(result.request_count, 1); assert.equal(calls, 1);
    assert.match(request.url, /stream\.camelai\.com\/v1\/responses$/);
    const body = JSON.parse(request.options.body); assert.equal(body.model, CAMELSTREAM_MODEL); assert.equal(body.max_output_tokens, 32); assert.ok(body.input);
    assert.equal(result.token_usage.total, 6); assert.equal(result.publishable_claim, false); assert.doesNotMatch(JSON.stringify(result), /mock-secret-not-output/);
  } finally { global.fetch = originalFetch; dns.lookup = originalLookup; if (originalKey === undefined) delete process.env.CAMEL_API_KEY; else process.env.CAMEL_API_KEY = originalKey; }
});

test("supervised live discovery uses one mocked models request and preserves the same evidence boundary", async () => {
  const originalKey = process.env.CAMEL_API_KEY; const originalFetch = global.fetch; const originalLookup = dns.lookup; let calls = 0;
  process.env.CAMEL_API_KEY = "mock-secret-not-output"; dns.lookup = async () => [{ address: "93.184.216.34", family: 4 }];
  global.fetch = async () => { calls += 1; return response({ data: [{ id: CAMELSTREAM_MODEL }] }); };
  try { const result = await discoverCamelstreamLive(liveOptions()); assert.equal(result.status, "passed"); assert.equal(result.request_count, 1); assert.equal(calls, 1); assert.equal(result.publishable_claim, false); }
  finally { global.fetch = originalFetch; dns.lookup = originalLookup; if (originalKey === undefined) delete process.env.CAMEL_API_KEY; else process.env.CAMEL_API_KEY = originalKey; }
});

test("canary budget rejects zero requests without contacting the provider", async () => {
  const originalKey = process.env.CAMEL_API_KEY; process.env.CAMEL_API_KEY = "configured";
  try { const result = await runCamelstreamLiveSmoke(liveOptions({ max_requests: 0 })); assert.equal(result.status, "blocked"); assert.equal(result.request_count, 0); assert.equal(result.live_contacted, false); }
  finally { if (originalKey === undefined) delete process.env.CAMEL_API_KEY; else process.env.CAMEL_API_KEY = originalKey; }
});

test("createProvider exposes Camelstream as a Responses API custom provider", async () => { const originalKey = process.env.CAMEL_API_KEY; delete process.env.CAMEL_API_KEY; try { const provider = createProvider("camelstream", {}); assert.equal(provider.name, "camelstream"); assert.equal(provider.baseUrl, CAMELSTREAM_BASE_URL); assert.equal(provider.responseApi, "responses"); assert.equal(provider.models[0].id, CAMELSTREAM_MODEL); assert.equal(await provider.isAvailable(), false); } finally { if (originalKey === undefined) delete process.env.CAMEL_API_KEY; else process.env.CAMEL_API_KEY = originalKey; } });
