"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

class FakeStream extends EventEmitter {
  writable = true;
  write(value) { this.emit("write", value); return true; }
}

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdin = new FakeStream();
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.writeCount = 0;
    this.stdin.on("write", () => {
      this.writeCount += 1;
      if (this.writeCount === 1) this.stdout.emit("data", Buffer.from(`${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2024-11-05" } })}\n`));
      if (this.writeCount === 2) this.stdout.emit("data", Buffer.from(`${JSON.stringify({ jsonrpc: "2.0", id: 2, result: { tools: [{ name: "minitok_status" }] } })}\n`));
    });
  }
  kill() { this.emit("exit", 0, null); }
}

test("agent MCP client handles newline JSON-RPC", async () => {
  const { McpProcessClient } = await import("../src/agent/mcp-client.mjs");
  const client = new McpProcessClient({ command: "fake", spawnImpl: () => new FakeChild(), timeoutMs: 500 });
  await client.start();
  assert.equal((await client.request("initialize", {})).protocolVersion, "2024-11-05");
  assert.equal((await client.request("tools/list", {})).tools[0].name, "minitok_status");
  await client.close();
});
