"use strict";

/**
 * Local MCP transport concurrency contract.
 *
 * JSON-RPC lines arrive through a non-blocking stdin handler, so two requests
 * can be in flight at once. The run-limit check and the run reservation must
 * therefore never be separated by an await: if they are, two minitok_run calls
 * arriving in the same read window both observe zero running runs and both
 * start, exceeding MINITOK_MCP_MAX_CONCURRENT_RUNS.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { RuntimeStdio } = require("../src/runtime/test-seam");

const TOKEN = "concurrency-test-token";
const INIT_ID = 1;

function harness(root, options = {}) {
  const runtime = new RuntimeStdio({
    authToken: TOKEN,
    workspaceRoot: root,
    runStatePath: path.join(root, "mcp-runs.json"),
    permissions: "read,write",
    services: { entitlement: { status: async () => ({ allowed: true, state: "ALLOWED" }) } },
    ...options,
  });
  const replies = [];
  const respond = value => replies.push(value);
  return { runtime, replies, respond };
}

function initMessage() {
  return { jsonrpc: "2.0", id: INIT_ID, method: "initialize", params: { protocolVersion: "2024-11-05", authToken: TOKEN, clientInfo: { name: "concurrency-test", version: "1" } } };
}

function runMessage(id, root) {
  return { jsonrpc: "2.0", id, method: "tools/call", params: { authToken: TOKEN, name: "minitok_run", arguments: { task: "concurrency probe", repo: root } } };
}

const errorCode = reply => reply?.error?.data?.type;
const runningCount = runtime => [...runtime._runs.values()].filter(run => run.state === "running").length;

test("concurrent minitok_run requests cannot exceed maxConcurrentRuns", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "minitok-mcp-concurrency-"));
  try {
    const { runtime, replies, respond } = harness(root, { maxConcurrentRuns: 1 });
    await runtime._handleMessage(initMessage(), respond);

    // Fire both without awaiting the first: the second must observe the first
    // request's reservation, not a stale "zero running" snapshot.
    const first = runtime._handleMessage(runMessage(2, root), respond);
    const second = runtime._handleMessage(runMessage(3, root), respond);
    await Promise.all([first, second]);

    const limited = replies.filter(reply => errorCode(reply) === "RUN_LIMIT_REACHED");
    assert.equal(limited.length, 1, "exactly one request must be rejected by the run limit");
    assert.equal(limited[0].id, 3, "the later request must be the one rejected");
    assert.equal(runningCount(runtime), 0, "no run may be left marked running after the requests settle");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("maxConcurrentRuns above one admits parallel runs", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "minitok-mcp-concurrency-"));
  try {
    const { runtime, replies, respond } = harness(root, { maxConcurrentRuns: 2 });
    await runtime._handleMessage(initMessage(), respond);

    const first = runtime._handleMessage(runMessage(2, root), respond);
    const second = runtime._handleMessage(runMessage(3, root), respond);
    await Promise.all([first, second]);

    assert.equal(replies.filter(reply => errorCode(reply) === "RUN_LIMIT_REACHED").length, 0, "a limit of two must admit two runs");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("a run reservation is released when entitlement denies the call", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "minitok-mcp-concurrency-"));
  try {
    const { runtime, replies, respond } = harness(root, {
      maxConcurrentRuns: 1,
      services: { entitlement: { status: async () => ({ allowed: false, state: "EXPIRED", message: "Paid entitlement required" }) } },
    });
    await runtime._handleMessage(initMessage(), respond);
    await runtime._handleMessage(runMessage(2, root), respond);

    assert.equal(errorCode(replies.at(-1)), "ENTITLEMENT_REQUIRED");
    assert.equal(runtime._runs.size, 0, "a denied call must not leave a run reservation behind");
    assert.equal(runtime._requestToRun.size, 0, "a denied call must not leave a request mapping behind");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("destructive tools are refused without the write scope", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "minitok-mcp-concurrency-"));
  try {
    const { runtime, replies, respond } = harness(root, { permissions: "read" });
    await runtime._handleMessage(initMessage(), respond);
    await runtime._handleMessage(runMessage(2, root), respond);

    assert.equal(errorCode(replies.at(-1)), "PERMISSION_DENIED");
    assert.equal(runtime._runs.size, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("stdout redirection is reference counted so overlapping runs cannot leak", () => {
  const { acquireStdoutGuard, releaseStdoutGuard } = require("../src/mcp/tools");
  const original = console.log;
  const originalInfo = console.info;
  const originalWarn = console.warn;
  try {
    acquireStdoutGuard();
    const redirected = console.log;
    assert.notEqual(redirected, original, "the first acquire must divert console.log");

    // A second overlapping run must not capture the already-diverted console,
    // otherwise its release would restore the original while the first run is
    // still logging.
    acquireStdoutGuard();
    assert.equal(console.log, redirected, "the second acquire must not re-capture a diverted console");

    releaseStdoutGuard();
    assert.equal(console.log, redirected, "the console must stay diverted while a holder remains");

    releaseStdoutGuard();
    assert.equal(console.log, original, "the last release must restore the original console.log");
    assert.equal(console.info, originalInfo, "the last release must restore the original console.info");
    assert.equal(console.warn, originalWarn, "the last release must restore the original console.warn");
  } finally {
    // Never leave the process with patched console methods if an assertion threw.
    while (console.log !== original) releaseStdoutGuard();
    console.log = original;
    console.info = originalInfo;
    console.warn = originalWarn;
  }
});

test("overlapping runs keep diverting output after the shorter run settles", async () => {
  const { getToolHandler } = require("../src/mcp/tools");
  const diverted = [];
  const savedError = console.error;
  console.error = (...values) => { diverted.push(values.join(" ")); };
  const toolOptions = runPipeline => ({
    workspaceRoot: process.cwd(),
    permissions: new Set(["write"]),
    safeResult: true,
    runPipeline,
  });
  try {
    // The first-started run settles first. Without reference counting it hands
    // the original console.log back while the second run is still emitting, so
    // the second run's line escapes to stdout instead of the diversion.
    const settlingFirst = getToolHandler("minitok_run", { task: "first", repo: process.cwd() }, {}, toolOptions(async () => {
      console.log("FIRST_RUN_MARKER");
      return { success: true };
    }));
    const stillRunning = getToolHandler("minitok_run", { task: "second", repo: process.cwd() }, {}, toolOptions(async () => {
      await new Promise(resolve => setTimeout(resolve, 40));
      console.log("SECOND_RUN_MARKER");
      return { success: true };
    }));
    await Promise.all([settlingFirst, stillRunning]);
    assert.ok(diverted.some(line => line.includes("FIRST_RUN_MARKER")), "the first run's output must be diverted");
    assert.ok(diverted.some(line => line.includes("SECOND_RUN_MARKER")), "the second run's output must stay diverted after the first run settles");
  } finally { console.error = savedError; }
});

test("minitok_run diverts its output and restores the console afterwards", async () => {
  const { getToolHandler } = require("../src/mcp/tools");
  const original = console.log;
  const result = await getToolHandler("minitok_run", { task: "restore probe", repo: process.cwd() }, {}, {
    workspaceRoot: process.cwd(),
    permissions: new Set(["write"]),
    safeResult: true,
    runPipeline: async () => { console.log("pipeline noise"); return { success: true }; },
  });
  assert.equal(JSON.parse(result.content[0].text).state, "completed");
  assert.equal(console.log, original, "the console must be restored once the run settles");
});


