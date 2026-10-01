"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const path = require("node:path");

function frame(value) {
  const body = Buffer.from(JSON.stringify(value));
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]);
}

const bridgePath = path.resolve(__dirname, "../src/mcp/cline-compat.js");
const SILENT_TARGET = ["-e", "setInterval(() => {}, 1000)"];

function spawnBridge(targetArgs, extra = [], extraEnv = {}) {
  return spawn(process.execPath, extra.concat([bridgePath]), {
    env: { ...process.env, MINITOK_MCP_TARGET_COMMAND: process.execPath, MINITOK_MCP_TARGET_ARGS: JSON.stringify(targetArgs), ...extraEnv },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
}

test("Cline bridge translates initialize and preserves framed responses", async () => {
  const bridge = path.resolve(__dirname, "../src/mcp/cline-compat.js");
  const mock = "process.stdin.setEncoding('utf8'); let b=''; process.stdin.on('data',c=>{b+=c; for(const l of b.split('\\n').slice(0,-1)){try{const m=JSON.parse(l); process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{protocolVersion:'2024-11-05',serverInfo:{name:'mock'}}})+'\\n')}catch{}} b=b.split('\\n').slice(-1)[0]})";
  const child = spawn(process.execPath, [bridge], {
    env: { ...process.env, MINITOK_MCP_TARGET_COMMAND: process.execPath, MINITOK_MCP_TARGET_ARGS: JSON.stringify(["-e", mock]) },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let output = Buffer.alloc(0);
  const response = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("bridge response timeout")), 3000);
    child.stdout.on("data", chunk => {
      output = Buffer.concat([output, chunk]);
      const end = output.indexOf(Buffer.from("\r\n\r\n"));
      if (end < 0) return;
      const match = output.subarray(0, end).toString().match(/Content-Length:\s*(\d+)/i);
      if (!match) return reject(new Error("missing framed response"));
      const start = end + 4; const length = Number(match[1]);
      if (output.length < start + length) return;
      clearTimeout(timer);
      resolve(JSON.parse(output.subarray(start, start + length).toString("utf8")));
    });
    child.on("error", reject);
  });
  try {
    child.stdin.write(frame({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {} } }));
    const result = await response;
    assert.equal(result.result.protocolVersion, "2025-06-18");
    assert.equal(result.result.serverInfo.name, "mock");
  } finally {
    child.kill();
  }
});

// Attach a stdout accumulator BEFORE writing so no data event is missed, then
// wait until `count` newline-delimited JSON messages have been collected.
function collectMessages(child, count, timeoutMs = 5000) {
  const messages = [];
  let rest = "";
  child.stdout.on("data", chunk => {
    rest += chunk.toString("utf8");
    const parts = rest.split("\n");
    rest = parts.pop();
    for (const line of parts) if (line.trim()) messages.push(JSON.parse(line));
  });
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const tick = async () => {
      while (Date.now() < deadline) {
        if (messages.length >= count) return resolve(messages);
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      reject(new Error(`timed out waiting for ${count} bridge messages (got ${messages.length})`));
    };
    tick();
  });
}

test("Cline bridge rejects requests beyond the pending limit with a JSON-RPC error", async () => {
  const child = spawnBridge(SILENT_TARGET, [], { MINITOK_BRIDGE_MAX_PENDING_REQUESTS: "8" });
  try {
    // With the pending cap lowered to 8, ids 9..24 against a silent target are
    // rejected with a JSON-RPC error instead of growing the pending map.
    const collected = collectMessages(child, 16);
    let payload = "";
    for (let id = 1; id <= 24; id++) payload += `${JSON.stringify({ jsonrpc: "2.0", id, method: "tools/list", params: {} })}\n`;
    child.stdin.write(payload);
    const rejected = (await collected).map(message => message.id);
    assert.equal(rejected.length, 16);
    assert.deepEqual(rejected, Array.from({ length: 16 }, (_, index) => index + 9));
  } finally {
    child.kill();
  }
});

test("Cline bridge discards oldest input bytes when the host buffer exceeds the cap", async () => {
  // Echo target answers each request line with a matching response.
  const echoTarget = ["-e", "process.stdin.setEncoding('utf8'); let b=''; process.stdin.on('data',c=>{b+=c; const parts=b.split('\\n'); b=parts.pop(); for(const l of parts){try{const m=JSON.parse(l); process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{ok:true}})+'\\n')}catch{}}})"];
  const child = spawnBridge(echoTarget, [], { MINITOK_BRIDGE_MAX_BUFFER_BYTES: "1024" });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk.toString("utf8"); });
  try {
    // 2KB of newline-free garbage exceeds the 1KB input buffer cap, so the
    // bridge discards the oldest bytes. The session must stay alive and keep
    // relaying: a follow-up request after the discard is still answered.
    const collected = collectMessages(child, 1);
    child.stdin.write(Buffer.alloc(2 * 1024, 0x78));
    const deadline = Date.now() + 5000;
    while (!/input buffer exceeded 1024 bytes, discarding buffered data/.test(stderr) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    assert.match(stderr, /input buffer exceeded 1024 bytes, discarding buffered data/);
    await new Promise(resolve => setTimeout(resolve, 100));
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: {} })}\n`);
    const [message] = await collected;
    assert.equal(message.id, 1);
    assert.equal(message.result.ok, true);
  } finally {
    child.kill();
  }
});

test("Cline bridge terminates the target when its output buffer exceeds the cap", async () => {
  const floodTarget = ["-e", "process.stdout.write(Buffer.alloc(64*1024,0x78))"];
  const child = spawnBridge(floodTarget, [], { MINITOK_BRIDGE_MAX_BUFFER_BYTES: "1024" });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk.toString("utf8"); });
  try {
    // A 64KB flood against a 1KB cap triggers target termination: the bridge
    // logs the termination instead of buffering unboundedly. The bridge stays
    // alive to keep relaying stdin until the host closes it.
    const deadline = Date.now() + 5000;
    while (!/output buffer exceeded 1024 bytes, terminating unresponsive target/.test(stderr) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    assert.match(stderr, /output buffer exceeded 1024 bytes, terminating unresponsive target/);
  } finally {
    child.kill();
  }
});
