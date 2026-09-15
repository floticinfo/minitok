"use strict";

function decodeIntel(value) {
  if (!value || typeof value !== "object") return value;
  if (!Object.prototype.hasOwnProperty.call(value, "s") && !Object.prototype.hasOwnProperty.call(value, "f")) return value;
  return {
    summary: value.s || "",
    relevant_files: Array.isArray(value.f) ? value.f : [],
    existing_patterns: Array.isArray(value.p) ? value.p : [],
    risks: Array.isArray(value.r) ? value.r : [],
    constraints: Array.isArray(value.c) ? value.c : [],
    recommendations: Array.isArray(value.n) ? value.n : [],
  };
}

function decodePlan(value) {
  if (!value || typeof value !== "object" || !Array.isArray(value.s)) return value;
  return {
    task_summary: value.t || "",
    steps: value.s.map((step, index) => ({
      id: step?.i ?? index + 1,
      action: step?.a || "modify",
      file: step?.f || "",
      description: step?.d || "",
      rationale: step?.r || "",
    })),
    estimated_files: value.n ?? value.s.length,
    risk_level: value.risk || value.r || "medium",
    notes: value.x || "",
  };
}

function decodeReview(value) {
  if (!value || typeof value !== "object" || !Object.prototype.hasOwnProperty.call(value, "v")) return value;
  const verdict = { A: "APPROVE", C: "CHANGES_REQUESTED", R: "REJECT" }[value.v] || value.v;
  return {
    verdict,
    confidence: value.c,
    summary: value.s || "",
    findings: Array.isArray(value.f) ? value.f : [],
    security_findings: Array.isArray(value.sec) ? value.sec : [],
    risk_level: value.r || "low",
    test_suggestions: Array.isArray(value.t) ? value.t : [],
  };
}

module.exports = { decodeIntel, decodePlan, decodeReview };
