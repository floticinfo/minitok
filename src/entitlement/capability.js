"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { postJson } = require("../core/http");

const DEFAULT_CAPABILITY_FILE = path.join(os.homedir(), ".minitok", "entitlement", "capability-token.json");
const FULL_TEST_PROFILE = "full_test";
const FULL_TEST_CAPABILITIES = Object.freeze(["read", "inspect", "workspace_write", "local_mutation", "verify", "verify_exec", "auto_accept", "unrestricted_autonomous", "unrestricted_general_autonomous", "goal_inference", "criteria_inference", "replanning", "tool_discovery"]);
const UNRESTRICTED_LOCAL_PROFILE = "unrestricted_local";
const UNRESTRICTED_LOCAL_CAPABILITIES = Object.freeze(["read", "inspect", "verify", "workspace_write", "local_mutation", "verify_exec", "unrestricted_autonomous", "auto_accept"]);
const UNRESTRICTED_LOCAL_EXECUTION_MODES = Object.freeze(["unrestricted"]);
const DENIED_CAPABILITIES = Object.freeze(["credential_use", "external_call", "publish", "deploy", "database_mutation", "force_push", "tag_overwrite", "protected_path_write", "always_blocked", "irreversible_operation", "safety_bypass"]);
const UNRESTRICTED_LOCAL_DENIED_CAPABILITIES = Object.freeze([...DENIED_CAPABILITIES, "unrestricted_general_autonomous", "goal_inference", "criteria_inference", "plan_expansion", "replanning", "tool_discovery"]);
const LOCAL_SCOPE_MAP = Object.freeze({ read: "read", workspace_write: "write", local_mutation: "write", verify_exec: "verify_exec", auto_accept: "auto_accept", unrestricted_autonomous: "unrestricted_autonomous", unrestricted_general_autonomous: "unrestricted_general_autonomous" });
const { loadInstallationRecord } = require("./online");

function isAuthorizedCapabilityProfile(profile) { return profile === FULL_TEST_PROFILE || profile === UNRESTRICTED_LOCAL_PROFILE; }
function profileCapabilities(profile) { return profile === FULL_TEST_PROFILE ? FULL_TEST_CAPABILITIES : profile === UNRESTRICTED_LOCAL_PROFILE ? UNRESTRICTED_LOCAL_CAPABILITIES : null; }

const MAX_LOCAL_CAPABILITY_TTL_SECONDS = 86400;
const MAX_SERVER_IAT_FUTURE_SKEW_SECONDS = 60;
function validServerClaims(claims, profile, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (!claims || typeof claims !== "object" || Array.isArray(claims) || claims.profile !== undefined && claims.profile !== profile) return false;
  if (profile === UNRESTRICTED_LOCAL_PROFILE && claims.profile !== profile) return false;
  if (!Number.isSafeInteger(claims.iat) || claims.iat < 0 || claims.iat > nowSeconds + MAX_SERVER_IAT_FUTURE_SKEW_SECONDS) return false;
  if (!Number.isSafeInteger(claims.exp) || claims.exp <= nowSeconds || claims.exp <= claims.iat) return false;
  if (profile === UNRESTRICTED_LOCAL_PROFILE && claims.exp - claims.iat > MAX_LOCAL_CAPABILITY_TTL_SECONDS) return false;
  return true;
}

function capabilityFile(entitlementDir) { return path.join(entitlementDir || path.join(os.homedir(), ".minitok", "entitlement"), "capability-token.json"); }
function safeRecord(record, now = Date.now(), options = {}) {
  if (!record || typeof record !== "object" || Array.isArray(record) || typeof record.token !== "string" || !record.token || !isAuthorizedCapabilityProfile(record.profile) || typeof record.installation_id !== "string" || !record.installation_id || typeof record.validated_at !== "string" || !Number.isFinite(Date.parse(record.validated_at)) || !Array.isArray(record.capabilities) || !record.capabilities.every(item => typeof item === "string") || !Number.isFinite(Date.parse(record.expires_at)) || now >= Date.parse(record.expires_at)) return null;
  const allowed = profileCapabilities(record.profile);
  const denied = record.profile === UNRESTRICTED_LOCAL_PROFILE ? UNRESTRICTED_LOCAL_DENIED_CAPABILITIES : DENIED_CAPABILITIES;
  const capabilities = [...new Set(record.capabilities)];
  if (capabilities.some(item => denied.includes(item) || !allowed.includes(item)) || allowed.some(item => !capabilities.includes(item))) return null;
  if (record.profile === UNRESTRICTED_LOCAL_PROFILE) {
    if (JSON.stringify(record.capabilities) !== JSON.stringify(UNRESTRICTED_LOCAL_CAPABILITIES) || JSON.stringify(record.execution_modes) !== JSON.stringify(UNRESTRICTED_LOCAL_EXECUTION_MODES)) return null;
    const installation = options.installationRecord === undefined ? loadInstallationRecord(options.entitlementDir) : options.installationRecord;
    if (!installation || installation.installation_id !== record.installation_id) return null;
  }
  return { ...record, capabilities };
}
function readCapabilityRecord(options = {}) {
  const filePath = options.filePath || capabilityFile(options.entitlementDir);
  try { return safeRecord(JSON.parse((options.fs || fs).readFileSync(filePath, "utf8")), options.now || Date.now(), options); } catch { return null; }
}
function writeCapabilityRecord(record, filePath = DEFAULT_CAPABILITY_FILE, validationOptions = {}) {
  const valid = safeRecord(record, Date.now(), validationOptions);
  if (!valid) throw new Error("Invalid capability record");
  const fileSystem = fs;
  fileSystem.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temp = `${filePath}.tmp.${process.pid}.${crypto.randomBytes(8).toString("hex")}`;
  try { fileSystem.writeFileSync(temp, `${JSON.stringify(valid, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 }); fileSystem.renameSync(temp, filePath); try { fileSystem.chmodSync(filePath, 0o600); } catch {} } catch (error) { try { fileSystem.unlinkSync(temp); } catch {} throw error; }
  return valid;
}
async function importCapabilityToken(token, options = {}) {
  if (typeof token !== "string" || !token.trim()) return { success: false, code: 400, error: "Capability token is required" };
  const installation = options.installationRecord === undefined ? token.trim().startsWith("mtcap_v1_") ? loadInstallationRecord(options.entitlementDir) : null : options.installationRecord;
  const installationId = typeof installation?.installation_id === "string" && installation.installation_id ? installation.installation_id : null;
  const serverUrl = String(options.serverUrl || process.env.MINITOK_SERVER_URL || "https://api.minitok.dev").replace(/\/$/, "");
  const isLocalProfile = options.profile === UNRESTRICTED_LOCAL_PROFILE || token.trim().startsWith("mtcap_v1_");
  if (isLocalProfile && !installationId) return { success: false, code: 401, error: "A matching local installation is required for this capability profile" };
  let response;
  try {
    response = await (options.validate || ((url, body) => postJson(url, body, 10000)))(`${serverUrl}/v1/capability/validate`, { token: token.trim(), ...(isLocalProfile ? { installation_id: installationId } : {}) });
  } catch {
    return { success: false, code: 503, error: "Capability validation service is unavailable" };
  }
  if (!response?.ok || !response.body || typeof response.body !== "object" || Array.isArray(response.body) || response.body.valid !== true) return { success: false, code: response?.status || 401, error: response?.body?.error || "Capability token was rejected by the server" };

  if (typeof response.body.profile !== "string" || !isAuthorizedCapabilityProfile(response.body.profile)) return { success: false, code: 401, error: "Capability validation response used an unauthorized profile" };
  if (isLocalProfile && response.body.profile !== UNRESTRICTED_LOCAL_PROFILE) return { success: false, code: 401, error: "Capability validation response profile did not match the local grant" };
  const claims = response.body.claims;
  const profile = response.body.profile;
  if (!validServerClaims(claims, profile)) return { success: false, code: 401, error: "Capability validation response was invalid" };
  if (installationId && claims.installation_id !== installationId || profile === FULL_TEST_PROFILE && typeof claims.installation_id !== "string") return { success: false, code: 401, error: "Capability validation response did not match this installation" };
  if (profile === UNRESTRICTED_LOCAL_PROFILE && (!isLocalProfile || !installationId)) return { success: false, code: 401, error: "A matching local installation is required for this capability profile" };
  const record = safeRecord({ token: token.trim(), installation_id: claims.installation_id, profile, capabilities: claims.capabilities, execution_modes: claims.execution_modes, issued_at: new Date(claims.iat * 1000).toISOString(), expires_at: new Date(claims.exp * 1000).toISOString(), validated_at: new Date().toISOString(), server_url: serverUrl }, Date.now(), { installationRecord: installation });
  if (!record) return { success: false, code: 401, error: "Capability validation response was invalid" };
  writeCapabilityRecord(record, options.filePath || capabilityFile(options.entitlementDir), { installationRecord: installation });
  return { success: true, record: { installation_id: record.installation_id, profile: record.profile, capabilities: record.capabilities, expires_at: record.expires_at, server_url: record.server_url } };
}
async function revalidateCapabilityRecord(options = {}) {
  const record = readCapabilityRecord(options);
  if (!record) return null;
  if (record.profile !== UNRESTRICTED_LOCAL_PROFILE) return record;
  const serverUrl = String(options.serverUrl || record.server_url || process.env.MINITOK_SERVER_URL || "https://api.minitok.dev").replace(/\/$/, "");
  try {
    const response = await (options.validate || ((url, body) => postJson(url, body, 10000)))(`${serverUrl}/v1/capability/validate`, { token: record.token, installation_id: record.installation_id });
    const claims = response?.body?.claims;
    if (!response?.ok || response.body?.valid !== true || !claims || claims.installation_id !== record.installation_id || claims.profile !== UNRESTRICTED_LOCAL_PROFILE || response.body.profile !== UNRESTRICTED_LOCAL_PROFILE || !validServerClaims(claims, UNRESTRICTED_LOCAL_PROFILE)) return null;
    const refreshed = safeRecord({ ...record, capabilities: claims.capabilities, execution_modes: claims.execution_modes, issued_at: new Date(claims.iat * 1000).toISOString(), expires_at: new Date(claims.exp * 1000).toISOString(), validated_at: new Date().toISOString(), server_url: serverUrl }, Date.now(), options);
    if (!refreshed) return null;
    writeCapabilityRecord(refreshed, options.filePath || capabilityFile(options.entitlementDir), options);
    return refreshed;
  } catch { return null; }
}
function capabilityPermissions(options = {}) {
  const record = readCapabilityRecord(options);
  if (!record) return { record: null, permissions: [] };
  const permissions = [...new Set(record.capabilities.map(item => LOCAL_SCOPE_MAP[item]).filter(Boolean))];
  return { record, permissions };
}
function clearCapabilityRecord(filePath = DEFAULT_CAPABILITY_FILE) { try { fs.unlinkSync(filePath); } catch {} }
module.exports = { DEFAULT_CAPABILITY_FILE, FULL_TEST_PROFILE, FULL_TEST_CAPABILITIES, UNRESTRICTED_LOCAL_PROFILE, UNRESTRICTED_LOCAL_CAPABILITIES, UNRESTRICTED_LOCAL_EXECUTION_MODES, DENIED_CAPABILITIES, UNRESTRICTED_LOCAL_DENIED_CAPABILITIES, capabilityFile, safeRecord, readCapabilityRecord, writeCapabilityRecord, importCapabilityToken, revalidateCapabilityRecord, capabilityPermissions, clearCapabilityRecord, isAuthorizedCapabilityProfile, profileCapabilities };
