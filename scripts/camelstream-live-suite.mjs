import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { summarizeQualityRuns } from "./benchmark-stats.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(ROOT, "scripts", "camelstream-live-benchmark.mjs");
const reps = (process.env.MINITOK_LIVE_REPS || "text,workflow_ir,edit_ir,adaptive").split(",").map(x => x.trim()).filter(Boolean);
const runs = Math.max(1, Number(process.env.MINITOK_LIVE_RUNS) || 3);
const maxCycles = Math.max(1, Number(process.env.MINITOK_LIVE_MAX_CYCLES) || 1);
const timeoutMs = Math.max(30_000, Number(process.env.MINITOK_LIVE_TIMEOUT_MS) || 120_000);
const results = [];
const output = process.env.MINITOK_LIVE_SUITE_OUTPUT || "";
const checkpointOutput = process.env.MINITOK_LIVE_SUITE_CHECKPOINT || output;

let activeRepresentation = null;
let activeCheckpoint = null;
function writeSuiteCheckpoint() {
  if (!checkpointOutput) return;
  const target = path.resolve(checkpointOutput);
  const temporary = `${target}.tmp.${process.pid}`;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(temporary, `${JSON.stringify({ status: "camelstream_live_suite_checkpoint", synthetic: false, representations: reps, runs_per_representation: runs, max_cycles: maxCycles, timeout_ms: timeoutMs, active_representation: activeRepresentation, active_checkpoint: activeCheckpoint, results }, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, target);
}

writeSuiteCheckpoint();
for (const representation of reps) {
  const checkpointFile = path.join(ROOT, `.camelstream-${representation}-checkpoint.json`);
  activeRepresentation = representation;
  activeCheckpoint = checkpointFile;
  writeSuiteCheckpoint();
  const env = { ...process.env, MINITOK_LIVE_REP: representation, MINITOK_LIVE_RUNS: String(runs), MINITOK_LIVE_MAX_CYCLES: String(maxCycles), MINITOK_LIVE_TIMEOUT_MS: String(timeoutMs), MINITOK_LIVE_CHECKPOINT: checkpointFile };
  const started = Date.now();
  const child = spawnSync(process.execPath, [script], { cwd: ROOT, env, encoding: "utf8", timeout: timeoutMs * runs + 15_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
  if (child.error || child.status !== 0) {
    const processError = /** @type {any} */ (child.error);
    let checkpoint = null;
    try { checkpoint = JSON.parse(fs.readFileSync(checkpointFile, "utf8")); } catch {}
    results.push({ representation, status: processError?.code === "ETIMEDOUT" ? "timeout" : "error", timed_out: processError?.code === "ETIMEDOUT", duration_ms: Date.now() - started, error: String(processError?.message || child.stderr || `exit ${child.status}`).slice(0, 500), runs: checkpoint?.runs || [], partial: checkpoint?.active_run || null });
    writeSuiteCheckpoint();
    continue;
  }
  try {
    const report = JSON.parse(child.stdout);
    results.push({ representation, status: report.status, timed_out: false, duration_ms: Date.now() - started, summary: report.summaries?.[representation] || null, runs: report.runs || [], retrieval: report.retrieval || null });
  } catch (error) {
    results.push({ representation, status: "invalid_output", timed_out: false, duration_ms: Date.now() - started, error: error.message, runs: [] });
  }
  writeSuiteCheckpoint();
}

const allRuns = results.flatMap(result => result.runs || []);
const quality = summarizeQualityRuns(allRuns);
const cost = allRuns.reduce((sum, run) => sum + Number(run.provider_cost_usd || 0), 0);
const report = { status: "camelstream_live_suite", synthetic: false, representations: reps, runs_per_representation: runs, max_cycles: maxCycles, timeout_ms: timeoutMs, results, aggregate: { ...quality, approved_runs: quality.quality_outcomes.approved || 0, total_cost_usd: cost, cost_per_approved_run_usd: quality.quality_outcomes.approved ? cost / quality.quality_outcomes.approved : null } };
if (output) fs.writeFileSync(path.resolve(output), `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify(report, null, 2));
