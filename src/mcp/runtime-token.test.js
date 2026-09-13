"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { rotateRuntimeToken, readRuntimeToken, revokeRuntimeToken, ensureRuntimeToken, runtimeTokenDiagnostics } = require("./runtime-token");

test("runtime tokens rotate independently and bind to installation", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "minitok-runtime-token-"));
  const entitlementDir = path.join(root, "entitlement");
  const filePath = path.join(root, "mcp", "runtime-token.json");
  fs.mkdirSync(entitlementDir, { recursive: true });
  fs.writeFileSync(path.join(entitlementDir, "installation-token.json"), JSON.stringify({ token: "installation-jwt", installation_id: "installation-a" }));
  try {
    const first = rotateRuntimeToken({ entitlementDir, filePath, now: 1000, ttlMs: 1000 });
    const second = rotateRuntimeToken({ entitlementDir, filePath, now: 1100, ttlMs: 1000 });
    assert.notEqual(first.token, second.token);
    assert.equal(readRuntimeToken(filePath, 1500).token, second.token);
    assert.equal(readRuntimeToken(filePath, 2100), null);
    fs.writeFileSync(path.join(entitlementDir, "installation-token.json"), JSON.stringify({ token: "installation-jwt", installation_id: "installation-b" }));
    assert.equal(readRuntimeToken(filePath, 1500), null);
    assert.equal(process.platform === "win32" || (fs.statSync(filePath).mode & 0o777) === 0o600, true);
    fs.writeFileSync(path.join(entitlementDir, "installation-token.json"), JSON.stringify({ token: "installation-jwt", installation_id: "installation-a" }));
    assert.equal(revokeRuntimeToken(filePath), true);
    assert.equal(readRuntimeToken(filePath, 1100), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("runtime token generation fails without an installation", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "minitok-runtime-token-missing-"));
  try {
    assert.throws(() => rotateRuntimeToken({ entitlementDir: root, filePath: path.join(root, "runtime-token.json") }), /active installation/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ensureRuntimeToken reuses a valid token and rotates an expired one", () => {
  // `minitok mcp token` relies on this: the 15 minute runtime token used to be
  // rotated only by `mcp connect`, so an editor lost MCP access after 15 minutes.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "minitok-runtime-token-ensure-"));
  const entitlementDir = path.join(root, "entitlement");
  const filePath = path.join(root, "mcp", "runtime-token.json");
  fs.mkdirSync(entitlementDir, { recursive: true });
  fs.writeFileSync(path.join(entitlementDir, "installation-token.json"), JSON.stringify({ token: "installation-jwt", installation_id: "installation-a" }));
  try {
    const first = ensureRuntimeToken({ entitlementDir, filePath, now: 1000, ttlMs: 1000 });
    assert.equal(typeof first.token, "string");
    assert.equal(ensureRuntimeToken({ entitlementDir, filePath, now: 1500, ttlMs: 1000 }).token, first.token, "a still valid token must be reused");

    const rotated = ensureRuntimeToken({ entitlementDir, filePath, now: 5000, ttlMs: 1000 });
    assert.notEqual(rotated.token, first.token, "an expired token must be rotated");
    assert.equal(readRuntimeToken(filePath, 5500).token, rotated.token);

    fs.rmSync(filePath, { force: true });
    assert.equal(ensureRuntimeToken({ entitlementDir, filePath, rotate: false }), null, "rotate:false must report absence instead of writing");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test("runtime token diagnostics explain a silently unusable token file", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "minitok-runtime-token-diagnostics-"));
  const entitlementDir = path.join(root, "entitlement");
  const filePath = path.join(root, "mcp", "runtime-token.json");
  fs.mkdirSync(entitlementDir, { recursive: true });
  fs.writeFileSync(path.join(entitlementDir, "installation-token.json"), JSON.stringify({ token: "installation-jwt", installation_id: "installation-a" }));
  try {
    const record = rotateRuntimeToken({ entitlementDir, filePath });
    const usable = runtimeTokenDiagnostics(filePath);
    assert.equal(usable.ok, true);
    assert.equal(usable.file, filePath);

    // Missing file: the operator is told which command recreates it.
    const missing = runtimeTokenDiagnostics(path.join(root, "mcp", "absent.json"));
    assert.equal(missing.ok, false);
    assert.match(missing.reason, /not found/);
    assert.match(missing.action, /minitok mcp token/);

    // Expired record.
    const expired = runtimeTokenDiagnostics(filePath, record.expires_at + 1);
    assert.equal(expired.ok, false);
    assert.match(expired.reason, /expired/);

    // Revoked record.
    revokeRuntimeToken(filePath);
    const revoked = runtimeTokenDiagnostics(filePath);
    assert.equal(revoked.ok, false);
    assert.match(revoked.reason, /revoked/);

    // The silent case that motivated the check: a perfectly valid record stored
    // somewhere other than ~/.minitok/mcp/ binds to an installation that does not
    // exist there, so readRuntimeToken refuses it without any message.
    const misplaced = path.join(root, "other", "mcp", "runtime-token.json");
    fs.mkdirSync(path.dirname(misplaced), { recursive: true });
    fs.writeFileSync(misplaced, JSON.stringify(record));
    assert.equal(readRuntimeToken(misplaced), null, "the record itself is valid");
    const diagnostic = runtimeTokenDiagnostics(misplaced);
    assert.equal(diagnostic.ok, false);
    assert.match(diagnostic.reason, /not match an active installation/);
    assert.match(diagnostic.reason, /installation-token\.json/, "the expected binding path is named");

    // Broken JSON is reported as such instead of looking like a missing token.
    const broken = path.join(root, "mcp", "broken.json");
    fs.writeFileSync(broken, "{ not json");
    assert.match(runtimeTokenDiagnostics(broken).reason, /not valid JSON/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

