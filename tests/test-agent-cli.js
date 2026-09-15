"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const bin = path.join(root, "bin", "minitok.js");

function run(args, env = {}) {
  return spawnSync(process.execPath, [bin, ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, MINITOK_UPDATE_CHECK: "0", ...env },
  });
}

test("agent off exits with code 2 before requiring credentials or starting MCP", () => {
  const result = run(["agent", "--mode", "off", "--repo", root, "must not run"], {
    ANTHROPIC_API_KEY: "",
    MINITOK_MCP_AUTH_TOKEN_FILE: path.join(root, "does-not-exist-token.json"),
  });
  assert.equal(result.status, 2);
  assert.match(`${result.stdout}${result.stderr}`, /minitok is OFF/);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /MCP process|runtime token|ANTHROPIC_API_KEY/);
});

test("agent help exposes the enforced host controls", () => {
  const result = run(["agent", "--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /--mode <mode>/);
  assert.match(result.stdout, /--status/);
  assert.match(result.stdout, /--auto-accept/);
});
