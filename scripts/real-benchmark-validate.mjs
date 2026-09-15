import fs from "node:fs";
import path from "node:path";

function fail(message) { console.error(`Benchmark input rejected: ${message}`); process.exit(1); }
const files = process.argv.slice(2);
if (files.length < 2) fail("provide baseline and minitok raw-run JSON files");
const records = files.map(file => JSON.parse(fs.readFileSync(path.resolve(file), "utf8")));
const numeric = ["duration_ms", "total_tokens", "total_cost_usd", "manual_interventions"];
const metricFields = ["provider_usage", "provider_cost_usd", "verification", "review_verdict", "repair_cycles", "changed_files", "compaction"];
function requireFields(value, fields, label) {
  for (const field of fields) if (!(field in value)) fail(`${label} is missing ${field}`);
}
for (const [index, record] of records.entries()) {
  if (record.synthetic === true || record.example === true) fail(`${files[index]} is marked synthetic/example`);
  const isAggregate = Array.isArray(record.runs);
  if (isAggregate) {
    if (record.runs.length < 3) fail(`${files[index]} requires at least 3 repeated runs`);
    for (const [runIndex, run] of record.runs.entries()) {
      if (!run || typeof run !== "object") fail(`${files[index]} run ${runIndex + 1} is invalid`);
      requireFields(run, ["model", "provider", "repository_commit", "task", "verification_exit_code", ...numeric, ...metricFields], `${files[index]} run ${runIndex + 1}`);
      if (run.verification_exit_code !== 0) fail(`${files[index]} run ${runIndex + 1} did not pass verification`);
    }
  } else {
    requireFields(record, ["model", "provider", "repository_commit", "task", "verification_exit_code", ...numeric, ...metricFields], files[index]);
    if (record.verification_exit_code !== 0) fail(`${files[index]} did not pass verification`);
  }
  for (const field of numeric) {
    const value = isAggregate ? record.runs.reduce((sum, run) => sum + Number(run[field] || 0), 0) : Number(record[field]);
    if (!Number.isFinite(value) || value < 0) fail(`${files[index]} has invalid ${field}`);
  }
}
const report = { status: "valid_input", records: files, baseline: records[0], minitok: records[1], generated_at: new Date().toISOString(), synthetic: false, metrics_contract: ["provider_usage", "provider_cost_usd", "latency_ms", "verification", "review_verdict", "repair_cycles", "changed_files", "compaction"] };
console.log(JSON.stringify(report, null, 2));
