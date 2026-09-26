"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const cap = require("../src/entitlement/capability");
const { RuntimeStdio } = require("../src/runtime/stdio");
const { FULL_TEST_PROFILE, FULL_TEST_CAPABILITIES } = cap;

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "minitok-capability-"));
  const dir = path.join(root, "entitlement"); fs.mkdirSync(dir, { recursive: true });
  const installationId = "install-a", token = `mtcap_v1_${"a".repeat(48)}`;
  const file = path.join(dir, "capability-token.json"), exp = Math.floor(Date.now() / 1000) + 3600;
  fs.writeFileSync(path.join(dir, "installation-token.json"), JSON.stringify({ token: "installation-jwt", installation_id: installationId }));
  const claims = { installation_id: installationId, profile: cap.UNRESTRICTED_LOCAL_PROFILE, capabilities: [...cap.UNRESTRICTED_LOCAL_CAPABILITIES], execution_modes: [...cap.UNRESTRICTED_LOCAL_EXECUTION_MODES], iat: exp - 3600, exp };
  return { root, dir, file, token, installationId, claims, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}
function record(f, patch = {}) { return { token: f.token, installation_id: f.installationId, profile: cap.UNRESTRICTED_LOCAL_PROFILE, capabilities: [...cap.UNRESTRICTED_LOCAL_CAPABILITIES], execution_modes: [...cap.UNRESTRICTED_LOCAL_EXECUTION_MODES], issued_at: new Date(f.claims.iat * 1000).toISOString(), expires_at: new Date(f.claims.exp * 1000).toISOString(), validated_at: new Date().toISOString(), server_url: "https://api.minitok.dev", ...patch }; }

test("preserves legacy full_test import compatibility without weakening local grants", async t => {
  const f = fixture(); t.after(f.cleanup);
  fs.rmSync(path.join(f.dir, "installation-token.json"), { force: true });
  const imported = await cap.importCapabilityToken("legacy-" + f.token, { filePath: f.file, entitlementDir: f.dir, validate: async (_url, body) => {
    assert.equal(Object.prototype.hasOwnProperty.call(body, "installation_id"), false);
    return { ok: true, body: { valid: true, profile: FULL_TEST_PROFILE, claims: { installation_id: "legacy-install", profile: FULL_TEST_PROFILE, capabilities: [...FULL_TEST_CAPABILITIES], iat: f.claims.iat, exp: f.claims.exp } } };
  } });
  assert.equal(imported.success, true);
  assert.equal(cap.readCapabilityRecord({ filePath: f.file }).profile, FULL_TEST_PROFILE);
});

test("imports a server-validated grant and binds request and record to local installation", async t => {
  const f = fixture(); t.after(f.cleanup); let sent;
  const result = await cap.importCapabilityToken(f.token, { filePath: f.file, entitlementDir: f.dir, serverUrl: "https://staging.example", validate: async (url, body) => { sent = { url, body }; return { ok: true, body: { valid: true, profile: cap.UNRESTRICTED_LOCAL_PROFILE, claims: f.claims } }; } });
  assert.equal(result.success, true); assert.equal(sent.url, "https://staging.example/v1/capability/validate");
  assert.deepEqual(sent.body, { token: f.token, installation_id: f.installationId });
  assert.equal(cap.readCapabilityRecord({ filePath: f.file, entitlementDir: f.dir }).profile, cap.UNRESTRICTED_LOCAL_PROFILE);
  assert.deepEqual(cap.capabilityPermissions({ filePath: f.file, entitlementDir: f.dir }).permissions.sort(), ["auto_accept", "read", "unrestricted_autonomous", "verify_exec", "write"]);
});

test("rejects server rejection, profile mismatch, installation mismatch and out-of-profile claims", async t => {
  const f = fixture(); t.after(f.cleanup);
  const bad = [
    { valid: false },
    { valid: true, profile: "unrestricted_general", claims: { ...f.claims, profile: "unrestricted_general" } },
    { valid: true, profile: cap.UNRESTRICTED_LOCAL_PROFILE, claims: { ...f.claims, profile: "full_test" } },
    { valid: true, profile: cap.UNRESTRICTED_LOCAL_PROFILE, claims: { ...f.claims, installation_id: "other" } },
    { valid: true, profile: cap.UNRESTRICTED_LOCAL_PROFILE, claims: { ...f.claims, execution_modes: ["unrestricted_general"] } },
    { valid: true, profile: cap.UNRESTRICTED_LOCAL_PROFILE, claims: { ...f.claims, capabilities: [...f.claims.capabilities, "external_call"] } },
    { valid: true, profile: cap.UNRESTRICTED_LOCAL_PROFILE, claims: { ...f.claims, iat: f.claims.iat + 61 } },
    { valid: true, profile: cap.UNRESTRICTED_LOCAL_PROFILE, claims: { ...f.claims, iat: f.claims.iat + 0.5 } },
    { valid: true, profile: cap.UNRESTRICTED_LOCAL_PROFILE, claims: { ...f.claims, exp: f.claims.iat + 86401 } },
    { valid: true, profile: cap.UNRESTRICTED_LOCAL_PROFILE, claims: { ...f.claims, exp: f.claims.iat + 10.5 } },
  ];
  for (const body of bad) {
    const result = await cap.importCapabilityToken(f.token, { filePath: f.file, entitlementDir: f.dir, validate: async () => ({ ok: true, body }) });
    assert.equal(result.success, false); assert.equal(fs.existsSync(f.file), false);
  }
});

test("requires the installation record before validating a local grant", async t => {
  const f = fixture(); t.after(f.cleanup);
  fs.rmSync(path.join(f.dir, "installation-token.json"), { force: true });
  let contacted = false;
  const result = await cap.importCapabilityToken(f.token, { filePath: f.file, entitlementDir: f.dir, validate: async () => { contacted = true; return { ok: true, body: { valid: true } }; } });
  assert.equal(result.success, false);
  assert.equal(contacted, false);
  assert.equal(fs.existsSync(f.file), false);
});

test("fails closed when server validation throws and does not persist a capability record", async t => {
  const f = fixture(); t.after(f.cleanup);
  const result = await cap.importCapabilityToken(f.token, { filePath: f.file, entitlementDir: f.dir, validate: async () => { throw new Error("simulated network failure"); } });
  assert.equal(result.success, false);
  assert.equal(result.code, 503);
  assert.equal(fs.existsSync(f.file), false);
});

test("rejects malformed, future, expired and overlong server claims during revalidation", async t => {
  const f = fixture(); t.after(f.cleanup);
  cap.writeCapabilityRecord(record(f), f.file, { entitlementDir: f.dir });
  const now = Math.floor(Date.now() / 1000);
  const invalidClaims = [
    { ...f.claims, iat: now + 61 },
    { ...f.claims, iat: now + 0.5 },
    { ...f.claims, exp: now - 1 },
    { ...f.claims, exp: f.claims.iat + 86401 },
    { ...f.claims, exp: f.claims.iat + 0.5 },
    { ...f.claims, profile: "full_test" },
  ];
  for (const claims of invalidClaims) {
    const result = await cap.revalidateCapabilityRecord({ filePath: f.file, entitlementDir: f.dir, validate: async () => ({ ok: true, body: { valid: true, profile: cap.UNRESTRICTED_LOCAL_PROFILE, claims } }) });
    assert.equal(result, null);
  }
});

test("rejects malformed validation responses and network failures without persistence", async t => {
  const f = fixture(); t.after(f.cleanup);
  const responses = [null, { ok: true, body: null }, { ok: true, body: [] }, { ok: true, body: "valid" }];
  for (const response of responses) {
    const result = await cap.importCapabilityToken(f.token, { filePath: f.file, entitlementDir: f.dir, validate: async () => response });
    assert.equal(result.success, false);
    assert.equal(fs.existsSync(f.file), false);
  }
});

test("rejects local profile validation without installation binding", async t => {
  const f = fixture(); t.after(f.cleanup);
  const result = await cap.importCapabilityToken(f.token, { filePath: f.file, installationRecord: null, validate: async () => ({ ok: true, body: { valid: true } }) });
  assert.equal(result.success, false);
  assert.equal(fs.existsSync(f.file), false);
});

test("safeRecord enforces exact profile, expiry, execution mode, installation and denylist", t => {
  const f = fixture(); t.after(f.cleanup); const options = { entitlementDir: f.dir };
  assert.ok(cap.safeRecord(record(f), Date.now(), options));
  assert.equal(cap.safeRecord(record(f, { expires_at: new Date(Date.now() - 1).toISOString() }), Date.now(), options), null);
  assert.equal(cap.safeRecord(record(f, { installation_id: "other" }), Date.now(), options), null);
  assert.equal(cap.safeRecord(record(f, { execution_modes: ["unrestricted_general"] }), Date.now(), options), null);
  assert.equal(cap.safeRecord(record(f, { capabilities: [...cap.UNRESTRICTED_LOCAL_CAPABILITIES, "publish"] }), Date.now(), options), null);
  assert.equal(cap.safeRecord(record(f), Date.now(), { installationRecord: { installation_id: "other" } }), null);
});

test("revalidates expiry and fails closed on revoke or server outage", async t => {
  const f = fixture(); t.after(f.cleanup);
  assert.equal(cap.safeRecord(record(f, { expires_at: new Date(Date.now() - 1).toISOString() }), Date.now(), { entitlementDir: f.dir }), null);
  cap.writeCapabilityRecord(record(f), f.file, { entitlementDir: f.dir });
  const revoked = await cap.revalidateCapabilityRecord({ filePath: f.file, entitlementDir: f.dir, validate: async (_url, body) => { assert.equal(body.installation_id, f.installationId); return { ok: true, status: 200, body: { valid: false } }; } });
  assert.equal(revoked, null);
  assert.equal(await cap.revalidateCapabilityRecord({ filePath: f.file, entitlementDir: f.dir, validate: async () => { throw new Error("offline"); } }), null);
});

test("preflight blocks capabilities outside the local profile even in unrestricted execution mode", t => {
  const { capabilityPreflight } = require("../src/goal/capability-preflight");
  const f = fixture(); t.after(f.cleanup);
  const result = capabilityPreflight({ profile: cap.UNRESTRICTED_LOCAL_PROFILE, granted: cap.UNRESTRICTED_LOCAL_CAPABILITIES, requested: [...cap.UNRESTRICTED_LOCAL_CAPABILITIES, "external_call", "unrestricted_general_autonomous"] });
  assert.ok(result.denied_capabilities.includes("external_call"));
  assert.ok(result.denied_capabilities.includes("unrestricted_general_autonomous"));
  assert.ok(result.blocked_external_operations.includes("external_call"));
});

test("MCP removes local permissions immediately after server-side revocation", async t => {
  const f = fixture(); t.after(f.cleanup);
  cap.writeCapabilityRecord(record(f), f.file, { entitlementDir: f.dir });
  let revoked = false;
  const server = http.createServer((req, res) => {
    let body = ""; req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      const input = JSON.parse(body);
      const claims = { ...f.claims, installation_id: input.installation_id };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(revoked ? { valid: false } : { valid: true, profile: cap.UNRESTRICTED_LOCAL_PROFILE, claims }));
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  const runtime = new RuntimeStdio({ workspaceRoot: f.root, entitlementDir: f.dir, capabilityFile: f.file, capabilityServerUrl: url, authToken: "runtime-auth", services: { entitlement: { status: async () => ({ allowed: true }) } } });
  const request = async (id, method, params = {}) => {
    const replies = [];
    await runtime._handleMessage({ jsonrpc: "2.0", id, method, params }, value => replies.push(value));
    return replies[0];
  };
  const initialized = await request(1, "initialize", { protocolVersion: "2024-11-05" });
  assert.equal(initialized.result.protocolVersion, "2024-11-05");
  const tools = await request(2, "tools/list");
  assert.ok(tools.result.tools.length > 0);
  assert.ok(runtime._permissions.has("write"));
  revoked = true;
  const rejected = await request(3, "tools/list");
  assert.equal(rejected.error.data.type, "CAPABILITY_REVALIDATION_FAILED");
  assert.equal(runtime._capabilityProfile, null);
  assert.deepEqual([...runtime._permissions], ["read"]);
  const deniedCall = await request(4, "tools/call", { name: "minitok_run", arguments: { task: "must not execute after grant revocation" } });
  assert.equal(deniedCall.error.data.type, "PERMISSION_DENIED");
});

test("revalidation refreshes claims only when server validates the same installation", async t => {
  const f = fixture(); t.after(f.cleanup); cap.writeCapabilityRecord(record(f), f.file, { entitlementDir: f.dir });
  const exp = Math.floor(Date.now() / 1000) + 7200;
  const refreshed = await cap.revalidateCapabilityRecord({ filePath: f.file, entitlementDir: f.dir, validate: async () => ({ ok: true, body: { valid: true, profile: cap.UNRESTRICTED_LOCAL_PROFILE, claims: { ...f.claims, exp } } }) });
  assert.ok(refreshed); assert.equal(Date.parse(refreshed.expires_at), exp * 1000);
  const wrongBinding = await cap.revalidateCapabilityRecord({ filePath: f.file, entitlementDir: f.dir, validate: async () => ({ ok: true, body: { valid: true, profile: cap.UNRESTRICTED_LOCAL_PROFILE, claims: { ...f.claims, installation_id: "other", exp } } }) });
  assert.equal(wrongBinding, null);
});
