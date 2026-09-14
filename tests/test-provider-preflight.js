"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { classifyProviderHealth } = require("../src/cli/commands/run");

function health(status) {
  return new Map([["openai", { status }]]);
}

test("run preflight preserves every provider health state", () => {
  const expected = {
    ok: "ok",
    skipped: "skipped",
    invalid: "invalid",
    network_error: "network_error",
    error: "error",
    absent: "absent",
  };
  for (const [providerStatus, classified] of Object.entries(expected)) {
    assert.equal(classifyProviderHealth("openai", ["openai"], health(providerStatus)), classified, providerStatus);
  }
});

test("run preflight marks unavailable and unprobed providers explicitly", () => {
  assert.equal(classifyProviderHealth("openai", [], new Map()), "absent");
  assert.equal(classifyProviderHealth("openai", ["openai"], new Map()), "unprobed");
});
