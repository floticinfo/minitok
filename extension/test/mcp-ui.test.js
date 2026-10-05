"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const sidebarHtml = fs.readFileSync(path.join(root, "src", "sidebar.html"), "utf8");
const sidebar = fs.readFileSync(path.join(root, "src", "sidebar.ts"), "utf8");

// MCP UI contract: the sidebar badge must be wired to the backend MCP commands.
// These assertions pin the message types and DOM updates that keep the badge
// in sync with the real MCP server state.

test("MCP badge has a click listener that posts mcp-status or mcp-connect", () => {
  assert.match(
    sidebarHtml,
    /getElementById\("mcpBadge"\)\?\.addEventListener\("click"/,
    "mcpBadge must have a click listener",
  );
  assert.match(
    sidebarHtml,
    /postMessage\(\{command:"mcp-status"\}\)/,
    "click must post mcp-status when already online",
  );
  assert.match(
    sidebarHtml,
    /postMessage\(\{command:"mcp-connect"\}\)/,
    "click must post mcp-connect when offline",
  );
});

test("MCP badge updates on 'mcp' message type", () => {
  assert.match(
    sidebarHtml,
    /if\(m\.type==='mcp'\)/,
    "message handler must process 'mcp' type",
  );
  assert.match(
    sidebarHtml,
    /badge\.className='badge '\+\(m\.ok\?'online':'offline'\)/,
    "badge className must switch between online and offline",
  );
  assert.match(
    sidebarHtml,
    /badge\.textContent=m\.ok\?'MCP online':'MCP offline'/,
    "badge text must reflect the connection state",
  );
});

test("MCP connect result shows a toast", () => {
  assert.match(
    sidebarHtml,
    /if\(m\.type==='mcp-connect'\)/,
    "message handler must process 'mcp-connect' type",
  );
  assert.match(
    sidebarHtml,
    /showToast\(m\.text\|\|'MCP connected\.',[^)]*\)/,
    "successful connect must show a toast",
  );
  assert.match(
    sidebarHtml,
    /showToast\(m\.text\|\|'MCP connection failed\.',[^)]*\)/,
    "failed connect must show a toast",
  );
});

test("MCP hosts list shows detected hosts", () => {
  assert.match(
    sidebarHtml,
    /if\(m\.type==='mcp-hosts'\)/,
    "message handler must process 'mcp-hosts' type",
  );
  assert.match(
    sidebarHtml,
    /Detected MCP hosts/,
    "mcp-hosts handler must display the detected hosts",
  );
});

test("resolveWebviewView probes MCP health on load", () => {
  assert.match(
    sidebar,
    /void this\.checkMcpHealth\(\)\.catch/,
    "resolveWebviewView must call checkMcpHealth to populate the badge",
  );
});

test("MCP badge starts in offline state", () => {
  assert.match(
    sidebarHtml,
    /class="badge offline"/,
    "initial badge class must be offline",
  );
  assert.match(
    sidebarHtml,
    /MCP: offline/,
    "initial badge text must be 'MCP: offline'",
  );
});

test("MCP badge resets to default when not entitled", () => {
  assert.match(
    sidebarHtml,
    /if\(!entitled\)\{const badge=document\.getElementById\('mcpBadge'\);badge\.className='badge';badge\.textContent='MCP';\}/,
    "not-entitled state must reset the badge to default",
  );
});

// --- Improvements from the MCP audit ---

test("connect sends a pending state so the badge cannot be double-triggered", () => {
  assert.match(
    sidebar,
    /postMessage\(\{ type: "mcp-connect", pending: true \}\)/,
    "connectMcp must announce a pending state before the slow dialog/CLI work",
  );
});

test("webview disables the badge and shows a busy style while connect is pending", () => {
  assert.match(
    sidebarHtml,
    /m\.pending\)\{badge\.classList\.add\('busy'\);badge\.disabled=true/,
    "pending connect must mark the badge busy and disabled",
  );
  assert.match(
    sidebarHtml,
    /\.badge\.busy\s*\{/,
    "a .badge.busy style must exist for the pending state",
  );
});

test("run completion updates the UI state", () => {
  assert.match(
    sidebarHtml,
    /if\(m\.type==='result'\)/,
    "message handler must process 'result' type",
  );
  assert.match(
    sidebarHtml,
    /running=false/,
    "result must clear the running flag",
  );
  assert.match(
    sidebarHtml,
    /stop\.disabled=true/,
    "result must disable the stop button",
  );
  assert.match(
    sidebarHtml,
    /run\.disabled=dry\.disabled=!entitledNow/,
    "result must re-enable run/dry buttons based on entitlement",
  );
  assert.match(
    sidebarHtml,
    /stage\.textContent=m\.ok\?'Done':'Failed'/,
    "result must show Done or Failed in the stage area",
  );
  assert.match(
    sidebarHtml,
    /stage\.className='task-status '\+\(m\.ok\?'success':'error'\)/,
    "result must apply the correct CSS class",
  );
  assert.match(
    sidebarHtml,
    /showToast\(displayText,m\.ok\?'info':'error'\)/,
    "result must show a toast with the outcome",
  );
});

test("successful connect re-resolves entitlement so the gate does not go stale", () => {
  const connectIdx = sidebar.indexOf('Connected to ${host}');
  assert.notStrictEqual(connectIdx, -1, "connect success message must exist");
  const after = sidebar.slice(connectIdx);
  assert.match(
    after,
    /await this\.refreshAuth\(\)/,
    "connectMcp must call refreshAuth after a successful connect",
  );
});

test("health check reports a missing CLI with an install hint", () => {
  assert.match(
    sidebar,
    /minitok CLI not found:.*npm install -g @flotic\/minitok/s,
    "cliPath failure must surface an actionable install hint",
  );
});

