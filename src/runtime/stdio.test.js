"use strict";

/**
 * Stdio framing unit tests.
 *
 * The HTTP transport caps a request body, while stdio used to buffer an
 * unlimited line: a client that never sent a newline could grow the buffer until
 * the process ran out of memory.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { drainStdioLines, drainStdioMessages, MAX_REQUEST_BYTES, MAX_TRACKED_RUNS, RuntimeStdio, SUPPORTED_PROTOCOLS } = require("./stdio");

describe("stdio framing", () => {
  it("negotiates current MCP protocol revisions", () => {
    assert.deepEqual(SUPPORTED_PROTOCOLS.slice(0, 4), ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"]);
  });

  it("parses Content-Length framing across chunks and preserves UTF-8", () => {
    const payload = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { text: "안녕하세요 🚀" } });
    const frame = Buffer.from(`Content-Length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`, "utf8");
    const split = Math.floor(frame.length / 2);
    const first = drainStdioMessages(Buffer.alloc(0), frame.subarray(0, split), "auto");
    assert.equal(first.mode, "framed");
    assert.deepEqual(first.messages, []);
    const second = drainStdioMessages(first.rest, frame.subarray(split), first.mode);
    assert.deepEqual(second.messages, [payload]);
    assert.equal(second.rest.length, 0);
  });

  it("parses multiple framed messages and rejects an oversized frame", () => {
    const make = value => { const body = JSON.stringify(value); return Buffer.from(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`); };
    const parsed = drainStdioMessages(Buffer.alloc(0), Buffer.concat([make({ id: 1 }), make({ id: 2 })]), "auto");
    assert.equal(parsed.messages.length, 2);
    const oversized = drainStdioMessages(Buffer.alloc(0), Buffer.from(`Content-Length: ${MAX_REQUEST_BYTES + 1}\r\n\r\n`), "auto");
    assert.equal(oversized.oversized, true);
  });

  it("returns complete lines and keeps the incomplete remainder", () => {
    const first = drainStdioLines("", '{"id":1}\n{"id":2}\n{"id":3');
    assert.deepEqual(first.lines, ['{"id":1}', '{"id":2}']);
    assert.equal(first.rest, '{"id":3');
    assert.equal(first.oversized, false);

    const second = drainStdioLines(first.rest, '}\n');
    assert.deepEqual(second.lines, ['{"id":3}']);
    assert.equal(second.rest, "");
  });

  it("handles a chunk boundary that splits a line", () => {
    const a = drainStdioLines("", '{"id":');
    const b = drainStdioLines(a.rest, '1}\n');
    assert.deepEqual(b.lines, ['{"id":1}']);
    assert.equal(b.rest, "");
  });

  it("refuses an incomplete line above the cap instead of buffering it", () => {
    const oversized = drainStdioLines("", "x".repeat(MAX_REQUEST_BYTES + 1));
    assert.equal(oversized.oversized, true);
    assert.deepEqual(oversized.lines, []);
    assert.equal(oversized.rest, "", "the oversized payload is dropped");
    assert.equal(oversized.dropping, true, "the rest of that line is discarded until its newline");
  });

  it("drops a complete line above the cap instead of parsing it", () => {
    const oversized = drainStdioLines("", `${"y".repeat(MAX_REQUEST_BYTES + 1)}\n`);
    assert.equal(oversized.oversized, true, "a terminated oversized line is refused too");
    assert.deepEqual(oversized.lines, []);
    assert.equal(oversized.rest, "");
    assert.equal(oversized.dropping, false, "the newline ended the line, so framing stays in sync");
  });

  it("discards the tail of an oversized line and still reads the next request", () => {
    // Measured before the fix: the 5 MB tail arrived as one line, so the following
    // request was answered with a parse error instead of a normal response.
    const first = drainStdioLines("", "z".repeat(MAX_REQUEST_BYTES + 10));
    assert.equal(first.dropping, true);
    const second = drainStdioLines(first.rest, 'ztail-ending-the-line\n{"jsonrpc":"2.0","id":4}\n', MAX_REQUEST_BYTES, first.dropping);
    assert.deepEqual(second.lines, ['{"jsonrpc":"2.0","id":4}'], "the next request survives an oversized predecessor");
    assert.equal(second.oversized, false, "the oversized line is reported once, not once per chunk");
    assert.equal(second.dropping, false);
  });

  it("still delivers the complete lines that preceded an oversized one", () => {
    const oversized = drainStdioLines("", `{"id":1}\n${"y".repeat(MAX_REQUEST_BYTES + 1)}`);
    assert.deepEqual(oversized.lines, ['{"id":1}']);
    assert.equal(oversized.oversized, true);
  });

  it("accepts a payload at exactly the cap", () => {
    const atCap = drainStdioLines("", "z".repeat(MAX_REQUEST_BYTES));
    assert.equal(atCap.oversized, false);
    assert.equal(atCap.rest.length, MAX_REQUEST_BYTES);
  });
});

describe("stdio run registry and scopes", () => {
  function harness(root, permissions = "read,write,verify_exec") {
    const replies = [];
    const runtime = new RuntimeStdio({
      authToken: "token",
      permissions,
      workspaceRoot: root,
      runStatePath: path.join(root, "runs.json"),
      services: { entitlement: { status: async () => ({ allowed: true, state: "ALLOWED" }) } },
      runPipeline: async () => ({ success: true, run_id: "stub", cycles: 1, totalTokens: { input: 0, output: 0 }, totalCost: 0 }),
    });
    runtime._respond = message => replies.push(message);
    // Persistence is exercised by the stdio integration tests; stubbing it keeps
    // this test about the registry bound instead of Windows fsync cost.
    runtime._saveRunState = () => ({ persisted: false, error: null, operation: "save" });
    return { runtime, replies };
  }
  const line = value => JSON.stringify(value);
  const call = (runtime, id, name, args) => runtime._handleLine(line({ jsonrpc: "2.0", id, method: "tools/call", params: { authToken: "token", name, arguments: args } }));

  it("bounds the in-memory run registry in a long-lived session", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mt-stdio-runs-"));
    try {
      const { runtime, replies } = harness(root);
      await runtime._handleLine(line({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2024-11-05", authToken: "token" } }));
      const total = MAX_TRACKED_RUNS + 25;
      for (let id = 1; id <= total; id += 1) await call(runtime, id, "minitok_run", { task: `run ${id}`, repo: root });
      assert.equal(runtime._runs.size, MAX_TRACKED_RUNS, `registry must stay bounded (was ${runtime._runs.size})`);

      await call(runtime, total + 1, "minitok_run_list", {});
      const listed = JSON.parse(replies.find(message => message.id === total + 1).result.content[0].text);
      assert.equal(listed.length <= MAX_TRACKED_RUNS, true, "run_list must not grow without bound either");
      // A recent run is still addressable after older ones were evicted.
      const recent = [...runtime._runs.keys()].pop();
      await call(runtime, total + 2, "minitok_run_get", { run_id: recent });
      assert.equal(replies.find(message => message.id === total + 2).result.content[0].text.includes(recent), true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("requires the verification scope before a run executes repository code", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mt-stdio-scope-"));
    try {
      const { runtime, replies } = harness(root, "read,write");
      await runtime._handleLine(line({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2024-11-05", authToken: "token" } }));
      await call(runtime, 1, "minitok_run", { task: "scope probe", repo: root });
      const failure = replies.find(message => message.id === 1);
      assert.equal(failure.error.data.type, "PERMISSION_DENIED");
      assert.match(failure.error.message, /verification permission required/);
      assert.equal(failure.error.data.scope, "verify_exec");
      assert.equal(runtime._runs.size, 0, "a denied run is not registered");

      // Read-only tools stay reachable without the extra grant.
      await call(runtime, 2, "minitok_run_list", {});
      assert.equal(Array.isArray(JSON.parse(replies.find(message => message.id === 2).result.content[0].text)), true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
