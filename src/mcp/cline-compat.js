"use strict";

// Cline currently sends newer MCP protocol revisions than the runtime contract
// shipped by older minitok releases. This stdio bridge translates only the
// initialize protocol version and preserves the client's framing mode.
const { spawn } = require("node:child_process");
const targetCommand = process.env.MINITOK_MCP_TARGET_COMMAND || process.execPath;
let targetArgs;
try { targetArgs = JSON.parse(process.env.MINITOK_MCP_TARGET_ARGS || "[]"); } catch { process.stderr.write("Invalid MINITOK_MCP_TARGET_ARGS\n"); process.exit(1); }
if (!Array.isArray(targetArgs)) { process.stderr.write("MINITOK_MCP_TARGET_ARGS must be an array\n"); process.exit(1); }
const targetEnv = { ...process.env };
delete targetEnv.MINITOK_MCP_TARGET_COMMAND;
delete targetEnv.MINITOK_MCP_TARGET_ARGS;
const child = spawn(targetCommand, targetArgs, { env: targetEnv, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
child.stderr.on("data", chunk => process.stderr.write(chunk));
child.on("error", error => { process.stderr.write(`minitok bridge target error: ${error.message}\n`); process.exitCode = 1; });
child.on("exit", (code, signal) => { if (code !== 0 || signal) process.exitCode = code ?? 1; });
let input = Buffer.alloc(0);
let output = Buffer.alloc(0);
const pending = new Map();
function emit(message, mode) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  if (mode === "framed") process.stdout.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]));
  else process.stdout.write(Buffer.concat([body, Buffer.from("\n")]));
}
function send(message) { child.stdin.write(`${JSON.stringify(message)}\n`); }
function handle(message, mode) {
  if (!message || typeof message !== "object" || Array.isArray(message)) return;
  if (message.method === "initialize" && message.params && typeof message.params === "object") {
    const params = { ...message.params };
    const requested = Array.isArray(params.protocolVersions) ? params.protocolVersions : [params.protocolVersion];
    const original = requested.find(value => typeof value === "string") || "2024-11-05";
    if (message.id !== undefined) pending.set(String(message.id), { mode, original });
    params.protocolVersion = "2024-11-05";
    delete params.protocolVersions;
    send({ ...message, params });
    return;
  }
  if (message.id !== undefined) pending.set(String(message.id), { mode });
  send(message);
}
function drainInput() {
  while (input.length) {
    const framed = /^Content-Length\s*:/i.test(input.toString("utf8", 0, Math.min(input.length, 64)));
    if (framed) {
      const end = input.indexOf(Buffer.from("\r\n\r\n"));
      if (end < 0) return;
      const header = input.subarray(0, end).toString("ascii");
      const match = header.match(/(?:^|\r\n)Content-Length\s*:\s*(\d+)/i);
      if (!match) { process.stderr.write("Invalid MCP Content-Length header\n"); process.exitCode = 1; return; }
      const length = Number(match[1]); const start = end + 4;
      if (!Number.isSafeInteger(length) || input.length < start + length) return;
      const body = input.subarray(start, start + length).toString("utf8"); input = input.subarray(start + length);
      try { handle(JSON.parse(body), "framed"); } catch { process.stderr.write("Invalid MCP JSON request\n"); }
    } else {
      const end = input.indexOf(10); if (end < 0) return;
      const line = input.subarray(0, end).toString("utf8").trim(); input = input.subarray(end + 1);
      if (!line) continue;
      try { handle(JSON.parse(line), "newline"); } catch { process.stderr.write("Invalid MCP JSON request\n"); }
    }
  }
}
process.stdin.on("data", chunk => { input = Buffer.concat([input, chunk]); drainInput(); });
process.stdin.on("end", () => child.stdin.end());
function drainOutput() {
  while (output.length) {
    const newline = output.indexOf(10);
    if (newline >= 0 && !/^Content-Length\s*:/i.test(output.toString("utf8", 0, Math.min(output.length, 64)))) {
      const line = output.subarray(0, newline).toString("utf8").trim(); output = output.subarray(newline + 1); if (!line) continue;
      try { const message = JSON.parse(line); const state = message.id === undefined ? null : pending.get(String(message.id)); if (state) { pending.delete(String(message.id)); if (message.result?.protocolVersion && state.original) message.result.protocolVersion = state.original; emit(message, state.mode); } else emit(message, "newline"); } catch { process.stderr.write("Invalid MCP JSON response\n"); }
      continue;
    }
    const end = output.indexOf(Buffer.from("\r\n\r\n")); if (end < 0) return;
    const header = output.subarray(0, end).toString("ascii"); const match = header.match(/(?:^|\r\n)Content-Length\s*:\s*(\d+)/i); if (!match) return;
    const length = Number(match[1]); const start = end + 4; if (!Number.isSafeInteger(length) || output.length < start + length) return;
    const body = output.subarray(start, start + length).toString("utf8"); output = output.subarray(start + length);
    try { const message = JSON.parse(body); const state = message.id === undefined ? null : pending.get(String(message.id)); if (state) { pending.delete(String(message.id)); if (message.result?.protocolVersion && state.original) message.result.protocolVersion = state.original; emit(message, state.mode); } else emit(message, "framed"); } catch { process.stderr.write("Invalid framed MCP response\n"); }
  }
}
child.stdout.on("data", chunk => { output = Buffer.concat([output, chunk]); drainOutput(); });
