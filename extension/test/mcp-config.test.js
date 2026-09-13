"use strict";
const path = require("node:path");
const fs = require("node:fs");
const test = require("node:test");
const assert = require("node:assert/strict");
const source = fs.readFileSync(path.join(__dirname, "..", "src", "workspace.ts"), "utf8");
const mcp = fs.readFileSync(path.join(__dirname, "..", "src", "mcp.ts"), "utf8");

test("packaged MCP runtime is resolved below the extension directory", () => {
  assert.match(source, /packagedMcpCommand/);
  assert.match(mcp, /runtime", "src", "runtime", "stdio-entry\.js/);
  assert.doesNotMatch(source, /\.\.\/\.\.\/src\/runtime\/stdio-entry/);
});

test("MCP command configuration supports quoted Windows paths and arrays", () => {
  assert.match(source, /parseMcpCommand/);
  assert.match(source, /string\[\]/);
  assert.match(mcp, /Unclosed quote/);
});

// Behavioural coverage: the source contract above cannot tell whether a Windows
// path survives parsing. A backslash before a non-special character is a path
// separator, not an escape, or the configured command silently becomes invalid.
const { parseMcpCommand } = require(path.join(__dirname, "..", "dist", "src", "mcp.js"));

test("quoted Windows paths keep their backslashes", () => {
  assert.deepEqual(parseMcpCommand('"C:\\Program Files\\nodejs\\node.exe" "C:\\ext\\runtime\\stdio-entry.js"'), ["C:\\Program Files\\nodejs\\node.exe", "C:\\ext\\runtime\\stdio-entry.js"]);
  assert.deepEqual(parseMcpCommand('C:\\tools\\node.exe --flag'), ["C:\\tools\\node.exe", "--flag"]);
  assert.deepEqual(parseMcpCommand('"C:\\a b\\node.exe"'), ["C:\\a b\\node.exe"]);
});

test("escapes still work where they are meaningful", () => {
  assert.deepEqual(parseMcpCommand('"C:\\\\double\\\\node.exe"'), ["C:\\double\\node.exe"]);
  assert.deepEqual(parseMcpCommand('"a\\"b"'), ['a"b']);
  assert.deepEqual(parseMcpCommand("'C:\\literal\\path'"), ["C:\\literal\\path"]);
  assert.deepEqual(parseMcpCommand("node /opt/minitok/entry.js"), ["node", "/opt/minitok/entry.js"]);
  assert.throws(() => parseMcpCommand('"unterminated'), /Unclosed quote/);
});
