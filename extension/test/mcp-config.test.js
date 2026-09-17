"use strict";
const path = require("node:path");
const fs = require("node:fs");
const test = require("node:test");
const assert = require("node:assert/strict");
const source = fs.readFileSync(path.join(__dirname, "..", "src", "workspace.ts"), "utf8");
const sidebarSource = fs.readFileSync(path.join(__dirname, "..", "src", "sidebar.ts"), "utf8");
const mcp = fs.readFileSync(path.join(__dirname, "..", "src", "mcp.ts"), "utf8");

test("host diagnostics are excluded from packaged Extension payloads", () => {
  const ignore = fs.readFileSync(path.join(__dirname, "..", ".vscodeignore"), "utf8");
  assert.match(ignore, /host-\*\.log/);
  assert.match(ignore, /host-\*\.err/);
  assert.match(ignore, /host-\*\.pid/);
});

test("packaged MCP runtime is resolved below the extension directory", () => {
  assert.match(source, /packagedMcpCommand/);
  assert.match(mcp, /runtime", "src", "runtime", "stdio-entry\.js/);
  assert.doesNotMatch(source, /\.\.\/\.\.\/src\/runtime\/stdio-entry/);
});

test("MCP subprocess environment is allowlisted and does not inherit arbitrary secrets", () => {
  assert.match(source, /MCP_ENV_ALLOWLIST/);
  assert.match(source, /inheritedMcpEnvironment/);
  assert.doesNotMatch(source, /return \{\.\.\.process\.env,\s*minitok_server_url/);
});

test("MCP command configuration propagates and persists the trusted workspace root", () => {
  assert.match(source, /MINITOK_MCP_WORKSPACE_ROOT/);
  assert.match(sidebarSource, /configuredEnv\.MINITOK_MCP_WORKSPACE_ROOT/);
  assert.match(fs.readFileSync(path.join(__dirname, "..", "src", "extension.ts"), "utf8"), /--workspace-root/);
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
