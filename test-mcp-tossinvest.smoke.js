"use strict";
/**
 * Smoke test for the trading add-on MCP tools (bidirectional bridge).
 *
 * Verifies:
 *   1. The tossinvest_* tools are present in getToolDefinitions() with
 *      external: true (so the tool registry's preflight gate applies).
 *   2. validateArgs accepts/rejects the expected schemas.
 *   3. The addon-proxy handler forwards through the configured proxy URL and
 *      surfaces upstream errors as isError.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { getToolDefinitions, getToolHandler, validateArgs } = require("./src/mcp/tools");

const ADDON_TOOLS = ["tossinvest_status", "tossinvest_escalate", "tossinvest_lifecycle_list", "tossinvest_goal_bridge_state"];

test("tossinvest tools are defined as external", () => {
  const defs = getToolDefinitions();
  for (const name of ADDON_TOOLS) {
    const def = defs.find((d) => d.name === name);
    assert.ok(def, `${name} is defined`);
    assert.equal(def.external, true, `${name} must be external`);
  }
});

test("tossinvest_status validates empty args", () => {
  const args = validateArgs("tossinvest_status", {});
  assert.deepEqual(args, {});
});

test("tossinvest_escalate requires severity/summary/options", () => {
  assert.throws(() => validateArgs("tossinvest_escalate", { severity: "warn" }), /required/);
  const args = validateArgs("tossinvest_escalate", {
    severity: "warn",
    summary: "test",
    options: [{ id: "o1", label: "Do it" }],
  });
  assert.equal(args.severity, "warn");
});

test("tossinvest tools fail closed without proxy config", async () => {
  const result = await getToolHandler("tossinvest_status", {}, {}, { safeResult: true });
  assert.equal(result.isError, true);
  const text = result.content[0].text;
  assert.ok(text.includes("ADDON_PROXY_UNAVAILABLE"), `expected ADDON_PROXY_UNAVAILABLE in ${text}`);
});

test("tossinvest tool forwards through the proxy", async () => {
  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      status: 200,
      async text() { return JSON.stringify({ ok: true, body: { status: "ok" } }); },
    };
  };
  try {
    const result = await getToolHandler("tossinvest_status", {}, {}, {
      addonProxyUrl: "https://api.minitok.dev",
      installationToken: "tok-1",
    });
    assert.equal(result.isError, undefined);
    const parsed = JSON.parse(result.content[0].text);
    assert.equal(parsed.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api.minitok.dev/v1/addon-proxy/tossinvest");
    const body = JSON.parse(calls[0].options.body);
    assert.equal(body.token, "tok-1");
    assert.equal(body.path, "/api/v1/health");
  } finally {
    global.fetch = originalFetch;
  }
});

test("tossinvest tool surfaces upstream errors", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: false,
    status: 502,
    async text() { return JSON.stringify({ ok: false, code: "ADDON_UNREACHABLE" }); },
  });
  try {
    const result = await getToolHandler("tossinvest_status", {}, {}, {
      addonProxyUrl: "https://api.minitok.dev",
      installationToken: "tok-1",
    });
    assert.equal(result.isError, true);
    const parsed = JSON.parse(result.content[0].text);
    assert.equal(parsed.error.code, "ADDON_UNREACHABLE");
  } finally {
    global.fetch = originalFetch;
  }
});