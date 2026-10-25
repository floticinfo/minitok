"use strict";

const crypto = require("crypto");

const SENSITIVE_KEY = /(token|secret|password|credential|api[_-]?key|authorization|private[_-]?key|access[_-]?key|license|prompt)/i;
const SENSITIVE_TEXT = /(api[_-]?key|token|secret|password|private[_-]?key|access[_-]?key|license)[=:]\s*[^\s,;]+/gi;
const SECRET_TOKEN = /(?:sk-ant-[A-Za-z0-9_-]{192,}|sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9_-]{36,}|github_pat_[A-Za-z0-9_]+|AIza[A-Za-z0-9_-]{35,}|AKIA[0-9A-Z]{16,}|xox[baprs]-[A-Za-z0-9-]+|ya29\.[A-Za-z0-9._-]+)/g;

function redactText(value) {
  if (typeof value !== "string") return value == null ? "" : String(value);
  return value.replace(SECRET_TOKEN, "[REDACTED]").replace(SENSITIVE_TEXT, "$1=[REDACTED]").replace(/Bearer\s+[^\s]+/gi, "Bearer [REDACTED]");
}

function redactValue(value, key = "") {
  if (SENSITIVE_KEY.test(key)) return "[REDACTED]";
  if (Array.isArray(value)) return value.map(item => redactValue(item));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, redactValue(item, name)]));
  return typeof value === "string" ? redactText(value) : value;
}

function redactKey(key) {
  if (typeof key !== "string" || key.length < 8) return "[REDACTED]";
  return key.slice(0, 4) + "..." + key.slice(-4);
}

function redactSecrets(text, ...secrets) {
  let result = typeof text === "string" ? text : String(text || "");
  for (const secret of secrets) {
    if (typeof secret === "string" && secret.length >= 8) {
      result = result.split(secret).join(redactKey(secret));
    }
  }
  return redactText(result);
}

function evidenceId(input) {
  const stable = JSON.stringify({ criterion_id: input.criterion_id, verifier_type: input.verifier_type, status: input.status, result: input.result, stdout: input.stdout, stderr: input.stderr });
  return `evidence_${crypto.createHash("sha256").update(stable).digest("hex").slice(0, 16)}`;
}

function createCriterionEvidence(input) {
  const evidence = {
    schema_version: 1,
    evidence_id: input.evidence_id || evidenceId(input),
    criterion_id: input.criterion_id,
    verifier_type: input.verifier_type,
    status: input.status,
    valid: input.valid === true,
    executed: input.executed === true || input.execution?.executed === true,
    execution: {
      executed: input.executed === true || input.execution?.executed === true,
      started_at: input.execution?.started_at || null,
      duration_ms: Number.isFinite(input.execution?.duration_ms) ? input.execution.duration_ms : 0,
      exit_code: Number.isInteger(input.execution?.exit_code) ? input.execution.exit_code : null,
      timed_out: input.execution?.timed_out === true,
      error: input.execution?.error || null,
    },
    stdout: redactText(input.stdout || ""),
    stderr: redactText(input.stderr || ""),
    result: redactValue(input.result || {}),
  };
  return redactValue(evidence);
}

module.exports = { redactText, redactValue, redactKey, redactSecrets, evidenceId, createCriterionEvidence };
