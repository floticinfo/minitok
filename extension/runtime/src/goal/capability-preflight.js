"use strict";

const crypto = require("crypto");
const { capabilityPermissions, DENIED_CAPABILITIES, UNRESTRICTED_LOCAL_PROFILE, UNRESTRICTED_LOCAL_CAPABILITIES } = require("../entitlement/capability");

const EXTERNAL_CAPABILITIES = new Set(["external_call", "credential_use", "publish", "deploy", "database_mutation", "force_push", "tag_overwrite"]);
const ALWAYS_BLOCKED = new Set(["always_blocked", "irreversible_operation", "safety_bypass", "protected_path_write"]);

function capabilitySnapshot(input = {}) {
  const record = input.record || null;
  const granted = [...new Set(Array.isArray(input.granted) ? input.granted.filter(item => typeof item === "string") : record?.capabilities || [])].sort();
  const profile = record?.profile || input.profile || null;
  const tokenValid = record !== null || input.tokenValid === true;
  const payload = { profile, token_valid: tokenValid, installation_id: record?.installation_id || input.installationId || null, expires_at: record?.expires_at || null, granted_capabilities: granted };
  const snapshotId = `cap-${crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 24)}`;
  return { ...payload, snapshot_id: snapshotId };
}

function capabilityPreflight(input = {}) {
  const requested = [...new Set(Array.isArray(input.requested) ? input.requested.filter(item => typeof item === "string") : [])];
  const record = input.record === undefined ? capabilityPermissions({ filePath: input.filePath }).record : input.record;
  const snapshot = capabilitySnapshot({ ...input, record });
  const granted = new Set(snapshot.granted_capabilities);
  const profileDenied = snapshot.profile === UNRESTRICTED_LOCAL_PROFILE ? requested.filter(item => !UNRESTRICTED_LOCAL_CAPABILITIES.includes(item)) : [];
  const denied = [...new Set([...requested.filter(item => !granted.has(item) && !["read", "inspect", "verify"].includes(item)), ...profileDenied])];
  const alwaysBlocked = [...new Set(requested.filter(item => ALWAYS_BLOCKED.has(item)))];
  const blockedExternal = [...new Set(requested.filter(item => EXTERNAL_CAPABILITIES.has(item) || DENIED_CAPABILITIES.includes(item)))];
  const policyDenied = Array.isArray(input.policyDecision?.denied_capabilities) ? input.policyDecision.denied_capabilities : [];
  const approval = [...new Set([...(input.policyDecision?.approval_required ? requested.filter(item => !alwaysBlocked.includes(item) && !blockedExternal.includes(item)) : []), ...policyDenied.filter(item => !alwaysBlocked.includes(item))])];
  const deniedCapabilities = [...new Set([...denied, ...policyDenied, ...blockedExternal])].filter(item => !approval.includes(item));
  if (snapshot.profile === UNRESTRICTED_LOCAL_PROFILE) for (const item of requested) if (!UNRESTRICTED_LOCAL_CAPABILITIES.includes(item) && !deniedCapabilities.includes(item)) deniedCapabilities.push(item);
  return { capability_profile: snapshot.profile, capability_token_valid: snapshot.token_valid, capability_snapshot_id: snapshot.snapshot_id, granted_capabilities: snapshot.granted_capabilities, denied_capabilities: deniedCapabilities, approval_required_capabilities: approval, always_blocked_capabilities: alwaysBlocked, blocked_external_operations: blockedExternal, policy_decision: input.policyDecision?.allowed === true ? "allowed" : approval.length ? "approval_required" : "denied" };
}

function sameCapabilitySnapshot(expected, current) { return Boolean(expected && current && expected.snapshot_id === current.snapshot_id && expected.token_valid === current.token_valid); }

module.exports = { EXTERNAL_CAPABILITIES, ALWAYS_BLOCKED, capabilitySnapshot, capabilityPreflight, sameCapabilitySnapshot };
