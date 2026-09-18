"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { setupInstructions, planChange } = require("./mcp");

test("MCP setup instructions point production users to account and pricing", () => {
  const output = setupInstructions("https://api.minitok.dev").join("\n");
  assert.match(output, /https:\/\/minitok\.dev\/signup/);
  assert.match(output, /https:\/\/minitok\.dev\/pricing/);
  assert.match(output, /no free plan or free trial/i);
  assert.doesNotMatch(output, /activation-key/);
});

test("MCP setup instructions preserve custom server URL", () => {
  const output = setupInstructions("https://staging.example.test").join("\n");
  assert.match(output, /https:\/\/staging\.example\.test\/signup/);
  assert.match(output, /https:\/\/staging\.example\.test\/pricing/);
});

test("MCP setup reuses the existing host config shape and defaults to read scope", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "minitok-mcp-setup-"));
  const file = path.join(root, "cline_mcp_settings.json");
  try {
    const plan = planChange(file, "connect", { tokenFile: path.join(root, "runtime-token.json") });
    assert.equal(plan.data.mcpServers.minitok.env.MINITOK_MCP_SCOPES, undefined);
    assert.match(plan.data.mcpServers.minitok.args[0], /stdio-entry\.js$/);
    assert.deepEqual(plan.data.mcpServers.minitok.autoApprove, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
