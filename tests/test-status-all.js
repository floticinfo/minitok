"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("status-all script and npm command are registered", () => {
  const root = path.join(__dirname, "..");
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  assert.equal(pkg.scripts["status:all"], "node scripts/status-all.mjs");
  assert.equal(fs.existsSync(path.join(root, "scripts", "status-all.mjs")), true);
});

test("status-all does not contain credential output patterns", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "scripts", "status-all.mjs"), "utf8");
  assert.match(source, /REDACTED/);
  assert.doesNotMatch(source, /console\.log\([^)]*process\.env\.(?:TOKEN|SECRET|COOKIE|JWT)/i);
});
