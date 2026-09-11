"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const panel = fs.readFileSync(path.join(root, "src", "panel.ts"), "utf8");
const sidebar = fs.readFileSync(path.join(root, "src", "sidebar.ts"), "utf8");
const extension = fs.readFileSync(path.join(root, "src", "extension.ts"), "utf8");
const entitlement = fs.readFileSync(path.join(root, "src", "entitlement.ts"), "utf8");
const sidebarHtml = fs.readFileSync(path.join(root, "src", "sidebar.html"), "utf8");
const panelHtml = fs.readFileSync(path.join(root, "src", "panel.html"), "utf8");
const workspace = fs.readFileSync(path.join(root, "src", "workspace.ts"), "utf8");

test("panel process lifecycle contract", () => {
  assert.match(panel, /setTimeout\([\s\S]*?1800000/);
  assert.match(panel, /detached:\s*process\.platform !== "win32"/);
  assert.match(panel, /spawnSpec/);
  assert.match(sidebar, /spawnSpec/);
  assert.match(workspace, /ComSpec/);
  assert.match(panel, /taskkill/);
  assert.match(panel, /A minitok run is already active/);
  assert.match(panel, /\["status", "--repo", cwd!\]/);
  assert.match(panel, /\["run", message\.task, "--repo", cwd!\]/);
  assert.match(sidebar, /\["run", message\.task, "--repo", cwd!\]/);
});

test("extension entitlement contract", () => {
  assert.match(extension, /checkEntitlement/);
  assert.match(extension, /requireEntitlement/);
  assert.match(extension, /await requireEntitlement\(\)/);
  assert.match(extension, /An active paid minitok plan is required/);
  assert.match(entitlement, /status/, "entitlement preflight must query CLI status");
  assert.match(entitlement, /entitlement\.allowed === true/);
});

test("extension approval response contract", () => {
  assert.match(sidebar, /decision: message\.command, nonce: request\.nonce, run_id: request\.run_id/);
});

test("first-run authentication UI contract", () => {
  assert.match(sidebarHtml, /id="authGate"/);
  assert.match(sidebarHtml, /customer-login/);
  assert.match(sidebarHtml, /auth-status/);
  assert.match(sidebar, /customerLogin/);
});

test("webview accessibility contract", () => {
  for (const html of [panelHtml, sidebarHtml]) {
    assert.match(html, /aria-live=/);
    assert.match(html, /<label[^>]+for="task"/);
    assert.match(html, /type="button"/);
  }
  assert.match(panelHtml, /role="status"/);
  assert.match(sidebarHtml, /role="alert"/);
  assert.match(sidebarHtml, /approval.*focus\(\)/);
});

test("shared entitlement preflight contract", () => {
  assert.match(entitlement, /export async function requireEntitlement/);
  assert.match(panel, /await requireEntitlement\(\)/);
  assert.match(sidebar, /await requireEntitlement\(\)/);
  assert.match(sidebar, /entitlementCommands/);
});

test("MCP stdio transport contract", () => {
  assert.match(workspace, /packagedMcpCommand/);
  assert.doesNotMatch(workspace, /runtime start/);
  assert.match(workspace, /MINITOK_MCP_AUTH_TOKEN_FILE/);
  assert.match(extension, /mcpAuthToken\(\)/);
  assert.match(extension, /method: "initialize"/);
  assert.match(extension, /method: "tools\/list"/);
  assert.match(sidebar, /mcpAuthToken\(\)/);
  assert.match(sidebar, /mcpEnvironment\(\)/);
  assert.match(sidebar, /configuredMcp\[0\]/);
  assert.match(sidebar, /MINITOK_MCP_AUTH_TOKEN_FILE/);
  assert.match(sidebar, /method, params: \{ \.\.\.params, authToken/);
});

test("all extension process paths require trusted workspaces", () => {
  for (const source of [extension, panel, sidebar, entitlement]) assert.match(source, /requireTrustedWorkspace/);
  assert.match(extension, /requireTrustedWorkspace\(workspacePath\(\)\)/);
  assert.match(panel, /requireTrustedWorkspace\(cwd\)/);
  assert.match(sidebar, /private async execute[\s\S]*?requireTrustedWorkspace\(cwd\)/);
  assert.match(sidebar, /private async checkMcpHealth[\s\S]*?requireTrustedWorkspace\(workspacePath\(\)\)/);
});

test("sidebar process lifecycle contract", () => {
  assert.match(sidebar, /approval-timeout-ms/);
  assert.match(sidebar, /taskkill/);
  assert.match(sidebar, /this\.mcpProcess/);
  assert.match(sidebar, /Unsupported command/);
});
