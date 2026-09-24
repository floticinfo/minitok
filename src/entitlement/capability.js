"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { postJson } = require("../core/http");

const DEFAULT_CAPABILITY_FILE = path.join(os.homedir(), ".minitok", "entitlement", "capability-token.json");
const FULL_TEST_PROFILE = "full_test";
const FULL_TEST_CAPABILITIES = Object.freeze(["read", "inspect", "workspace_write", "local_mutation", "verify", "verify_exec", "auto_accept", "unrestricted_autonomous", "unrestricted_general_autonomous", "goal_inference", "criteria_inference", "replanning", "tool_discovery"]);
const DENIED_CAPABILITIES = Object.freeze(["credential_use", "external_call", "publish", "deploy", "database_mutation", "force_push", "tag_overwrite", "protected_path_write", "always_blocked", "irreversible_operation", "safety_bypass"]);
const LOCAL_SCOPE_MAP = Object.freeze({ read: "read", workspace_write: "write", local_mutation: "write", verify_exec: "verify_exec", auto_accept: "auto_accept", unrestricted_autonomous: "unrestricted_autonomous", unrestricted_general_autonomous: "unrestricted_general_autonomous" });

function capabilityFile(entitlementDir) { return path.join(entitlementDir || path.join(os.homedir(), ".minitok", "entitlement"), "capability-token.json"); }
function safeRecord(record, now = Date.now()) {
  if (!record || typeof record !== "object" || Array.isArray(record) || typeof record.token !== "string" || !record.token || record.profile !== FULL_TEST_PROFILE || typeof record.installation_id !== "string" || typeof record.validated_at !== "string" || !Number.isFinite(Date.parse(record.validated_at)) || !Array.isArray(record.capabilities) || !Number.isFinite(Date.parse(record.expires_at)) || now >= Date.parse(record.expires_at)) return null;
  const capabilities = [...new Set(record.capabilities)];
  if (capabilities.some(item => DENIED_CAPABILITIES.includes(item)) || FULL_TEST_CAPABILITIES.some(item => !capabilities.includes(item))) return null;
  return { ...record, capabilities };
}
function readCapabilityRecord(options = {}) {
  const filePath = options.filePath || capabilityFile(options.entitlementDir);
  try { return safeRecord(JSON.parse((options.fs || fs).readFileSync(filePath, "utf8")), options.now || Date.now()); } catch { return null; }
}
function writeCapabilityRecord(record, filePath = DEFAULT_CAPABILITY_FILE) {
  const valid = safeRecord(record);
  if (!valid) throw new Error("Invalid capability record");
  const fileSystem = fs;
  fileSystem.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temp = `${filePath}.tmp.${process.pid}.${crypto.randomBytes(8).toString("hex")}`;
  try { fileSystem.writeFileSync(temp, `${JSON.stringify(valid, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 }); fileSystem.renameSync(temp, filePath); try { fileSystem.chmodSync(filePath, 0o600); } catch {} } catch (error) { try { fileSystem.unlinkSync(temp); } catch {} throw error; }
  return valid;
}
async function importCapabilityToken(token, options = {}) {
  if (typeof token !== "string" || !token.trim()) return { success: false, code: 400, error: "Capability token is required" };
  const serverUrl = String(options.serverUrl || process.env.MINITOK_SERVER_URL || "https://api.minitok.dev").replace(/\/$/, "");
  const response = await (options.validate || ((url, body) => postJson(url, body, 10000)))(`${serverUrl}/v1/capability/validate`, { token: token.trim() });
  if (!response?.ok || response.body?.valid !== true) return { success: false, code: response?.status || 401, error: response?.body?.error || "Capability token was rejected by the server" };
  const claims = response.body.claims;
  const record = safeRecord({ token: token.trim(), installation_id: claims.installation_id, profile: response.body.profile, capabilities: claims.capabilities, execution_modes: claims.execution_modes, issued_at: new Date(claims.iat * 1000).toISOString(), expires_at: new Date(claims.exp * 1000).toISOString(), validated_at: new Date().toISOString(), server_url: serverUrl });
  if (!record) return { success: false, code: 401, error: "Capability validation response was invalid" };
  writeCapabilityRecord(record, options.filePath || capabilityFile(options.entitlementDir));
  return { success: true, record: { installation_id: record.installation_id, profile: record.profile, capabilities: record.capabilities, expires_at: record.expires_at, server_url: record.server_url } };
}
function capabilityPermissions(options = {}) {
  const record = readCapabilityRecord(options);
  if (!record) return { record: null, permissions: [] };
  const permissions = [...new Set(record.capabilities.map(item => LOCAL_SCOPE_MAP[item]).filter(Boolean))];
  return { record, permissions };
}
function clearCapabilityRecord(filePath = DEFAULT_CAPABILITY_FILE) { try { fs.unlinkSync(filePath); } catch {} }
module.exports = { DEFAULT_CAPABILITY_FILE, FULL_TEST_PROFILE, FULL_TEST_CAPABILITIES, DENIED_CAPABILITIES, capabilityFile, safeRecord, readCapabilityRecord, writeCapabilityRecord, importCapabilityToken, capabilityPermissions, clearCapabilityRecord };
