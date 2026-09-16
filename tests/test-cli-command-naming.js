"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const bin = path.resolve(__dirname, "../bin/minitok.js");

function help(...args) {
  return spawnSync(process.execPath, [bin, ...args, "--help"], { encoding: "utf8", env: { ...process.env, MINITOK_UPDATE_CHECK: "0" } });
}

test("top-level help groups current commands with descriptions", () => {
  const result = help();
  assert.equal(result.status, 0);
  for (const command of ["run", "status", "doctor", "models", "workspace", "auth", "migrate", "runtime", "mcp"]) assert.match(result.stdout, new RegExp(`\\b${command}\\b`));
  assert.match(result.stdout, /Run a verified repository-aware coding workflow/);
  assert.match(result.stdout, /Manage MCP status, connections, tokens, and host\s+setup/);
});

test("compatibility aliases are visible and provider auth remains separate", () => {
  assert.match(help("runs").stdout, /Alias|List recorded runs|Show a recorded run/);
  assert.match(help("account").stdout, /Alias for auth customer-login/);
  assert.match(help("billing").stdout, /Alias for checkout/);
  assert.match(help("license").stdout, /Alias for activate/);
  assert.match(help("auth").stdout, /Log in to an LLM provider/);
});
