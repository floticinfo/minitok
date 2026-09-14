"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");
const { NONCE_PATTERN } = require("../../runtime/server");
const PID_FILE = path.join(os.homedir(), ".minitok", "runtime.pid");

function _processMatches(record) {
  try {
    if (process.platform === "win32") {
      const script = "$p = Get-CimInstance Win32_Process -Filter 'ProcessId=" + Number(record.pid) + "'; if ($null -eq $p) { exit 2 }; $p.CommandLine";
      const output = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 });
      const commandLine = output.toLowerCase();
      return commandLine.includes("minitok") && commandLine.includes("runtime");
    }
    const output = execFileSync("ps", ["-p", String(record.pid), "-o", "args="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 });
    const commandLine = output.toLowerCase();
    return commandLine.includes("minitok") && commandLine.includes("runtime");
  } catch {
    return false;
  }
}

function _readRecord(pidFile = PID_FILE) {
  try {
    const record = JSON.parse(fs.readFileSync(pidFile, "utf8"));
    if (!Number.isInteger(record.pid) || !record.nonce || !record.startedAt || !record.tokenFile) return null;
    return record;
  } catch { return null; }
}

function _getRuntimeToken(record) {
  try { return fs.readFileSync(record.tokenFile, "utf8").trim() || null; } catch { return null; }
}

function _recordMatches(current, expected) {
  return current && expected && current.pid === expected.pid && current.nonce === expected.nonce && current.tokenFile === expected.tokenFile;
}

function _cleanupRecord(record = _readRecord()) {
  const current = _readRecord();
  if (record && !_recordMatches(current, record)) return;
  if (!record) {
    try { fs.unlinkSync(PID_FILE); } catch {}
    return;
  }
  try { fs.unlinkSync(PID_FILE); } catch {}
  const after = _readRecord();
  if (!after) {
    try { fs.unlinkSync(record.tokenFile); } catch {}
  }
}

function _isRunning() {
  const record = _readRecord();
  if (!record || !NONCE_PATTERN.test(record.nonce)) {
    _cleanupRecord(record);
    return false;
  }
  try {
    process.kill(record.pid, 0);
    const running = _processMatches(record) && Boolean(_getRuntimeToken(record));
    if (!running) _cleanupRecord(record);
    return running;
  } catch { _cleanupRecord(record); return false; }
}

function _waitForExit(pid, attempts = 40) {
  for (let i = 0; i < attempts; i++) {
    try { process.kill(pid, 0); } catch { return true; }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  return false;
}

async function cmdRuntimeStart(opts) {
  if (_isRunning()) {
    const record = _readRecord();
    console.log(`minitok runtime already running (PID ${record?.pid ?? "?"})`);
    return 0;
  }

  // Local MCP scopes are opt-in; validate here so a typo fails immediately
  // instead of silently starting a read-only server (or throwing inside a
  // detached child, where the error would be invisible to the operator).
  const scopes = opts.scopes ? require("../../runtime/stdio").parseLocalMcpScopes(opts.scopes).join(",") : null;

  // P4: --detach launches the runtime as a background daemon instead of
  // blocking the terminal forever. The detached child re-enters this same
  // command without --detach and publishes runtime.pid/runtime.token;
  // ownership of those files is what "running" means everywhere else, so
  // stop/status keep working unchanged.
  if (opts.detach) {
    const { spawn } = require("child_process");
    const bin = path.resolve(String(process.argv[1] || ""));
    const port = String(opts.port ?? 4578);
    const args = [bin, "runtime", "start", "--port", port];
    if (opts.server) args.push("--server", String(opts.server));
    if (scopes) args.push("--scopes", scopes);
    if (opts.idleTimeoutMs !== undefined) args.push("--idle-timeout", String(Math.round(opts.idleTimeoutMs / 60000)));
    spawn(process.execPath, args, { stdio: "ignore", detached: true, windowsHide: true });
    for (let attempt = 0; attempt < 15; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const record = _readRecord();
      if (record && _isRunning()) {
        console.log(`minitok runtime started in background (PID ${record.pid}, port ${record.port || port})`);
        return 0;
      }
    }
    console.error("minitok runtime failed to start in background. Check ~/.minitok/runtime.pid and runtime.token.");
    return 1;
  }

  const { RuntimeServer } = require("../../runtime/server");
  const server = new RuntimeServer({
    port: opts.port ?? 4578,
    idleTimeoutMs: opts.idleTimeoutMs,
    knowledgePath: opts.knowledgePath,
    entitlementDir: opts.entitlementDir,
    serverUrl: opts.server,
    auditPath: opts.auditPath,
    runtimeToken: opts.runtimeToken || process.env.minitok_runtime_token,
    permissions: scopes || undefined,
  });
  await server.start();
  return new Promise(() => {});
}

async function cmdRuntimeStop() {
  const record = _readRecord();
  if (!record || !_isRunning()) {
    _cleanupRecord(record);
    console.log("minitok runtime is not running");
    return 0;
  }
  const token = _getRuntimeToken(record);
  if (!token || !NONCE_PATTERN.test(record.nonce)) { _cleanupRecord(record); return 1; }
  try {
    if (process.platform === "win32") execFileSync("taskkill", ["/PID", String(record.pid), "/T", "/F"], { stdio: "ignore" });
    else process.kill(record.pid, "SIGTERM");
  } catch { _cleanupRecord(record); return 1; }
  if (_waitForExit(record.pid)) {
    _cleanupRecord(record);
    console.log(`minitok runtime stopped (PID ${record.pid})`);
    return 0;
  }
  _cleanupRecord(record);
  return 1;
}

async function cmdRuntimeStatus() {
  const record = _readRecord();
  if (_isRunning()) console.log(`minitok runtime is running (PID ${record.pid})`);
  else console.log("minitok runtime is not running");
  return 0;
}

module.exports = { cmdRuntimeStart, cmdRuntimeStop, cmdRuntimeStatus, _waitForExit, _recordMatches, _processMatches, _isRunning };
