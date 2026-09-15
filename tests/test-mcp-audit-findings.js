"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { RuntimeStdio } = require("../src/runtime/test-seam");
const { requireApprovalPath, getToolHandler, getToolDefinitions, requiredScopeFor } = require("../src/mcp/tools");
const { writeConfig, planChange, configuredScopes } = require("../src/cli/commands/mcp");

test("stdio auth accepts bearer and rotated tokens with expiry and revoke", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "minitok-mcp-"));
  try {
    const runtime = new RuntimeStdio({ workspaceRoot: root, authToken: "one", nextAuthToken: "two", nextAuthExpiresAt: Date.now() + 10000, runStatePath: path.join(root, "runs.json") });
    assert.equal(runtime._authValid("one"), true);
    assert.equal(runtime._authValid("two"), true);
    runtime.revokeAuthToken("one");
    assert.equal(runtime._authValid("one"), false);
    assert.equal(runtime._authValue({ authorization: "Bearer two" }), "two");
    runtime.rotateAuthToken("three", Date.now() - 1);
    assert.equal(runtime._authValid("three"), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("approval paths are canonical and constrained", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "minitok-mcp-"));
  try {
    fs.mkdirSync(path.join(root, ".minitok"));
    assert.equal(requireApprovalPath(path.join(root, ".minitok", "approval.json"), root), path.join(root, ".minitok", "approval.json"));
    assert.throws(() => requireApprovalPath(path.join(root, "approval.json"), root), /under workspace/);
    assert.throws(() => requireApprovalPath(path.join(root, ".minitok", "..", "approval.json"), root), /under workspace/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("tool results expose stable structured success and error contracts", async () => {
  const services = { compact: { compact: text => ({ text }) } };
  const success = await getToolHandler("minitok_compact_context", { text: "ok" }, services, { safeResult: true });
  assert.equal(success.isError, false);
  assert.deepEqual(success.structuredContent, { text: "ok" });
  const failure = await getToolHandler("missing", {}, services, { safeResult: true });
  assert.equal(failure.isError, true);
  assert.equal(failure.structuredContent.error.code, "TOOL_NOT_FOUND");
});

test("MCP config writes remove stale locks and leave owner-only config", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "minitok-mcp-config-"));
  try {
    const file = path.join(root, "mcp.json");
    fs.writeFileSync(`${file}.lock`, "stale");
    fs.utimesSync(`${file}.lock`, new Date(Date.now() - 60000), new Date(Date.now() - 60000));
    writeConfig(file, { mcpServers: { minitok: { command: "minitok" } } });
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).mcpServers.minitok, { command: "minitok" });
    assert.equal(fs.existsSync(`${file}.lock`), false);
    if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("MCP host scope diagnostics report valid and invalid grants", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "minitok-mcp-scopes-"));
  try {
    const file = path.join(root, "mcp.json");
    fs.writeFileSync(file, JSON.stringify({ mcpServers: { minitok: { env: { MINITOK_MCP_SCOPES: "read,write,unknown" } } } }));
    assert.deepEqual(configuredScopes(file), { scopes: ["read", "write", "unknown"], scopes_explicit: true, scopes_source: "explicit", invalid_scopes: ["unknown"] });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("MCP reconnect preserves existing scopes when --scopes is omitted", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "minitok-mcp-reconnect-"));
  try {
    const file = path.join(root, "mcp.json");
    fs.writeFileSync(file, JSON.stringify({ mcpServers: { minitok: { env: { MINITOK_MCP_SCOPES: "read,write,verify_exec" } } } }));
    const plan = planChange(file, "connect", { tokenFile: path.join(root, "token.json") });
    assert.equal(plan.data.mcpServers.minitok.env.MINITOK_MCP_SCOPES, "read,write,verify_exec");
    const explicit = planChange(file, "connect", { tokenFile: path.join(root, "token.json"), scopes: "read" });
    assert.equal(explicit.data.mcpServers.minitok.env.MINITOK_MCP_SCOPES, "read");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("MCP host configs launch the authenticated stdio entrypoint without a raw token", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "minitok-mcp-config-"));
  try {
    const plan = planChange(path.join(root, "mcp.json"), "connect");
    const server = plan.data.mcpServers.minitok;
    assert.equal(server.command, process.execPath);
    assert.deepEqual(server.args, [path.resolve(__dirname, "../src/runtime/stdio-entry.js")]);
    assert.equal(server.env.MINITOK_MCP_AUTH_TOKEN_FILE, path.join(os.homedir(), ".minitok", "mcp", "runtime-token.json"));
    assert.deepEqual(server.autoApprove, [], "generated MCP entries must not auto-approve tools by default");
    assert.equal(Object.values(server.env).some(value => value.includes("compat-test-token")), false);
    assert.equal(JSON.stringify(server).includes("token"), true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("stdio authenticates a session from the installation token file", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "minitok-mcp-auth-"));
  const tokenFile = path.join(root, "installation-token.json");
  fs.writeFileSync(tokenFile, JSON.stringify({ token: "fixture-auth-token" }));
  const runtime = new RuntimeStdio({ authTokenFile: tokenFile, runStatePath: path.join(root, "runs.json"), services: { entitlement: { status: async () => ({ allowed: true, state: "ALLOWED", entitlement: { plan_id: "open" } }) } } });
  try {
    const request = async message => {
      const response = new Promise(resolve => { runtime._respond = resolve; });
      await runtime._handleLine(JSON.stringify(message));
      return response;
    };
    const init = await request({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } });
    const tools = await request({ jsonrpc: "2.0", id: 2, method: "tools/list", params: { authToken: "fixture-auth-token" } });
    assert.equal(init.result.protocolVersion, "2024-11-05");
    assert.equal(tools.result.tools.length, getToolDefinitions().filter(tool => requiredScopeFor(tool.name) === "read").length, "an unconfigured grant is read-only, and tools/list must say so");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("minitok_run keeps pipeline logs off stdout", async () => {
  const originalWrite = process.stdout.write;
  let output = "";
  process.stdout.write = (chunk, ...args) => { output += String(chunk); return true; };
  try {
    const { getToolHandler } = require("../src/mcp/tools");
    const result = await getToolHandler("minitok_run", { task: "test", repo: process.cwd() }, {}, {
      runPipeline: async () => { console.log("pipeline log"); console.warn("pipeline warning"); return { success: true }; },
      workspaceRoot: process.cwd(),
      permissions: new Set(["write"]),
      safeResult: true,
    });
    assert.equal(output, "");
    assert.equal(JSON.parse(result.content[0].text).state, "completed");
  } finally { process.stdout.write = originalWrite; }
});

test("MCP run-state write failures are returned as persistence diagnostics", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "minitok-mcp-persist-"));
  try {
    const state = path.join(root, "runs.json");
    const failingFs = { ...fs, writeFileSync: () => { throw Object.assign(new Error("disk full"), { code: "ENOSPC" }); } };
    const runtime = new RuntimeStdio({ workspaceRoot: root, runStatePath: state, fs: failingFs });
    runtime._runs.set("run-id", { runId: "run-id", requestId: 1, state: "completed", result: { success: true }, controller: new AbortController() });
    const result = runtime._saveRunState();
    assert.equal(result.persisted, false);
    assert.match(result.error, /disk full/);
    const listed = JSON.parse((await getToolHandler("minitok_run_list", {}, {}, { safeResult: false, runs: runtime._runs, persistence: result })).content[0].text);
    assert.equal(listed[0].persistence.persisted, false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("corrupted MCP run state is diagnosed and fails closed", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "minitok-mcp-corrupt-"));
  try {
    const state = path.join(root, "runs.json");
    fs.writeFileSync(state, "not-json");
    const runtime = new RuntimeStdio({ workspaceRoot: root, runStatePath: state });
    assert.deepEqual(runtime._recoveredRuns, []);
    assert.equal(runtime._persistence.persisted, false);
    assert.match(runtime._persistence.error, /Unexpected token|JSON/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("restart recovery reconciles running records to unknown interrupted state", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "minitok-mcp-recovery-"));
  try {
    const state = path.join(root, "runs.json");
    fs.writeFileSync(state, JSON.stringify([{ run_id: "run-id", request_id: 1, state: "running" }, { run_id: "done", state: "completed" }]));
    const runtime = new RuntimeStdio({ workspaceRoot: root, runStatePath: state });
    assert.deepEqual(runtime._recoveredRuns[0], { run_id: "run-id", request_id: 1, state: "unknown", recovery: "interrupted" });
    assert.equal(runtime._recoveredRuns[1].state, "completed");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("terminal MCP run states persist with status", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "minitok-mcp-terminal-"));
  try {
    const state = path.join(root, "runs.json");
    const runtime = new RuntimeStdio({ workspaceRoot: root, runStatePath: state });
    for (const status of ["completed", "failed", "cancelled"]) {
      runtime._runs.set(status, { runId: status, requestId: status, state: status, result: { status }, controller: new AbortController() });
    }
    assert.equal(runtime._saveRunState().persisted, true);
    const recovered = new RuntimeStdio({ workspaceRoot: root, runStatePath: state });
    assert.deepEqual(recovered._recoveredRuns.map(run => run.state), ["completed", "failed", "cancelled"]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("runtime maps request ids to durable run ids", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "minitok-mcp-"));
  try {
    const runtime = new RuntimeStdio({ workspaceRoot: root, runStatePath: path.join(root, "runs.json") });
    runtime._runs.set("run-id", { runId: "run-id", requestId: 42, state: "running", controller: new AbortController() });
    runtime._requestToRun.set(42, "run-id");
    runtime._saveRunState();
    const recovered = new RuntimeStdio({ workspaceRoot: root, runStatePath: path.join(root, "runs.json") });
    assert.equal(recovered._recoveredRuns[0].run_id, "run-id");
    assert.equal(recovered._recoveredRuns[0].request_id, 42);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
