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

test("workspace-relative extension paths stay inside the workspace", () => {
  assert.match(source, /export function workspaceRelativePath/);
  assert.match(source, /must stay inside the workspace/);
  assert.match(sidebarSource, /Checkpoint must stay under workspace/);
});

test("ordinary CLI subprocesses use an allowlist and bounded output", () => {
  assert.match(source, /const CLI_ENV_ALLOWLIST/);
  assert.match(source, /const CLI_EXPLICIT_ENV/);
  assert.match(source, /MINITOK_MCP_AUTH_TOKEN_FILE/);
  assert.match(source, /MINITOK_MCP_SCOPES/);
  assert.match(source, /MINITOK_MCP_WORKSPACE_ROOT/);
  assert.match(source, /appendBoundedOutput/);
  assert.match(sidebarSource, /output = appendBoundedOutput\(output, text\)/);
  assert.match(sidebarSource, /error = appendBoundedOutput\(error, text\)/);
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
  // The parser throws for an unterminated quote, so every call site that
  // builds the command from settings must catch it instead of letting the
  // error escape as an unhandled rejection in a command handler.
  const extensionSource = fs.readFileSync(path.join(__dirname, "..", "src", "extension.ts"), "utf8");
  for (const file of [extensionSource, sidebarSource]) {
    const sites = file.match(/=\s*mcpCommand\(\);/g) || [];
    const guarded = file.match(/try\s*\{\s*\w+\s*=\s*mcpCommand\(\);\s*\}\s*catch/g) || [];
    assert.equal(sites.length > 0, true, "mcpCommand must be called from settings-backed flows");
    assert.equal(guarded.length, sites.length, `every mcpCommand() call must be wrapped in try/catch (${guarded.length} of ${sites.length})`);
  }

test("MCP badge updates aria-label and title on state change", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "src", "sidebar.html"), "utf8");
  assert.match(html, /badge\.title\s*=\s*'MCP '\s*\+\s*state/);
  assert.match(html, /badge\.setAttribute\('aria-label',/);
});

test("MCP connect failures carry actionable guidance", () => {
  const sidebarSource = fs.readFileSync(path.join(__dirname, "..", "src", "sidebar.ts"), "utf8");
  assert.match(sidebarSource, /action: "open-settings"/);
  assert.match(sidebarSource, /action: "sign-in"/);
  assert.match(sidebarSource, /action: "retry"/);
});

test("MCP connect success triggers mcp-status refresh", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "src", "sidebar.html"), "utf8");
  assert.match(html, /if\(m\.ok\)\{showToast\(m\.text\|\|'MCP connected\.','info'\);vscode\.postMessage\(\{command:'mcp-status'\}\)\}/);
});

test("Panel webview shows MCP status badge", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "src", "panel.html"), "utf8");
  assert.match(html, /id="mcpStatus"/);
  assert.match(html, /vscode\.postMessage\(\{command:'mcp-status'\}\)/);
});

test("MCP process lifecycle uses killProcessTree and disposes on view close", () => {
  // C-1: mcpStatus must kill the whole tree, not just the direct child.
  assert.match(extensionSource, /killProcessTree\(child\)/);
  assert.doesNotMatch(extensionSource, /const finish = \(text: string\).*child\.kill\(\)/);
  // C-2: the sidebar must dispose MCP processes when the webview closes.
  assert.match(sidebarSource, /view\.onDidDispose\(\(\) => this\.dispose\(\)\)/);
  assert.match(sidebarSource, /this\.stopChild\(this\.mcpProcess\)/);
  // M-1: handshake timeout retries with cleanup.
  assert.match(sidebarSource, /retrying \(\$\{retryCount \+ 1\}\/2\)/);

test("MCP token refresh failure is surfaced to the user", () => {
  assert.match(source, /reject\(error\)/);
  assert.match(source, /minitok mcp token timed out/);
  assert.match(source, /minitok mcp token exited with code/);
});

test("MCP runtime token directory uses restricted permissions", () => {
  assert.match(source, /fs\.mkdirSync\(dir, \{ recursive: true, mode: 0o700 \}\)/);
});

test("MCP command change prompts for confirmation", () => {
  const sidebarSource = fs.readFileSync(path.join(__dirname, "..", "src", "sidebar.ts"), "utf8");
  assert.match(sidebarSource, /differs from the default/);
  assert.match(sidebarSource, /showWarningMessage/);
});

test("package.json mcpCommand description includes security warning", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
  const description = pkg.contributes.configuration.properties["minitok.mcpCommand"].description;
  assert.match(description, /user permissions/);
  assert.match(description, /Only configure a command you trust/);
});

test("redactSensitiveText redacts Windows user home paths", () => {
  const redact = require(path.join(__dirname, "..", "dist", "src", "redaction.js"));
  const redacted = redact.redactSensitiveText("MINITOK_MCP_AUTH_TOKEN_FILE=C:\\Users\\J1\\.minitok\\mcp\\runtime-token.json");
  assert.match(redacted, /C:\\Users\\\[USER\]/);
});

test("expired MCP token triggers refresh and surfaces failure", () => {
  // mcpAuthToken must return undefined for expired tokens so ensureMcpAuthToken
  // falls through to refreshRuntimeToken, which now rejects on failure.
  assert.match(source, /Date\.now\(\) >= value\.expires_at/);
  assert.match(source, /await refreshRuntimeToken\(\)/);
  assert.match(source, /return mcpAuthToken\(\)/);
});

test("sidebar dispose calls killProcessTree for MCP process", () => {
  // dispose() must route the MCP probe through the same tree-kill path as
  // run-process timeouts, not just child.kill().
  assert.match(sidebarSource, /this\.stopChild\(this\.mcpProcess\)/);
  const runProcess = fs.readFileSync(path.join(__dirname, "..", "src", "run-process.ts"), "utf8");
  assert.match(runProcess, /killProcessTree/);
});
  assert.match(sidebarSource, /this\.stopChild\(mcp\)/);
  // M-2: spawn failures map ENOENT/EACCES to user-friendly text.
  assert.match(sidebarSource, /MCP command not found\. Check minitok\.mcpCommand setting\./);
  assert.match(sidebarSource, /MCP command permission denied\. Check file permissions\./);
});

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
  // Single quotes are quote delimiters, not escapes (as in POSIX shells), so
  // interior backslashes keep their path-separator meaning inside the span.
  assert.deepEqual(parseMcpCommand("'C:\literal\path'"), ["C:\literal\path"]);
  assert.deepEqual(parseMcpCommand("node /opt/minitok/entry.js"), ["node", "/opt/minitok/entry.js"]);
  assert.throws(() => parseMcpCommand('"unterminated'), /Unclosed quote/);
});
