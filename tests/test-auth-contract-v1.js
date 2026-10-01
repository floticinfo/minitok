"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const fixturePath = process.env.AUTH_CONTRACT_V1_FIXTURE_PATH || path.join(__dirname, "fixtures", "auth-contract-v1.fixture.json");
const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));

function decodePayload(token) {
  const parts = token.split(".");
  assert.equal(parts.length, 3);
  return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
}

function tokenFor(claims) {
  const encoded = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `header.${encoded}.signature`;
}

test("AUTH_CONTRACT_V1 fixture classifies customer and installation tokens", () => {
  const customer = decodePayload(tokenFor(fixture.customer_jwt));
  const installation = decodePayload(tokenFor(fixture.installation_jwt));
  assert.equal(customer.aud, "minitok:customer");
  assert.equal(customer.iss, "minitok-server");
  assert.equal(customer.installation_id, undefined);
  assert.equal(customer.token_type, undefined);
  assert.equal(installation.aud, "minitok:installation");
  assert.equal(installation.token_type, "installation");
  assert.equal(installation.installation_id, fixture.installation_jwt.installation_id);
  assert.equal(installation.subscription_id, fixture.installation_jwt.subscription_id);
});

test("AUTH_CONTRACT_V1 fixture preserves plan IDs and permissions", () => {
  assert.deepEqual(Object.keys(fixture.plans), ["level1"]);
  assert.deepEqual(fixture.plans.level1, { max_devices: 1, telemetry: "none", checkout: true });
  assert.deepEqual(fixture.remote_mcp.tools, ["minitok_status", "minitok_compact"]);
  assert.deepEqual(fixture.remote_mcp.scopes, ["read"]);
  assert.equal(fixture.remote_mcp.filesystem, false);
  assert.equal(fixture.remote_mcp.write, false);
  assert.equal(fixture.remote_mcp.run, false);
  assert.equal(fixture.remote_mcp.auto_accept, false);
  assert.equal(fixture.local_mcp.default_scope, "read");
  assert.deepEqual(fixture.local_mcp.explicit_scopes, ["write", "auto_accept"]);
});

test("remote and local MCP implementations match fixture scopes", () => {
  const { REMOTE_READ_ONLY_TOOLS } = require("../src/mcp/remote");
  assert.deepEqual([...REMOTE_READ_ONLY_TOOLS], fixture.remote_mcp.tools);
  const { RuntimeStdio } = require("../src/runtime/stdio");
  const runtime = new RuntimeStdio({ authToken: "runtime-token", workspaceRoot: process.cwd() });
  assert.deepEqual([...runtime._permissions], [fixture.local_mcp.default_scope]);
});

test("provider auth login remains separate from customer authentication", () => {
  const { Command } = require("commander");
  const program = new Command();
  require("../src/cli/commands/auth").register(program);
  const auth = program.commands.find(command => command.name() === "auth");
  const providerLogin = auth.commands.find(command => command.name() === "login");
  const customerLogin = auth.commands.find(command => command.name() === "customer-login");
  assert.match(providerLogin.description(), /LLM provider/);
  assert.ok(customerLogin);
  assert.doesNotMatch(providerLogin.description(), /customer account|billing/);
  assert.match(customerLogin.description(), /customer account|billing/);
});
