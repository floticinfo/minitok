"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const root = path.join(__dirname, "..");
const run = args => execFileSync(process.execPath, [path.join(root, "scripts", "sync-version-metadata.mjs"), ...args], { cwd: root, encoding: "utf8" });

test("version metadata is synchronized with the canonical CLI version", () => {
  const cli = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
  const extension = JSON.parse(fs.readFileSync(path.join(root, "extension", "package.json"), "utf8"));
  const runtime = JSON.parse(fs.readFileSync(path.join(root, "extension", "runtime", "package.json"), "utf8"));
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "extension", "runtime", "runtime-manifest.json"), "utf8"));
  assert.equal(lock.version, cli.version);
  assert.equal(lock.packages[""].version, cli.version);
  assert.equal(extension.minitok.cliVersion, cli.version);
  assert.equal(runtime.version, cli.version);
  assert.equal(manifest.cliVersion, cli.version);
});

test("version check is clean and extension marketplace version remains independent", () => {
  const result = JSON.parse(run(["--check"]));
  const extension = JSON.parse(fs.readFileSync(path.join(root, "extension", "package.json"), "utf8"));
  assert.equal(result.status, "in_sync");
  assert.equal(extension.version, "0.2.7");
});
