"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const entitlement = fs.readFileSync(path.join(root, "src", "entitlement.ts"), "utf8");
const workspace = fs.readFileSync(path.join(root, "src", "workspace.ts"), "utf8");
const extension = fs.readFileSync(path.join(root, "src", "extension.ts"), "utf8");
const sidebar = fs.readFileSync(path.join(root, "src", "sidebar.ts"), "utf8");
const sidebarHtml = fs.readFileSync(path.join(root, "src", "sidebar.html"), "utf8");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

// The mcpScopes setting accepts exactly the MCP_SCOPES list the code validates
// against; a description that documents a subset made users believe the
// unrestricted_* scopes were rejected.
test("the documented mcp scopes match the validated scope list", () => {
  const documented = manifest.contributes.configuration.properties["minitok.mcpScopes"].description
    .match(/\b(read|write|auto_accept|verify_exec|unrestricted_autonomous|unrestricted_general_autonomous)\b/g) || [];
  const validated = workspace.match(/export const MCP_SCOPES = \[([^\]]+)\]/)[1]
    .match(/"([^"]+)"/g).map(value => value.slice(1, -1));
  assert.deepEqual([...new Set(documented)].sort(), [...new Set(validated)].sort());
});

// The activation key is a bearer credential: whoever holds it can spend the
// plan. These assertions pin the two properties that keep it out of places a
// local process can read -- argv and the CLI's own child environment.
test("the activation key never reaches argv", () => {
  // The key is passed by variable *name* through --key-env; the CLI resolves it
  // from the child environment. Interpolating the key into the args array would
  // expose it in every process listing on the machine.
  assert.match(
    entitlement,
    /spawnSpec\(cliPath\(\), \["activate", "--key-env", ACTIVATION_KEY_ENV\]\)/,
    "activation must pass the env variable name, not the key itself",
  );
  assert.doesNotMatch(
    entitlement,
    /spawnSpec\([^)]*trimmed/,
    "the trimmed key must never be interpolated into the argv array",
  );
  // The environment variable name is a constant shared by the spawn and the
  // allowlist entry; a drift between them makes the CLI reject a valid key.
  assert.match(entitlement, /const ACTIVATION_KEY_ENV = "MINITOK_ACTIVATION_KEY";/);
  assert.match(workspace, /"MINITOK_ACTIVATION_KEY",/);
});

test("activation is wired to a masked prompt, not the checkout URL", () => {
  const command = manifest.contributes.commands.find((entry) => entry.command === "minitok.activate");
  assert.ok(command, "minitok.activate is a contributed command");
  assert.ok(
    manifest.activationEvents.includes("onCommand:minitok.activate"),
    "the command must activate the Extension",
  );
  // password:true keeps the key off the screen and out of screenshots and
  // shoulder-surfing range while it is being pasted.
  assert.match(extension, /showInputBox\(\{[\s\S]*?password: true/);
  assert.match(extension, /activateEntitlement\(key\)/);
  // Activation changes what the gate answers, so the pre-activation denial that
  // every surface cached has to be dropped and the sidebar repainted.
  assert.match(entitlement, /invalidateEntitlementCache\(\);/);
  assert.match(extension, /await sidebar\.refresh\(\)/);
  assert.match(sidebar, /public async refresh\(\)/);
});

test("an activation key is never logged, echoed or persisted by the Extension", () => {
  // The Extension does not store the key: the CLI writes the signed artifact and
  // the installation token under ~/.minitok, which is the only durable copy.
  assert.doesNotMatch(entitlement, /secrets\.store[^)]*ACTIVATION_KEY/);
  assert.doesNotMatch(entitlement, /writeFileSync[^)]*trimmed/);
  // Activation output is routed through the shared redactor before it can reach
  // the output channel or a toast.
  assert.match(extension, /redactExtensionOutput\(`Activation failed: \$\{result\.message\}`\)/);
  assert.match(extension, /redactExtensionOutput\(result\.message\)/);
});

test("the not-entitled state offers both activation and billing paths", () => {
  // A customer holding a license key activates this installation via the
  // activation panel; a customer without one goes to checkout. Both affordances
  // must be present, and neither may shadow the other.
  // The "activate" CTA opens the activation panel, not billing.
  assert.match(sidebar, /if \(message\.command === "activate"\) \{ this\.view\?\.webview\.postMessage\(\{ type: "bind-panel-toggle" \}\); return; \}/);
  // [2026-10-22 F1단계] The panel hands the key to the CLI, which activates over
  // the canonical POST /v1/activate. The Phase 1 bind route was retired and
  // answered 404, so the extension must not call it.
  assert.match(sidebar, /if \(message\.command === "bind-license"\) \{ await this\.bindLicense\(message\.key\); return; \}/);
  assert.match(sidebar, /await activateEntitlement\(trimmed\)/);
  assert.doesNotMatch(sidebar, /bindLicenseToAccount/);
  // Billing moved to its own command so a user without a key is never stranded.
  assert.match(sidebar, /if \(message\.command === "open-billing"\) \{ await this\.openBilling\(\); return; \}/);
  // The CTA still reaches the checkout flow, so pin the CLI subcommand itself
  // rather than the helper's (now parameterless) signature.
  assert.match(sidebar, /const args = \["checkout", "--token-env"/);
  assert.doesNotMatch(sidebar, /manage-plan/);
  assert.doesNotMatch(sidebar, /portal_url/);
  // The webview exposes both entry points and posts the typed key, never a literal.
  assert.match(sidebarHtml, /id="activateButton"/);
  assert.match(sidebarHtml, /id="billingButton"/);
  assert.match(sidebarHtml, /command:"bind-license",key:document\.getElementById\("bindKeyInput"\)\.value/);
  // A successful bind re-resolves entitlement so the gate flips without a reload.
  assert.match(sidebar, /invalidateEntitlementCache\(\);\s*\n\s*this\.view\?\.webview\.postMessage\(\{ type: "bind-result", ok: true/);
});