"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { setOwnerOnlyPermissions } = require("../utils/file-permissions");

const DEFAULT_ENTITLEMENT_DIR = path.join(os.homedir(), ".minitok", "entitlement");
const DEFAULT_RUNTIME_TOKEN_FILE = path.join(os.homedir(), ".minitok", "mcp", "runtime-token.json");
const DEFAULT_TTL_MS = 15 * 60 * 1000;

function installationRecord(entitlementDir = DEFAULT_ENTITLEMENT_DIR) {
  try {
    const record = JSON.parse(fs.readFileSync(path.join(entitlementDir, "installation-token.json"), "utf8"));
    if (!record || typeof record.token !== "string" || !record.token || typeof record.installation_id !== "string" || !record.installation_id) return null;
    return record;
  } catch {
    return null;
  }
}

function readRuntimeToken(filePath = DEFAULT_RUNTIME_TOKEN_FILE, now = Date.now()) {
  try {
    const record = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!record || typeof record.token !== "string" || !record.token || typeof record.installation_id !== "string" || !record.installation_id || typeof record.session_id !== "string" || !record.session_id || !Number.isFinite(record.expires_at) || now >= record.expires_at || record.revoked_at) return null;
    const entitlement = path.join(path.dirname(filePath), "..", "entitlement", "installation-token.json");
    try {
      const installation = JSON.parse(fs.readFileSync(entitlement, "utf8"));
      if (installation.installation_id !== record.installation_id) return null;
    } catch {
      return null;
    }
    return record;
  } catch {
    return null;
  }
}

function writeRuntimeToken(record, filePath = DEFAULT_RUNTIME_TOKEN_FILE) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = `${filePath}.tmp.${process.pid}.${crypto.randomBytes(8).toString("hex")}`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    setOwnerOnlyPermissions(temp);
    fs.renameSync(temp, filePath);
    setOwnerOnlyPermissions(filePath);
  } catch (error) {
    // Clean up the temporary file on failure. If rename succeeded the file
    // no longer exists at `temp` and unlinkSync would throw ENOENT — swallowed.
    // If rename failed, the temp file is left behind for diagnostic purposes
    // when the error is a permissions or disk-space issue, but we still attempt
    // cleanup to avoid orphaned temp files accumulating.
    try { fs.unlinkSync(temp); } catch {}
    throw error;
  }
  return record;
}

function rotateRuntimeToken(options = {}) {
  const entitlementDir = options.entitlementDir || DEFAULT_ENTITLEMENT_DIR;
  const filePath = options.filePath || path.join(path.dirname(entitlementDir), "mcp", "runtime-token.json");
  const installation = installationRecord(entitlementDir);
  if (!installation) throw new Error("MCP runtime token requires an active installation");
  const now = options.now || Date.now();
  return writeRuntimeToken({ token: crypto.randomBytes(32).toString("base64url"), installation_id: installation.installation_id, session_id: crypto.randomUUID(), issued_at: now, expires_at: now + (Number(options.ttlMs) > 0 ? Number(options.ttlMs) : DEFAULT_TTL_MS), path: filePath }, filePath);
}

function ensureRuntimeToken(options = {}) {
  const filePath = options.filePath || DEFAULT_RUNTIME_TOKEN_FILE;
  const current = readRuntimeToken(filePath, options.now || Date.now());
  if (current) return current;
  if (options.rotate === false) return null;
  return rotateRuntimeToken({ ...options, filePath });
}

function revokeRuntimeToken(filePath = DEFAULT_RUNTIME_TOKEN_FILE) {
  let current;
  try { current = JSON.parse(fs.readFileSync(filePath, "utf8")); } catch { return false; }
  if (!current || typeof current.token !== "string" || !current.token) return false;
  writeRuntimeToken({ ...current, revoked_at: Date.now() }, filePath);
  return true;
}

function runtimeTokenPath(entitlementDir = DEFAULT_ENTITLEMENT_DIR) {
  return path.join(path.dirname(entitlementDir), "mcp", "runtime-token.json");
}

/**
 * Explain why an MCP auth token file is (not) usable.
 *
 * `readRuntimeToken` refuses a token silently: a file outside `~/.minitok/mcp/`
 * resolves its installation binding against that other directory, so the MCP host
 * fails every call with AUTH_REQUIRED while the configuration looks correct.
 * Diagnostics exist so `minitok mcp status` can say which record or path is wrong.
 * @returns {{ ok: boolean, file?: string, reason?: string, action?: string }}
 */
function runtimeTokenDiagnostics(filePath = DEFAULT_RUNTIME_TOKEN_FILE, now = Date.now()) {
  if (typeof filePath !== "string" || !filePath) {
    return { ok: false, reason: "No MCP auth token file is configured.", action: "Run: minitok mcp connect <host>" };
  }
  if (!fs.existsSync(filePath)) {
    return { ok: false, file: filePath, reason: `MCP auth token file not found: ${filePath}`, action: "Run: minitok mcp token" };
  }
  if (readRuntimeToken(filePath, now)) return { ok: true, file: filePath };

  let detail = "the file is not valid JSON";
  let raw;
  try { raw = JSON.parse(fs.readFileSync(filePath, "utf8")); } catch { raw = null; }
  if (raw && typeof raw === "object") {
    if (typeof raw.token !== "string" || !raw.token) detail = "the record has no token";
    else if (raw.revoked_at) detail = "the token was revoked";
    else if (!Number.isFinite(raw.expires_at)) detail = "the record has no numeric expires_at";
    else if (now >= raw.expires_at) detail = "the token has expired";
    else if (typeof raw.installation_id !== "string" || !raw.installation_id) detail = "the record has no installation_id";
    else if (typeof raw.session_id !== "string" || !raw.session_id) detail = "the record has no session_id";
    else detail = "the record does not match an active installation";
  }
  // The binding is read as <dirname>/../entitlement/installation-token.json, so a
  // token file anywhere else can never be validated.
  const expected = path.join(path.dirname(filePath), "..", "entitlement", "installation-token.json");
  return {
    ok: false,
    file: filePath,
    reason: `MCP auth token file is not usable: ${detail}. The installation binding is read from ${expected}`,
    action: "Run: minitok mcp token",
  };
}

module.exports = { DEFAULT_RUNTIME_TOKEN_FILE, DEFAULT_TTL_MS, installationRecord, readRuntimeToken, writeRuntimeToken, rotateRuntimeToken, ensureRuntimeToken, revokeRuntimeToken, runtimeTokenPath, runtimeTokenDiagnostics };
