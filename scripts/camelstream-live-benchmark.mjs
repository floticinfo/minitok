import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { median } from "./benchmark-stats.mjs";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(os.homedir(), ".cline", "data");
const REPS = process.env.MINITOK_LIVE_REP ? [process.env.MINITOK_LIVE_REP] : ["text", "workflow_ir", "edit_ir", "adaptive"];
const COUNT = Math.max(1, Number(process.env.MINITOK_LIVE_RUNS) || 1);
const MAX_CYCLES = Math.max(1, Number(process.env.MINITOK_LIVE_MAX_CYCLES) || 1);
const RUN_TIMEOUT_MS = Math.max(30_000, Number(process.env.MINITOK_LIVE_TIMEOUT_MS) || 120_000);
const OUTPUT_FILE = process.env.MINITOK_LIVE_OUTPUT || "";
const CHECKPOINT_FILE = process.env.MINITOK_LIVE_CHECKPOINT || OUTPUT_FILE;
const RETRIEVAL = process.env.MINITOK_LIVE_RETRIEVAL || "full";
const UNRELATED_FILES = Math.max(0, Number(process.env.MINITOK_LIVE_UNRELATED_FILES) || 20);
const UNRELATED_LINES = Math.max(1, Number(process.env.MINITOK_LIVE_UNRELATED_LINES) || 60);

function writeJsonFile(file, payload) {
  if (!file) return;
  const target = path.resolve(file);
  const temporary = `${target}.tmp.${process.pid}`;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, target);
}

function writeCheckpoint(payload) {
  writeJsonFile(CHECKPOINT_FILE, payload);
}

function loadConfig() {
  const state = JSON.parse(fs.readFileSync(path.join(DATA, "globalState.json"), "utf8"));
  const secrets = JSON.parse(fs.readFileSync(path.join(DATA, "secrets.json"), "utf8"));
  const endpoint = String(state.openAiBaseUrl || "").trim();
  const model = String(state.actModeOpenAiModelId || state.planModeApiModelId || "auto").trim();
  const key = String(secrets.openAiApiKey || "").trim();
  if (!endpoint || !model || !key) throw new Error("Cline CamelStream configuration is incomplete");
  return { endpoint, model, key };
}

function makeFixture(id, cfg) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `minitok-camel-${id}-`));
  for (const args of [["init", "-q"], ["config", "user.email", "benchmark@example.test"], ["config", "user.name", "benchmark"]]) execFileSync("git", args, { cwd: root, stdio: "pipe" });
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "camel-fixture", type: "module" }));
  fs.writeFileSync(path.join(root, "src", "target.mjs"), ["export const VALUE = 1;", ...Array.from({ length: 120 }, (_, i) => `export const FIXTURE_${i} = ${i};`), ""].join("\n"));
  for (let index = 0; index < UNRELATED_FILES; index += 1) fs.writeFileSync(path.join(root, "src", `unrelated-${String(index).padStart(2, "0")}.mjs`), `export const UNRELATED_${index} = ${index};\n` + "// unrelated fixture context\n".repeat(UNRELATED_LINES));
  fs.writeFileSync(path.join(root, "VERIFY_CMD.mjs"), "import { VALUE } from './src/target.mjs';\nprocess.exit(VALUE === 1 || VALUE === 2 ? 0 : 1);\n");
  fs.writeFileSync(path.join(root, "minitok.yml"), `default_provider: camelstream\nproviders:\n  camelstream:\n    base_url: ${cfg.endpoint}\n    api_key_env: CAMEL_STREAM_API_KEY\n    model: ${cfg.model}\nroles:\n  intel: { provider: camelstream, model: ${cfg.model} }\n  plan: { provider: camelstream, model: ${cfg.model} }\n  work: { provider: camelstream, model: ${cfg.model} }\n  review: { provider: camelstream, model: ${cfg.model} }\nvalidation:\n  enabled: true\n  script_path: VERIFY_CMD.mjs\nexecution:\n  max_retries: 0\n  timeout_hard_limit_sec: 900\n  context_retrieval: ${RETRIEVAL}\n`);
  execFileSync("git", ["add", "-A"], { cwd: root, stdio: "pipe" });
  execFileSync("git", ["commit", "-qm", "fixture"], { cwd: root, stdio: "pipe" });
  return root;
}

function redacted(value, key) { return String(value || "").replaceAll(key, "<redacted>").slice(0, 500); }

function instrument(providerModule, calls, onCall) {
  const original = providerModule.createProvider;
  providerModule.createProvider = (...args) => {
    const provider = original(...args);
    const complete = provider.complete.bind(provider);
    provider.complete = async (messages, options) => {
      const promptChars = messages.reduce((sum, m) => sum + String(m.content || "").length, 0);
      try {
        const response = await complete(messages, options);
        calls.push({ role: args[0], prompt_chars: promptChars, model: response?.model || null, tokens: response?.tokens || { input: 0, output: 0 }, cost_usd: Number(response?.usage?.cost_details?.upstream_inference_cost) || null, error: null });
        onCall?.(calls.at(-1));
        return response;
      } catch (error) {
        calls.push({ role: args[0], prompt_chars: promptChars, model: null, tokens: { input: 0, output: 0 }, cost_usd: null, error: String(error?.message || error).slice(0, 200) });
        onCall?.(calls.at(-1));
        throw error;
      }
    };
    return provider;
  };
  return () => { providerModule.createProvider = original; };
}

function classifyQuality(run) {
  if (run.timed_out || run.final_status === "timeout") return { quality_outcome: "timeout", complete_run: false, approval_eligible: false };
  if (run.review_verdict === "APPROVE" && run.verification_exit_code === 0 && run.success) return { quality_outcome: "approved", complete_run: true, approval_eligible: true };
  if (run.review_verdict === "REJECT" || run.review_verdict === "CHANGES_REQUESTED") return { quality_outcome: "review_rejected", complete_run: true, approval_eligible: true };
  const lastStatus = run.cycle_states?.at(-1)?.status;
  if (lastStatus === "VERIFICATION_FAILED" || run.verification_exit_code !== null && run.verification_exit_code !== 0) return { quality_outcome: "verification_failed", complete_run: true, approval_eligible: true };
  if (lastStatus === "MODEL_OUTPUT_INVALID") return { quality_outcome: "implementation_invalid", complete_run: true, approval_eligible: true };
  if (lastStatus === "NO_ACTIONABLE_PLAN") return { quality_outcome: "no_actionable_plan", complete_run: true, approval_eligible: true };
  if (run.final_status === "error" || run.error) return { quality_outcome: "provider_error", complete_run: false, approval_eligible: false };
  return { quality_outcome: "incomplete", complete_run: false, approval_eligible: false };
}

async function runOne(rep, n, cfg) {
  const root = makeFixture(`${n}-${rep}`, cfg);
  const calls = [];
  const providerModule = require(path.join(ROOT, "src", "llm", "provider.js"));
  const restoreProvider = instrument(providerModule, calls, () => {
    writeCheckpoint({ status: "camelstream_live_benchmark_checkpoint", synthetic: false, representation: rep, repetition: n, retrieval: RETRIEVAL, max_cycles: MAX_CYCLES, timeout_ms: RUN_TIMEOUT_MS, runs, active_run: { representation: rep, repetition: n, stage_calls: calls } });
  });
  const oldKey = process.env.CAMEL_STREAM_API_KEY;
  const oldLog = console.log;
  const oldWarn = console.warn;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), RUN_TIMEOUT_MS);
  const started = Date.now();
  process.env.CAMEL_STREAM_API_KEY = cfg.key;
  try {
    console.log = () => {};
    console.warn = () => {};
    delete require.cache[require.resolve(path.join(ROOT, "src", "pipeline", "loop.js"))];
    const { TEST_AUTHORIZATION } = require(path.join(ROOT, "src", "pipeline", "test-seam.js"));
    const { runPipelineInWorkspace } = require(path.join(ROOT, "src", "pipeline", "loop.js"));
    const result = await runPipelineInWorkspace("Change VALUE from 1 to 2 in src/target.mjs and preserve every other line.", { repoRoot: root, signal: controller.signal, authorization: TEST_AUTHORIZATION, autoAccept: true, overrides: { budget: { max_cycles: MAX_CYCLES, token_budget: 100000 }, execution: { research_enabled: true, context_representation: rep === "adaptive" ? "adaptive" : rep === "workflow_ir" ? "workflow_ir" : "text", edit_representation: rep === "edit_ir" ? "edit_ir" : "full_file" } } });
    const last = result.cycles.at(-1);
    const run = { provider: "camelstream", requested_model: cfg.model, served_models: [...new Set(calls.map(call => call.model).filter(Boolean))], representation: rep, repetition: n, max_cycles: MAX_CYCLES, timeout_ms: RUN_TIMEOUT_MS, timed_out: false, success: Boolean(result.success), final_status: result.metrics.final_status, verification_exit_code: last?.check?.exit_code ?? null, review_verdict: last?.review?.verdict || "NONE", provider_calls: result.metrics.provider_calls, provider_usage: result.metrics.provider_usage, total_tokens: result.totalTokens.input + result.totalTokens.output, prompt_chars: calls.reduce((sum, call) => sum + call.prompt_chars, 0), stage_calls: calls, cycle_states: result.cycles.map(cycle => ({ cycle: cycle.cycle, status: cycle.status, repair_mode: cycle.repair_mode || false, repair_reason: cycle.repair_reason || null, intel_state: cycle.intel_state || null, plan_state: cycle.plan_state || null, work_only: cycle.work_only || false })), repair_metrics: result.metrics.repair, edit_metrics: result.metrics.edits, retrieval_metrics: result.metrics.context?.retrieval || null, context_stage_metrics: result.metrics.context?.stages || null, duration_ms: Date.now() - started, repair_cycles: result.metrics.repair_cycles, changed_files: result.metrics.changed_files, provider_cost_usd: result.metrics.provider_cost_usd || null, context: result.metrics.context, error: null };
    return { ...run, ...classifyQuality(run) };
  } catch (error) {
    const run = { provider: "camelstream", requested_model: cfg.model, served_models: [...new Set(calls.map(call => call.model).filter(Boolean))], representation: rep, repetition: n, max_cycles: MAX_CYCLES, timeout_ms: RUN_TIMEOUT_MS, timed_out: controller.signal.aborted, success: false, final_status: controller.signal.aborted ? "timeout" : "error", verification_exit_code: null, review_verdict: "NONE", provider_calls: calls.length, provider_usage: { input: calls.reduce((sum, call) => sum + Number(call.tokens?.input || 0), 0), output: calls.reduce((sum, call) => sum + Number(call.tokens?.output || 0), 0), total: calls.reduce((sum, call) => sum + Number(call.tokens?.input || 0) + Number(call.tokens?.output || 0), 0) }, total_tokens: calls.reduce((sum, call) => sum + Number(call.tokens?.input || 0) + Number(call.tokens?.output || 0), 0), prompt_chars: calls.reduce((sum, call) => sum + call.prompt_chars, 0), stage_calls: calls, cycle_states: [], repair_metrics: null, edit_metrics: null, duration_ms: Date.now() - started, repair_cycles: 0, changed_files: 0, provider_cost_usd: null, context: null, error: redacted(error?.message || error, cfg.key) };
    return { ...run, ...classifyQuality(run) };
  } finally {
    console.log = oldLog;
    console.warn = oldWarn;
    clearTimeout(timeout);
    restoreProvider();
    if (oldKey === undefined) delete process.env.CAMEL_STREAM_API_KEY; else process.env.CAMEL_STREAM_API_KEY = oldKey;
    fs.rmSync(root, { recursive: true, force: true });
  }
}


const cfg = loadConfig();
const runs = [];
function buildReport() {
  const summaries = Object.fromEntries(REPS.map(rep => {
    const values = runs.filter(x => x.representation === rep);
    const avg = key => values.length ? values.reduce((sum, x) => sum + Number(x[key] || 0), 0) / values.length : 0;
    const approved = values.filter(x => x.quality_outcome === "approved").length;
    const complete = values.filter(x => x.complete_run);
    const eligible = values.filter(x => x.approval_eligible);
    const timedOut = values.filter(x => x.quality_outcome === "timeout").length;
    const totalCost = values.reduce((sum, x) => sum + Number(x.provider_cost_usd || 0), 0);
    const qualityOutcomes = Object.fromEntries([...new Set(values.map(x => x.quality_outcome))].map(outcome => [outcome, values.filter(x => x.quality_outcome === outcome).length]));
    const qualityOutcomeRates = Object.fromEntries(Object.entries(qualityOutcomes).map(([outcome, count]) => [outcome, values.length ? count / values.length : 0]));
    const retrievalSelected = values.filter(x => Number(x.retrieval_metrics?.selected_stages || 0) > 0).length;
    const fallbackStages = values.reduce((sum, x) => sum + Number(x.retrieval_metrics?.fallback_stages || 0), 0);
    return [rep, { runs: values.length, complete_runs: complete.length, complete_run_rate: values.length ? complete.length / values.length : 0, success_rate: values.length ? values.filter(x => x.success).length / values.length : 0, approval_rate: eligible.length ? approved / eligible.length : 0, approval_eligible_runs: eligible.length, timeout_rate: values.length ? timedOut / values.length : 0, quality_outcomes: qualityOutcomes, quality_outcome_rates: qualityOutcomeRates, retrieval_selected_run_rate: values.length ? retrievalSelected / values.length : 0, avg_retrieval_fallback_stages: values.length ? fallbackStages / values.length : 0, avg_total_tokens: avg("total_tokens"), median_total_tokens: median(values.map(x => x.total_tokens)), avg_input_tokens: values.length ? values.reduce((sum, x) => sum + Number(x.provider_usage?.input || 0), 0) / values.length : 0, median_input_tokens: median(values.map(x => x.provider_usage?.input)), avg_output_tokens: values.length ? values.reduce((sum, x) => sum + Number(x.provider_usage?.output || 0), 0) / values.length : 0, median_output_tokens: median(values.map(x => x.provider_usage?.output)), avg_prompt_chars: avg("prompt_chars"), median_prompt_chars: median(values.map(x => x.prompt_chars)), avg_duration_ms: avg("duration_ms"), avg_provider_calls: avg("provider_calls"), avg_repair_cycles: avg("repair_cycles"), avg_cost_usd: values.length ? totalCost / values.length : 0, median_cost_usd: median(values.map(x => x.provider_cost_usd)), cost_per_approved_run_usd: approved ? totalCost / approved : null, provider_cost_available: values.some(x => x.provider_cost_usd !== null) }];
  }));
  return { status: "camelstream_live_benchmark", synthetic: false, endpoint_host: new URL(cfg.endpoint).host, requested_model: cfg.model, retrieval: RETRIEVAL, max_cycles: MAX_CYCLES, timeout_ms: RUN_TIMEOUT_MS, repetitions: COUNT, representations: REPS, summaries, runs, limitations: ["CamelStream pricing was not present in Cline configuration", "cost is null when provider does not report cost"] };
}
for (let n = 1; n <= COUNT; n += 1) for (const rep of REPS) {
  const run = await runOne(rep, n, cfg);
  runs.push(run);
  writeCheckpoint(buildReport());
}
const report = buildReport();
writeJsonFile(OUTPUT_FILE, report);
if (!OUTPUT_FILE) writeCheckpoint(report);
console.log(JSON.stringify(report, null, 2));
