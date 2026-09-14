"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const { setOwnerOnlyPermissions } = require("../utils/file-permissions");
const { readEnv } = require("../core/env");
const { normalizeCustomerSession } = require("./customer-session");

const CUSTOMER_TOKEN_FILE = path.join(os.homedir(), ".minitok", "entitlement", "customer-token.json");
const ACCOUNT_SESSION_FILE = path.join(os.homedir(), ".minitok", "account", "session.json");

function isExpiredJwt(token) {
  try {
    const part = token.split(".")[1];
    if (!part) return false;
    const payload = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    return typeof payload.exp === "number" && Date.now() >= payload.exp * 1000 - 60000;
  } catch { return false; }
}

function loadCustomerSession(filePath = ACCOUNT_SESSION_FILE) {
  try {
    const value = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    if (value?.revoked_at) return null;
    return normalizeCustomerSession(value);
  } catch { return null; }
}

function loadCustomerToken(filePath = CUSTOMER_TOKEN_FILE) {
  const customerToken = readEnv("minitok_customer_token");
  if (customerToken) return customerToken;
  try {
    const record = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    if (typeof record.token === "string" && record.token && !isExpiredJwt(record.token)) return record.token;
  } catch {}
  const normalized = loadCustomerSession();
  if (normalized?.access_token && (!normalized.expires_at || Date.now() < new Date(normalized.expires_at).getTime() - 60000)) return normalized.access_token;
  return null;
}

function writeOwnerOnlyJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp.${process.pid}`;
  fs.writeFileSync(tempPath, JSON.stringify(value, null, 2), { encoding: "utf-8", mode: 0o600 });
  setOwnerOnlyPermissions(tempPath);
  fs.renameSync(tempPath, filePath);
  // chmod/ACL must be applied after rename too: Windows inherits ACLs from
  // the destination directory and mode: 0o600 is not an ACL guarantee.
  setOwnerOnlyPermissions(filePath);
}

function saveCustomerSession(session, filePath = ACCOUNT_SESSION_FILE) {
  const accessToken = session?.access_token || session?.accessToken;
  if (typeof accessToken !== "string" || !accessToken) throw new TypeError("Customer access token is required");
  const refreshToken = session?.refresh_token || session?.refreshToken;
  writeOwnerOnlyJson(filePath, {
    ...(session.customer_id || session.customerId ? { customer_id: session.customer_id || session.customerId } : {}),
    access_token: accessToken,
    ...(typeof refreshToken === "string" && refreshToken ? { refresh_token: refreshToken } : {}),
    token_type: session.token_type || session.tokenType || "Bearer",
    ...(session.expires_in ? { expires_in: session.expires_in } : {}),
    ...(session.expires_at || session.expiresAt ? { expires_at: session.expires_at || session.expiresAt } : {}),
    saved_at: new Date().toISOString()
  });
}

function saveCustomerToken(token, filePath = CUSTOMER_TOKEN_FILE) {
  if (typeof token !== "string" || !token) throw new TypeError("Customer token is required");
  // An access-only login cannot revoke or refresh a previous refresh-token
  // session. Remove that session first rather than leaving a different account's
  // refresh token available to customer logout and billing flows.
  if (filePath === CUSTOMER_TOKEN_FILE) {
    try { fs.unlinkSync(ACCOUNT_SESSION_FILE); } catch {}
  }
  writeOwnerOnlyJson(filePath, { token, saved_at: new Date().toISOString() });
  // Do not manufacture an account session from an access-only token: the shared
  // session schema is intentionally refreshable and loadCustomerSession rejects
  // incomplete records. The legacy token remains the explicit fallback.
}

function revokeCustomerSession(filePath = ACCOUNT_SESSION_FILE) {
  writeOwnerOnlyJson(filePath, { revoked_at: new Date().toISOString() });
}

function removeCustomerToken(filePath = CUSTOMER_TOKEN_FILE) {
  try { fs.unlinkSync(filePath); } catch {}
  if (filePath === CUSTOMER_TOKEN_FILE) { try { fs.unlinkSync(ACCOUNT_SESSION_FILE); } catch {} }
}

module.exports = { CUSTOMER_TOKEN_FILE, ACCOUNT_SESSION_FILE, loadCustomerToken, loadCustomerSession, saveCustomerToken, saveCustomerSession, revokeCustomerSession, removeCustomerToken };
