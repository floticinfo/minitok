"use strict";

/**
 * Transport-level contract for the MCP tool surface.
 *
 * tests/test-m3-stdio.js only exercises unauthenticated requests, so the
 * entitlement gate, the scope gate and run_id delivery were never asserted.
 * That gap hid four tools that were advertised by tools/list but permanently
 * unusable: the transport replaced their declared run_id with null, so every
 * call failed schema validation. These tests drive the real transport
 * (RuntimeStdio._handleMessage) with a stub entitlement and an injected
 * pipeline, so they neither need paid credentials nor touch the real pipeline.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { RuntimeStdio } = require("../src/runtime/stdio");
const { createRuntimeServices } = require("../src/runtime");
const { validateArgs, requiredScopeFor, TOOL_SCOPES, getToolDefinitions } = require("../src/mcp/tools");

const TOKEN = "transport-test-token";

/** A pipeline that stays pending until the run is cancelled. */
function pendingPipeline(calls) {
  return async (task, options) => {
    const entry = { task, aborted: false };
    calls.push(entry);
    await new Promise(resolve => {
      if (!options.signal) return resolve();
      options.signal.addEventListener("abort", () => { entry.aborted = true; resolve(); }, { once: true });
    });
    return { success: false, cancelled: true };
  };
}

/**
 * `safeResult` reports tool failures inside the result envelope rather than as a
 * JSON-RPC error, so checking only `reply.error` would accept a failing tool.
 */
function assertToolSucceeded(reply, label) {
  assert.equal(reply.error, undefined, `${label} must not fail the request: ${JSON.stringify(reply.error)}`);
  assert.notEqual(reply.result?.isError, true, `${label} must succeed, got: ${reply.result?.content?.[0]?.text}`);
}

function sandbox(scopes, pipeline, calls = []) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "minitok-mcp-transport-")));
  const runtimeDir = path.join(root, "runtime-state");
  const services = createRuntimeServices({ runtimeDir });
  // Stub only the entitlement so requests reach the scope and schema gates.
  services.entitlement = { status: async () => ({ allowed: true, state: "ALLOWED", plan: "pro" }) };
  const runtime = new RuntimeStdio({
    authToken: TOKEN,
    workspaceRoot: root,
    runStatePath: path.join(runtimeDir, "mcp-runs.json"),
    permissions: scopes,
    services,
    runPipeline: pipeline || pendingPipeline(calls),
  });
  // Keep progress notifications out of the test process stdout.
  const notifications = [];
  runtime._respond = message => notifications.push(message);
  const replies = [];
  const respond = value => replies.push(value);
  const send = async message => { await runtime._handleMessage(message, respond); return replies.find(reply => reply && reply.id === message.id); };
  const start = message => runtime._handleMessage(message, respond);
  const callMessage = (id, name, args) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args, authToken: TOKEN } });
  const call = (id, name, args) => send(callMessage(id, name, args));
  const init = () => send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "transport-test" }, authToken: TOKEN } });
  return {
    root, runtime, services, notifications, replies,
    call, callMessage, init, send, start,
    payload: reply => JSON.parse(reply.result.content[0].text),
    errorType: reply => reply?.error?.data?.type,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

test("a client-supplied run_id reaches minitok_run_get and minitok_run_cancel", async () => {
  const calls = [];
  const box = sandbox("read,write", pendingPipeline(calls), calls);
  try {
    await box.init();
    // Start a run and leave it pending so it stays addressable by run_id.
    const pending = box.start(box.callMessage(2, "minitok_run", { task: "transport probe", repo: box.root }));

    const listed = await box.call(3, "minitok_run_list", {});
    const runs = box.payload(listed);
    assert.equal(runs.length, 1, "the run must be registered by the transport");
    const runId = runs[0].run_id;
    assert.ok(runId, "the transport must generate a run id");

    const got = await box.call(4, "minitok_run_get", { run_id: runId });
    assert.equal(got.error, undefined, `minitok_run_get must accept run_id: ${JSON.stringify(got.error)}`);
    assert.deepEqual([box.payload(got).run_id, box.payload(got).state], [runId, "running"]);

    const cancelled = await box.call(5, "minitok_run_cancel", { run_id: runId });
    assert.equal(cancelled.error, undefined, `minitok_run_cancel must accept run_id: ${JSON.stringify(cancelled.error)}`);
    assert.equal(box.payload(cancelled).state, "cancelled");

    await pending;
    assert.equal(calls.length, 1, "the injected pipeline must be the one that ran");
    assert.equal(calls[0].aborted, true, "cancelling must abort the running pipeline");
  } finally { box.cleanup(); }
});

test("minitok_approve_run delivers the documented approval flow", async () => {
  const box = sandbox("read,write");
  try {
    await box.init();
    const approvalDir = path.join(box.root, ".minitok");
    fs.mkdirSync(approvalDir, { recursive: true });
    const approvalFile = path.join(approvalDir, "approval.json");
    const nonce = "0123456789abcdef";
    const runId = "run-approval-probe";
    fs.writeFileSync(approvalFile, JSON.stringify({ type: "approval_request", run_id: runId, nonce, expires_at: Date.now() + 60000 }), "utf8");

    const reply = await box.call(6, "minitok_approve_run", { approval_file: approvalFile, nonce, run_id: runId });
    assert.equal(reply.error, undefined, `approval must be deliverable: ${JSON.stringify(reply.error)}`);
    assert.equal(box.payload(reply).decision, "approve");
    assert.deepEqual(JSON.parse(fs.readFileSync(`${approvalFile}.response`, "utf8")), { decision: "approve", nonce, run_id: runId });
  } finally { box.cleanup(); }
});

test("the read scope is read-only: every writing tool is refused", async () => {
  const box = sandbox("read");
  try {
    await box.init();
    const probes = [
      [10, "minitok_knowledge_record", { goal: "scope probe", status: "success" }],
      [11, "minitok_observe", { project: "scope probe", events: [{ type: "task_started" }] }],
      [12, "minitok_run", { task: "scope probe", repo: box.root }],
      [13, "minitok_run_cancel", { run_id: "run-abc" }],
    ];
    for (const [id, name, args] of probes) {
      const reply = await box.call(id, name, args);
      assert.equal(box.errorType(reply), "PERMISSION_DENIED", `${name} must require the write scope`);
    }
    const runtimeDir = path.join(box.root, "runtime-state");
    const written = fs.existsSync(runtimeDir) ? fs.readdirSync(runtimeDir) : [];
    assert.deepEqual(written.filter(entry => entry.startsWith("knowledge") || entry.startsWith("observations")), [],
      `the read scope must not persist anything, found: ${written}`);
  } finally { box.cleanup(); }
});

test("the write scope grants the writing tools", async () => {
  const box = sandbox("read,write");
  try {
    await box.init();
    const recorded = await box.call(20, "minitok_knowledge_record", { goal: "scope probe", status: "success" });
    assertToolSucceeded(recorded, "minitok_knowledge_record with the write scope");
    assert.equal(box.payload(recorded).recorded, true);
    const observed = await box.call(21, "minitok_observe", { project: "scope probe", events: [{ type: "task_started" }] });
    assertToolSucceeded(observed, "minitok_observe with the write scope");
    assert.equal(box.payload(observed).accepted, 1);
  } finally { box.cleanup(); }
});

test("the read scope still serves read-only tools", async () => {
  const box = sandbox("read");
  try {
    await box.init();
    for (const [id, name, args] of [[30, "minitok_status", {}], [31, "minitok_compact_context", { text: "hello world" }], [32, "minitok_knowledge_query", { limit: 5 }], [33, "minitok_run_list", {}]]) {
      const reply = await box.call(id, name, args);
      assertToolSucceeded(reply, `${name} with the read scope`);
    }
    const resources = await box.send({ jsonrpc: "2.0", id: 34, method: "resources/list", params: { authToken: TOKEN } });
    assert.ok(resources.result.resources.length >= 1);
  } finally { box.cleanup(); }
});

test("project scoping arguments are accepted by the analysis tools", async () => {
  const box = sandbox("read");
  try {
    await box.init();
    for (const [id, name] of [[40, "minitok_analyze_failures"], [41, "minitok_recommend_policy"]]) {
      const reply = await box.call(id, name, { project: "proj-a" });
      assertToolSucceeded(reply, `${name} with a project argument`);
    }
  } finally { box.cleanup(); }
});

test("the pipeline injected into the constructor replaces the real one", async () => {
  const seen = [];
  const box = sandbox("read,write", async (task) => { seen.push(task); return { success: true, marker: "injected" }; });
  try {
    await box.init();
    const reply = await box.call(50, "minitok_run", { task: "injected pipeline probe", repo: box.root });
    assert.equal(reply.error, undefined, `the run must not fall back to the real pipeline: ${JSON.stringify(reply.error)}`);
    assert.deepEqual(seen, ["injected pipeline probe"]);
    assert.equal(box.payload(reply).result.marker, "injected");
  } finally { box.cleanup(); }
});

test("validateArgs returns the validated copy and drops undeclared run_id", () => {
  assert.equal(validateArgs("minitok_run", { task: "t" }).run_id, undefined);
  assert.equal(validateArgs("minitok_run_get", { run_id: "r1" }).run_id, "r1");
  assert.deepEqual(validateArgs("minitok_run_list", { run_id: "smuggled" }), {}, "a tool without run_id must not receive one");
  assert.throws(() => validateArgs("minitok_run", { task: "t", run_id: { nested: true } }), /run_id must be string/);
  assert.throws(() => validateArgs("minitok_run", { task: "t", bogus: 1 }), /Unknown argument/);
  assert.throws(() => validateArgs("minitok_run_get", {}), /run_id is required/);
});

test("every tool declares the scope it actually needs", () => {
  const writers = getToolDefinitions().map(tool => tool.name).filter(name => requiredScopeFor(name) === "write");
  assert.deepEqual(writers.sort(), Object.keys(TOOL_SCOPES).sort());
  for (const tool of getToolDefinitions()) {
    if (requiredScopeFor(tool.name) !== "read") continue;
    assert.equal(tool.annotations.destructiveHint, false, `${tool.name} is read-scoped but marked destructive`);
  }
  // Additive writers persist to the user's home directory, so they need write.
  for (const name of ["minitok_knowledge_record", "minitok_observe", "minitok_run", "minitok_run_cancel", "minitok_approve_run", "minitok_reject_run"]) {
    assert.equal(requiredScopeFor(name), "write", `${name} must need the write scope`);
  }
  assert.equal(requiredScopeFor("minitok_compact_context"), "read");
});

