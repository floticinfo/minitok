"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const os = require("node:os");
const path = require("node:path");

const script = path.resolve(__dirname, "../scripts/readiness-checks.mjs");

function run(...args) {
  return spawnSync(process.execPath, [script, ...args, "--json"], {
    cwd: path.resolve(__dirname, ".."),
    encoding: "utf8",
    env: { ...process.env, USERPROFILE: os.tmpdir(), HOME: os.tmpdir(), APPDATA: undefined, XDG_CONFIG_HOME: path.join(os.tmpdir(), `minitok-readiness-xdg-${process.pid}`), MINITOK_NO_COLOR: "1", NO_COLOR: "1", MINITOK_UPDATE_CHECK: "0", MINITOK_STAGE2_LIVE_SMOKE: "" },
  });
}

test("readiness checks are separated by customer surface", () => {
  for (const target of ["extension", "cli", "mcp"]) {
    const result = run("--target", target);
    const report = JSON.parse(result.stdout);
    assert.deepEqual(Object.keys(report), [target]);
    assert.ok(report[target].some(item => item.status === "PASS"));
    assert.ok(report[target].some(item => item.status === "UNVERIFIED"));
    assert.equal(result.status, 0, result.stderr);
  }
});

test("readiness checks never contact production by default", () => {
  const result = run();
  const report = JSON.parse(result.stdout);
  const checks = Object.values(report).flat();
  assert.ok(checks.some(item => item.name.includes("publication") && item.status === "UNVERIFIED"));
  assert.ok(checks.some(item => item.name.includes("production") && item.status === "UNVERIFIED"));
  assert.equal(checks.some(item => item.status === "BLOCKED"), false);
  assert.equal(result.status, 0, result.stderr);
});

test("readiness output preserves actionable surface contracts", () => {
  const result = run();
  const checks = Object.values(JSON.parse(result.stdout)).flat();
  assert.ok(checks.some(item => item.name === "CLI non-TTY contract" && item.status === "PASS"));
  assert.ok(checks.some(item => item.name === "MCP localhost versus remote boundary" && item.status === "PASS"));
  assert.ok(checks.some(item => item.name === "extension trusted-workspace boundary" && item.status === "PASS"));
});

test("Stage 3 reports packaged identity and isolation evidence", () => {
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  const checks = Object.values(JSON.parse(result.stdout)).flat();
  for (const name of ["extension packaged VSIX", "extension VSIX manifest consistency", "CLI packaged npm files", "CLI packaged manifest consistency", "MCP packaged stdio entrypoint", "MCP stdio token-file and session isolation", "MCP HTTP localhost and auth contract", "MCP HTTP session isolation"]) {
    assert.ok(checks.some(item => item.name === name), name);
  }
  assert.ok(checks.some(item => item.name === "extension packaged VSIX" && item.status === "PASS"));
  assert.equal(checks.some(item => item.status === "BLOCKED"), false);
  assert.ok(checks.some(item => item.name === "MCP HTTP session isolation" && item.status === "PASS"));
});

test("readiness:all is the canonical all-surface command and preserves the alias", () => {
  const packageJson = require(path.resolve(__dirname, "../package.json"));
  assert.equal(packageJson.scripts["readiness:all"], "node scripts/readiness-checks.mjs --target all");
  assert.equal(packageJson.scripts["readiness:checks"], "node scripts/readiness-checks.mjs --target all");
});

test("human readiness output reports explicit status summary", () => {
  const result = spawnSync(process.execPath, [script], {
    cwd: path.resolve(__dirname, ".."),
    encoding: "utf8",
    env: { ...process.env, MINITOK_UPDATE_CHECK: "0" },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Summary: PASS=\d+ BLOCKED=0 UNVERIFIED=\d+/);
  assert.match(result.stdout, /Result: UNVERIFIED/);
});
