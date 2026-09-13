
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("child_process");
const path = require("path");
const fs2 = require("fs");
const { version } = require("../package.json");

const SCRIPT = path.join(__dirname, "..", "src", "runtime", "stdio-entry.js");
const TO = 8000;

function send(p, msg, t) {
  t = t || TO;
  return new Promise((ok, no) => {
    const tm = setTimeout(() => no(new Error("timeout")), t);
    let buf = "";
    function on(d) {
      buf += d.toString();
      const ls = buf.split("\n");
      for (let i = 0; i < ls.length-1; i++) {
        const l = ls[i].trim(); if (!l) continue;
        try { const message = JSON.parse(l); if (message.id === undefined) continue; clearTimeout(tm); p.stdout.removeListener("data", on); ok(message); return; } catch {} }
      buf = ls[ls.length-1] || "";
    }
    p.stdout.on("data", on);
    p.stdin.write(JSON.stringify(msg) + "\n");
  });
}

function wait(p) { return new Promise(r => { setTimeout(() => { p.kill(); r(); }, 2000); p.on("exit", () => r()); }); }

if (!fs2.existsSync(SCRIPT)) fs2.writeFileSync(SCRIPT, "require(\"./stdio.js\").start();", "utf-8");

describe("M3 stdio MCP integration", () => {
  it("starts without MODULE_NOT_FOUND", async () => {
    const p = spawn(process.execPath, [SCRIPT], { cwd: path.dirname(SCRIPT), stdio: ["pipe","pipe","pipe"], env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("MINITOK_MCP_AUTH"))) } });
    let stderr = ""; p.stderr.on("data", d => { stderr += d.toString(); });
    await new Promise(r => setTimeout(r, 500));
    assert.ok(p.exitCode === null, "Process alive. stderr: " + stderr);
    assert.ok(!stderr.includes("MODULE_NOT_FOUND"), "No MODULE_NOT_FOUND: " + stderr);
    p.kill(); await wait(p);
  });

  it("initialize returns valid response", async () => {
    const p = spawn(process.execPath, [SCRIPT], { cwd: path.dirname(SCRIPT), stdio: ["pipe","pipe","pipe"], env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("MINITOK_MCP_AUTH"))) } });
    try {
      const r = await send(p, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test" } } });
      assert.equal(r.result.protocolVersion, "2024-11-05");
      assert.equal(r.result.serverInfo.name, "minitok-runtime");
      assert.equal(r.result.serverInfo.version, version);
    } finally { p.kill(); await wait(p); }
  });

  it("resources and prompts are rejected before authentication", async () => {
    const p = spawn(process.execPath, [SCRIPT], { cwd: path.dirname(SCRIPT), stdio: ["pipe","pipe","pipe"], env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("MINITOK_MCP_AUTH"))) } });
    try {
      const init = await send(p, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test" } } });
      assert.deepEqual(init.result.capabilities.resources, { subscribe: false, listChanged: false });
      const resources = await send(p, { jsonrpc: "2.0", id: 2, method: "resources/list", params: {} });
      assert.equal(resources.error.data.type, "AUTH_REQUIRED");
      const prompts = await send(p, { jsonrpc: "2.0", id: 3, method: "prompts/list", params: {} });
      assert.equal(prompts.error.data.type, "AUTH_REQUIRED");
    } finally { p.kill(); await wait(p); }
  });

  it("tools/list is rejected before authentication", async () => {
    const p = spawn(process.execPath, [SCRIPT], { cwd: path.dirname(SCRIPT), stdio: ["pipe","pipe","pipe"], env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("MINITOK_MCP_AUTH"))) } });
    try {
      await send(p, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test" } } });
      p.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
      const r = await send(p, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
      // Authentication is checked before the entitlement gate, so an anonymous
      // client never reaches it. tests/test-mcp-tool-transport.js covers the
      // authenticated entitlement and scope paths.
      assert.equal(r.error.data.type, "AUTH_REQUIRED");
    } finally { p.kill(); await wait(p); }
  });

  it("tools/call is rejected before authentication", async () => {
    const p = spawn(process.execPath, [SCRIPT], { cwd: path.dirname(SCRIPT), stdio: ["pipe","pipe","pipe"], env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("MINITOK_MCP_AUTH"))) } });
    try {
      await send(p, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test" } } });
      p.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
      const r = await send(p, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "minitok_status", arguments: {} } });
      assert.equal(r.id, 3);
      assert.equal(r.error.data.type, "AUTH_REQUIRED");
    } finally { p.kill(); await wait(p); }
  });

  it("an anonymous knowledge query is rejected", async () => {
    const p = spawn(process.execPath, [SCRIPT], { cwd: path.dirname(SCRIPT), stdio: ["pipe","pipe","pipe"], env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("MINITOK_MCP_AUTH"))) } });
    try {
      await send(p, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test" } } });
      p.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
      const r = await send(p, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "minitok_knowledge_query", arguments: { limit: 5 } } });
      assert.equal(r.id, 4);
      assert.equal(r.error.data.type, "AUTH_REQUIRED");
    } finally { p.kill(); await wait(p); }
  });

  it("an unknown method fails before method routing", async () => {
    const p = spawn(process.execPath, [SCRIPT], { cwd: path.dirname(SCRIPT), stdio: ["pipe","pipe","pipe"], env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("MINITOK_MCP_AUTH"))) } });
    try {
      const r = await send(p, { jsonrpc: "2.0", id: 99, method: "nonexistent", params: {} });
      // Authentication runs first, so METHOD_NOT_FOUND is only reachable for an
      // authenticated session (covered in tests/test-mcp-tool-transport.js).
      assert.equal(r.error.data.type, "AUTH_REQUIRED");
    } finally { p.kill(); await wait(p); }
  });

  it("malformed JSON does not crash", async () => {
    const p = spawn(process.execPath, [SCRIPT], { cwd: path.dirname(SCRIPT), stdio: ["pipe","pipe","pipe"], env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("MINITOK_MCP_AUTH"))) } });
    try {
      await send(p, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test" } } });
      p.stdin.write("not valid json {{{\n");
      await new Promise(r => setTimeout(r, 500));
      assert.equal(p.exitCode, null, "Process alive after malformed input");
    } finally { p.kill(); await wait(p); }
  });
});
