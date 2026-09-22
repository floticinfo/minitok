"use strict";

const crypto = require("crypto");
const { redactValue } = require("./evidence");

const EXTERNAL_OPERATION_CONTRACT_SCHEMA_VERSION = 1;
const OPERATION_STATUSES = Object.freeze(["success", "failed", "partial_success", "unknown", "timeout"]);
const BAD_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function plain(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
function array(value) { return Array.isArray(value) ? value : []; }
function hasBadKeys(value) {
  if (Array.isArray(value)) return value.some(hasBadKeys);
  if (!value || typeof value !== "object") return false;
  if (!plain(value)) return true;
  return Object.entries(value).some(([key, child]) => BAD_KEYS.has(key) || hasBadKeys(child));
}
function canonical(value) {
  if (value === undefined) return null;
  if (Array.isArray(value)) return value.map(canonical);
  if (plain(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  if (typeof value === "number" && !Number.isFinite(value)) return null;
  if (["string", "number", "boolean"].includes(typeof value) || value === null) return value;
  return String(value);
}
function digest(prefix, value) {
  return `${prefix}_${crypto.createHash("sha256").update(JSON.stringify(canonical(redactValue(value)))).digest("hex")}`;
}
function targetValue(input = {}) { return plain(input.target) ? input.target : plain(input.target_binding) ? input.target_binding : null; }
function requiredTargetFields(binding) {
  if (Array.isArray(binding)) return binding;
  if (plain(binding)) return array(binding.required || binding.fields);
  return [];
}
function normalizeRetryPolicy(policy = {}) {
  const maxAttempts = Number.isSafeInteger(policy.max_attempts) && policy.max_attempts > 0 ? policy.max_attempts : 1;
  const retryableStatuses = [...new Set(array(policy.retryable_statuses).filter(status => OPERATION_STATUSES.includes(status)))];
  return { max_attempts: maxAttempts, retryable_statuses: retryableStatuses, retry_unknown: policy.retry_unknown === true, backoff_ms: Number.isSafeInteger(policy.backoff_ms) && policy.backoff_ms >= 0 ? policy.backoff_ms : 0 };
}
function normalizeContract(input = {}, adapter = {}) {
  const value = plain(input) ? input : {};
  return {
    schema_version: EXTERNAL_OPERATION_CONTRACT_SCHEMA_VERSION,
    target_binding: value.target_binding || { required: ["target_id"] },
    required_capabilities: [...new Set(array(value.required_capabilities || adapter.capabilities).filter(item => typeof item === "string"))],
    mutation: value.mutation !== false,
    idempotency_required: value.idempotency_required !== false,
    read_after_write_required: value.read_after_write_required !== false && value.mutation !== false,
    retry_policy: normalizeRetryPolicy(value.retry_policy),
    timeout_ms: Number.isSafeInteger(value.timeout_ms) && value.timeout_ms > 0 ? value.timeout_ms : 0,
    state_fingerprint_fields: array(value.state_fingerprint_fields).filter(item => typeof item === "string"),
  };
}
function validateExternalOperationContract(contract, path = "external_operation_contract") {
  const errors = [];
  if (!plain(contract) || hasBadKeys(contract)) return [{ path, code: "INVALID_EXTERNAL_CONTRACT" }];
  const fields = requiredTargetFields(contract.target_binding);
  if (!fields.length || fields.some(item => typeof item !== "string" || !item.trim())) errors.push({ path: `${path}.target_binding`, code: "TARGET_BINDING_REQUIRED" });
  if (contract.required_capabilities !== undefined && (!Array.isArray(contract.required_capabilities) || contract.required_capabilities.some(item => typeof item !== "string"))) errors.push({ path: `${path}.required_capabilities`, code: "INVALID_CAPABILITIES" });
  if (contract.retry_policy !== undefined && !plain(contract.retry_policy)) errors.push({ path: `${path}.retry_policy`, code: "INVALID_RETRY_POLICY" });
  if (Number.isSafeInteger(contract.retry_policy?.max_attempts) && contract.retry_policy.max_attempts < 1) errors.push({ path: `${path}.retry_policy.max_attempts`, code: "INVALID_ATTEMPT_LIMIT" });
  return errors;
}
function validateTargetBinding(input, contract) {
  const target = targetValue(input);
  const required = requiredTargetFields(contract.target_binding);
  if (!target) return { valid: false, code: "EXTERNAL_TARGET_REQUIRED", reason: "a bound external target is required" };
  const missing = required.filter(field => target[field] === undefined || target[field] === null || target[field] === "");
  if (missing.length) return { valid: false, code: "EXTERNAL_TARGET_UNBOUND", missing_target_fields: missing, reason: "external target binding is incomplete" };
  return { valid: true, target: redactValue(target) };
}
function requestFingerprint(adapterName, input, contract) {
  const copy = plain(input) ? { ...input } : {};
  delete copy.idempotency_key;
  delete copy.request_fingerprint;
  return digest("request", { adapter: adapterName, target: targetValue(copy), input: copy, contract: { target_binding: contract.target_binding, mutation: contract.mutation } });
}
function externalStateFingerprint(state, fields = []) {
  const value = plain(state) ? state : { value: state };
  const selected = fields.length ? Object.fromEntries(fields.filter(field => Object.prototype.hasOwnProperty.call(value, field)).sort().map(field => [field, value[field]])) : value;
  return digest("state", selected);
}
function createOperationRequest(adapterName, input = {}, contract) {
  const fingerprint = requestFingerprint(adapterName, input, contract);
  const supplied = typeof input.idempotency_key === "string" && input.idempotency_key.trim() ? input.idempotency_key.trim() : null;
  return { idempotency_key: supplied || digest("idem", { adapter: adapterName, request_fingerprint: fingerprint }), request_fingerprint: fingerprint, target: targetValue(input) };
}
function normalizeOperationResult(value) {
  const result = plain(value) ? redactValue(value) : { success: false, status: "unknown", reason: "external adapter returned a non-object result" };
  let status = typeof result.status === "string" && OPERATION_STATUSES.includes(result.status) ? result.status : result.timed_out === true ? "timeout" : result.success === true ? "success" : result.success === false ? "failed" : "unknown";
  if (result.partial_success === true) status = "partial_success";
  return { ...result, status, success: status === "success", completed: false };
}
function invokeWithTimeout(invoke, timeoutMs) {
  const value = Promise.resolve().then(invoke);
  if (!timeoutMs) return value;
  let timer;
  const timeout = new Promise(resolve => { timer = setTimeout(() => resolve({ success: false, status: "timeout", timed_out: true, reason: "external operation timeout" }), timeoutMs); });
  return Promise.race([value, timeout]).finally(() => clearTimeout(timer));
}
function verifyReadAfterWrite(readResult, operationResult, contract, input = {}) {
  const normalized = normalizeOperationResult(readResult);
  if (normalized.status !== "success") return { status: "unknown", valid: false, code: "EXTERNAL_READ_AFTER_WRITE_UNKNOWN", reason: normalized.reason || "read-after-write verification did not complete" };
  const observed = normalized.external_state ?? normalized.state ?? normalized.observation;
  const expected = operationResult.expected_external_state ?? operationResult.external_state ?? operationResult.post_state ?? input.expected_external_state ?? input.post_state;
  if (observed === undefined || expected === undefined) return { status: "unknown", valid: false, code: "EXTERNAL_STATE_REQUIRED", reason: "read-after-write requires expected and observed external state" };
  const observedFingerprint = externalStateFingerprint(observed, contract.state_fingerprint_fields);
  const expectedFingerprint = externalStateFingerprint(expected, contract.state_fingerprint_fields);
  if (observedFingerprint !== expectedFingerprint) return { status: "unknown", valid: false, code: "EXTERNAL_STATE_DRIFT", expected_fingerprint: expectedFingerprint, observed_fingerprint: observedFingerprint, reason: "external state fingerprint differs after write" };
  return { status: "passed", valid: true, executed: true, expected_fingerprint: expectedFingerprint, observed_fingerprint: observedFingerprint };
}
function validateExternalOperation(input, adapter, options = {}) {
  const contract = normalizeContract(adapter.external_operation_contract, adapter);
  const contractErrors = validateExternalOperationContract(adapter.external_operation_contract || contract);
  if (contractErrors.length && adapter.external_operation_contract) return { valid: false, code: "EXTERNAL_CONTRACT_INVALID", errors: contractErrors };
  const target = validateTargetBinding(input, contract);
  if (!target.valid) return target;
  const granted = array(options.capabilities);
  const missing = contract.required_capabilities.filter(capability => !granted.includes(capability));
  if (missing.length) return { valid: false, code: "EXTERNAL_CAPABILITY_MISMATCH", missing_capabilities: missing, reason: "external operation capability is not granted" };
  const request = createOperationRequest(adapter.name, input, contract);
  return { valid: true, contract, request };
}
function ledgerValue(ledger, key) { return ledger instanceof Map ? ledger.get(key) : plain(ledger) ? ledger[key] : undefined; }
function ledgerSet(ledger, key, value) { if (ledger instanceof Map) ledger.set(key, value); else if (plain(ledger)) ledger[key] = value; }
function wait(ms) { return ms > 0 ? new Promise(resolve => setTimeout(resolve, ms)) : Promise.resolve(); }
/** @param {{ adapter: Object, input: Object, options?: { operation_ledger?: Map|Object, operationLedger?: Map|Object, timeout_ms?: number, capabilities?: string[] }, finalize: Function, execute: Function, readAfterWrite?: Function }} args */
async function executeExternalOperation({ adapter, input, options = {}, finalize, execute, readAfterWrite }) {
  const validation = validateExternalOperation(input, adapter, options);
  if (!validation.valid) return { success: false, completed: false, status: "blocked", ...redactValue(validation), adapter: adapter.name };
  const { contract, request } = validation;
  const ledger = options.operation_ledger || options.operationLedger;
  if (!ledger || !(ledger instanceof Map || plain(ledger))) return { success: false, completed: false, status: "blocked", code: "OPERATION_LEDGER_REQUIRED", adapter: adapter.name, idempotency_key: request.idempotency_key, request_fingerprint: request.request_fingerprint };
  const existing = ledgerValue(ledger, request.idempotency_key);
  if (existing) return { success: false, completed: false, status: "duplicate", code: "DUPLICATE_EXTERNAL_OPERATION", adapter: adapter.name, idempotency_key: request.idempotency_key, request_fingerprint: request.request_fingerprint, prior_status: existing.status || "pending" };
  const base = { adapter: adapter.name, idempotency_key: request.idempotency_key, request_fingerprint: request.request_fingerprint, target: request.target };
  ledgerSet(ledger, request.idempotency_key, { ...base, status: "pending" });
  const attempts = [];
  const policy = contract.retry_policy;
  const shouldRetry = status => policy.retryable_statuses.includes(status) || (status === "unknown" && policy.retry_unknown === true);
  let operationResult;
  try {
    for (let attempt = 1; attempt <= policy.max_attempts; attempt += 1) {
      const raw = await invokeWithTimeout(() => execute({ ...input, idempotency_key: request.idempotency_key, request_fingerprint: request.request_fingerprint }), contract.timeout_ms || options.timeout_ms);
      operationResult = normalizeOperationResult(raw);
      attempts.push({ attempt, status: operationResult.status });
      if (!shouldRetry(operationResult.status) || attempt === policy.max_attempts) break;
      await wait(policy.backoff_ms);
    }
    let verification = null;
    if (operationResult.status === "success" && contract.read_after_write_required) {
      if (typeof readAfterWrite !== "function") verification = { status: "unknown", valid: false, code: "READ_AFTER_WRITE_UNAVAILABLE", reason: "verified external writes require an injected read-after-write adapter" };
      else {
        const read = await invokeWithTimeout(() => readAfterWrite({ ...input, idempotency_key: request.idempotency_key, request_fingerprint: request.request_fingerprint }), contract.timeout_ms || options.timeout_ms);
        verification = verifyReadAfterWrite(read, operationResult, contract, input);
      }
      if (!verification.valid) operationResult = { ...operationResult, status: "unknown", success: false };
    }
    const value = finalize(adapter, operationResult);
    const completed = operationResult.status === "success" && (!contract.read_after_write_required || verification?.valid === true) && value.completed === true;
    const result = redactValue({ ...value, ...base, attempts, operation_status: operationResult.status, operation_audit: { idempotency_key: request.idempotency_key, request_fingerprint: request.request_fingerprint, operation_status: operationResult.status, attempts: attempts.length, target: request.target }, completed, status: completed ? "completed" : operationResult.status, verification: { ...(value.verification || {}), external_state: verification || { status: "not_required", valid: true, executed: false } } });
    ledgerSet(ledger, request.idempotency_key, { ...base, status: result.status, completed: result.completed });
    return result;
  } catch (error) {
    const result = redactValue({ ...base, success: false, completed: false, status: "unknown", code: "EXTERNAL_OPERATION_UNKNOWN", error: { message: error.message }, attempts });
    ledgerSet(ledger, request.idempotency_key, { ...base, status: result.status, completed: false });
    return result;
  }
}
module.exports = { EXTERNAL_OPERATION_CONTRACT_SCHEMA_VERSION, OPERATION_STATUSES, normalizeContract, validateExternalOperationContract, validateTargetBinding, canonical, requestFingerprint, externalStateFingerprint, createOperationRequest, normalizeOperationResult, verifyReadAfterWrite, validateExternalOperation, executeExternalOperation };
