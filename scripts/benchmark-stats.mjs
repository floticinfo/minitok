export function median(values) {
  const numbers = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!numbers.length) return null;
  const middle = Math.floor(numbers.length / 2);
  return numbers.length % 2 ? numbers[middle] : (numbers[middle - 1] + numbers[middle]) / 2;
}

export function summarizeQualityRuns(values) {
  const runs = Array.isArray(values) ? values : [];
  const approved = runs.filter(run => run.quality_outcome === "approved").length;
  const complete = runs.filter(run => run.complete_run).length;
  const eligible = runs.filter(run => run.approval_eligible).length;
  const outcomes = Object.fromEntries([...new Set(runs.map(run => run.quality_outcome))].map(outcome => [outcome, runs.filter(run => run.quality_outcome === outcome).length]));
  const rates = Object.fromEntries(Object.entries(outcomes).map(([outcome, count]) => [outcome, runs.length ? count / runs.length : 0]));
  const selected = runs.filter(run => Number(run.retrieval_metrics?.selected_stages || 0) > 0).length;
  return {
    runs: runs.length,
    complete_runs: complete,
    complete_run_rate: runs.length ? complete / runs.length : 0,
    approval_rate: eligible ? approved / eligible : 0,
    approval_eligible_runs: eligible,
    quality_outcomes: outcomes,
    quality_outcome_rates: rates,
    retrieval_selected_run_rate: runs.length ? selected / runs.length : 0,
    median_total_tokens: median(runs.map(run => run.total_tokens)),
    median_input_tokens: median(runs.map(run => run.provider_usage?.input)),
    median_output_tokens: median(runs.map(run => run.provider_usage?.output)),
    median_prompt_chars: median(runs.map(run => run.prompt_chars)),
    median_cost_usd: median(runs.map(run => run.provider_cost_usd)),
  };
}
