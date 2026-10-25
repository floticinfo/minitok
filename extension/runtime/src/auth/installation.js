"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { setOwnerOnlyPermissions } = require("../utils/file-permissions");

const DEFAULT_ENTITLEMENT_DIR = path.join(os.homedir(), ".minitok", "entitlement");
const INSTALLATION_TOKEN_FILE = "installation-token.json";
const INSTALLATION_ID_FILE = "installation-id.json";
const INSTALLATION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function installationTokenPath(entitlementDir = DEFAULT_ENTITLEMENT_DIR) {
  return path.join(entitlementDir, INSTALLATION_TOKEN_FILE);
}

function installationIdPath(entitlementDir = DEFAULT_ENTITLEMENT_DIR) {
  return path.join(entitlementDir, INSTALLATION_ID_FILE);
}

function readInstallationRecord(entitlementDir = DEFAULT_ENTITLEMENT_DIR) {
  const file = installationTokenPath(entitlementDir);
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    if (typeof value.token !== "string" || !value.token || typeof value.installation_id !== "string" || !value.installation_id.trim()) return null;
    return { ...value, path: file };
  } catch {
    return null;
  }
}

function writeInstallationRecord(record, entitlementDir = DEFAULT_ENTITLEMENT_DIR) {
  if (!record || typeof record.token !== "string" || !record.token || typeof record.installation_id !== "string" || !record.installation_id.trim()) throw new TypeError("A valid installation token record is required");
  const file = installationTokenPath(entitlementDir);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.tmp.${process.pid}.${crypto.randomBytes(6).toString("hex")}`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify({ ...record, saved_at: new Date().toISOString() }, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    setOwnerOnlyPermissions(temp);
    fs.renameSync(temp, file);
    setOwnerOnlyPermissions(file);
  } catch (error) {
    try { fs.unlinkSync(temp); } catch {}
    throw error;
  }
  // The bound installation id is authoritative, so the standalone id file is
  // brought in line with it. Otherwise a later activation that could only see
  // the id file would present a DIFFERENT installation id to the server, and
  // the server would treat the machine as a second device.
  try { writeInstallationIdFile(record.installation_id, entitlementDir); } catch {}
  return { ...record, path: file };
}

function writeInstallationIdFile(installationId, entitlementDir = DEFAULT_ENTITLEMENT_DIR) {
  if (typeof installationId !== "string" || !INSTALLATION_ID_RE.test(installationId)) {
    throw new TypeError("A valid installation id is required");
  }
  const file = installationIdPath(entitlementDir);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.tmp.${process.pid}.${crypto.randomBytes(6).toString("hex")}`;
  try {
    fs.writeFileSync(temp, `${installationId}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    setOwnerOnlyPermissions(temp);
    fs.renameSync(temp, file);
    setOwnerOnlyPermissions(file);
  } catch (error) {
    try { fs.unlinkSync(temp); } catch {}
    throw error;
  }
  return installationId;
}

/**
 * Return this machine's installation id, creating it on first use.
 *
 * [2026-10-22 E단계] `POST /v1/activate` requires an `installation_id`, and
 * the server allows one active installation per subscription. The id
 * therefore has to be STABLE: an activation that fails after the server
 * already bound the key must not present a new id on the next attempt, or the
 * machine would occupy a second device slot and the customer would be locked
 * out by the device limit.
 *
 * The bound record wins, then the standalone id file, then a fresh id is
 * created and persisted BEFORE the activation call.
 */
function ensureInstallationId(entitlementDir = DEFAULT_ENTITLEMENT_DIR) {
  const bound = loadInstallationId(entitlementDir);
  if (bound && INSTALLATION_ID_RE.test(bound)) return bound;
  try {
    const stored = fs.readFileSync(installationIdPath(entitlementDir), "utf8").trim();
    if (INSTALLATION_ID_RE.test(stored)) return stored;
  } catch {}
  const created = crypto.randomUUID();
  writeInstallationIdFile(created, entitlementDir);
  return created;
}

function installationTokenExpired(token, skewMs = 60000) {
  try {
    if (typeof token !== "string") return true;
    const parts = token.split(".");
    if (parts.length !== 3 || parts.some(part => !part)) return true;
    const header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    if (!header || typeof header !== "object" || Array.isArray(header)) return true;
    if (typeof header.alg !== "string" || !header.alg || header.alg.toLowerCase() === "none") return true;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return true;
    if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp)) return true;
    return Date.now() >= payload.exp * 1000 - skewMs;
  } catch {
    return true;
  }
}

function loadInstallationId(entitlementDir = DEFAULT_ENTITLEMENT_DIR) {
  return readInstallationRecord(entitlementDir)?.installation_id || null;
}

function installationStatus(entitlementDir = DEFAULT_ENTITLEMENT_DIR) {
  const file = installationTokenPath(entitlementDir);
  if (!fs.existsSync(file)) return { state: "MISSING", present: false, path: file, installation_id: null };
  const record = readInstallationRecord(entitlementDir);
  if (!record) return { state: "MALFORMED", present: true, path: file, installation_id: null };
  return { state: "BOUND", present: true, path: file, installation_id: record.installation_id };
}

module.exports = { DEFAULT_ENTITLEMENT_DIR, INSTALLATION_TOKEN_FILE, INSTALLATION_ID_FILE, INSTALLATION_ID_RE, installationTokenPath, installationIdPath, readInstallationRecord, writeInstallationRecord, writeInstallationIdFile, ensureInstallationId, installationTokenExpired, loadInstallationId, installationStatus };
