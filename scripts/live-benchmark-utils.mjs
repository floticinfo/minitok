import crypto from "node:crypto";

export const LIVE_PROFILES = ["small_single_file", "multi_file", "new_file", "broad_rewrite"];
export const LIVE_MODES = ["baseline", "adaptive"];

function number(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

/** Normalize common OpenAI-compatible, Anthropic, Google and gateway usage fields. */
export function normalizeUsage(usage = {}, tokens = {}) {
  const input = number(tokens.input) || number(usage.input_tokens) || number(usage.prompt_tokens) || number(usage.promptTokenCount);
  const output = number(tokens.output) || number(usage.output_tokens) || number(usage.completion_tokens) || number(usage.candidatesTokenCount);
  const cachedInput = number(usage.cache_read_input_tokens) || number(usage.cached_input_tokens) || number(usage.prompt_tokens_details?.cached_tokens) || number(usage.cachedContentTokenCount);
  const cacheWrite = number(usage.cache_creation_input_tokens) || number(usage.cache_write_input_tokens) || number(usage.cache_creation?.ephemeral_5m_input_tokens);
  return { input, output, total: input + output, cached_input: cachedInput, cache_write: cacheWrite };
}

export function estimateCost(usage, prices = {}) {
  const inputPrice = number(prices.input_per_mtok);
  const outputPrice = number(prices.output_per_mtok);
  const cacheReadPrice = number(prices.cache_read_per_mtok);
  const cacheWritePrice = number(prices.cache_write_per_mtok);
  const input = Math.max(0, usage.input - usage.cached_input - usage.cache_write);
  const cost = input / 1e6 * inputPrice + usage.output / 1e6 * outputPrice + usage.cached_input / 1e6 * cacheReadPrice + usage.cache_write / 1e6 * cacheWritePrice;
  return { input, output: usage.output, cached_input: usage.cached_input, cache_write: usage.cache_write, total: cost };
}

export function taskDigest(profile, task) {
  return crypto.createHash("sha256").update(`${profile}\0${task}`).digest("hex").slice(0, 16);
}

export function summarizeRuns(runs) {
  const median = values => { const sorted = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b); if (!sorted.length) return null; const i = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[i] : (sorted[i - 1] + sorted[i]) / 2; };
  const groups = [...new Set(runs.map(run => `${run.profile}:${run.mode}`))];
  return Object.fromEntries(groups.map(key => {
    const [profile, mode] = key.split(":");
    const rows = runs.filter(run => run.profile === profile && run.mode === mode);
    const approved = rows.filter(run => run.quality_outcome === "approved").length;
    const totalCost = rows.reduce((sum, run) => sum + number(run.cost?.total), 0);
    return [key, { profile, mode, runs: rows.length, success_rate: rows.length ? rows.filter(run => run.success).length / rows.length : 0, approval_rate: rows.length ? approved / rows.length : 0, approved_runs: approved, median_input_tokens: median(rows.map(run => run.usage?.input)), median_output_tokens: median(rows.map(run => run.usage?.output)), median_total_tokens: median(rows.map(run => run.usage?.total)), median_cached_input_tokens: median(rows.map(run => run.usage?.cached_input)), median_cost_usd: median(rows.map(run => run.cost?.total)), cost_per_approved_run_usd: approved ? totalCost / approved : null, repair_rate: rows.length ? rows.filter(run => number(run.repair_cycles) > 0).length / rows.length : 0, fallback_rate: rows.length ? rows.filter(run => String(run.edit_strategy || "").includes("fallback")).length / rows.length : 0 }];
  }));
}

export function compareProfile(runs, profile) {
  const baseline = runs.filter(run => run.profile === profile && run.mode === "baseline");
  const adaptive = runs.filter(run => run.profile === profile && run.mode === "adaptive");
  const median = rows => field => { const values = rows.map(row => Number(field(row))).filter(Number.isFinite).sort((a, b) => a - b); if (!values.length) return null; const i = Math.floor(values.length / 2); return values.length % 2 ? values[i] : (values[i - 1] + values[i]) / 2; };
  const b = median(baseline)(row => row.usage?.total);
  const a = median(adaptive)(row => row.usage?.total);
  const bc = median(baseline)(row => row.cost?.total);
  const ac = median(adaptive)(row => row.cost?.total);
  return { profile, baseline_runs: baseline.length, adaptive_runs: adaptive.length, total_token_reduction_pct: b && a ? (1 - a / b) * 100 : null, cost_reduction_pct: bc && ac ? (1 - ac / bc) * 100 : null, approval_rate_delta: (adaptive.length ? adaptive.filter(row => row.quality_outcome === "approved").length / adaptive.length : 0) - (baseline.length ? baseline.filter(row => row.quality_outcome === "approved").length / baseline.length : 0) };
}
