"use strict";

const crypto = require("crypto");
const path = require("path");
const { auditLog } = require("../core/audit");
const { redactText, redactValue } = require("./evidence");

const EXECUTION_AUDIT_SCHEMA_VERSION = 1;
const SENSITIVE_TEXT = /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|private[_ -]?key|authorization(?:[_ -]?header)?|token))\s*[:=]\s*["']?[^\s,;"']+/gi;
const PRIVATE_KEY = /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gi;
const HIGH_RISK_TOKEN = /\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_-]{12,}|eyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g;
const SAFE_SOURCES = new Set(["cli", "mcp", "internal", "extension"]);
const SAFE_OPERATIONS = new Set(["workspace_write", "external_call", "credential_use", "publish", "deploy", "database_mutation", "force_push", "tag_overwrite"]);

function redactAuditText(value, max = 2000) {
  if (value === undefined || value === null) return null;
  let text = redactText(String(value));
  text = text.replace(PRIVATE_KEY, "[REDACTED_PRIVATE_KEY]").replace(SENSITIVE_TEXT, "[REDACTED]").replace(/Bearer\s+[^\s]+/gi, "[REDACTED]").replace(HIGH_RISK_TOKEN, "[REDACTED_TOKEN]");
  return text.length > max ? `${text.slice(0, max)}...[TRUNCATED]` : text;
}
function hasDangerousKey(value) {
  if (Array.isArray(value)) return value.some(hasDangerousKey);
  if (!value || typeof value !== "object") return false;
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return true;
  return Object.keys(value).some(key => ["__proto__", "prototype", "constructor"].includes(key) || hasDangerousKey(value[key]));
}
function safeRelativePath(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const normalized = value.replace(/\\/g, "/");
  if (normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized) || normalized.split("/").includes("..")) return "[REDACTED_UNSAFE_PATH]";
  const clean = path.posix.normalize(normalized).replace(/^\.\//, "");
  return clean === "." || clean.startsWith("../") ? "[REDACTED_UNSAFE_PATH]" : clean.slice(0, 512);
}
function redactAffectedPaths(value) {
  const paths = Array.isArray(value) ? value : value === undefined ? [] : [value];
  return [...new Set(paths.map(safeRelativePath).filter(Boolean))].slice(0, 64);
}
function redactExternalTarget(value) {
  if (value === undefined || value === null) return null;
  try {
    const url = new URL(String(value));
    return { protocol: url.protocol, hostname: url.hostname, port: url.port || null, pathname: url.pathname || "/" };
  } catch {
    return redactAuditText(value, 512);
  }
}
function auditId(input) {
  return `exec-audit-${crypto.randomBytes(10).toString("hex")}`;
}
function createExecutionAuditRecord(input = {}) {
  if (hasDangerousKey(input)) throw Object.assign(new Error("Dangerous execution audit input was rejected"), { code: "AUDIT_INVALID_INPUT" });
  const requested = Array.isArray(input.requested_capabilities) ? [...new Set(input.requested_capabilities.filter(item => typeof item === "string"))] : [];
  const granted = Array.isArray(input.granted_capabilities) ? [...new Set(input.granted_capabilities.filter(item => typeof item === "string"))] : [];
  const denied = Array.isArray(input.denied_capabilities) ? [...new Set(input.denied_capabilities.filter(item => typeof item === "string"))] : [];
  const operations = requested.filter(item => SAFE_OPERATIONS.has(item));
  const actor = input.actor && typeof input.actor === "object" ? { id: redactAuditText(input.actor.id, 128), type: redactAuditText(input.actor.type, 64) } : null;
  const record = {
    schema_version: EXECUTION_AUDIT_SCHEMA_VERSION,
    audit_id: typeof input.audit_id === "string" && input.audit_id ? input.audit_id : auditId(input),
    goal_id: redactAuditText(input.goal_id, 128),
    session_id: redactAuditText(input.session_id, 128),
    timestamp: typeof input.timestamp === "string" ? input.timestamp : new Date().toISOString(),
    actor,
    actor_source: actor,
    source: SAFE_SOURCES.has(input.source) ? input.source : "internal",
    execution_mode: typeof input.execution_mode === "string" ? input.execution_mode : "safe",
    requested_capabilities: requested,
    granted_capabilities: granted,
    denied_capabilities: denied,
    policy_decision: ["allowed", "approval_required", "denied"].includes(input.policy_decision) ? input.policy_decision : "denied",
    task: redactAuditText(input.task),
    affected_paths: redactAffectedPaths(input.affected_paths),
    external_target: redactExternalTarget(input.external_target),
    approval_bypassed: input.approval_bypassed === true && input.execution_mode === "unrestricted" && granted.length > 0,
    credential_presence_used: input.credential_presence_used === true,
    verification_result: redactAuditText(input.verification_result, 512),
    final_outcome: redactAuditText(input.final_outcome, 512),
    operation: SAFE_OPERATIONS.has(input.operation) ? input.operation : operations[0] || null,
    phase: input.phase === "preflight" ? "preflight" : "final",
  };
  const redacted = redactValue(record);
  redacted.credential_presence_used = input.credential_presence_used === true;
  return redacted;
}
function recordExecutionAudit(record, options = {}) {
  const safeRecord = createExecutionAuditRecord(record);
  const result = auditLog({ type: "execution", ...safeRecord }, options.auditPath);
  if (!result?.persisted) throw Object.assign(new Error("Execution audit persistence is required before continuing"), { code: "AUDIT_PERSISTENCE_REQUIRED", audit: safeRecord, persistence: result });
  return { ...safeRecord, persisted: true };
}
module.exports = { EXECUTION_AUDIT_SCHEMA_VERSION, SAFE_OPERATIONS, redactAuditText, redactAffectedPaths, redactExternalTarget, createExecutionAuditRecord, recordExecutionAudit };