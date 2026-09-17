"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { RemoteMcpClient, extractResourceMetadata } = require("./remote");

test("remote MCP extracts resource metadata from common challenge formats", () => {
  const url = "https://service.example/.well-known/oauth-protected-resource/mcp";
  assert.equal(extractResourceMetadata(`Bearer resource_metadata = "${url}"`), url);
  assert.equal(extractResourceMetadata(`Bearer scope="read", resource_metadata='${url}'`), url);
  assert.equal(extractResourceMetadata(`Bearer resource_metadata=${url}, scope="read"`), url);
  assert.equal(extractResourceMetadata(`Bearer realm="service", RESOURCE_METADATA = "${url}"`), url);
  assert.equal(extractResourceMetadata("Bearer realm=\"service\""), null);
});
const { OAuthFlow } = require("../auth/oauth");

test("remote MCP discovers OAuth metadata when bearer is absent", async () => {
  const originalFetch = global.fetch;
  const originalAuthorize = OAuthFlow.prototype.authorize;
  const urls = [];
  global.fetch = async (url, options = {}) => {
    urls.push(String(url));
    if (String(url) === "https://service.example/mcp") return new Response(JSON.stringify({ error: "Missing Authorization header" }), { status: 401, headers: { "content-type": "application/json", "www-authenticate": 'Bearer resource_metadata="https://service.example/.well-known/oauth-protected-resource/mcp"' } });
    if (String(url).includes("oauth-protected-resource")) return new Response(JSON.stringify({ authorization_servers: ["https://service.example/.well-known/oauth-authorization-server"], scopes_supported: ["read"] }), { status: 200, headers: { "content-type": "application/json" } });
    return new Response(JSON.stringify({ authorization_endpoint: "https://service.example/oauth/authorize", token_endpoint: "https://service.example/oauth/token" }), { status: 200, headers: { "content-type": "application/json" } });
  };
  OAuthFlow.prototype.authorize = async () => { throw Object.assign(new Error("browser authorization cancelled"), { code: "OAUTH_CANCELLED" }); };
  try {
    await assert.rejects(() => new RemoteMcpClient({ url: "https://service.example/mcp" }).request("initialize"), error => error.code === "REMOTE_OAUTH_DISCOVERY_FAILED");
    assert.deepEqual(urls, ["https://service.example/mcp", "https://service.example/.well-known/oauth-protected-resource/mcp", "https://service.example/.well-known/oauth-authorization-server"]);
  } finally { global.fetch = originalFetch; OAuthFlow.prototype.authorize = originalAuthorize; }
});
