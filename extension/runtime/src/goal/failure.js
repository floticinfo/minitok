"use strict";

const crypto = require("crypto");

const FAILURE_CATEGORIES = Object.freeze(["model_output_invalid", "planning_error", "implementation_error", "verification_failure", "environment_failure", "permission_blocked", "timeout", "repeated_failure", "scope_violation", "unknown"]);
function textOf(result = {}) { return `${result.error || ""} ${result.output || ""} ${result.reason || ""}`.toLowerCase(); }
function classifyFailure(result = {}) {
  const text = textOf(result);
  if (result.category && FAILURE_CATEGORIES.includes(result.category)) return result.category;
  if (result.code === "ETIMEDOUT" || /timeout|timed out/.test(text)) return "timeout";
  if (/scope violation|outside workspace|path traversal|blocked path/.test(text)) return "scope_violation";
  if (/permission denied|eacces|approval required|not authorized/.test(text) || result.status === "permission_blocked") return "permission_blocked";
  if (result.stage === "plan" || /planner|planning|plan failed/.test(text)) return text.includes("json") || result.invalid === true ? "model_output_invalid" : "planning_error";
  if (result.stage === "implement" || /implement|write failed|apply failed/.test(text)) return "implementation_error";
  if (result.stage === "verify" || /verification|assertion|test failed|gate failed/.test(text)) return "verification_failure";
  if (/provider|network|enoent|environment|not found/.test(text)) return "environment_failure";
  if (result.repeated === true) return "repeated_failure";
  return "unknown";
}
function stableHash(value) { return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16); }
function failureSignature(failure) { return stableHash({ category: failure.category || classifyFailure(failure), task: failure.task, verifier_id: failure.verifier_id, error: String(failure.error || failure.reason || "").replace(/(token|secret|password|api[_-]?key)[=:]\s*[^\s]+/gi, "$1=[REDACTED]") }); }
function patchSignature(result = {}) {
  const changes = Array.isArray(result.changes) ? result.changes : result.changes?.changes || result.changes?.changed_files || [];
  return stableHash({ files: changes.map(item => typeof item === "string" ? { file: item } : { file: item.file, action: item.action, content: item.content }).sort((a, b) => String(a.file).localeCompare(String(b.file))) });
}
function detectStagnation({ taskHistory = [], currentProgress = 0, previousProgress = 0, limit = 2 }) {
  const recent = taskHistory.slice(-Math.max(1, limit));
  const tasks = recent.map(item => item.task).filter(Boolean);
  const failures = recent.map(item => `${item.failure_category || "unknown"}:${item.verifier_id || ""}`).filter(Boolean);
  const patches = recent.map(item => item.patch_signature).filter(Boolean);
  const evidence = recent.flatMap(item => item.evidence_ids || []).filter(Boolean);
  const same_task = tasks.length >= limit && new Set(tasks).size === 1;
  const same_verifier_failure = failures.length >= limit && new Set(failures).size === 1;
  const same_patch = patches.length >= limit && new Set(patches).size === 1;
  const no_new_evidence = evidence.length < limit || new Set(evidence).size < evidence.length;
  const no_progress = currentProgress <= previousProgress;
  return { same_task, same_verifier_failure, same_patch, no_new_evidence, no_progress, stagnant: same_task || same_verifier_failure || same_patch || no_new_evidence || no_progress };
}
module.exports = { FAILURE_CATEGORIES, classifyFailure, failureSignature, patchSignature, detectStagnation };
