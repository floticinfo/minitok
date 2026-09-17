"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const root = path.join(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "extension", "runtime", "runtime-manifest.json"), "utf8"));

function hash(file) {
  // Match sync-extension-runtime.mjs: tracked text may be CRLF on Windows.
  const canonical = fs.readFileSync(file, "utf8").replaceAll("\r\n", "\n");
  return crypto.createHash("sha256").update(canonical, "utf8").digest("hex");
}

test("embedded security-sensitive runtime files match canonical source hashes", () => {
  for (const relative of manifest.files) {
    const source = path.join(root, "src", relative);
    const embedded = path.join(root, "extension", "runtime", "src", relative);
    assert.equal(hash(source), manifest.hashes[relative].source, relative);
    assert.equal(hash(embedded), manifest.hashes[relative].embedded, relative);
    assert.equal(hash(source), hash(embedded), relative);
  }
  for (const required of ["runtime/stdio.js", "runtime/server.js", "runtime/entitlement.js", "mcp/tools.js"]) {
    assert.ok(manifest.files.includes(required), required);
  }
});

test("runtime manifest has canonical package parity", () => {
  const cli = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const runtime = JSON.parse(fs.readFileSync(path.join(root, "extension", "runtime", "package.json"), "utf8"));
  const extension = JSON.parse(fs.readFileSync(path.join(root, "extension", "package.json"), "utf8"));
  assert.equal(runtime.name, cli.name);
  assert.equal(runtime.version, cli.version);
  assert.equal(extension.minitok.cliPackage, cli.name);
  assert.equal(extension.minitok.cliVersion, cli.version);
  assert.equal(manifest.cliPackage, cli.name);
  assert.equal(manifest.cliVersion, cli.version);
});
