"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { RuntimeStdio, RuntimeServer } = require("../src/runtime/test-seam");
const { importCapabilityToken, readCapabilityRecord, clearCapabilityRecord, FULL_TEST_CAPABILITIES } = require("../src/entitlement/capability");
const { RemoteMcpClient } = require("../src/mcp/remote");

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "minitok-capability-e2e-"));
  const file = path.join(root, "capability-token.json");
  const record = { token: crypto.randomBytes(24).toString("hex"), installation_id: "11111111-1111-4111-8111-111111111111", profile: "full_test", capabilities: [...FULL_TEST_CAPABILITIES], validated_at: new Date().toISOString(), expires_at: new Date(Date.now() + 3600000).toISOString(), server_url: "https://test.invalid" };
  return { root, file, record };
}

async function requestRuntime(runtime, message) {
  const responses = [];
  runtime._respond = value => responses.push(value);
  await runtime._handleLine(JSON.stringify(message));
  return responses[0];
}

test("disposable capability E2E covers import, status, Local MCP, and cleanup", async () => {
  const f = fixture();
  try {
    const imported = await importCapabilityToken(f.record.token, { filePath: f.file, serverUrl: "https://test.invalid", validate: async () => ({ ok: true, body: { valid: true, profile: f.record.profile, claims: { installation_id: f.record.installation_id, capabilities: f.record.capabilities, iat: Date.now() / 1000 - 10, exp: Date.now() / 1000 + 3600 } } }) });
    assert.equal(imported.success, true);
    assert.equal(readCapabilityRecord({ filePath: f.file }).profile, "full_test");

    const runtime = new RuntimeStdio({ authToken: "runtime-test-token", capabilityFile: f.file, entitlementRequired: false });
    const initialize = await requestRuntime(runtime, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } });
    assert.equal(initialize.result.protocolVersion, "2024-11-05");
    const tools = await requestRuntime(runtime, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    assert.ok(Array.isArray(tools.result.tools));
    assert.equal(JSON.stringify(tools).includes(f.record.token), false);

    clearCapabilityRecord(f.file);
    assert.equal(fs.existsSync(f.file), false);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("disposable Local HTTP MCP and Remote MCP fail closed after capability cleanup", async () => {
  const f = fixture();
  const runtimeFiles = { pidFile: path.join(f.root, "runtime.pid"), tokenFile: path.join(f.root, "runtime.token"), lockFile: path.join(f.root, "runtime.lock") };
  fs.writeFileSync(f.file, JSON.stringify(f.record));
  const server = new RuntimeServer({ ...runtimeFiles, port: 0, runtimeToken: "http-test-token", capabilityFile: f.file, entitlementRequired: false });
  await server.start();
  try {
    assert.ok(server._mcp._capabilityProfile === "full_test");
    fs.writeFileSync(f.file, JSON.stringify({ ...f.record, expires_at: new Date(Date.now() - 1).toISOString() }));
    const remote = new RemoteMcpClient({ url: "https://service.example/mcp", token: "customer-token", capabilityFile: f.file });
    await assert.rejects(() => remote.handshake(), error => error.code === "REMOTE_CAPABILITY_REQUIRED");
  } finally { await server.stop(); fs.rmSync(f.root, { recursive: true, force: true }); }
});
