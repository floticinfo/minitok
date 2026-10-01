"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const bin = path.resolve(__dirname, "../bin/minitok.js");

test("bare non-TTY invocation exits with guidance and does not create state", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "minitok-cli-"));
  const result = spawnSync(process.execPath, [bin], { env: { ...process.env, HOME: home, USERPROFILE: home, MINITOK_UPDATE_CHECK: "0" }, encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.match(`${result.stdout}${result.stderr}`, /minitok gui|--task/);
  assert.equal(fs.existsSync(path.join(home, ".minitok")), false);
});

test("ui is an explicit alias for gui", () => {
  const result = spawnSync(process.execPath, [bin, "ui", "--help"], { encoding: "utf8" });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Open the minitok terminal interface/);
});

test("help and version avoid update checks", () => {
  for (const args of [["--help"], ["--version"]]) {
    const result = spawnSync(process.execPath, [bin, ...args], { env: { ...process.env, MINITOK_UPDATE_CHECK: "1" }, encoding: "utf8" });
    assert.equal(result.status, 0);
  }
});

test("an unknown command is reported instead of reaching the default action", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "minitok-cli-"));
  try {
    const result = spawnSync(process.execPath, [bin, "statsu"], { env: { ...process.env, HOME: home, USERPROFILE: home, MINITOK_UPDATE_CHECK: "0" }, encoding: "utf8" });
    const output = `${result.stdout}${result.stderr}`;
    // commander routes an unmatched command to the default action, which used to
    // print the bare-invocation hint (or open the GUI on a TTY) for a typo.
    assert.equal(result.status, 1);
    assert.match(output, /unknown command 'statsu'/);
    assert.doesNotMatch(output, /Bare non-TTY usage/);
    assert.doesNotMatch(output, /minitok gui/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("a typo in a valid command name is still rejected", () => {
  const result = spawnSync(process.execPath, [bin, "runx", "task"], { env: { ...process.env, MINITOK_UPDATE_CHECK: "0" }, encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(`${result.stdout}${result.stderr}`, /unknown command 'runx'/);
});

test("an option value after a boolean flag is not mistaken for a command", () => {
  // The unknown-command scan used to treat the first bare token as a command,
  // so `minitok --no-mcp-setup statsu` reported "unknown command 'statsu'"
  // only by accident — a value-taking option in between would have shifted the
  // blame to the option value. The scan now skips boolean flags and keeps
  // looking for a genuine positional argument.
  const result = spawnSync(process.execPath, [bin, "--no-mcp-setup", "statsu"], { env: { ...process.env, MINITOK_UPDATE_CHECK: "0" }, encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(`${result.stdout}${result.stderr}`, /unknown command 'statsu'/);
});

test("a bare boolean top-level flag alone is not reported as an unknown command", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "minitok-cli-"));
  try {
    const result = spawnSync(process.execPath, [bin, "--no-mcp-setup"], { env: { ...process.env, HOME: home, USERPROFILE: home, MINITOK_UPDATE_CHECK: "0" }, encoding: "utf8" });
    // No positional argument exists, so the default action must fall through to
    // the bare non-TTY guidance instead of an "unknown command" error.
    assert.equal(result.status, 2);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /unknown command/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("runtime start exposes an idle shutdown control", () => {
  // The fixed 30 minute idle shutdown silently stopped a runtime a client had
  // configured, so it has to be visible and adjustable.
  const result = spawnSync(process.execPath, [bin, "runtime", "start", "--help"], { encoding: "utf8" });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /--idle-timeout <minutes>/);
  assert.match(result.stdout, /0 disables/);
});

test("runtime start rejects a non-numeric --port instead of falling back to 4578", () => {
  // `--port abc` used to become `parseInt("abc", 10) || 4578` and silently start
  // on the default port, so a typo looked like a successful custom launch.
  const result = spawnSync(process.execPath, [bin, "runtime", "start", "--port", "abc"], { env: { ...process.env, MINITOK_UPDATE_CHECK: "0" }, encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(`${result.stdout}${result.stderr}`, /invalid --port 'abc'/);
});

test("runtime start rejects an out-of-range --port", () => {
  const result = spawnSync(process.execPath, [bin, "runtime", "start", "--port", "99999"], { env: { ...process.env, MINITOK_UPDATE_CHECK: "0" }, encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(`${result.stdout}${result.stderr}`, /invalid --port '99999'/);
});

test("runtime start rejects a non-numeric --idle-timeout instead of ignoring it", () => {
  // `--idle-timeout xyz` used to produce NaN and silently keep the 30 minute
  // default, so an explicit disable request was dropped without any feedback.
  const result = spawnSync(process.execPath, [bin, "runtime", "start", "--idle-timeout", "xyz"], { env: { ...process.env, MINITOK_UPDATE_CHECK: "0" }, encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(`${result.stdout}${result.stderr}`, /invalid --idle-timeout 'xyz'/);
});

test("mcp exposes a runtime token refresh command", () => {
  const result = spawnSync(process.execPath, [bin, "mcp", "--help"], { encoding: "utf8" });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /token/);
});

