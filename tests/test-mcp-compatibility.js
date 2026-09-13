"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const path = require("node:path");
const { RuntimeStdio } = require("../src/runtime/test-seam");
const script = path.resolve(__dirname, "../src/runtime/stdio-entry.js");
const authToken = "compat-test-token";
const { getToolDefinitions, requiredScopeFor } = require("../src/mcp/tools");
// The default grant is `read`, and tools/list advertises exactly what the session
// may call, so a compatibility probe expects the read-only subset.
const READ_ONLY_TOOL_COUNT = getToolDefinitions().filter(tool => requiredScopeFor(tool.name) === "read").length;

async function request(runtime, message) {
  const responses = [];
  runtime._respond = value => responses.push(value);
  await runtime._handleLine(JSON.stringify(message));
  return responses[0];
}

function runtime() {
  return new RuntimeStdio({ authToken, entitlementRequired: false });
}

test("MCP compatibility contract", async () => {
  const service = runtime();
  const params = () => ({ authToken });
  const init = await request(service, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "compat" }, ...params() } });
  assert.equal(init.result.protocolVersion, "2024-11-05");
  const tools = await request(service, { jsonrpc: "2.0", id: 2, method: "tools/list", params: params() });
  assert.ok(tools.result.tools.length >= READ_ONLY_TOOL_COUNT);
  assert.equal(tools.result.tools.some(tool => requiredScopeFor(tool.name) === "write"), false, "a read-only grant must not advertise a writing tool");
  const resources = await request(service, { jsonrpc: "2.0", id: 3, method: "resources/list", params: params() });
  assert.ok(resources.result.resources.length >= 2);
  const prompts = await request(service, { jsonrpc: "2.0", id: 4, method: "prompts/list", params: params() });
  assert.ok(prompts.result.prompts.some(prompt => prompt.name === "minitok_task"));
  const error = await request(service, { jsonrpc: "2.0", id: 5, method: "missing/method", params: params() });
  assert.equal(error.error.code, -32601);
});

test("stdio suppresses notification responses and preserves batch parity", async () => {
  const service = runtime();
  const responses = [];
  service._respond = value => responses.push(value);
  await service._handleLine(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: { authToken } }));
  assert.deepEqual(responses, []);
  await service._handleLine(JSON.stringify([
    { jsonrpc: "2.0", id: 1, method: "tools/list", params: { authToken } },
    { jsonrpc: "2.0", method: "notifications/initialized", params: { authToken } },
    { jsonrpc: "2.0", id: 2, method: "prompts/list", params: { authToken } },
  ]));
  assert.deepEqual(responses.map(item => item.id), [1, 2]);
});

test("packaged entrypoint ignores test bypass flags", async () => {
  for (const flag of ["--test-no-auth", "--test-no-entitlement"]) {
    const child = spawn(process.execPath, [script, flag], { stdio: ["pipe", "pipe", "pipe"], env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("MINITOK_MCP_AUTH"))) } });
    let buffer = "";
    const pending = [];
    const waiters = [];
    child.stdout.on("data", chunk => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines.filter(Boolean)) {
        const result = JSON.parse(line);
        const resolve = waiters.shift();
        if (resolve) resolve(result); else pending.push(result);
      }
    });
    const nextResponse = () => pending.length ? Promise.resolve(pending.shift()) : new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout")), 8000);
      waiters.push(value => { clearTimeout(timer); resolve(value); });
    });
    try {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })}\n`);
      const result = await nextResponse();
      assert.equal(result.error.data.type, "AUTH_REQUIRED");
    } finally {
      child.kill();
    }
  }
});
