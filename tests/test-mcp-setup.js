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
        workspaceRoot: root,
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

test("MCP reconnect preserves an explicit workspace root unless changed", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "minitok-mcp-root-"));
  const file = path.join(root, "mcp.json");
  fs.writeFileSync(file, JSON.stringify({ mcpServers: { minitok: { env: { MINITOK_MCP_WORKSPACE_ROOT: path.join(root, "old") } } } }));
  try {
    const preserved = mcp.planChange(file, "connect", { tokenFile: path.join(root, "runtime-token.json") });
    assert.equal(preserved.data.mcpServers.minitok.env.MINITOK_MCP_WORKSPACE_ROOT, path.join(root, "old"));
    const changed = mcp.planChange(file, "connect", { tokenFile: path.join(root, "runtime-token.json"), workspaceRoot: root });
    assert.equal(changed.data.mcpServers.minitok.env.MINITOK_MCP_WORKSPACE_ROOT, path.resolve(root));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("setup requires explicit task scopes and keeps the default read-only", () => {
  const { root, file } = fixture({ mcpServers: {} });
  try {
    const defaultPlan = mcp.planChange(file, "connect", { tokenFile: path.join(root, "runtime-token.json") });
    assert.equal(defaultPlan.data.mcpServers.minitok.env.MINITOK_MCP_SCOPES, undefined);
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
    const first = clineIntegration.installMcpConfig({ packageRoot: root, tokenFile: path.join(root, "token.json"), workspaceRoot: root });
    const value = JSON.parse(fs.readFileSync(config, "utf8"));
    assert.equal(first.changed, true);
    assert.equal(value.mcpServers.other.command, "keep");
    assert.match(value.mcpServers.minitok.args[0], /cline-compat\.js$/);
    assert.equal(value.mcpServers.minitok.env.MINITOK_MCP_WORKSPACE_ROOT, path.resolve(root));
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

test("Cline integration fails closed on malformed server container instead of replacing it", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "minitok-cline-container-"));
  const previous = process.env.CLINE_DATA_DIR;
  process.env.CLINE_DATA_DIR = root;
  try {
    const config = path.join(root, "settings", "cline_mcp_settings.json");
    fs.mkdirSync(path.dirname(config), { recursive: true });
    fs.writeFileSync(config, JSON.stringify({ mcpServers: [] }));
    assert.throws(() => clineIntegration.installMcpConfig({ packageRoot: root, tokenFile: path.join(root, "token.json") }), /malformed/);
    assert.deepEqual(JSON.parse(fs.readFileSync(config, "utf8")), { mcpServers: [] });
  } finally {
    if (previous === undefined) delete process.env.CLINE_DATA_DIR;
    else process.env.CLINE_DATA_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Cline integration fails closed on malformed JSON instead of overwriting it", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "minitok-cline-malformed-"));
  const previous = process.env.CLINE_DATA_DIR;
  process.env.CLINE_DATA_DIR = root;
  try {
    const config = path.join(root, "settings", "cline_mcp_settings.json");
    fs.mkdirSync(path.dirname(config), { recursive: true });
    fs.writeFileSync(config, "{ malformed");
    assert.throws(() => clineIntegration.installMcpConfig({ packageRoot: root, tokenFile: path.join(root, "token.json") }), /malformed/);
    assert.equal(fs.readFileSync(config, "utf8"), "{ malformed");
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

test("MCP host entry contract distinguishes Node stdio from an editor executable", () => {
  const validRoot = fs.mkdtempSync(path.join(os.tmpdir(), "minitok-mcp-entry-valid-"));
  const validFile = path.join(validRoot, "config.json");
  fs.writeFileSync(validFile, JSON.stringify({ mcpServers: { minitok: { command: process.execPath, args: [path.join(validRoot, "src", "runtime", "stdio-entry.js")] } } }));
  const invalidRoot = fs.mkdtempSync(path.join(os.tmpdir(), "minitok-mcp-entry-invalid-"));
  const invalidFile = path.join(invalidRoot, "config.json");
  fs.writeFileSync(invalidFile, JSON.stringify({ mcpServers: { minitok: { command: "Code.exe", args: [path.join(invalidRoot, "stdio-entry.js")] } } }));
  try {
    assert.deepEqual(mcp.configuredEntryContract(validFile), { contract: "valid", contract_reason: null });
    const invalid = mcp.configuredEntryContract(invalidFile);
    assert.equal(invalid.contract, "invalid");
    assert.match(invalid.contract_reason, /must run with Node/);
  } finally {
    fs.rmSync(validRoot, { recursive: true, force: true });
    fs.rmSync(invalidRoot, { recursive: true, force: true });
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

test("entitlement failure surfaces the first-time setup instructions instead of a dead end", () => {
  // The CLI entrypoint prints only the thrown error's message, so the guidance
  // must travel inside the error the entitlement gate raises.
  assert.throws(
    () => mcp.throwEntitlementRequired({ allowed: false, message: "Entitlement denied" }, "https://api.minitok.dev", "An active paid entitlement is required"),
    error => {
      assert.match(error.message, /Entitlement denied/);
      assert.match(error.message, /MCP first-time setup needs an active minitok entitlement\./);
      assert.match(error.message, /https:\/\/minitok\.dev\/signup/);
      assert.match(error.message, /https:\/\/minitok\.dev\/pricing/);
      assert.match(error.message, /minitok mcp setup cline/);
      return true;
    }
  );
});

test("entitlement failure without a server message uses the context message and a non-default server URL", () => {
  assert.throws(
    () => mcp.throwEntitlementRequired({ allowed: false }, "https://staging.example.com", "An active paid entitlement is required"),
    error => {
      assert.match(error.message, /^An active paid entitlement is required/);
      assert.match(error.message, /https:\/\/staging\.example\.com\/signup/);
      assert.match(error.message, /https:\/\/staging\.example\.com\/pricing/);
      return true;
    }
  );
});
