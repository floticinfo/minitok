"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { loadCustomerToken, loadCustomerSession, saveCustomerToken, saveCustomerSession, revokeCustomerSession, removeCustomerToken } = require("./customer-token");

describe("customer token storage", () => {
  it("saves and loads an owner-only customer token", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "minitok-customer-token-"));
    const file = path.join(root, "customer-token.json");
    saveCustomerToken("jwt-value", file);
    assert.equal(loadCustomerToken(file), "jwt-value");
    removeCustomerToken(file);
    assert.equal(loadCustomerToken(file), null);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("loads refreshable sessions and respects a local revocation tombstone", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "minitok-customer-session-"));
    const file = path.join(root, "session.json");
    saveCustomerSession({ access_token: "access", refresh_token: "refresh", expires_in: 3600 }, file);
    assert.equal(loadCustomerSession(file)?.refresh_token, "refresh");
    revokeCustomerSession(file);
    assert.equal(loadCustomerSession(file), null);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("stores access-only login tokens without manufacturing a refresh session", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "minitok-access-only-"));
    const tokenFile = path.join(root, "customer-token.json");
    const sessionFile = path.join(root, "session.json");
    saveCustomerSession({ access_token: "old-access", refresh_token: "old-refresh", expires_in: 3600 }, sessionFile);
    saveCustomerToken("new-access", tokenFile);
    assert.equal(loadCustomerToken(tokenFile), "new-access");
    assert.equal(loadCustomerSession(sessionFile)?.refresh_token, "old-refresh", "custom token paths must not alter unrelated session files");
    removeCustomerToken(tokenFile);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("prefers the explicit environment token", () => {
    const previous = process.env.minitok_customer_token;
    process.env.minitok_customer_token = "env-jwt";
    try { assert.equal(loadCustomerToken("missing.json"), "env-jwt"); } finally {
      if (previous === undefined) delete process.env.minitok_customer_token;
      else process.env.minitok_customer_token = previous;
    }
  });
});
