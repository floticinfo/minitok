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
  // The timeout is a named constant; the assertion follows the constant instead
  // of a literal inside the timer callback, which is how it went stale.
  assert.match(panel, /const CLI_TIMEOUT_MS = 1800000;/);
  assert.match(panel, /setTimeout\([\s\S]*?CLI_TIMEOUT_MS\)/);
  assert.match(panel, /detached:\s*process\.platform !== "win32"/);
  assert.match(panel, /spawnSpec/);
  assert.match(sidebar, /spawnSpec/);
  assert.match(workspace, /ComSpec/);
  assert.match(panel, /taskkill/);
  assert.match(panel, /A minitok run is already active/);
  assert.match(panel, /statusArgs = cwd \? \["status", "--repo", cwd\] : \["status"\]/);
  assert.match(panel, /\["run", message\.task, "--repo", cwd!, "--evidence-path", evidencePath\]/);
  assert.match(sidebar, /\["run", message\.task, "--repo", cwd!, "--evidence-path", evidencePath\]/);
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
  assert.match(sidebar, /Dry run still performs provider planning/);
  assert.match(panel, /await requireEntitlement\(\)/);
});

test("MCP stdio transport contract", () => {
  assert.match(workspace, /packagedMcpCommand/);
  assert.doesNotMatch(workspace, /runtime start/);
  assert.match(workspace, /MINITOK_MCP_AUTH_TOKEN_FILE/);
  assert.match(workspace, /MCP_SCOPES = \["read", "write", "auto_accept", "verify_exec"\]/);
  assert.match(workspace, /Unsupported MCP scope/);
  assert.match(sidebar, /configuredMcpScopes\(\)/);
  assert.match(extension, /configuredMcpScopes\(\)/);
  assert.match(extension, /ensureMcpAuthToken\(\)/);
  assert.match(extension, /method: "initialize"/);
  assert.match(extension, /method: "tools\/list"/);
  assert.match(sidebar, /ensureMcpAuthToken\(\)/);
  // The runtime token expires after 15 minutes, so the handshake has to be able
  // to refresh it through the CLI instead of failing until `mcp connect` is rerun.
  assert.match(workspace, /export async function ensureMcpAuthToken/);
  assert.match(workspace, /\["mcp", "token"\]/);
  assert.match(sidebar, /mcpEnvironment\(\)/);
  assert.match(sidebar, /configuredMcp\[0\]/);
  assert.match(sidebar, /MINITOK_MCP_AUTH_TOKEN_FILE/);
  // The credential travels through the spawned child's environment
  // (mcpEnvironment → MINITOK_MCP_AUTH_TOKEN_FILE) and never through request
  // params: a standard host such as VS Code, Claude Desktop, or Cursor has no way
  // to echo a token in `params`, and the probe used to work only because it
  // injected one - reporting "online" for a configuration every real host failed.
  assert.match(sidebar, /const send = \(method: string, params: Record<string, unknown> = \{\}\) => mcp\.stdin\.write/);
  assert.match(sidebar, /const sendNotification = \(method: string, params: Record<string, unknown> = \{\}\) => mcp\.stdin\.write/);
  assert.match(sidebar, /sendNotification\("notifications\/initialized"\)/);
  assert.match(sidebar, /env: mcpEnvironment\(\)/);
  assert.equal(/authToken/.test(sidebar), false, "the probe must not echo a token in request params");
  assert.match(extension, /method: "tools\/list", params: \{\} \}/);
  assert.equal(/authToken:/.test(extension), false, "the probe must not echo a token in request params");
});

test("customer logout revokes remotely when possible and always clears local state", () => {
  const auth = fs.readFileSync(path.join(root, "..", "src", "cli", "commands", "auth.js"), "utf8");
  assert.match(auth, /\/v1\/auth\/logout/);
  assert.match(auth, /removeCustomerToken\(\)/);
  assert.match(auth, /revokeCustomerSession\(\)/);
  assert.match(auth, /Remote customer session revoked/);
  assert.match(auth, /Remote logout unavailable/);
});

test("execution and local configuration paths require trusted workspaces", () => {
  for (const source of [extension, panel, sidebar]) assert.match(source, /requireTrustedWorkspace/);
  assert.match(extension, /requireTrustedWorkspace\(workspacePath\(\)\)/);
  assert.match(panel, /requireTrustedWorkspace\(cwd\)/);
  assert.match(sidebar, /private async execute[\s\S]*?requireTrustedWorkspace\(cwd\)/);
  assert.match(sidebar, /private async checkMcpHealth[\s\S]*?requireTrustedWorkspace\(workspacePath\(\)\)/);
  assert.doesNotMatch(entitlement, /requireTrustedWorkspace/);
});

test("interactive consent is forwarded to the spawned CLI", () => {
  // A run spawned from the extension has no TTY: the CLI refuses every file
  // change without --auto-accept, so each consent path must forward it. The
  // command palette used to collect consent and drop it.
  assert.match(extension, /approved = true;[\s\S]{0,500}\["--auto-accept"\]/);
  assert.match(panel, /args\.push\("--auto-accept"\)/);
  assert.match(sidebar, /"--approval-file"/);
  assert.match(sidebar, /"--approval-timeout-ms"/);
});

test("a run can be cancelled or timed out instead of hanging the extension host", () => {
  // `runCli` spawned the CLI and waited with no timeout and no cancellation path:
  // a stuck provider request kept the "minitok task" notification, the run status,
  // and the sidebar state alive until the window was reloaded.
  assert.match(extension, /const CLI_RUN_TIMEOUT_MS = 1800000;/);
  assert.match(extension, /setTimeout\(\(\) => \{ killProcessTree\(child\); finish\(new Error\(`minitok timed out after/);
  assert.match(extension, /options\.token\?\.onCancellationRequested\(\(\) => \{ killProcessTree\(child\); finish\(new Error\("minitok run cancelled"\)\); \}\)/);
  assert.match(extension, /cancellable: true/);
  assert.match(extension, /await runCli\(cliPath\(\), runArgs, \{ timeoutMs: CLI_RUN_TIMEOUT_MS, token \}\)/);
  // The whole tree is killed: on Windows a Node child can survive its parent's
  // signal, and the CLI has the verification gate as a child of its own.
  assert.match(extension, /function killProcessTree\(/);
  assert.match(extension, /execFile\("taskkill", \["\/pid", String\(child\.pid\), "\/t", "\/f"\]/);
});

test("status and version answers are bounded", () => {
  assert.match(extension, /const CLI_STATUS_TIMEOUT_MS = 60000;/);
  assert.match(extension, /await runCli\(cliPath\(\), \["--version"\], \{ timeoutMs: CLI_STATUS_TIMEOUT_MS \}\)/);
  assert.match(extension, /await runCli\(cliPath\(\), statusCwd \? \["status", "--repo", statusCwd\] : \["status"\], \{ timeoutMs: CLI_STATUS_TIMEOUT_MS, requireWorkspace: false \}\)/);
});

test("every MCP probe call is bounded", () => {
  // The probe preflight spawned processes without a timeout, so a provider outage
  // left the sidebar reporting "checking" forever.
  assert.match(sidebar, /timeout = setTimeout\(\(\) => finish\(false, "MCP offline: handshake timed out"\), 5000\);/);
  assert.match(sidebar, /let finished = false/);
  assert.match(sidebar, /if \(finished\) return/);
  assert.match(sidebar, /execFile\(spec\.command, spec\.args, \{ \.\.\.spawnOptionsFor\(spec, \{ cwd, env \}\), timeout: 30000 \}/);
  assert.match(sidebar, /execFile\("git", args, \{ cwd, timeout: 30000, windowsHide: true \}/);
});

test("the entitlement decision is cached and dropped after an auth change", () => {
  // Every check spawns the CLI, so the same answer must not be paid for once per
  // command; a login, logout, or manual refresh drops the cached decision.
  assert.match(entitlement, /const ALLOWED_CACHE_MS/);
  assert.match(entitlement, /const DENIED_CACHE_MS/);
  assert.match(entitlement, /export function invalidateEntitlementCache/);
  assert.match(entitlement, /cachedDecision = \{ at: Date\.now\(\), state \}/);
  assert.match(sidebar, /invalidateEntitlementCache/);
  assert.equal((sidebar.match(/invalidateEntitlementCache\(\)/g) || []).length >= 4, true, "login, logout, manual refresh, and the credential form");
});

test("the MCP host entry is written back to the key that host uses", () => {
  // A host config that lists its servers under `servers` was read from that key and
  // then written to `mcpServers`, so the entry never loaded.
  assert.match(sidebar, /const serversKey = /);
  assert.match(sidebar, /config\[serversKey\] = existingServers/);
  assert.equal(/config\.mcpServers = existingServers/.test(sidebar), false, "the container key must not be hardcoded");
});

test("sidebar process lifecycle contract", () => {
  assert.match(sidebar, /approval-timeout-ms/);
  assert.match(sidebar, /taskkill/);
  assert.match(sidebar, /this\.mcpProcess/);
  assert.match(sidebar, /finish\(false, "MCP offline: handshake timed out"\)/);
  assert.match(sidebar, /sendNotification\("notifications\/initialized"\)/);
  assert.match(sidebar, /acquireMcpConfigLock\(configPath\)/);
  assert.match(sidebar, /configLock\.release\(\)/);
  assert.match(sidebar, /redactOutputText/);
  assert.match(panel, /redactPanelOutput/);
  assert.match(sidebar, /this\.handle\(message\)\.catch/);
  assert.match(panel, /this\.handle\(message\)\.catch/);
  assert.match(sidebar, /evidencePath/);
  assert.match(sidebar, /MCP authentication token could not be prepared/);
  assert.match(extension, /minitok MCP authentication token could not be prepared/);
  assert.match(extension, /redactExtensionOutput/);
  assert.match(sidebar, /Signed out locally and from the server/);
  assert.match(panel, /server session could not be revoked/);
  assert.match(sidebar, /latestCliVersion/);
  assert.match(sidebar, /storeTaskText/);
  assert.match(sidebar, /taskPreview/);
  assert.match(sidebar, /taskHash/);
  assert.match(sidebar, /const preview = redactTaskText\(task\.trim\(\)\.slice\(0, 300\)\)/);
  assert.match(sidebar, /redactSensitiveText/);
  assert.match(sidebar, /redactOutputText/);
  assert.match(workspace, /MINITOK_MCP_SCOPES/);
  assert.match(workspace, /MINITOK_UPDATE_CHECK: "0"/);
  assert.match(workspace, /minitok_server_url = configuredServerUrl\(\)/);
  assert.match(extension, /let finished = false/);
  assert.match(sidebar, /let finished = false/);
  assert.match(sidebar, /Read and validate only after the lock is held/);
  assert.match(sidebar, /task redacted/);
  assert.match(sidebar, /if \(!task\) return args/);
  assert.match(sidebar, /replaceAll\(task, "\[task redacted\]"\)/);
  assert.match(sidebarHtml, /item\.taskPreview/);
  assert.match(sidebar, /clear-history/);
  assert.match(sidebar, /Local Extension run history cleared/);
  assert.match(sidebar, /Repository evidence, checkpoints, and patches were preserved/);
  assert.match(sidebar, /storeTaskText/);
  assert.match(sidebar, /Unsupported command/);
});

test("Extension subprocesses inherit the configured server URL and disable update checks", () => {
  assert.match(workspace, /export function extensionCliEnvironment/);
  assert.match(workspace, /env\.minitok_server_url = configuredServerUrl\(\)/);
  assert.match(workspace, /MINITOK_UPDATE_CHECK: "0"/);
  assert.match(entitlement, /spawnOptionsFor\(spec/);
  assert.match(panel, /spawnOptionsFor\(processSpec/);
  assert.match(sidebar, /spawnOptionsFor\(processSpec/);
});

test("extension commands target the folder that is open in the editor", () => {
  // Without --repo the CLI falls back to the globally registered workspace, so
  // `minitok.run` could modify a different repository than the open folder.
  assert.match(extension, /\["run", task, "--repo", cwd/);
  assert.match(extension, /\["status", "--repo", statusCwd\]/);
});
