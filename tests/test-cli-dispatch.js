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

