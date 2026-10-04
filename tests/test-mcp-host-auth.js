"use strict";

/**
 * Regression coverage for two MCP transport defects that every existing test
 * happened to hide.
 *
 * 1. Authentication. Every other MCP test sends `params.authToken` on every
 *    request, so nothing noticed that a standard host — VS Code, Claude Desktop,
 *    Cursor — only passes env and args (it has no way to echo a token per call).
 *    Those hosts completed `initialize` and then got AUTH_REQUIRED on every
 *    `tools/list` / `tools/call`. The probe below spawns the real stdio entry
 *    point with the credential in the environment only, exactly like a host.
 *
 * 2. Run state. A pipeline that fails inside `safeResult` returns
 *    `isError: true` instead of throwing, and the transport recorded the run as
 *    "completed" anyway — in `minitok_run_get`, in `minitok_run_list` and in the
 *    persisted run file that survives a restart.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { RuntimeStdio } = require("../src/runtime/stdio");
const { createRuntimeServices } = require("../src/runtime");
const { parseLocalMcpScopes, LOCAL_MCP_SCOPES } = require("../src/runtime/stdio");

const TOKEN = "env-only-host-token";
const entry = path.resolve(__dirname, "../src/runtime/stdio-entry.js");

test("unrestricted MCP scope is explicit and remains separate from autonomous auto_accept", () => {
  assert.equal(LOCAL_MCP_SCOPES.has("unrestricted_autonomous"), true);
  assert.deepEqual(parseLocalMcpScopes("read,write,unrestricted_autonomous"), ["read", "write", "unrestricted_autonomous"]);
  assert.throws(() => parseLocalMcpScopes("read,unrestricted"), error => error.code === "INVALID_SCOPE");
});

/** Environment for a host that can only pass the credential through env. */
function hostEnvironment(token) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("MINITOK_MCP_") || key === "MINITOK_ENTITLEMENT") delete env[key];
  env.MINITOK_MCP_AUTH_TOKEN = token;
  env.MINITOK_MCP_SCOPES = "read";
  return env;
}

/**
 * Spawn the packaged stdio entry point the way a host would. Phase 4: the
 * entitlement credential rides in the spawn environment (MINITOK_ENTITLEMENT),
 * mirroring the auth token — a stdio host has no headers and no params.
 */
function spawnHost(entitlement) {
  const env = hostEnvironment(TOKEN);
  if (entitlement !== undefined) env.MINITOK_ENTITLEMENT = entitlement;
  const child = spawn(process.execPath, [entry], { stdio: ["pipe", "pipe", "pipe"], env });
  let buffer = "";
  const pending = [];
  const waiters = [];
  child.stdout.on("data", chunk => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines.filter(Boolean)) {
      let value;
      try { value = JSON.parse(line); } catch { continue; }
      const resolve = waiters.shift();
      if (resolve) resolve(value); else pending.push(value);
    }
  });
  const next = () => pending.length ? Promise.resolve(pending.shift()) : new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for an MCP response")), 20000);
    waiters.push(value => { clearTimeout(timer); resolve(value); });
  });
  return {
    request: async (id, method, params = {}) => {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      return next();
    },
    stop: () => { try { child.kill(); } catch {} },
  };
}

function runtimeFixture(runPipeline, options = {}) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "minitok-mcp-envhost-")));
  const runtimeDir = path.join(root, "runtime-state");
  const services = createRuntimeServices({ runtimeDir });
  // Stub only the paid-entitlement lookup; the auth and scope gates stay real.
  services.entitlement = { status: async () => ({ allowed: true, state: "ALLOWED", plan: "pro" }) };
  const runtime = new RuntimeStdio({
    authToken: TOKEN,
    workspaceRoot: root,
    runStatePath: path.join(runtimeDir, "mcp-runs.json"),
    permissions: ["read", "write", "verify_exec"],
    services,
    runPipeline,
    // Overrides let the token-file lifecycle below build the same session without
    // the static startup token.
    ...options,
  });
  const replies = [];
  runtime._respond = message => replies.push(message);
  const send = async message => {
    await runtime._handleMessage(message, value => replies.push(value));
    return replies.find(reply => reply && reply.id === message.id);
  };
  return {
    root,
    runtime,
    send,
    payload: reply => JSON.parse(reply.result.content[0].text),
    initialize: () => send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "env-only-host" } } }),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

test("an env-only MCP host can call tools without echoing the token in params", async () => {
  // Phase 4: the env credential must satisfy the handshake entitlement check,
  // exactly like MINITOK_MCP_AUTH_TOKEN satisfies the auth check.
  const host = spawnHost("entitlement-token-for-this-installation");
  try {
    const init = await host.request(1, "initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "env-only-host" } });
    assert.equal(init.error, undefined, `initialize must succeed: ${JSON.stringify(init.error)}`);
    assert.equal(init.result.protocolVersion, "2024-11-05");

    const tools = await host.request(2, "tools/list", {});
    assert.notEqual(tools.error?.data?.type, "AUTH_REQUIRED", "the startup credential must authorize a request that carries no token: a standard host has no way to add one");
    // The packaged entry point also enforces the paid entitlement. A machine
    // without one must still get past authentication, which is what this asserts.
    if (tools.error) assert.equal(tools.error.data.type, "ENTITLEMENT_REQUIRED", `unexpected error: ${JSON.stringify(tools.error)}`);
    else {
      // MINITOK_MCP_SCOPES is "read" in this environment, so the advertised tools
      // are the read-only ones: a client must not be taught to call a tool whose
      // only possible answer is PERMISSION_DENIED.
      const names = tools.result.tools.map(tool => tool.name);
      assert.equal(names.includes("minitok_run"), false, "a read-only host must not be offered minitok_run");
      assert.equal(names.includes("minitok_run_list"), true, "a read-only host must keep the read-only tools");
    }

    // A wrong explicit token must still be rejected: the fallback must not
    // weaken per-request validation.
    const rejected = await host.request(3, "tools/list", { authToken: "not-the-configured-token" });
    assert.equal(rejected.error?.data?.type, "AUTH_REQUIRED");
  } finally { host.stop(); }
});

test("an in-process stdio session authenticates from its startup credential", async () => {
  const box = runtimeFixture(async () => ({ success: true }));
  try {
    const init = await box.initialize();
    assert.equal(init.result.protocolVersion, "2024-11-05");
    const tools = await box.send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    assert.equal(tools.error, undefined, `tools/list must not require a params token: ${JSON.stringify(tools.error)}`);
    assert.equal(tools.result.tools.length >= 14, true);
  } finally { box.cleanup(); }
});

test("a failed run is recorded as failed, not completed", async () => {
  const box = runtimeFixture(async () => { throw new Error("pipeline exploded"); });
  try {
    await box.initialize();
    const started = await box.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "minitok_run", arguments: { task: "failing task", repo: box.root } } });
    const startedPayload = box.payload(started);
    assert.equal(started.result.isAsync, true);
    assert.equal(startedPayload.state, "running");
    await box.runtime._runs.get(startedPayload.run_id).promise.catch(() => {});

    const listed = await box.send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "minitok_run_list", arguments: {} } });
    const runs = box.payload(listed);
    assert.equal(runs.length, 1);
    const runId = runs[0].run_id;
    assert.equal(runs[0].state, "failed", "run_list must report the failure");

    const got = await box.send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "minitok_run_get", arguments: { run_id: runId } } });
    assert.equal(box.payload(got).state, "failed", "run_get must report the failure");

    const persisted = JSON.parse(fs.readFileSync(path.join(box.root, "runtime-state", "mcp-runs.json"), "utf8"));
    assert.equal(persisted.records.find(record => record.run_id === runId).state, "failed", "the persisted record must not claim success either");
  } finally { box.cleanup(); }
});

test("a successful run is still recorded as completed", async () => {
  const box = runtimeFixture(async () => ({ success: true, cycles: [] }));
  try {
    await box.initialize();
    const started = await box.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "minitok_run", arguments: { task: "working task", repo: box.root } } });
    const startedPayload = box.payload(started);
    assert.equal(started.result.isAsync, true);
    assert.equal(startedPayload.state, "running");
    await box.runtime._runs.get(startedPayload.run_id).promise;
    const listed = await box.send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "minitok_run_list", arguments: {} } });
    assert.equal(box.payload(listed)[0].state, "completed");
  } finally { box.cleanup(); }
});

test("a pipeline outcome of success:false is recorded and reported as failed", async () => {
  // The throwing pipeline above is converted into `isError` by safeResult. A run
  // that returns normally with `success: false` (change rejected, verification
  // failed, cancelled) is a different path: the envelope said "failed" while the
  // transport recorded "completed", so run_get / run_list and the persisted file
  // all claimed success for a failed run.
  const box = runtimeFixture(async () => ({ success: false, cycles: [{ status: "rejected_by_user" }] }));
  try {
    await box.initialize();
    const started = await box.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "minitok_run", arguments: { task: "rejected task", repo: box.root } } });
    const startedPayload = box.payload(started);
    assert.equal(started.result.isAsync, true);
    assert.equal(startedPayload.state, "running");
    await box.runtime._runs.get(startedPayload.run_id).promise;

    const listed = await box.send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "minitok_run_list", arguments: {} } });
    const runs = box.payload(listed);
    assert.equal(runs.length, 1);
    const runId = runs[0].run_id;
    assert.equal(runs[0].state, "failed", "run_list must report the failure");

    const got = await box.send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "minitok_run_get", arguments: { run_id: runId } } });
    assert.equal(box.payload(got).state, "failed", "run_get must report the failure");

    const persisted = JSON.parse(fs.readFileSync(path.join(box.root, "runtime-state", "mcp-runs.json"), "utf8"));
    assert.equal(persisted.records.find(record => record.run_id === runId).state, "failed", "the persisted record must not claim success either");
  } finally { box.cleanup(); }
});

/** A runtime-token fixture: the record a host configuration launches against. */
function runtimeTokenDir() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "minitok-mcp-token-")));
  fs.mkdirSync(path.join(root, "entitlement"), { recursive: true });
  fs.mkdirSync(path.join(root, "mcp"), { recursive: true });
  fs.writeFileSync(path.join(root, "entitlement", "installation-token.json"), JSON.stringify({ token: "installation-token", installation_id: "installation-1" }));
  return { root, filePath: path.join(root, "mcp", "runtime-token.json"), runStatePath: path.join(root, "runtime-state", "mcp-runs.json") };
}

function writeTokenRecord(filePath, record) {
  fs.writeFileSync(filePath, JSON.stringify({
    token: "token-one",
    installation_id: "installation-1",
    session_id: "session-1",
    issued_at: Date.now(),
    expires_at: Date.now() + 60000,
    ...record,
  }, null, 2));
}

test("the token file's expiry, rotation and revocation govern a live session", async () => {
  // A host passes MINITOK_MCP_AUTH_TOKEN_FILE and nothing else, and the transport
  // read that file once, at startup: the 15-minute TTL never applied and
  // `minitok mcp disconnect` (which revokes the record) ended nothing until the
  // editor was restarted.
  const fixture = runtimeTokenDir();
  writeTokenRecord(fixture.filePath, {});
  const services = createRuntimeServices({ runtimeDir: path.join(fixture.root, "runtime-state") });
  services.entitlement = { status: async () => ({ allowed: true, state: "ALLOWED", plan: "pro" }) };
  const runtime = new RuntimeStdio({
    authTokenFile: fixture.filePath,
    authTokenFileRefreshMs: 0,
    workspaceRoot: fixture.root,
    runStatePath: fixture.runStatePath,
    permissions: ["read"],
    services,
  });
  const replies = [];
  runtime._respond = message => replies.push(message);
  const send = async message => {
    replies.length = 0;
    await runtime._handleMessage(message, value => replies.push(value));
    return replies.find(reply => reply && reply.id === message.id);
  };
  try {
    const init = await send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", clientInfo: { name: "token-probe" } } });
    assert.equal(init.result.protocolVersion, "2024-11-05", `the launch credential must authenticate: ${JSON.stringify(init.error)}`);

    // The advertised surface follows the read-only grant: minitok_run needs
    // `write` and `verify_exec`, so a client is not taught to call a tool whose
    // only possible answer is PERMISSION_DENIED.
    const granted = await send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const names = granted.result.tools.map(tool => tool.name);
    assert.equal(names.includes("minitok_run"), false, "a read-only session must not advertise minitok_run");
    assert.equal(names.includes("minitok_run_list"), true, "a read-only session must keep its read-only tools");

    writeTokenRecord(fixture.filePath, { expires_at: Date.now() - 1000 });
    assert.equal((await send({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} })).error.data.type, "AUTH_REQUIRED", "an expired record must end the session");

    // `minitok mcp token` rotates the record; a running host picks it up without a
    // restart, which is what the rotation command promises.
    writeTokenRecord(fixture.filePath, { token: "token-two" });
    const rotated = await send({ jsonrpc: "2.0", id: 4, method: "tools/list", params: {} });
    assert.equal(rotated.error, undefined, `a rotated record must be picked up: ${JSON.stringify(rotated.error)}`);

    // `minitok mcp disconnect` revokes it; the session must fail closed.
    writeTokenRecord(fixture.filePath, { token: "token-two", revoked_at: Date.now() });
    assert.equal((await send({ jsonrpc: "2.0", id: 5, method: "tools/list", params: {} })).error.data.type, "AUTH_REQUIRED", "a revoked record must end the session");
    assert.equal((await send({ jsonrpc: "2.0", id: 6, method: "tools/list", params: { authToken: "token-two" } })).error.data.type, "AUTH_REQUIRED", "an explicit copy of a revoked token must be refused too");
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

/** A runtime wired to the rotating token file, the way a host launches it. */
function tokenRuntime(fixture) {
  const services = createRuntimeServices({ runtimeDir: path.join(fixture.root, "runtime-state") });
  services.entitlement = { status: async () => ({ allowed: true, state: "ALLOWED", plan: "pro" }) };
  const runtime = new RuntimeStdio({
    authTokenFile: fixture.filePath,
    authTokenFileRefreshMs: 0,
    workspaceRoot: fixture.root,
    runStatePath: fixture.runStatePath,
    permissions: ["read"],
    services,
  });
  const replies = [];
  runtime._respond = message => replies.push(message);
  const send = async message => {
    replies.length = 0;
    await runtime._handleMessage(message, value => replies.push(value));
    return replies.find(reply => reply && reply.id === message.id);
  };
  return { runtime, send };
}

test("an AUTH_REQUIRED failure self-recovers when the token file is renewed", async () => {
  // The 15-minute record expired while the host kept the session open. Renewing
  // it (`minitok mcp token`) must let the very next call succeed without a host
  // restart — before this, the session token was dead and the transport never
  // re-anchored it, so every call kept failing with AUTH_REQUIRED.
  const fixture = runtimeTokenDir();
  writeTokenRecord(fixture.filePath, {});
  const { send } = tokenRuntime(fixture);
  try {
    const init = await send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", clientInfo: { name: "recover-probe" } } });
    assert.equal(init.result.protocolVersion, "2024-11-05", `the launch credential must authenticate: ${JSON.stringify(init.error)}`);

    writeTokenRecord(fixture.filePath, { expires_at: Date.now() - 1000 });
    const expired = await send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    assert.equal(expired.error.data.type, "AUTH_REQUIRED", "an expired record must fail the call");
    assert.match(expired.error.data.recovery.action, /minitok mcp token/, "the failure must name the rotation command");

    writeTokenRecord(fixture.filePath, { token: "token-renewed" });
    const recovered = await send({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} });
    assert.equal(recovered.error, undefined, `the renewed record must be adopted without a restart: ${JSON.stringify(recovered.error)}`);
    assert.ok(Array.isArray(recovered.result.tools), "the recovered session must answer tools/list");
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("an unrecoverable AUTH_REQUIRED names the reconnect command", async () => {
  // The record is gone and nothing can be re-read: the error must tell the user
  // how to recover instead of the bare "Authentication required".
  const fixture = runtimeTokenDir();
  fs.rmSync(fixture.filePath, { force: true });
  const { send } = tokenRuntime(fixture);
  try {
    const denied = await send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    assert.equal(denied.error.data.type, "AUTH_REQUIRED");
    assert.match(denied.error.message, /Run: minitok mcp connect <host>/, "a missing setup must name the reconnect command");
    assert.equal(denied.error.data.recovery.action, "Run: minitok mcp connect <host>");
    assert.match(denied.error.data.recovery.reason, /not readable|not found/, "the failure must explain what is wrong");
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("an explicit session token is not re-anchored by a file rotation", async () => {
  // A host that echoes the launch credential on every request opted out of the
  // transport-following behaviour: when the record rotates, only a session that
  // never supplied its own token is re-anchored on the new record.
  const fixture = runtimeTokenDir();
  writeTokenRecord(fixture.filePath, {});
  const { send } = tokenRuntime(fixture);
  try {
    const init = await send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", clientInfo: { name: "explicit-probe" }, authToken: "token-one" } });
    assert.equal(init.error, undefined, `the launch credential echoed by the client must authenticate initialize: ${JSON.stringify(init.error)}`);
    writeTokenRecord(fixture.filePath, { token: "token-two" });
    const listed = await send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: { authToken: "token-one" } });
    assert.equal(listed.error?.data?.type, "AUTH_REQUIRED", "a session that echoes its own token must not be re-anchored on the rotated record");
    assert.match(listed.error.message, /Run: minitok mcp connect <host>/, "a dead explicit session token cannot be recovered by rotating the file, so the error names the reconnect command");
    // The session token is sticky: a later request without an explicit token is
    // still the explicit-token session, not a transport one.
    const transport = await send({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} });
    assert.equal(transport.error?.data?.type, "AUTH_REQUIRED", "a session that began with an explicit token stays explicit");
    const reinit = await send({ jsonrpc: "2.0", id: 4, method: "initialize", params: { protocolVersion: "2024-11-05", clientInfo: { name: "explicit-probe" } } });
    assert.equal(reinit.error, undefined, `re-initializing without a token must adopt the rotated record: ${JSON.stringify(reinit.error)}`);
    const healed = await send({ jsonrpc: "2.0", id: 5, method: "tools/list", params: {} });
    assert.equal(healed.error, undefined, `the transport session must adopt the rotated record: ${JSON.stringify(healed.error)}`);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});
