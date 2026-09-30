"use strict";

const crypto = require("crypto");

const FAILURE_CATEGORIES = Object.freeze(["model_output_invalid", "planning_error", "implementation_error", "verification_failure", "environment_failure", "permission_blocked", "timeout", "repeated_failure", "scope_violation", "unknown"]);
const TERMINAL_STATUSES = Object.freeze([
  "planning_failed", "model_output_invalid", "implementation_invalid", "implementation_apply_failed",
  "verification_failed", "review_rejected", "recovery_scheduled", "recovery_failed", "merge_failed",
  "completed", "blocked", "escalated", "timeout", "token_limit", "stagnation", "repetition", "unknown",
]);
const TERMINAL_FAILURE_STAGES = Object.freeze(["plan", "implement", "apply", "verify", "review", "merge", "environment"]);

function textOf(result = {}) { return `${result.error || ""} ${result.output || ""} ${result.reason || ""}`.toLowerCase(); }

function terminalFailureCategory(status) {
  const categories = {
    planning_failed: "planning_error", model_output_invalid: "model_output_invalid",
    implementation_invalid: "implementation_error", implementation_apply_failed: "implementation_error",
    verification_failed: "verification_failure", review_rejected: "review_rejected",
    recovery_scheduled: "recovery_scheduled", recovery_failed: "recovery_failed",
    merge_failed: "merge_failed", blocked: "permission_blocked", escalated: "unknown",
    timeout: "timeout", token_limit: "timeout", stagnation: "repeated_failure", repetition: "repeated_failure", unknown: "unknown",
  };
  return categories[status] || null;
}

function terminalFailureStage(status) {
  const stages = {
    planning_failed: "plan", model_output_invalid: "implement", implementation_invalid: "implement",
    implementation_apply_failed: "apply", verification_failed: "verify", review_rejected: "review",
    recovery_scheduled: "environment", recovery_failed: "environment", merge_failed: "merge",
    completed: null, blocked: "environment", escalated: "environment", timeout: "environment",
    token_limit: "environment", stagnation: "environment", repetition: "environment", unknown: "environment",
  };
  return stages[status] ?? "environment";
}
function terminalStatusFor(result = {}, options = {}) {
  const evidence = result.evidence || result.cycle_evidence || result.last_cycle_evidence || {};
  const cycleEvidence = Array.isArray(result.cycles)
    ? result.cycles.at(-1)?.evidence || result.cycles.at(-1) || {}
    : Object.keys(evidence).length > 0 ? evidence : result;
  const state = result.state || options.state;
  const explicit = result.terminal_status || options.terminal_status;
  if (explicit && TERMINAL_STATUSES.includes(explicit)) return explicit;
  if (state === "completed" && options.valid_evidence === true || result.completed === true && options.valid_evidence === true) return "completed";
  if (state === "timeout" || result.code === "ETIMEDOUT" || result.timed_out === true) return "timeout";
  if (state === "token_limit" || result.token_limit === true) return "token_limit";
  if (state === "max_cycles") return Number(result.stagnantCycles || options.stagnantCycles) > 0 ? "stagnation" : "repetition";
  if (state === "stagnation") return "stagnation";
  if (state === "repetition" || state === "repeated_failure") return "repetition";
  if (["escalate", "escalated"].includes(state) || result.humanEscalation === true) return "escalated";
  if (state === "blocked" || result.blocked === true) return "blocked";
  if (state === "recover" || result.recovery_scheduled === true) return "recovery_scheduled";
  if (state === "recovery_failed" || result.recovery_failed === true) return "recovery_failed";
  if (cycleEvidence.status && TERMINAL_STATUSES.includes(cycleEvidence.status)) {
    if (cycleEvidence.status === "completed" && options.valid_evidence !== true) return "unknown";
    return cycleEvidence.status;
  }
  if (cycleEvidence.plan?.valid === false) return cycleEvidence.plan?.error ? "model_output_invalid" : "planning_failed";
  const implementation = cycleEvidence.implementation || result.implementation || result.changes || {};
  const changeCount = Number(implementation.change_count ?? result.change_count ?? (Array.isArray(implementation.changed_files) ? implementation.changed_files.length : 0));
  const appliedCount = Number(implementation.applied_count ?? result.applied_count ?? 0);
  if (implementation.response_valid === false || result.invalid === true) return "model_output_invalid";
  if (implementation.changes_valid === false || result.changes_valid === false || implementation.changes_missing === true) return "implementation_invalid";
  if (changeCount > 0 && appliedCount === 0 && (implementation.applied_count !== undefined || result.applied_count !== undefined)) return "implementation_apply_failed";
  const verification = cycleEvidence.verification || result.verification || {};
  if (verification.status === "unknown" || verification.status === "missing" || result.verifier_unknown === true) return "unknown";
  if (appliedCount > 0 && (verification.status === "failed" || verification.status === "timeout" || Number.isInteger(verification.exit_code) && verification.exit_code !== 0)) return "verification_failed";
  const review = cycleEvidence.review || result.review || {};
  if ((verification.status === "passed" || verification.passed === true) && ["REJECT", "CHANGES_REQUESTED"].includes(review.verdict)) return "review_rejected";
  if (result.merge_failed === true || result.isolation?.merge?.applied === false || cycleEvidence.workspace?.merge_attempted === true && cycleEvidence.workspace?.merge_applied === false) return "merge_failed";
  if (result.recovery_failed === true) return "recovery_failed";
  if (result.success === true && options.valid_evidence === true) return "completed";
  return "unknown";
}

function createTerminalResult(result = {}, options = {}) {
  const terminal_status = terminalStatusFor(result, options);
  const failure_category = result.failure_category || terminalFailureCategory(terminal_status) || null;
  const failure_stage = result.failure_stage !== undefined
    ? result.failure_stage
    : terminal_status === "completed"
      ? null
      : terminal_status === "model_output_invalid" && (result.plan || result.stage === "plan")
        ? "plan"
        : terminalFailureStage(terminal_status);
  const recoverable = result.recoverable !== undefined
    ? result.recoverable === true
    : ["model_output_invalid", "planning_failed", "implementation_invalid", "implementation_apply_failed", "verification_failed", "review_rejected", "recovery_scheduled", "timeout", "stagnation", "repetition"].includes(terminal_status);
  const human_escalation_required = result.human_escalation_required !== undefined
    ? result.human_escalation_required === true
    : ["blocked", "escalated", "token_limit", "merge_failed", "unknown"].includes(terminal_status);
  const lastCycle = Array.isArray(result.cycles) ? result.cycles.at(-1) : null;
  const last_cycle_evidence_id = result.last_cycle_evidence_id || lastCycle?.evidence?.evidence_id || lastCycle?.evidence_id || null;
  return { terminal_status, failure_category, failure_stage, recoverable, human_escalation_required, last_cycle_evidence_id };
}

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
module.exports = {
  FAILURE_CATEGORIES,
  TERMINAL_STATUSES,
  TERMINAL_FAILURE_STAGES,
  classifyFailure,
  terminalStatusFor,
  createTerminalResult,
  terminalFailureCategory,
  terminalFailureStage,
  failureSignature,
  patchSignature,
  detectStagnation,
};
