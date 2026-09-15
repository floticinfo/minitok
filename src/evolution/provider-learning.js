"use strict";

const DEFAULTS = {
  min_samples: 3,
  min_approval_rate: 0.8,
  min_complete_rate: 0.9,
};

function isCompleteRun(outcome) {
  return outcome?.complete_run !== false && outcome?.quality_outcome !== "timeout" && outcome?.quality_outcome !== "incomplete";
}

function isApprovalEligible(outcome) {
  return isCompleteRun(outcome) && outcome?.approval_eligible !== false;
}

function providerOutcomes(outcome) {
  if (Array.isArray(outcome?.provider_outcomes)) return outcome.provider_outcomes;
  if (!outcome?.provider) return [];
  return [{
    role: outcome.role || "work",
    provider: outcome.provider,
    model: outcome.model || "",
    cost_usd: Number(outcome.total_cost) || 0,
    complete_run: isCompleteRun(outcome),
    approved: outcome.status === "success",
    approval_eligible: isApprovalEligible(outcome),
  }];
}

/** Aggregate complete-run evidence without treating timeouts as approvals. */
function summarizeProviderLearning(outcomes, options = {}) {
  const groups = new Map();
  for (const run of Array.isArray(outcomes) ? outcomes : []) {
    const perRun = new Map();
    for (const sample of providerOutcomes(run)) {
      if (!sample.provider) continue;
      const role = sample.role || "work";
      if (options.role && role !== options.role) continue;
      const key = `${role}:${sample.provider}:${sample.model || ""}`;
      if (!perRun.has(key)) perRun.set(key, { role, provider: sample.provider, model: sample.model || "", cost_usd: 0, complete: true, strict_proof: true });
      const aggregate = perRun.get(key);
      aggregate.cost_usd += Number(sample.cost_usd) || 0;
      aggregate.complete = aggregate.complete && isCompleteRun(sample);
      aggregate.strict_proof = aggregate.strict_proof && sample.strict_proof === true;
    }
    for (const aggregate of perRun.values()) {
      const key = `${aggregate.role}:${aggregate.provider}:${aggregate.model}`;
      if (!groups.has(key)) groups.set(key, { role: aggregate.role, provider: aggregate.provider, model: aggregate.model, runs: 0, complete_runs: 0, approvals: 0, total_cost_usd: 0, strict_proof: true });
      const stats = groups.get(key);
      stats.runs += 1;
      const complete = aggregate.complete && isCompleteRun(run);
      if (complete) {
        stats.strict_proof = stats.strict_proof && run.strict_proof === true && aggregate.strict_proof === true;
        stats.complete_runs += 1;
        if (run.status === "success" || run.approved === true) stats.approvals += 1;
        stats.total_cost_usd += aggregate.cost_usd;
      }
    }
  }
  return [...groups.values()].map(stats => ({
    ...stats,
    approval_rate: stats.complete_runs ? stats.approvals / stats.complete_runs : 0,
    complete_rate: stats.runs ? stats.complete_runs / stats.runs : 0,
    cost_per_approved_run: stats.approvals ? stats.total_cost_usd / stats.approvals : null,
  })).sort((a, b) => (a.cost_per_approved_run ?? Infinity) - (b.cost_per_approved_run ?? Infinity));
}

/**
 * Choose a learned candidate only when it has enough complete evidence and
 * clears the quality floor. Sparse or bad evidence never changes the policy.
 */
function selectProviderByLearnedCost(currentProvider, candidates, outcomes, options = {}) {
  const policy = { ...DEFAULTS, ...options };
  const allowed = new Set(Array.isArray(candidates) ? candidates : []);
  const stats = summarizeProviderLearning(outcomes, { role: options.role });
  const eligible = stats.filter(item => (item.strict_proof === true || options.allow_unproven === true) && allowed.has(item.provider)
    && item.complete_runs >= Number(policy.min_samples)
    && item.approval_rate >= Number(policy.min_approval_rate)
    && item.complete_rate >= Number(policy.min_complete_rate)
    && item.cost_per_approved_run !== null);
  if (!eligible.length) return { provider: currentProvider, selected: false, reason: "insufficient_quality_samples", stats };
  const current = eligible.find(item => item.provider === currentProvider);
  const best = eligible[0];
  if (current && best.cost_per_approved_run >= current.cost_per_approved_run) return { provider: currentProvider, selected: false, reason: "current_provider_is_non_inferior", stats };
  return { provider: best.provider, selected: best.provider !== currentProvider, reason: best.provider === currentProvider ? "current_provider_is_best" : "lower_cost_per_approved_run", stats };
}

module.exports = { DEFAULTS, isCompleteRun, isApprovalEligible, summarizeProviderLearning, selectProviderByLearnedCost };
