"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const output = require("../src/cli/output");

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, "g");
const strip = s => s.replace(ANSI, "");

// A fake stream lets us flip isTTY without monkey-patching the real stdout.
const ttyStream = { isTTY: true };
const pipeStream = { isTTY: false };

test("color is enabled only on a TTY with no NO_COLOR override", () => {
  assert.equal(output.colorEnabled({}, ttyStream), true);
  assert.equal(output.colorEnabled({}, pipeStream), false);
  assert.equal(output.colorEnabled({ NO_COLOR: "1" }, ttyStream), false);
  assert.equal(output.colorEnabled({ MINITOK_NO_COLOR: "1" }, ttyStream), false);
  assert.equal(output.colorEnabled({ NO_COLOR: "0" }, ttyStream), true, "NO_COLOR=0 must not disable colour");
});

test("markers stay plain and byte-identical when colour is off", () => {
  assert.equal(output.markerError(false), "[error]");
  assert.equal(output.markerOk(false), "[ok]");
});

test("markers are tinted red/green on a TTY and strip back to plain text", () => {
  const e = output.markerError(true);
  const o = output.markerOk(true);
  assert.ok(e.includes("\x1b[31m"), "error marker uses the terminal red, not a brand hue");
  assert.ok(o.includes("\x1b[32m"), "ok marker uses the terminal green, not a brand hue");
  assert.equal(strip(e), "[error]");
  assert.equal(strip(o), "[ok]");
});

test("brand badge paints a primary tile with an onPrimary glyph (never text-only dark hue)", () => {
  const badge = output.markerBrand("minitok", true);
  assert.ok(badge.includes("\x1b[48;2;"), "badge paints a background tile");
  assert.ok(badge.includes("\x1b[38;2;"), "badge paints an onPrimary foreground");
  assert.equal(strip(badge), " minitok ");
});

test("printError/printOk emit the same visible text with colour on or off", () => {
  const lines = [];
  const savedLog = console.log;
  const savedErr = console.error;
  console.log = m => lines.push(m);
  console.error = m => lines.push(m);
  try {
    output.printOk("ready", false);
    output.printError("broken", false);
    output.printOk("ready", true);
    output.printError("broken", true);
    output.ok("alias", false);
  } finally {
    console.log = savedLog;
    console.error = savedErr;
  }
  assert.equal(lines[0], "[ok] ready");
  assert.equal(lines[1], "[error] broken");
  assert.equal(strip(lines[2]), "[ok] ready");
  assert.equal(strip(lines[3]), "[error] broken");
  assert.equal(lines[4], "[ok] alias", "ok() remains as a short alias for printOk");
});
