"use strict";

/**
 * Runtime server regressions:
 *  - session eviction must drop the least recently used session, not the oldest
 *    created one (which could be the session in active use),
 *  - the idle shutdown must be configurable, because the fixed 30 minute default
 *    silently stopped a runtime a client had configured.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { RuntimeServer, IDLE_TIMEOUT_MS } = require("../src/runtime/server");

function buildServer(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "minitok-runtime-"));
  const instance = new RuntimeServer({
    port: 0,
    runtimeDir: root,
    entitlementDir: path.join(root, "entitlement"),
    runStatePath: path.join(root, "mcp-runs.json"),
    ...options,
  });
  instance._services.entitlement = { status: async () => ({ allowed: true, state: "ALLOWED" }) };
  // The session registry is under test, not the protocol: stub the transport.
  instance._createMcpSession = () => ({ _handleLine: async () => {} });
  return { instance, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

/** Drive one POST /mcp request through the real session bookkeeping. */
async function mcpRequest(instance, sessionId) {
  const headers = {};
  const res = {
    headersSent: false,
    setHeader: (key, value) => { headers[key] = value; },
    writeHead: function writeHead() { this.headersSent = true; return this; },
    end: () => {},
  };
  const req = { headers: { authorization: "Bearer runtime-token", ...(sessionId ? { "mcp-session-id": sessionId } : {}) }, socket: {} };
  await instance._handleMcpRequestBody(req, res, { jsonrpc: "2.0", id: 1, method: "initialize", params: { authToken: "runtime-token" } });
  return headers["Mcp-Session-Id"];
}

test("session eviction drops the least recently used session", async () => {
  const { instance, cleanup } = buildServer({ maxMcpSessions: 2 });
  try {
    const first = await mcpRequest(instance);
    const second = await mcpRequest(instance);
    // Use the first session again so it becomes the most recently used.
    await mcpRequest(instance, first);
    const third = await mcpRequest(instance);
    assert.equal(instance._mcpSessions.size, 2);
    assert.equal(instance._mcpSessions.has(first), true, "the recently used session must survive eviction");
    assert.equal(instance._mcpSessions.has(second), false, "the least recently used session must be evicted");
    assert.equal(instance._mcpSessions.has(third), true);
  } finally { cleanup(); }
});

test("a reused session keeps working while the oldest is evicted", async () => {
  const { instance, cleanup } = buildServer({ maxMcpSessions: 1 });
  try {
    const only = await mcpRequest(instance);
    assert.equal(instance._mcpSessions.has(only), true);
    const replacement = await mcpRequest(instance);
    assert.notEqual(replacement, only);
    assert.equal(instance._mcpSessions.has(only), false);
  } finally { cleanup(); }
});

test("the idle shutdown is configurable and defaults to 30 minutes", () => {
  const defaulted = buildServer();
  const disabled = buildServer({ idleTimeoutMs: 0 });
  try {
    assert.equal(defaulted.instance._idleTimeoutMs, IDLE_TIMEOUT_MS);
    assert.equal(disabled.instance._idleTimeoutMs, 0);
    disabled.instance._resetIdleTimer();
    assert.equal(disabled.instance._idleTimer, null, "no idle timer may be armed when the shutdown is disabled");
    defaulted.instance._resetIdleTimer();
    assert.ok(defaulted.instance._idleTimer, "the default configuration still arms the idle timer");
  } finally {
    defaulted.cleanup();
    disabled.cleanup();
  }
});
