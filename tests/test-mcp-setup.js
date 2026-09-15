"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const mcp = require("../src/cli/commands/mcp");
const clineIntegration = require("../src/mcp/cline-integration");

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
        host: "cline",
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
      assert.match(plan.data[schema].minitok.args[0], /src[\\/]mcp[\\/]cline-compat\.js$/);
      const targetArgs = JSON.parse(plan.data[schema].minitok.env.MINITOK_MCP_TARGET_ARGS);
      assert.equal(targetArgs.length, 1);
      assert.match(targetArgs[0], /src[\\/]runtime[\\/]stdio-entry\.js$/);
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

test("setup exposes an only-unconfigured option and onboarding helpers", async () => {
  assert.equal(typeof mcp.runMcpOnboarding, "function");
  assert.equal(typeof mcp.unconfiguredHosts, "function");
  const result = await mcp.runMcpOnboarding({ input: { isTTY: false }, output: { write() {} } });
  assert.equal(result.status, "skipped");
  const cli = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "src", "cli", "commands", "mcp.js"), "utf8");
  assert.match(cli, /--only-unconfigured/);
});

test("Cline integration writes a bridge entry, preserves existing settings, and is idempotent", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "minitok-cline-integration-"));
  const previous = process.env.CLINE_DATA_DIR;
  process.env.CLINE_DATA_DIR = root;
  try {
    const config = path.join(root, "settings", "cline_mcp_settings.json");
    fs.mkdirSync(path.dirname(config), { recursive: true });
    fs.writeFileSync(config, JSON.stringify({ mcpServers: { other: { command: "keep" } } }));
    const first = clineIntegration.installMcpConfig({ packageRoot: root, tokenFile: path.join(root, "token.json") });
    const value = JSON.parse(fs.readFileSync(config, "utf8"));
    assert.equal(first.changed, true);
    assert.equal(value.mcpServers.other.command, "keep");
    assert.match(value.mcpServers.minitok.args[0], /cline-compat\.js$/);
    assert.equal(value.mcpServers.minitok.autoApprove.length, 0);
    assert.equal(fs.existsSync(`${config}.bak`), true);
    const second = clineIntegration.installMcpConfig({ packageRoot: root, tokenFile: path.join(root, "token.json") });
    assert.equal(second.changed, false);
  } finally {
    if (previous === undefined) delete process.env.CLINE_DATA_DIR;
    else process.env.CLINE_DATA_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Cline rule and skill guidance is marker-idempotent", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "minitok-cline-guidance-"));
  const previousHome = process.env.USERPROFILE;
  const previousData = process.env.CLINE_DATA_DIR;
  process.env.USERPROFILE = root;
  process.env.CLINE_DATA_DIR = path.join(root, ".cline", "data");
  try {
    const first = clineIntegration.installRuleAndSkill();
    const second = clineIntegration.installRuleAndSkill();
    assert.equal(first.rule, true);
    assert.equal(first.skill, true);
    assert.equal(second.rule, false);
    assert.equal(second.skill, false);
    assert.match(fs.readFileSync(first.rulePath, "utf8"), /minitok_run/);
    assert.match(fs.readFileSync(first.skillPath, "utf8"), /name: minitok/);
  } finally {
    if (previousHome === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousHome;
    if (previousData === undefined) delete process.env.CLINE_DATA_DIR;
    else process.env.CLINE_DATA_DIR = previousData;
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
