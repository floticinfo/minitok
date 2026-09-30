"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { FULL_TEST_CAPABILITIES, capabilityPermissions, importCapabilityToken, readCapabilityRecord, safeRecord } = require("../src/entitlement/capability");

function box() { const root = fs.mkdtempSync(path.join(os.tmpdir(), "minitok-capability-client-")); return { root, file: path.join(root, "capability-token.json"), clean: () => fs.rmSync(root, { recursive: true, force: true }) }; }
function claims(exp = Math.floor(Date.now() / 1000) + 3600) { return { installation_id: "11111111-1111-4111-8111-111111111111", profile: "full_test", capabilities: [...FULL_TEST_CAPABILITIES], execution_modes: ["unrestricted", "unrestricted_general"], iat: Math.floor(Date.now() / 1000), exp }; }

test("client imports only a server-validated full_test token", async () => {
  const b = box();
  try {
    const token = "eyJ.fake.capability";
    const result = await importCapabilityToken(token, { filePath: b.file, serverUrl: "https://test.invalid", validate: async (_url, body) => ({ ok: true, status: 200, body: { valid: true, profile: "full_test", claims: { ...claims() } } }) });
    assert.equal(result.success, true);
    assert.equal(readCapabilityRecord({ filePath: b.file }).profile, "full_test");
    assert.deepEqual(capabilityPermissions({ filePath: b.file }).permissions.sort(), ["auto_accept", "read", "unrestricted_autonomous", "unrestricted_general_autonomous", "verify_exec", "write"].sort());
    assert.equal(fs.readFileSync(b.file, "utf8").includes(token), true);
  } finally { b.clean(); }
});

test("client rejects forged, expired, and denied capability records", () => {
  const b = box();
  try {
    assert.equal(safeRecord({ token: "forged", installation_id: claims().installation_id, profile: "full_test", capabilities: ["credential_use"], expires_at: new Date(Date.now() + 3600000).toISOString() }), null);
    assert.equal(safeRecord({ token: "expired", installation_id: claims().installation_id, profile: "full_test", capabilities: [...FULL_TEST_CAPABILITIES], expires_at: new Date(Date.now() - 1).toISOString() }), null);
    fs.writeFileSync(b.file, JSON.stringify({ token: "bad", installation_id: claims().installation_id, profile: "full_test", capabilities: [...FULL_TEST_CAPABILITIES], expires_at: new Date(Date.now() + 3600000).toISOString() }));
    assert.equal(capabilityPermissions({ filePath: b.file }).record, null);
  } finally { b.clean(); }
});
