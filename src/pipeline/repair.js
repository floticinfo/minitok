"use strict";

function buildRepairTask(originalGoal, review, check) {
  const findings = (review?.findings || []).map(f => `- [${f.severity || "error"}] ${f.message || "issue"}`).join("\n");
  const verification = check?.evidence ? `\nVerification command: ${check.evidence.command}\nVerification output:\n${check.evidence.output}` : "";
  return `${originalGoal}\n\nRepair the failed implementation. Address every review finding and verification failure before making changes.\n\nReview summary: ${review?.summary || "No review summary"}\nFindings:\n${findings || "- Verification failed; inspect the command output."}${verification}`;
}

function buildImplementationRepairTask(originalGoal, errors) {
  const details = (Array.isArray(errors) ? errors : [errors]).filter(Boolean).map(error => `- ${error}`).join("\n");
  return `${originalGoal}\n\nThe previous implementation was rejected before verification. Produce a corrected implementation only.\n\nRejected changes:\n${details || "- The model output was invalid or unsafe."}\n\nDo not modify validation scripts, test harnesses, minitok.yml, .minitok, credentials, CI/workflow files, or other protected paths. Return complete file contents in the required JSON format. Do not return an empty changes array unless the goal is already satisfied.`;
}

module.exports = { buildRepairTask, buildImplementationRepairTask };
