"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.join(__dirname, "..");
const checker = path.join(root, "scripts", "mcp-registry-check.mjs");

test("official MCP Registry metadata passes local commercial validation", () => {
  const result = spawnSync(process.execPath, [checker], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /MCP Registry metadata valid/);
  assert.match(result.stdout, /paid_entitlement=true/);
  assert.match(result.stdout, /auto_approve=false/);
});

test("server.json is standard metadata and marketplace extensions stay separate", () => {
  const server = JSON.parse(fs.readFileSync(path.join(root, "server.json"), "utf8"));
  const marketplace = JSON.parse(fs.readFileSync(path.join(root, "mcp-marketplace.json"), "utf8"));
  assert.equal(server.name, "dev.minitok/minitok");
  assert.equal(server.packages[0].registryType, "npm");
  assert.equal(server.packages[0].transport.type, "stdio");
  assert.deepEqual(server.packages[0].packageArguments.map(argument => argument.value), ["mcp", "serve"]);
  assert.equal(Object.hasOwn(server, "commercial"), false);
  assert.equal(marketplace.commercial.activePaidEntitlementRequired, true);
});

test("npm package metadata exposes the Registry ownership marker", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  assert.equal(pkg.mcpName, "dev.minitok/minitok");
  assert.equal(pkg.files.includes("server.json"), true);
  assert.equal(pkg.files.includes("mcp-marketplace.json"), true);
});

test("registry metadata never contains credential values", () => {
  const text = fs.readFileSync(path.join(root, "server.json"), "utf8");
  assert.doesNotMatch(text, /sk-[A-Za-z0-9]{16,}|Bearer\s+[A-Za-z0-9._-]{16,}|eyJ[A-Za-z0-9_-]{20,}/);
});
