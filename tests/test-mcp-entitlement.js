"use strict";

/**
 * Phase 6: MCP entitlement integration.
 *
 * Spawns the real stdio-entry process and exercises the handshake gate:
 *   - no credential → LICENSE_REQUIRED (-32003)
 *   - valid credential → initialize succeeds
 *   - initialize-params credential path → initialize succeeds
 *   - malformed token → LICENSE_REQUIRED
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

const SCRIPT = path.join(__dirname, "..", "src", "runtime", "stdio-entry.js");
const TO = 8000;

function envWith(extra = {}) {
  return {
    ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("MINITOK_MCP_AUTH") && k !== "MINITOK_ENTITLEMENT")),
    ...extra,
  };
}

function send(p, msg, timeoutMs = TO) {
  return new Promise((ok, no) => {
    const tm = setTimeout(() => no(new Error("timeout")), timeoutMs);
    let buf = "";
    function on(d) {
      buf += d.toString();
      const lines = buf.split("\n");
      for (let i = 0; i < lines.length - 1; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        try {
          const message = JSON.parse(line);
          if (message.id === undefined) continue;
          clearTimeout(tm);
          p.stdout.removeListener("data", on);
          ok(message);
          return;
        } catch {}
      }
      buf = lines[lines.length - 1] || "";
    }
    p.stdout.on("data", on);
    p.stdin.write(JSON.stringify(msg) + "\n");
  });
}

function wait(p) {
  return new Promise((r) => {
    setTimeout(() => { p.kill(); r(); }, 2000);
    p.on("exit", () => r());
  });
}

const INIT = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "phase6" } } };

describe("Phase 6: MCP entitlement handshake", () => {
  it("rejects initialize with LICENSE_REQUIRED when no credential is present", async () => {
    const p = spawn(process.execPath, [SCRIPT], { cwd: path.dirname(SCRIPT), stdio: ["pipe", "pipe", "pipe"], env: envWith() });
    try {
      const r = await send(p, INIT);
      assert.equal(r.error.code, -32003);
      assert.equal(r.error.data.type, "LICENSE_REQUIRED");
      assert.match(r.error.message, /License required/);
    } finally { p.kill(); await wait(p); }
  });

  it("accepts initialize when MINITOK_ENTITLEMENT is set", async () => {
    const p = spawn(process.execPath, [SCRIPT], { cwd: path.dirname(SCRIPT), stdio: ["pipe", "pipe", "pipe"], env: envWith({ MINITOK_ENTITLEMENT: "phase6-token" }) });
    try {
      const r = await send(p, INIT);
      assert.ok(r.result, "initialize must succeed");
      assert.equal(r.result.serverInfo.name, "minitok-runtime");
    } finally { p.kill(); await wait(p); }
  });

  it("accepts the credential passed in initialize params", async () => {
    const p = spawn(process.execPath, [SCRIPT], { cwd: path.dirname(SCRIPT), stdio: ["pipe", "pipe", "pipe"], env: envWith() });
    try {
      const r = await send(p, { ...INIT, params: { ...INIT.params, entitlementToken: "params-token" } });
      assert.ok(r.result, "initialize with params credential must succeed");
    } finally { p.kill(); await wait(p); }
  });

  it("rejects a malformed credential with LICENSE_REQUIRED", async () => {
    const p = spawn(process.execPath, [SCRIPT], { cwd: path.dirname(SCRIPT), stdio: ["pipe", "pipe", "pipe"], env: envWith({ MINITOK_ENTITLEMENT: "   " }) });
    try {
      const r = await send(p, INIT);
      assert.equal(r.error.code, -32003);
      assert.equal(r.error.data.type, "LICENSE_REQUIRED");
    } finally { p.kill(); await wait(p); }
  });
});
