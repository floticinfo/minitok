"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const path = require("node:path");

function frame(value) {
  const body = Buffer.from(JSON.stringify(value));
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]);
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
