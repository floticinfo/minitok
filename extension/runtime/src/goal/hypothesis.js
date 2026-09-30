"use strict";

const crypto = require("crypto");

const HYPOTHESIS_SCHEMA_VERSION = 1;
const HYPOTHESIS_SOURCES = Object.freeze(["explicit", "inferred", "observed", "model"]);
const HYPOTHESIS_STATUSES = Object.freeze(["proposed", "accepted", "rejected", "invalidated"]);
const ASSUMPTION_RISK_LEVELS = Object.freeze(["low", "medium", "high", "critical"]);
const CONFIRMATION_POLICIES = Object.freeze(["auto_accept_low_risk", "require_user_confirmation", "require_external_approval", "never_auto_accept"]);
const LEDGER_SCHEMA_VERSION = 1;
const BAD_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const HYPOTHESIS_FIELDS = new Set(["schema_version", "hypothesis_id", "statement", "basis", "source", "confidence", "impact_if_wrong", "reversibility", "requires_confirmation", "related_criteria", "status", "evidence_ids"]);
const ASSUMPTION_FIELDS = new Set(["schema_version", "assumption_id", "statement", "source", "confidence", "risk_level", "affects_steps", "invalidation_signals", "confirmation_policy", "status", "hypothesis_id", "evidence_ids"]);
const LEDGER_FIELDS = new Set(["schema_version", "ledger_id", "assumptions", "hypotheses", "history", "version"]);
const HISTORY_FIELDS = new Set(["event_id", "event_type", "record_id", "from_status", "to_status", "reason", "evidence_ids", "timestamp", "replan"]);

function plain(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
function nonEmpty(value) { return typeof value === "string" && value.trim() !== ""; }
function clean(value) {
  if (!nonEmpty(value)) return "";
  return String(value)
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gi, "[REDACTED_PRIVATE_KEY]")
    .replace(/\b(?:api[_ -]?key|access[_ -]?token|password|secret|credential)\s*(?:is|=|:)\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .replace(/\bBearer\s+[^\s]+/gi, "Bearer [REDACTED]")
    .replace(/\s+/g, " ").trim();
}
function redact(value, key = "") {
  if (BAD_KEYS.has(key) || /token|secret|password|credential|api[_-]?key|authorization|private[_ -]?key/i.test(key)) return "[REDACTED]";
  if (Array.isArray(value)) return value.map(item => redact(item));
  if (plain(value)) return Object.fromEntries(Object.entries(value).map(([name, child]) => [name, redact(child, name)]));
  return typeof value === "string" ? clean(value) : value;
}
function stableId(prefix, value) { return `${prefix}_${crypto.createHash("sha256").update(JSON.stringify(redact(value))).digest("hex").slice(0, 16)}`; }
function issue(path, code, message) { return { path, code, message }; }
function confidence(value, path, errors) { if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) errors.push(issue(path, "INVALID_CONFIDENCE", "confidence must be between 0 and 1")); }
function strings(value, path, errors) { if (!Array.isArray(value) || value.some(item => !nonEmpty(item))) errors.push(issue(path, "INVALID_STRING_LIST", "Expected a list of non-empty strings")); }
function unknownFields(value, fields, path, errors) { if (!plain(value)) return; for (const key of Object.keys(value)) if (!fields.has(key)) errors.push(issue(`${path}.${key}`, BAD_KEYS.has(key) ? "DANGEROUS_FIELD" : "UNKNOWN_FIELD", "Unknown or dangerous field")); }
function hasBadKey(value) { if (Array.isArray(value)) return value.some(hasBadKey); if (!value || typeof value !== "object") return false; if (!plain(value)) return true; return Object.entries(value).some(([key, child]) => BAD_KEYS.has(key) || hasBadKey(child)); }

function createHypothesis(input = {}) {
  if (!plain(input)) throw new TypeError("Hypothesis must be a plain object");
  return redact({ schema_version: HYPOTHESIS_SCHEMA_VERSION, hypothesis_id: input.hypothesis_id || stableId("hypothesis", input), statement: input.statement, basis: input.basis || "", source: input.source || "inferred", confidence: input.confidence ?? 0, impact_if_wrong: input.impact_if_wrong || "unknown", reversibility: input.reversibility || "unknown", requires_confirmation: input.requires_confirmation === true, related_criteria: Array.isArray(input.related_criteria) ? input.related_criteria : [], status: input.status || "proposed", evidence_ids: Array.isArray(input.evidence_ids) ? input.evidence_ids : [] });
}
function validateHypothesis(value) {
  const errors = [];
  if (!plain(value)) return { valid: false, errors: [issue("$", "INVALID_OBJECT", "Hypothesis must be a plain object")] };
  unknownFields(value, HYPOTHESIS_FIELDS, "$", errors); if (hasBadKey(value)) errors.push(issue("$", "DANGEROUS_FIELD", "Dangerous nested key is not allowed"));
  if (value.schema_version !== HYPOTHESIS_SCHEMA_VERSION) errors.push(issue("schema_version", "INVALID_VERSION", "Unsupported hypothesis schema version")); if (!/^hypothesis_[A-Fa-f0-9]{16}$/.test(value.hypothesis_id || "")) errors.push(issue("hypothesis_id", "INVALID_ID", "Invalid hypothesis id"));
  if (!nonEmpty(value.statement)) errors.push(issue("statement", "INVALID_STRING", "statement is required")); if (!nonEmpty(value.basis)) errors.push(issue("basis", "INVALID_STRING", "basis is required")); if (!HYPOTHESIS_SOURCES.includes(value.source)) errors.push(issue("source", "INVALID_SOURCE", "Invalid hypothesis source")); confidence(value.confidence, "confidence", errors); if (!nonEmpty(value.impact_if_wrong)) errors.push(issue("impact_if_wrong", "INVALID_STRING", "impact_if_wrong is required")); if (!nonEmpty(value.reversibility)) errors.push(issue("reversibility", "INVALID_STRING", "reversibility is required")); if (typeof value.requires_confirmation !== "boolean") errors.push(issue("requires_confirmation", "INVALID_BOOLEAN", "requires_confirmation must be boolean")); strings(value.related_criteria, "related_criteria", errors); if (!HYPOTHESIS_STATUSES.includes(value.status)) errors.push(issue("status", "INVALID_STATUS", "Invalid hypothesis status")); strings(value.evidence_ids, "evidence_ids", errors);
  return { valid: errors.length === 0, errors };
}
function assertValidHypothesis(value) { const result = validateHypothesis(value); if (!result.valid) throw new TypeError(`Invalid hypothesis: ${result.errors.map(item => item.path).join(",")}`); return value; }

function createAssumption(input = {}) {
  if (!plain(input)) throw new TypeError("Assumption must be a plain object");
  const risk = input.risk_level || "low"; const policy = input.confirmation_policy || (risk === "low" ? "auto_accept_low_risk" : "require_user_confirmation");
  return redact({ schema_version: LEDGER_SCHEMA_VERSION, assumption_id: input.assumption_id || stableId("assumption", input), statement: input.statement, source: input.source || "inferred", confidence: input.confidence ?? 0, risk_level: risk, affects_steps: Array.isArray(input.affects_steps) ? input.affects_steps : [], invalidation_signals: Array.isArray(input.invalidation_signals) ? input.invalidation_signals : [], confirmation_policy: policy, status: input.status || "proposed", hypothesis_id: input.hypothesis_id || null, evidence_ids: Array.isArray(input.evidence_ids) ? input.evidence_ids : [] });
}
function validateAssumption(value) {
  const errors = [];
  if (!plain(value)) return { valid: false, errors: [issue("$", "INVALID_OBJECT", "Assumption must be a plain object")] };
  unknownFields(value, ASSUMPTION_FIELDS, "$", errors); if (hasBadKey(value)) errors.push(issue("$", "DANGEROUS_FIELD", "Dangerous nested key is not allowed")); if (value.schema_version !== LEDGER_SCHEMA_VERSION) errors.push(issue("schema_version", "INVALID_VERSION", "Unsupported assumption schema version")); if (!/^assumption_[A-Fa-f0-9]{16}$/.test(value.assumption_id || "")) errors.push(issue("assumption_id", "INVALID_ID", "Invalid assumption id")); if (!nonEmpty(value.statement)) errors.push(issue("statement", "INVALID_STRING", "statement is required")); if (!HYPOTHESIS_SOURCES.includes(value.source)) errors.push(issue("source", "INVALID_SOURCE", "Invalid assumption source")); confidence(value.confidence, "confidence", errors); if (!ASSUMPTION_RISK_LEVELS.includes(value.risk_level)) errors.push(issue("risk_level", "INVALID_RISK", "Invalid risk level")); strings(value.affects_steps, "affects_steps", errors); strings(value.invalidation_signals, "invalidation_signals", errors); if (!CONFIRMATION_POLICIES.includes(value.confirmation_policy)) errors.push(issue("confirmation_policy", "INVALID_POLICY", "Invalid confirmation policy")); if (!["proposed", "accepted", "rejected", "invalidated"].includes(value.status)) errors.push(issue("status", "INVALID_STATUS", "Invalid assumption status")); if (value.hypothesis_id !== null && !/^hypothesis_[A-Fa-f0-9]{16}$/.test(value.hypothesis_id || "")) errors.push(issue("hypothesis_id", "INVALID_ID", "Invalid related hypothesis id")); strings(value.evidence_ids, "evidence_ids", errors);
  return { valid: errors.length === 0, errors };
}
function assertValidAssumption(value) { const result = validateAssumption(value); if (!result.valid) throw new TypeError(`Invalid assumption: ${result.errors.map(item => item.path).join(",")}`); return value; }
function decisionForAssumption(value, options = {}) { assertValidAssumption(value); if (value.risk_level === "low" && value.confirmation_policy === "auto_accept_low_risk" && options.mode === "unrestricted_general") return { status: "accepted", requires_confirmation: false, reason: "low-risk assumption is eligible for unrestricted_general auto-accept" }; return { status: "confirmation_required", requires_confirmation: true, reason: "assumption impact or policy requires confirmation" }; }

function createLedger(input = {}) { if (!plain(input)) throw new TypeError("Assumption ledger must be a plain object"); return redact({ schema_version: LEDGER_SCHEMA_VERSION, ledger_id: input.ledger_id || stableId("ledger", input), assumptions: Array.isArray(input.assumptions) ? input.assumptions : [], hypotheses: Array.isArray(input.hypotheses) ? input.hypotheses : [], history: Array.isArray(input.history) ? input.history : [], version: Number.isInteger(input.version) && input.version > 0 ? input.version : 1 }); }
function validateHistory(value, path, errors) { if (!Array.isArray(value)) { errors.push(issue(path, "INVALID_LIST", "history must be an array")); return; } for (const [index, item] of value.entries()) { const itemPath = `${path}[${index}]`; if (!plain(item)) { errors.push(issue(itemPath, "INVALID_OBJECT", "history entries must be objects")); continue; } unknownFields(item, HISTORY_FIELDS, itemPath, errors); if (!/^ledger-event_[A-Fa-f0-9]{16}$/.test(item.event_id || "")) errors.push(issue(`${itemPath}.event_id`, "INVALID_ID", "Invalid history event id")); if (!nonEmpty(item.event_type)) errors.push(issue(`${itemPath}.event_type`, "INVALID_STRING", "event_type is required")); } }
function validateLedger(value) { const errors = []; if (!plain(value)) return { valid: false, errors: [issue("$", "INVALID_OBJECT", "Ledger must be a plain object")] }; unknownFields(value, LEDGER_FIELDS, "$", errors); if (value.schema_version !== LEDGER_SCHEMA_VERSION) errors.push(issue("schema_version", "INVALID_VERSION", "Unsupported ledger schema version")); if (!/^ledger_[A-Fa-f0-9]{16}$/.test(value.ledger_id || "")) errors.push(issue("ledger_id", "INVALID_ID", "Invalid ledger id")); if (!Array.isArray(value.assumptions) || value.assumptions.some(item => !validateAssumption(item).valid)) errors.push(issue("assumptions", "INVALID_ASSUMPTION", "Ledger contains invalid assumption")); if (!Array.isArray(value.hypotheses) || value.hypotheses.some(item => !validateHypothesis(item).valid)) errors.push(issue("hypotheses", "INVALID_HYPOTHESIS", "Ledger contains invalid hypothesis")); validateHistory(value.history, "history", errors); if (!Number.isInteger(value.version) || value.version < 1) errors.push(issue("version", "INVALID_VERSION", "version must be a positive integer")); return { valid: errors.length === 0, errors }; }
function appendLedgerEvent(ledger, event = {}) { const value = createLedger(ledger); const record = redact({ event_id: event.event_id || stableId("ledger-event", { ledger_id: value.ledger_id, version: value.version, event }), event_type: event.event_type || "updated", record_id: event.record_id || null, from_status: event.from_status || null, to_status: event.to_status || null, reason: event.reason || "", evidence_ids: Array.isArray(event.evidence_ids) ? event.evidence_ids : [], timestamp: event.timestamp || new Date().toISOString(), replan: event.replan || null }); value.history = [...value.history, record]; value.version += 1; return value; }
function transitionAssumption(ledger, assumptionId, status, detail = {}) { const value = createLedger(ledger); const index = value.assumptions.findIndex(item => item.assumption_id === assumptionId); if (index < 0) throw new Error(`Assumption not found: ${assumptionId}`); const current = value.assumptions[index]; assertValidAssumption(current); if (status === "accepted" && decisionForAssumption(current, detail).requires_confirmation && detail.confirmed !== true) throw Object.assign(new Error("Assumption confirmation is required"), { code: "ASSUMPTION_CONFIRMATION_REQUIRED" }); value.assumptions[index] = redact({ ...current, status }); return appendLedgerEvent(value, { event_type: status === "invalidated" ? "assumption_invalidated" : "assumption_status_changed", record_id: assumptionId, from_status: current.status, to_status: status, reason: detail.reason || "", evidence_ids: detail.evidence_ids, replan: status === "invalidated" ? { required: true, affected_steps: current.affects_steps, reason: detail.reason || "assumption invalidated" } : null }); }
function replanMetadata(ledger, reason, affectedSteps = [], evidenceIds = []) { return { required: true, reason: redact(reason), affected_steps: [...new Set(affectedSteps)], evidence_ids: [...new Set(evidenceIds)] }; }
function serializeLedger(ledger) { const value = createLedger(ledger); const result = validateLedger(value); if (!result.valid) throw new TypeError(`Invalid assumption ledger: ${result.errors.map(item => item.path).join(",")}`); return JSON.stringify(value); }
function deserializeLedger(serialized) { if (typeof serialized !== "string" || !serialized.trim()) throw new TypeError("Serialized assumption ledger must be non-empty"); const value = createLedger(JSON.parse(serialized)); const result = validateLedger(value); if (!result.valid) throw new TypeError(`Invalid assumption ledger: ${result.errors.map(item => item.path).join(",")}`); return value; }
function migrateLedger(value = {}) { const input = plain(value) ? value : {}; return createLedger({ ledger_id: input.ledger_id, assumptions: Array.isArray(input.assumptions) ? input.assumptions.map(item => createAssumption(item)) : [], hypotheses: Array.isArray(input.hypotheses) ? input.hypotheses.map(item => createHypothesis(item)) : [], history: Array.isArray(input.history) ? input.history : [], version: input.version }); }

module.exports = { HYPOTHESIS_SCHEMA_VERSION, HYPOTHESIS_SOURCES, HYPOTHESIS_STATUSES, ASSUMPTION_RISK_LEVELS, CONFIRMATION_POLICIES, LEDGER_SCHEMA_VERSION, createHypothesis, validateHypothesis, assertValidHypothesis, createAssumption, validateAssumption, assertValidAssumption, decisionForAssumption, createLedger, migrateLedger, validateLedger, appendLedgerEvent, transitionAssumption, replanMetadata, serializeLedger, deserializeLedger, redact };
