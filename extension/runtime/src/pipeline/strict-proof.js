"use strict";

const crypto = require("node:crypto");

function digest(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function canonicalChanges(changes) {
  const list = Array.isArray(changes) ? changes : Array.isArray(changes?.changes) ? changes.changes : [];
  return list.map(change => ({
    file: String(change?.file || "").replaceAll("\\", "/"),
    action: String(change?.action || "modify"),
    content: typeof change?.content === "string" ? change.content : undefined,
    before_hash: typeof change?.before_hash === "string" ? change.before_hash : undefined,
    edits: Array.isArray(change?.edits) ? change.edits : undefined,
  })).sort((a, b) => a.file.localeCompare(b.file) || a.action.localeCompare(b.action));
}

function canonicalPatchDigest(changesOrDigest) {
  if (typeof changesOrDigest === "string" && /^[a-f0-9]{64}$/i.test(changesOrDigest)) return changesOrDigest.toLowerCase();
  return digest(canonicalChanges(changesOrDigest));
}

function canonicalReview(review = {}) {
  return {
    verdict: review.verdict || null,
    confidence: Number.isFinite(Number(review.confidence)) ? Number(review.confidence) : null,
    findings: (Array.isArray(review.findings) ? review.findings : []).map(finding => ({
      severity: finding?.severity || null,
      file: finding?.file || null,
      line: finding?.line ?? null,
      message: finding?.message || null,
    })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    security_findings: Array.isArray(review.security_findings) ? review.security_findings : [],
    risk_level: review.risk_level || null,
  };
}

function canonicalVerification(verification = {}) {
  return {
    passed: verification.passed === true,
    exit_code: verification.exit_code ?? null,
    command: verification.command || null,
    output_digest: verification.output_digest || (verification.output === undefined ? null : digest(String(verification.output))),
  };
}

function optimizationIdentity(input = {}) {
  // Identity is the workload identity, not the optimization policy: baseline
  // and candidate must be allowed to use different policies while proving they
  // solved the same task against the same repository state.
  return digest({
    task: input.task || "",
    repository_fingerprint: input.repository_fingerprint || "",
  });
}

function costOf(run) {
  return Number(run?.cost_usd ?? run?.total_cost ?? run?.metrics?.provider_cost_usd);
}

/**
 * Strict optimization proof. This is deliberately exact: an optimized result
 * is adoptable only when it is the same canonical patch and review/verification
 * contract as the baseline, and costs strictly less.
 */
function compareOptimizationProof(baseline, candidate) {
  const reasons = [];
  const sameIdentity = typeof baseline?.identity === "string" && typeof candidate?.identity === "string" && baseline.identity === candidate.identity;
  const baselinePatch = canonicalPatchDigest(baseline?.patch_digest || baseline?.changes);
  const candidatePatch = canonicalPatchDigest(candidate?.patch_digest || candidate?.changes);
  const baselineReview = digest(canonicalReview(baseline?.review));
  const candidateReview = digest(canonicalReview(candidate?.review));
  const baselineVerification = canonicalVerification(baseline?.verification);
  const candidateVerification = canonicalVerification(candidate?.verification);
  const sameVerification = digest(baselineVerification) === digest(candidateVerification);
  const sameReview = baselineReview === candidateReview;
  const samePatch = baselinePatch === candidatePatch;
  const costBaseline = costOf(baseline);
  const costCandidate = costOf(candidate);
  const strictCostReduction = Number.isFinite(costBaseline) && Number.isFinite(costCandidate) && costCandidate < costBaseline;
  if (!sameIdentity) reasons.push("baseline_and_candidate_identity_differ");
  if (baseline?.complete_run !== true || candidate?.complete_run !== true) reasons.push("both_runs_must_be_complete");
  if (baseline?.approval_eligible !== true || candidate?.approval_eligible !== true) reasons.push("both_runs_must_be_approval_eligible");
  if (baselineVerification.passed !== true || candidateVerification.passed !== true) reasons.push("both_verifications_must_pass");
  if (!samePatch) reasons.push("canonical_patch_differs");
  if (!sameVerification) reasons.push("verification_contract_differs");
  if (!sameReview) reasons.push("review_contract_differs");
  if (!strictCostReduction) reasons.push("candidate_cost_is_not_strictly_lower");
  return {
    passed: reasons.length === 0,
    reasons,
    identity: candidate?.identity || baseline?.identity || null,
    baseline_patch_digest: baselinePatch,
    candidate_patch_digest: candidatePatch,
    baseline_review_digest: baselineReview,
    candidate_review_digest: candidateReview,
    baseline_verification: baselineVerification,
    candidate_verification: candidateVerification,
    baseline_cost_usd: costBaseline,
    candidate_cost_usd: costCandidate,
    strict_cost_reduction: strictCostReduction,
  };
}

module.exports = { digest, optimizationIdentity, canonicalChanges, canonicalPatchDigest, canonicalReview, canonicalVerification, compareOptimizationProof };
