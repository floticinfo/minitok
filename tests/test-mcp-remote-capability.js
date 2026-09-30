"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { RemoteMcpClient, remoteCapabilityPreflight } = require("../src/mcp/remote");
const { FULL_TEST_CAPABILITIES } = require("../src/entitlement/capability");

test("remote MCP keeps legacy bearer auth when no capability is configured", () => {
  assert.equal(remoteCapabilityPreflight({}).policy_decision, "legacy_auth");
});

test("remote MCP accepts a validated full_test record for read-only tools", () => {
  const record = { token: "server-validated-capability", profile: "full_test", installation_id: "11111111-1111-4111-8111-111111111111", validated_at: new Date().toISOString(), expires_at: new Date(Date.now() + 3600000).toISOString(), capabilities: [...FULL_TEST_CAPABILITIES] };
  const result = remoteCapabilityPreflight({ capabilityRecord: record }, "minitok_status");
  assert.equal(result.policy_decision, "allowed");
  assert.equal(result.token_valid, true);
  assert.deepEqual(result.blocked_external_operations, ["credential_use", "external_call", "publish", "deploy"]);
});

test("remote MCP fails closed for missing or expired capability records", async () => {
  const client = new RemoteMcpClient({ url: "https://service.example/mcp", token: "jwt", capabilityFile: "C:\\missing\\capability-token.json" });
  await assert.rejects(() => client.handshake(), error => error.code === "REMOTE_CAPABILITY_REQUIRED");
});

test("remote MCP never forwards capability token to the remote server", async () => {
  const originalFetch = global.fetch;
  let body = "";
  global.fetch = async (_url, options) => { body += options.body; return new Response(JSON.stringify({ jsonrpc: "2.0", id: JSON.parse(options.body).id, result: { protocolVersion: "2024-11-05", tools: [{ name: "minitok_status" }] } })); };
  const record = { token: "server-validated-capability", profile: "full_test", installation_id: "11111111-1111-4111-8111-111111111111", validated_at: new Date().toISOString(), expires_at: new Date(Date.now() + 3600000).toISOString(), capabilities: [...FULL_TEST_CAPABILITIES] };
  const capabilityToken = crypto.randomBytes(24).toString("hex");
  try { await new RemoteMcpClient({ url: "https://service.example/mcp", token: "jwt", capabilityRecord: record, capabilityToken, validateCapability: async () => ({ valid: true, profile: record.profile, claims: { installation_id: record.installation_id, capabilities: record.capabilities, exp: Math.floor(Date.parse(record.expires_at) / 1000) } }) }).handshake(); } finally { global.fetch = originalFetch; }
  assert.equal(body.includes(capabilityToken), false);
});
