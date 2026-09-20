"use strict";

const path = require("path");
const { resolveExecutionPolicy } = require("./execution_policy");
const { recordExecutionAudit, redactAuditText, SAFE_OPERATIONS } = require("./execution_audit");
const { redactValue } = require("./evidence");

const RISK_OPERATIONS = Object.freeze([...SAFE_OPERATIONS]);
const ADAPTER_NAMES = Object.freeze(Object.fromEntries(RISK_OPERATIONS.map(operation => [operation, operation])));
const INTEGRITY_BLOCKERS = new Set(["path_traversal", "workspace_boundary", "dangerous_object_key", "verifier_tampering", "always_blocked"]);

function relativeSafePath(root, value) {
  if (typeof value !== "string" || !value.trim()) return { safe: false, reason: "path is empty" };
  const relative = path.relative(path.resolve(root), path.resolve(root, value)).replace(/\\/g, "/");
  if (!relative || relative === ".." || relative.startsWith("../") || path.isAbsolute(relative) || relative.split("/").includes("..")) return { safe: false, reason: "path escapes workspace boundary" };
  return { safe: true, value: relative };
}
function validateRiskInput(operation, input = {}, options = {}) {
  if (!RISK_OPERATIONS.includes(operation)) return { valid: false, code: "UNKNOWN_RISK_OPERATION", reason: "risk operation is not supported" };
  if (input && typeof input === "object" && Object.keys(input).some(key => ["__proto__", "prototype", "constructor"].includes(key))) return { valid: false, code: "DANGEROUS_OBJECT_KEY", reason: "dangerous object key is not allowed" };
  const safePaths = [];
  for (const item of Array.isArray(input.paths) ? input.paths : []) {
    const checked = relativeSafePath(options.workspaceRoot || process.cwd(), item);
    if (!checked.safe) return { valid: false, code: "PATH_OUTSIDE_WORKSPACE", reason: checked.reason };
    safePaths.push(checked.value);
  }
  if (input.verifier_tampering === true || input.verifier_changed === true) return { valid: false, code: "VERIFIER_TAMPERING", reason: "verification gates cannot be modified" };
  return { valid: true, paths: [...new Set(safePaths)] };
}
function adapterFor(adapters, operation) { return typeof adapters?.[operation] === "function" ? adapters[operation] : null; }
function operationCapabilities(operation) { return [operation]; }

async function executeRiskOperations(proposal = {}, options = {}) {
  const requested = Array.isArray(proposal.risk_operations) ? proposal.risk_operations : Array.isArray(proposal.operations) ? proposal.operations : [];
  if (requested.length === 0) return { success: true, status: "not_requested", audits: [], operations: [] };
  const audits = []; const results = [];
  const goalId = options.goal_id || options.goalId || options.session?.goalSpec?.goal_id || null;
  const sessionId = options.session_id || options.sessionId || options.session?.state?.session_id || null;
  for (const entry of requested) {
    const operation = typeof entry === "string" ? entry : entry?.operation;
    const input = typeof entry === "object" && entry ? entry : {};
    const requestedCapabilities = operationCapabilities(operation);
    const decision = resolveExecutionPolicy({ mode: options.mode || "safe", capabilities: requestedCapabilities, explicit_confirmation: options.explicit_confirmation === true, auto_accept: options.auto_accept === true || options.autoAccept === true, source: options.source || "internal", actor: options.actor, config: options.config });
    const checked = validateRiskInput(operation, input, options);
    const denied = checked.valid ? decision.denied_capabilities : [...new Set([...(decision.denied_capabilities || []), checked.code])];
    const allowed = checked.valid && decision.allowed && decision.mode === "unrestricted";
    const grantedCapabilities = allowed ? requestedCapabilities : [];
    const base = { goal_id: goalId, session_id: sessionId, source: options.source, actor: options.actor, execution_mode: decision.mode, requested_capabilities: requestedCapabilities, granted_capabilities: grantedCapabilities, denied_capabilities: denied, policy_decision: allowed ? "allowed" : decision.approval_required ? "approval_required" : "denied", task: options.task, affected_paths: checked.paths || input.paths, external_target: input.external_target, approval_bypassed: allowed, credential_presence_used: input.credential_presence_used === true, verification_result: "not_executed", final_outcome: checked.valid ? "not_executed" : checked.code, operation, phase: "preflight" };
    let audit;
    try { audit = recordExecutionAudit(base, options); audits.push(audit); } catch (error) { return { success: false, status: "blocked", error: error.message, error_code: error.code, audits, operations: results }; }
    if (!allowed) { results.push({ operation, success: false, status: "blocked", reason: checked.valid ? decision.reason : checked.reason, audit_id: audit.audit_id }); continue; }
    const adapter = adapterFor(options.adapters || options.riskAdapters || options.executionAdapters, operation);
    if (!adapter) { results.push({ operation, success: false, status: "unavailable", reason: "injected risk adapter is required", audit_id: audit.audit_id }); continue; }
    let outcome;
    try { outcome = await adapter({ ...input, paths: checked.paths, operation, read_only: false }); } catch (error) { outcome = { success: false, status: "failure", error: redactAuditText(error.message) }; }
    const successful = outcome?.success === true;
    try { const finalAudit = recordExecutionAudit({ ...base, audit_id: audit.audit_id, phase: "final", verification_result: outcome?.verification_result || outcome?.verification || (successful ? "passed" : "failed"), final_outcome: successful ? "completed" : "failed" }, options); audits.push(finalAudit); } catch (error) { return { success: false, status: "blocked", error: error.message, error_code: error.code, audits, operations: results }; }
    results.push({ operation, success: successful, status: outcome?.status || (successful ? "success" : "failure"), result: redactValue(outcome), audit_id: audit.audit_id });
  }
  const success = results.every(item => item.success === true);
  return { success, status: success ? "success" : "failure", operations: results, audits, risk_operations: results.map(item => item.operation) };
}

module.exports = { RISK_OPERATIONS, ADAPTER_NAMES, INTEGRITY_BLOCKERS, relativeSafePath, validateRiskInput, executeRiskOperations };
