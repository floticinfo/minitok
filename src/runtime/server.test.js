"use strict";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { RuntimeServer } = require("./test-seam");

function request(port, options = {}, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, ...options }, res => {
      const chunks = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function runtimeFiles() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mt-runtime-"));
  return { root, pidFile: path.join(root, "runtime.pid"), tokenFile: path.join(root, "runtime.token"), lockFile: path.join(root, "runtime.lock") };
}

describe("runtime PID cleanup", () => {
  let files;
  afterEach(() => { if (files) fs.rmSync(files.root, { recursive: true, force: true }); });

  it("removes only PID and token files owned by its nonce and token path", () => {
    files = runtimeFiles();
    const server = new RuntimeServer({ ...files, authRequired: false, entitlementRequired: false });
    server._writePid();
    server._removePid();
    assert.equal(fs.existsSync(files.pidFile), false);
    assert.equal(fs.existsSync(files.tokenFile), false);
  });

  it("does not remove replacement PID or token metadata", () => {
    files = runtimeFiles();
    const server = new RuntimeServer({ ...files, authRequired: false, entitlementRequired: false });
    server._writePid();
    fs.writeFileSync(files.pidFile, JSON.stringify({ pid: process.pid, nonce: "replacement", tokenFile: files.tokenFile }));
    server._removePid();
    assert.equal(fs.existsSync(files.pidFile), true);
    assert.equal(fs.existsSync(files.tokenFile), true);
  });

  it("requires bearer auth for HTTP initialize before MCP processing", async () => {
    files = runtimeFiles();
    const server = new RuntimeServer({ ...files, port: 0, entitlementRequired: false, runtimeToken: "http-secret" });
    await server.start();
    try {
      const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } });
      const missing = await request(server._port, { method: "POST", path: "/mcp", headers: { "Content-Type": "application/json" } }, body);
      assert.equal(missing.status, 401);
      const invalid = await request(server._port, { method: "POST", path: "/mcp", headers: { Authorization: "Bearer wrong", "Content-Type": "application/json" } }, body);
      assert.equal(invalid.status, 401);
      const valid = await request(server._port, { method: "POST", path: "/mcp", headers: { Authorization: "Bearer http-secret", "Content-Type": "application/json" } }, body);
      assert.equal(valid.status, 200);
      assert.equal(JSON.parse(valid.body).result.protocolVersion, "2024-11-05");
    } finally { await server.stop(); }
  });

  it("exposes authenticated operational metrics without secrets", async () => {
    files = runtimeFiles();
    const server = new RuntimeServer({ ...files, port: 0, entitlementRequired: true, runtimeToken: "metrics-secret" });
    await server.start();
    try {
      const unauthorized = await request(server._port, { path: "/metrics" });
      assert.equal(unauthorized.status, 401);
      const authorized = await request(server._port, { path: "/metrics", headers: { Authorization: "Bearer metrics-secret" } });
      assert.equal(authorized.status, 200);
      const body = JSON.parse(authorized.body);
      assert.equal(body.ready, true);
      assert.equal(body.auth_required, true);
      assert.equal(body.entitlement_required, true);
      assert.equal(Object.prototype.hasOwnProperty.call(body, "runtime_token"), false);
    } finally { await server.stop(); }
  });

  it("serves MCP JSON-RPC over authenticated HTTP without changing REST auth", async () => {
    files = runtimeFiles();
    const server = new RuntimeServer({ ...files, port: 0, entitlementRequired: false });
    await server.start();
    const token = fs.readFileSync(files.tokenFile, "utf8").trim();
    try {
      const init = await request(server._port, { method: "POST", path: "/mcp", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } }, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } }));
      assert.equal(init.status, 200);
      assert.equal(JSON.parse(init.body).result.protocolVersion, "2024-11-05");
      assert.equal(server._mcp._authToken, token);
      const list = await request(server._port, { method: "POST", path: "/mcp", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } }, JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }));
      assert.equal(JSON.parse(list.body).result.tools.length > 0, true);
    } finally { await server.stop(); }
  });

  it("handles localhost HTTP auth, chunked bodies, malformed JSON, and oversized bodies", async () => {
    files = runtimeFiles();
    const server = new RuntimeServer({ ...files, port: 0, entitlementRequired: false });
    await server.start();
    const port = server._port;
    try {
      assert.equal((await request(port, { path: "/health" })).status, 200);
      assert.equal((await request(port, { path: "/api/v1/status" })).status, 401);
      const token = fs.readFileSync(files.tokenFile, "utf8").trim();
      assert.equal((await request(port, { path: "/api/v1/status", headers: { Authorization: `Bearer ${token}` } })).status, 200);
      assert.equal((await request(port, { method: "POST", path: "/api/v1/knowledge/query", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } }, "{bad")).status, 400);
      const oversized = "{" + "x".repeat(1024 * 1024 + 1) + "}";
      assert.equal((await request(port, { method: "POST", path: "/api/v1/knowledge/query", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "Transfer-Encoding": "chunked" } }, oversized)).status, 413);
    } finally {
      await server.stop();
    }
  });

  it("suppresses notification results and errors", async () => {
    files = runtimeFiles();
    const server = new RuntimeServer({ ...files, port: 0, entitlementRequired: false });
    await server.start();
    const headers = { Authorization: `Bearer ${fs.readFileSync(files.tokenFile, "utf8").trim()}`, "Content-Type": "application/json" };
    try {
      for (const message of [
        { jsonrpc: "2.0", method: "initialize", params: { protocolVersion: "2024-11-05" } },
        { jsonrpc: "2.0", method: "prompts/get", params: { name: "missing" } },
        { jsonrpc: "2.0", method: "notifications/initialized" },
      ]) {
        const response = await request(server._port, { method: "POST", path: "/mcp", headers }, JSON.stringify(message));
        assert.equal(response.status, 202);
        assert.equal(response.body, "");
      }
    } finally { await server.stop(); }
  });

  it("returns Invalid Request for malformed single and batch messages", async () => {
    files = runtimeFiles();
    const server = new RuntimeServer({ ...files, port: 0, entitlementRequired: false });
    await server.start();
    const headers = { Authorization: `Bearer ${fs.readFileSync(files.tokenFile, "utf8").trim()}`, "Content-Type": "application/json" };
    try {
      for (const message of [null, [], { jsonrpc: "1.0", id: 1, method: "tools/list" }, { jsonrpc: "2.0", id: [], method: "tools/list" }, { jsonrpc: "2.0", id: 1, method: "tools/list", params: [] }]) {
        const response = await request(server._port, { method: "POST", path: "/mcp", headers }, JSON.stringify(message));
        const body = JSON.parse(response.body);
        assert.equal(response.status, 200);
        assert.equal(body.error?.code ?? body[0]?.error?.code, -32600);
      }
      const batch = await request(server._port, { method: "POST", path: "/mcp", headers }, JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } }, null, { jsonrpc: "2.0", id: [], method: "tools/list" }]));
      assert.equal(batch.status, 200);
      assert.deepEqual(JSON.parse(batch.body).map(item => item.error?.code || item.id), [1, -32600, -32600]);
    } finally { await server.stop(); }
  });

  it("returns only correlated responses for valid batches", async () => {
    files = runtimeFiles();
    const server = new RuntimeServer({ ...files, port: 0, entitlementRequired: false });
    await server.start();
    const headers = { Authorization: `Bearer ${fs.readFileSync(files.tokenFile, "utf8").trim()}`, "Content-Type": "application/json" };
    try {
      const response = await request(server._port, { method: "POST", path: "/mcp", headers }, JSON.stringify([
        { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } },
        { jsonrpc: "2.0", method: "notifications/initialized" },
        { jsonrpc: "2.0", id: 2, method: "prompts/list", params: {} },
      ]));
      assert.equal(response.status, 200);
      const body = JSON.parse(response.body);
      assert.equal(body.length, 2);
      assert.deepEqual(body.map(item => item.id), [1, 2]);
    } finally { await server.stop(); }
  });
});
describe("runtime idle shutdown", () => {
  let files;
  afterEach(() => { if (files) fs.rmSync(files.root, { recursive: true, force: true }); });

  it("waits for stop() before exiting", async () => {
    files = runtimeFiles();
    const server = new RuntimeServer({ ...files, authRequired: false, entitlementRequired: false });
    const order = [];
    server.stop = async () => {
      order.push("stop:start");
      await new Promise(resolve => setTimeout(resolve, 20));
      order.push("stop:end");
    };
    const originalExit = process.exit;
    process.exit = code => { order.push(`exit:${code}`); };
    try {
      await server._shutdownForIdle();
    } finally {
      process.exit = originalExit;
    }
    // The lock release lives inside stop(), so exiting first left a stale lock.
    assert.deepEqual(order, ["stop:start", "stop:end", "exit:0"]);
  });

  it("still exits when stop() fails", async () => {
    files = runtimeFiles();
    const server = new RuntimeServer({ ...files, authRequired: false, entitlementRequired: false });
    const order = [];
    server.stop = async () => { throw new Error("stop failed"); };
    const originalExit = process.exit;
    process.exit = code => { order.push(`exit:${code}`); };
    try {
      await server._shutdownForIdle();
    } finally {
      process.exit = originalExit;
    }
    assert.deepEqual(order, ["exit:0"]);
  });
});

