"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const { RemoteMcpClient } = require("../src/mcp/remote");

function response(status, body, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function sandbox() {
  const sessions = new Map();
  const requests = [];
  let sessionNumber = 0;
  let token = "customer-jwt-1";
  let refreshCount = 0;
  let logoutCount = 0;
  let revoked = false;
  async function fetchImpl(url, options = {}) {
    const path = new URL(url).pathname;
    const body = options.body ? JSON.parse(options.body) : {};
    const headers = options.headers || {};
    requests.push({ path, body, headers });
    if (path === "/v1/auth/device/token") return response(200, { customer_id: "00000000-0000-4000-8000-000000000001", access_token: token, refresh_token: "refresh-sandbox-1", token_type: "Bearer", expires_in: 3600 });
    if (path === "/v1/auth/token/refresh") {
      assert.equal(body.refresh_token, "refresh-sandbox-1");
      refreshCount += 1;
      token = "customer-jwt-2";
      return response(200, { customer_id: "00000000-0000-4000-8000-000000000001", access_token: token, refresh_token: "refresh-sandbox-2", token_type: "Bearer", expires_in: 3600 });
    }
    if (path === "/v1/auth/logout") {
      assert.equal(body.refresh_token, "refresh-sandbox-2");
      logoutCount += 1;
      revoked = true;
      return new Response(null, { status: 204 });
    }
    if (path === "/.well-known/oauth-protected-resource/mcp") return response(200, { resource: "https://sandbox.example/mcp", authorization_servers: ["https://sandbox.example"], scopes_supported: ["read"], bearer_methods_supported: ["header"] });
    if (path === "/.well-known/oauth-authorization-server") return response(200, { issuer: "https://sandbox.example", authorization_endpoint: "https://sandbox.example/oauth/authorize", token_endpoint: "https://sandbox.example/oauth/token", response_types_supported: ["code"], grant_types_supported: ["authorization_code"], code_challenge_methods_supported: ["S256"] });
    assert.equal(path, "/mcp");
    if (revoked || headers.Authorization !== `Bearer ${token}`) return response(401, { error: "invalid token" }, { "www-authenticate": 'Bearer realm="minitok-mcp", resource_metadata="https://sandbox.example/.well-known/oauth-protected-resource/mcp"' });
    if (body.method === "initialize") {
      const id = `sandbox-session-${++sessionNumber}`;
      sessions.set(id, token);
      return response(200, { jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: { listChanged: false } } } }, { "Mcp-Session-Id": id });
    }
    const id = headers["Mcp-Session-Id"];
    assert.equal(sessions.get(id), token);
    if (body.method === "tools/list") return response(200, { jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "minitok_status" }, { name: "minitok_compact" }] } }, { "Mcp-Session-Id": id });
    if (body.method === "tools/call" && body.params?.name === "minitok_status") return response(200, { jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: JSON.stringify({ status: "ok" }) }] } }, { "Mcp-Session-Id": id });
    if (body.method === "tools/call" && body.params?.name === "minitok_compact") { const text = body.params.arguments?.text || ""; const budget = body.params.arguments?.budget_chars || 40; return response(200, { jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: text.slice(0, budget) }] } }, { "Mcp-Session-Id": id }); }
    return response(400, { error: "unsupported method" });
  }
  return { fetchImpl, requests, sessions, get refreshCount() { return refreshCount; }, get logoutCount() { return logoutCount; } };
}

test("sandbox client/server MCP flow", async () => {
  const transport = sandbox();
  const originalFetch = global.fetch;
  global.fetch = transport.fetchImpl;
  try {
    const device = await fetch("https://sandbox.example/v1/auth/device/token", { method: "POST", body: "{}" }).then(r => r.json());
    assert.equal(device.refresh_token, "refresh-sandbox-1");
    const client = new RemoteMcpClient({ url: "https://sandbox.example/mcp", token: device.access_token });
    assert.equal((await client.handshake()).protocolVersion, "2024-11-05");
    assert.deepEqual((await client.listTools()).map(tool => tool.name), ["minitok_status", "minitok_compact"]);
    assert.match((await client.callTool("minitok_status")).content[0].text, /"status":"ok"/);
    assert.equal((await client.callTool("minitok_compact", { text: "x".repeat(100), budget_chars: 40 })).content[0].text.length, 40);
    const refreshed = await fetch("https://sandbox.example/v1/auth/token/refresh", { method: "POST", body: JSON.stringify({ refresh_token: device.refresh_token }) }).then(r => r.json());
    assert.equal(refreshed.access_token, "customer-jwt-2");
    assert.equal(transport.refreshCount, 1);
    assert.equal((await fetch("https://sandbox.example/v1/auth/logout", { method: "POST", body: JSON.stringify({ refresh_token: refreshed.refresh_token }) })).status, 204);
    assert.equal(transport.logoutCount, 1);
    assert.ok(transport.requests.some(request => request.headers["Mcp-Session-Id"]));
  } finally { global.fetch = originalFetch; }
});

test("sandbox OAuth metadata contract", async () => {
  const transport = sandbox();
  const originalFetch = global.fetch;
  global.fetch = transport.fetchImpl;
  try {
    const resource = await fetch("https://sandbox.example/.well-known/oauth-protected-resource/mcp").then(r => r.json());
    assert.deepEqual(resource.scopes_supported, ["read"]);
    const authorization = await fetch("https://sandbox.example/.well-known/oauth-authorization-server").then(r => r.json());
    assert.deepEqual(authorization.code_challenge_methods_supported, ["S256"]);
  } finally { global.fetch = originalFetch; }
});
