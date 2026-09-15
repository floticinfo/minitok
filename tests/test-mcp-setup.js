"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const mcp = require("../src/cli/commands/mcp");

function fixture(initial) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "minitok-mcp-setup-"));
  const file = path.join(root, "config.json");
  fs.writeFileSync(file, `${JSON.stringify(initial, null, 2)}\n`);
  return { root, file };
}

for (const schema of ["mcpServers", "servers"]) {
  test(`setup preserves the ${schema} host schema and unrelated entries`, () => {
    const { root, file } = fixture({
      [schema]: { existing: { command: "existing-server", args: ["--keep"] } },
      userSetting: { keep: true },
    });
    try {
      const plan = mcp.planChange(file, "connect", {
        tokenFile: path.join(root, "runtime-token.json"),
        scopes: "read,write,verify_exec",
      });
      assert.equal(plan.schema, schema);
      assert.equal(plan.data.userSetting.keep, true);
      assert.deepEqual(plan.data[schema].existing, { command: "existing-server", args: ["--keep"] });
      assert.equal(plan.data[schema].minitok.disabled, false);
      assert.deepEqual(plan.data[schema].minitok.autoApprove, []);
      assert.equal(plan.data[schema].minitok.env.MINITOK_MCP_SCOPES, "read,write,verify_exec");
      assert.equal(path.isAbsolute(plan.data[schema].minitok.args[0]), true);
      assert.match(plan.data[schema].minitok.args[0], /src[\\/]runtime[\\/]stdio-entry\.js$/);
      assert.equal(plan.data[schema].minitok.command, process.execPath);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

test("setup defaults to the task-capable scopes while leaving auto_accept disabled", () => {
  const { root, file } = fixture({ mcpServers: {} });
  try {
    const plan = mcp.planChange(file, "connect", {
      tokenFile: path.join(root, "runtime-token.json"),
      scopes: "read,write,verify_exec",
    });
    const entry = plan.data.mcpServers.minitok;
    assert.equal(entry.env.MINITOK_MCP_SCOPES, "read,write,verify_exec");
    assert.deepEqual(entry.autoApprove, []);
    assert.equal(entry.env.MINITOK_MCP_AUTH_TOKEN_FILE.endsWith("runtime-token.json"), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("invalid setup scopes fail before a configuration write", () => {
  const { root, file } = fixture({ mcpServers: { existing: { command: "keep" } } });
  try {
    assert.throws(() => require("../src/runtime/stdio").parseLocalMcpScopes("read,invalid"), /Unknown local MCP scope/);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { mcpServers: { existing: { command: "keep" } } });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
