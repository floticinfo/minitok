"use strict";

const { redactText } = require("../goal/evidence");

function buildBlockerRepairTask(originalGoal, blockerReport, context = {}) {
  const alternatives = (blockerReport?.alternatives || []).map(item => `- ${item.alternative_id}: ${item.description} (risk=${item.risk_level}, approval_required=${item.approval_required}, reversible=${item.reversible})`).join("\n");
  const selected = blockerReport?.recommended_alternative || "none";
  const reason = redactText(String(blockerReport?.cause || "unknown blocker"));
  return `${originalGoal}\n\nBlocker diagnosis: ${blockerReport?.category || "unknown"} at ${blockerReport?.stage || "unknown"}.\nCause: ${reason}\nAffected step: ${blockerReport?.affected_step || "unknown"}\nAlternatives:\n${alternatives || "- none"}\nRecommended alternative: ${selected}\nRepair constraint: ${context.strategy || "Use only an applicable alternative inside the existing safety boundary; do not repeat the previous patch."}`;
}

function buildRepairTask(originalGoal, review, check, context = {}) {
  const findings = (review?.findings || []).map(f => `- [${f.severity || "error"}] ${f.message || "issue"}`).join("\n");
  const verification = check?.evidence ? `\nVerification command: ${check.evidence.command}\nVerification output:\n${check.evidence.output}` : "";
  const changedFiles = Array.isArray(context.changed_files) ? context.changed_files.join(", ") : "unknown";
  const previousPatch = context.previous_patch_signature || "unknown";
  const remaining = Array.isArray(context.remaining_success_criteria) ? context.remaining_success_criteria.join(", ") : "unknown";
  const strategy = context.strategy || "Use a different implementation strategy and do not repeat the previous patch.";
  return `${originalGoal}\n\nRepair the failed implementation. Address every review finding and verification failure before making changes.\n\nReview summary: ${review?.summary || "No review summary"}\nFindings:\n${findings || "- Verification failed; inspect the command output."}${verification}\n\nCurrent changed files: ${changedFiles}\nPrevious patch signature: ${previousPatch}\nRemaining success criteria: ${remaining}\nRecovery constraint: ${strategy}`;
}

module.exports = { buildRepairTask, buildBlockerRepairTask };
