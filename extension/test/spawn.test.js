"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

// The compiled module is required so the real implementation runs, not a copy.
const { spawnSpecFor, npmSpawnSpec, batchCommandLine, quoteCmdArg } = require(path.join(__dirname, "..", "dist", "src", "spawn.js"));

const CLI = path.join(__dirname, "..", "..", "bin", "minitok.js");
const NODE = process.execPath;
const COMSpec = process.env.ComSpec || "cmd.exe";
const launch = (platform, command, args) => spawnSpecFor(platform, command, args, { comspec: COMSpec, nodePath: NODE });

test("a .cmd shim is handed to cmd.exe verbatim", () => {
  const spec = launch("win32", "C:\\npm\\minitok.cmd", ["run", "fix the build"]);
  assert.equal(spec.shell, false);
  assert.equal(spec.command, COMSpec);
  assert.equal(spec.windowsVerbatimArguments, true, "Node must not escape the command line for cmd.exe");
  assert.deepEqual(spec.args.slice(0, 3), ["/d", "/s", "/c"]);
  assert.equal(spec.args[3], batchCommandLine("C:\\npm\\minitok.cmd", ["run", "fix the build"]));
  assert.equal(spec.args[3], 'call "C:\\npm\\minitok.cmd" "run" "fix the build"');
});

test("a JavaScript entry is launched with node instead of cmd.exe", () => {
  const spec = launch("win32", "C:\\npm\\node_modules\\@flotic\\minitok\\bin\\minitok.js", ["status"]);
  assert.equal(spec.command, NODE);
  assert.deepEqual(spec.args, ["C:\\npm\\node_modules\\@flotic\\minitok\\bin\\minitok.js", "status"]);
  assert.equal(spec.windowsVerbatimArguments, false);
  assert.equal(launch("linux", "/usr/lib/node_modules/@flotic/minitok/bin/minitok.js", ["status"]).command, NODE);
});

test("a native executable is launched directly on every platform", () => {
  for (const platform of ["win32", "linux", "darwin"]) {
    const spec = launch(platform, "minitok.exe", ["--version"]);
    assert.equal(spec.command, "minitok.exe");
    assert.deepEqual(spec.args, ["--version"]);
    assert.equal(spec.windowsVerbatimArguments, false);
  }
  assert.deepEqual(launch("linux", "minitok", ["--version"]).args, ["--version"]);
});

test("npm is launched through its batch shim on Windows and directly elsewhere", () => {
  const windows = npmSpawnSpec("win32", ["view", "@flotic/minitok", "version"], { comspec: COMSpec });
  assert.equal(windows.command, COMSpec);
  assert.equal(windows.windowsVerbatimArguments, true);
  assert.match(windows.args[3], /^call "npm\.cmd"/);
  const posix = npmSpawnSpec("linux", ["view", "@flotic/minitok", "version"]);
  assert.equal(posix.command, "npm");
  assert.equal(posix.windowsVerbatimArguments, false);
});

test("cmd metacharacters are refused for a batch shim but fine for a JavaScript entry", () => {
  const task = 'add "x" & calc';
  assert.throws(() => launch("win32", "minitok.cmd", ["run", task]), /batch shim/);
  assert.throws(() => launch("win32", "minitok.bat", ["run", "100% sure"]), /batch shim/);
  // The same argument is safe when node receives it directly, which is why the
  // resolver prefers the package's JavaScript entry point.
  const spec = launch("win32", "C:\\pkg\\node_modules\\@flotic\\minitok\\bin\\minitok.js", ["run", task]);
  assert.equal(spec.command, NODE);
  assert.deepEqual(spec.args, ["C:\\pkg\\node_modules\\@flotic\\minitok\\bin\\minitok.js", "run", task]);
});

test("quoting never lets a task break out of its argument", () => {
  assert.equal(quoteCmdArg("plain"), '"plain"');
  assert.equal(batchCommandLine("minitok.cmd", ["run", "fix the build"]), 'call "minitok.cmd" "run" "fix the build"');
  // An argument the shim can transport safely stays quoted as a single token.
  const spec = launch("win32", "minitok.cmd", ["run", "fix build", "--repo", "C:\\repo path"]);
  assert.equal(spec.args[3], 'call "minitok.cmd" "run" "fix build" "--repo" "C:\\repo path"');
});

test("the real CLI launches through a .cmd shim and through node", { skip: process.platform !== "win32" }, () => {
  const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), "minitok-shim-"));
  try {
    const shim = path.join(shimDir, "minitok.cmd");
    fs.writeFileSync(shim, `@ECHO off\r\n"${NODE}" "${CLI}" %*\r\n`);

    // Before the fix this returned exit code 1 with
    // 'call \"...minitok.cmd\"' is not recognized as an internal or external command.
    const viaShim = spawnSync(...specArgs(launch("win32", shim, ["--version"])));
    assert.equal(viaShim.status, 0, `shim launch failed: ${viaShim.stderr}`);
    assert.match(String(viaShim.stdout).trim(), /^minitok \d+\.\d+\.\d+/);

    const viaNode = spawnSync(...specArgs(launch("win32", CLI, ["--version"])));
    assert.equal(viaNode.status, 0, `node launch failed: ${viaNode.stderr}`);
    assert.match(String(viaNode.stdout).trim(), /^minitok \d+\.\d+\.\d+/);
  } finally {
    fs.rmSync(shimDir, { recursive: true, force: true });
  }
});

test("a task containing a quote and a shell metacharacter reaches a node entry intact", { skip: process.platform !== "win32" }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "minitok-args-"));
  try {
    // A stand-in for the CLI that echoes the argv it received, so the assertion
    // covers argument transport instead of the CLI's own behaviour.
    const echo = path.join(dir, "echo.js");
    fs.writeFileSync(echo, "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n");

    const args = ["run", 'fix the "a & b" parser', "--repo", "C:\\repo path"];
    const result = spawnSync(...specArgs(launch("win32", echo, args)));
    assert.equal(result.status, 0, `launch failed: ${result.stderr}`);
    assert.deepEqual(JSON.parse(String(result.stdout)), args, "every argument must arrive intact");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function specArgs(spec) {
  const options = { encoding: "utf8", windowsHide: true, timeout: 20000, windowsVerbatimArguments: spec.windowsVerbatimArguments, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } };
  return [spec.command, spec.args, options];
}
