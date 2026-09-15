import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { LIVE_PROFILES, LIVE_MODES, normalizeUsage, estimateCost, taskDigest, summarizeRuns, compareProfile } from "./live-benchmark-utils.mjs";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_PRICES = { input_per_mtok: 0, output_per_mtok: 0, cache_read_per_mtok: 0, cache_write_per_mtok: 0 };
const profiles = (process.env.MINITOK_LIVE_PROFILES || LIVE_PROFILES.join(",")).split(",").map(value => value.trim()).filter(value => LIVE_PROFILES.includes(value));
const modes = (process.env.MINITOK_LIVE_MODES || LIVE_MODES.join(",")).split(",").map(value => value.trim()).filter(value => LIVE_MODES.includes(value));
const repetitions = Math.max(1, Number(process.env.MINITOK_LIVE_RUNS) || 3);
const timeoutMs = Math.max(30_000, Number(process.env.MINITOK_LIVE_TIMEOUT_MS) || 180_000);
const allowPaid = process.env.MINITOK_LIVE_ALLOW_PAID === "1";
const preflightOnly = process.argv.includes("--preflight") || !allowPaid;
const outputFile = process.env.MINITOK_LIVE_SUITE_OUTPUT || "";

function readJsonSafe(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (error) { return { error: `${path.basename(file)}: ${error.message}` }; }
}
function loadProviderConfig() {
  const configFile = process.env.MINITOK_LIVE_CONFIG;
  const configured = configFile ? readJsonSafe(path.resolve(configFile)) : {};
  const state = readJsonSafe(path.join(os.homedir(), ".cline", "data", "globalState.json"));
  const secrets = readJsonSafe(path.join(os.homedir(), ".cline", "data", "secrets.json"));
  const endpoint = String(process.env.MINITOK_LIVE_ENDPOINT || configured.endpoint || state.openAiBaseUrl || "").trim();
  const model = String(process.env.MINITOK_LIVE_MODEL || configured.model || state.actModeOpenAiModelId || state.planModeApiModelId || "").trim();
  const key = String(process.env.MINITOK_LIVE_API_KEY || configured.api_key || secrets.openAiApiKey || "").trim();
  const prices = { ...DEFAULT_PRICES, ...(configured.pricing || {}) };
  return { endpoint, model, key, prices, source: configFile ? "explicit_config" : "environment_or_cline_state", parse_errors: [state, secrets, configured].filter(item => item?.error).map(item => item.error) };
}
function assertProviderConfig(config) {
  const missing = [!config.endpoint && "endpoint", !config.model && "model", !config.key && "api_key"].filter(Boolean);
  return { valid: missing.length === 0, missing, endpoint_host: config.endpoint ? new URL(config.endpoint).host : null, parse_errors: config.parse_errors };
}
function writeJson(file, payload) {
  if (!file) return;
  const target = path.resolve(file); fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp.${process.pid}`; fs.writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, "utf8"); fs.renameSync(temporary, target);
}
function yamlConfig(cfg, mode) {
  const adaptive = mode === "adaptive";
  return `default_provider: live\nproviders:\n  live:\n    base_url: ${cfg.endpoint}\n    api_key_env: MINITOK_LIVE_API_KEY\n    model: ${cfg.model}\nroles:\n  intel: { provider: live, model: ${cfg.model} }\n  plan: { provider: live, model: ${cfg.model} }\n  work: { provider: live, model: ${cfg.model} }\n  review: { provider: live, model: ${cfg.model} }\nvalidation:\n  enabled: true\n  script_path: VERIFY_CMD.mjs\nexecution:\n  max_retries: 0\n  timeout_hard_limit_sec: 900\n  context_retrieval: ${adaptive ? "focused" : "full"}\n  optimization_mode: ${adaptive ? "auto" : "off"}\n  context_representation: ${adaptive ? "adaptive" : "text"}\n  edit_representation: ${adaptive ? "adaptive" : "full_file"}\n  compact_output: ${adaptive ? "true" : "false"}\n  max_output_tokens_by_stage:\n    intel: ${adaptive ? 1536 : 4096}\n    plan: ${adaptive ? 2048 : 4096}\n    work: 8192\n    review: ${adaptive ? 1536 : 4096}\n`;
}

function createFixture(profile, cfg, mode, repetition) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `minitok-live-${profile}-${mode}-${repetition}-`));
  for (const args of [["init", "-q"], ["config", "user.email", "benchmark@example.test"], ["config", "user.name", "benchmark"]]) execFileSync("git", args, { cwd: root, stdio: "pipe" });
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: `live-${profile}`, type: "module" }));
  const target = ["export const VALUE = 1;", ...Array.from({ length: profile === "broad_rewrite" ? 500 : 80 }, (_, i) => `export const FIXTURE_${i} = ${i};`), ""].join("\n");
  fs.writeFileSync(path.join(root, "src", "target.mjs"), target);
  if (["multi_file", "broad_rewrite"].includes(profile)) fs.writeFileSync(path.join(root, "src", "second.mjs"), "export const SECOND = 1;\n" + "// second file context\n".repeat(profile === "broad_rewrite" ? 300 : 30));
  if (profile === "broad_rewrite") for (let i = 0; i < 12; i += 1) fs.writeFileSync(path.join(root, "src", `unrelated-${i}.mjs`), `export const UNRELATED_${i} = ${i};\n` + "// unrelated context\n".repeat(100));
  const verify = profile === "new_file" ? `import { VALUE } from './src/target.mjs';\nimport fs from 'node:fs';\nconst hasNewFile = fs.existsSync(new URL('./src/new-file.mjs', import.meta.url));\nprocess.exit(VALUE === 1 && hasNewFile === ${mode === "adaptive"} ? 0 : 1);\n` : profile === "multi_file" ? "import { VALUE } from './src/target.mjs';\nimport { SECOND } from './src/second.mjs';\nprocess.exit((VALUE === 1 && SECOND === 1) || (VALUE === 2 && SECOND === 2) ? 0 : 1);\n" : "import { VALUE } from './src/target.mjs';\nprocess.exit(VALUE === 1 || VALUE === 2 ? 0 : 1);\n";
  fs.writeFileSync(path.join(root, "VERIFY_CMD.mjs"), verify);
  fs.writeFileSync(path.join(root, "minitok.yml"), yamlConfig(cfg, mode));
  execFileSync("git", ["add", "-A"], { cwd: root, stdio: "pipe" }); execFileSync("git", ["commit", "-qm", "fixture"], { cwd: root, stdio: "pipe" });
  const tasks = { small_single_file: "Change VALUE from 1 to 2 in src/target.mjs and preserve every other line.", multi_file: "Change VALUE from 1 to 2 in src/target.mjs and change SECOND from 1 to 2 in src/second.mjs.", new_file: "Create src/new-file.mjs exporting NEW_VALUE = 1 while preserving the existing target file.", broad_rewrite: "Change VALUE from 1 to 2 and update the fixture implementation consistently across the source modules without removing unrelated exports." };
  return { root, task: tasks[profile] };
}

function instrument(providerModule, calls) {
  const original = providerModule.createProvider;
  providerModule.createProvider = (...args) => {
    const provider = original(...args); const complete = provider.complete.bind(provider);
    provider.complete = async (messages, options) => {
      const promptChars = messages.reduce((sum, message) => sum + String(message.content || "").length, 0);
      try {
        const response = await complete(messages, options); const usage = normalizeUsage(response?.usage, response?.tokens);
        calls.push({ role: args[0], model: response?.model || options?.model || null, prompt_chars: promptChars, usage, reported_cost_usd: Number(response?.usage?.cost_details?.upstream_inference_cost) || null, error: null }); return response;
      } catch (error) { calls.push({ role: args[0], model: options?.model || null, prompt_chars: promptChars, usage: normalizeUsage({}, {}), reported_cost_usd: null, error: String(error?.message || error).slice(0, 240) }); throw error; }
    }; return provider;
  }; return () => { providerModule.createProvider = original; };
}

function quality(result, run) {
  if (run.timed_out) return { quality_outcome: "timeout", complete_run: false, approval_eligible: false };
  if (result.success && run.review_verdict === "APPROVE" && run.verification_exit_code === 0) return { quality_outcome: "approved", complete_run: true, approval_eligible: true };
  if (["REJECT", "CHANGES_REQUESTED"].includes(run.review_verdict)) return { quality_outcome: "review_rejected", complete_run: true, approval_eligible: true };
  if (run.verification_exit_code !== null && run.verification_exit_code !== 0) return { quality_outcome: "verification_failed", complete_run: true, approval_eligible: true };
  return { quality_outcome: result.metrics?.final_status === "error" ? "provider_error" : "incomplete", complete_run: false, approval_eligible: false };
}

async function runOne(profile, mode, repetition, cfg) {
  const fixture = createFixture(profile, cfg, mode, repetition); const calls = []; const started = Date.now(); let result = null; let timedOut = false;
  const oldKey = process.env.MINITOK_LIVE_API_KEY; process.env.MINITOK_LIVE_API_KEY = cfg.key;
  const oldLog = console.log; const oldWarn = console.warn; const controller = new AbortController(); const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  try {
    console.log = () => {}; console.warn = () => {};
    const providerModule = require(path.join(ROOT, "src", "llm", "provider.js")); const restore = instrument(providerModule, calls);
    try {
      delete require.cache[require.resolve(path.join(ROOT, "src", "pipeline", "loop.js"))];
      const { TEST_AUTHORIZATION } = require(path.join(ROOT, "src", "pipeline", "test-seam.js"));
      const { runPipelineInWorkspace } = require(path.join(ROOT, "src", "pipeline", "loop.js"));
      result = await runPipelineInWorkspace(fixture.task, { repoRoot: fixture.root, signal: controller.signal, authorization: TEST_AUTHORIZATION, autoAccept: true, overrides: { budget: { max_cycles: 1, token_budget: 100000 } } });
    } finally { restore(); }
    const last = result.cycles.at(-1); const usage = calls.reduce((sum, call) => ({ input: sum.input + call.usage.input, output: sum.output + call.usage.output, total: sum.total + call.usage.total, cached_input: sum.cached_input + call.usage.cached_input, cache_write: sum.cache_write + call.usage.cache_write }), normalizeUsage({}, {}));
    const reported = calls.map(call => call.reported_cost_usd).filter(value => Number.isFinite(value) && value > 0); const cost = reported.length === calls.length ? { total: reported.reduce((sum, value) => sum + value, 0), source: "provider_reported" } : { ...estimateCost(usage, cfg.prices), source: "estimated" };
    const run = { profile, mode, repetition, task_digest: taskDigest(profile, fixture.task), provider: "live", requested_model: cfg.model, served_models: [...new Set(calls.map(call => call.model).filter(Boolean))], success: Boolean(result.success), final_status: result.metrics.final_status, timed_out: false, verification_exit_code: last?.check?.exit_code ?? null, review_verdict: last?.review?.verdict || "NONE", provider_calls: calls.length, usage, cost, prompt_chars: calls.reduce((sum, call) => sum + call.prompt_chars, 0), stage_calls: calls, repair_cycles: result.metrics.repair_cycles, edit_strategy: result.metrics.edits?.strategy || null, edit_policy_reason: result.metrics.edits?.policy_reason || null, retrieval_metrics: result.metrics.context?.retrieval || null, context: result.metrics.context || null, effective: result.metrics.effective || null, duration_ms: Date.now() - started, error: null };
    return { ...run, ...quality(result, run) };
  } catch (error) {
    const usage = calls.reduce((sum, call) => ({ input: sum.input + call.usage.input, output: sum.output + call.usage.output, total: sum.total + call.usage.total, cached_input: sum.cached_input + call.usage.cached_input, cache_write: sum.cache_write + call.usage.cache_write }), normalizeUsage({}, {}));
    return { profile, mode, repetition, task_digest: taskDigest(profile, fixture.task), provider: "live", requested_model: cfg.model, served_models: [...new Set(calls.map(call => call.model).filter(Boolean))], success: false, final_status: timedOut ? "timeout" : "error", timed_out: timedOut, verification_exit_code: null, review_verdict: "NONE", provider_calls: calls.length, usage, cost: { ...estimateCost(usage, cfg.prices), source: "estimated" }, prompt_chars: calls.reduce((sum, call) => sum + call.prompt_chars, 0), stage_calls: calls, repair_cycles: 0, edit_strategy: null, edit_policy_reason: null, retrieval_metrics: null, context: null, effective: null, duration_ms: Date.now() - started, error: String(error?.message || error).slice(0, 300), quality_outcome: timedOut ? "timeout" : "provider_error", complete_run: false, approval_eligible: false };
  } finally {
    console.log = oldLog; console.warn = oldWarn; clearTimeout(timer); if (oldKey === undefined) delete process.env.MINITOK_LIVE_API_KEY; else process.env.MINITOK_LIVE_API_KEY = oldKey; fs.rmSync(fixture.root, { recursive: true, force: true });
  }
}

async function main() {
  const cfg = loadProviderConfig(); const preflight = assertProviderConfig(cfg);
  if (preflightOnly || !preflight.valid) {
    const report = { status: preflight.valid ? "preflight_only" : "blocked_live_credentials", synthetic: false, paid_calls_allowed: allowPaid, preflight, profiles, modes, repetitions, limitations: ["No provider calls were made", "Set MINITOK_LIVE_ALLOW_PAID=1 to permit paid live calls"] };
    writeJson(outputFile, report); console.log(JSON.stringify(report, null, 2)); return;
  }
  const runs = [];
  for (let repetition = 1; repetition <= repetitions; repetition += 1) for (const profile of profiles) for (const mode of modes) runs.push(await runOne(profile, mode, repetition, cfg));
  const report = { status: "live_cost_suite", synthetic: false, paid_calls_allowed: true, endpoint_host: preflight.endpoint_host, requested_model: cfg.model, profiles, modes, repetitions, timeout_ms: timeoutMs, pricing: cfg.prices, summaries: summarizeRuns(runs), comparisons: Object.fromEntries(profiles.map(profile => [profile, compareProfile(runs, profile)])), runs, limitations: ["Provider/model behavior and tokenization are live-dependent", "Cost is provider-reported when every call reports cost, otherwise estimated from configured pricing"] };
  writeJson(outputFile, report); console.log(JSON.stringify(report, null, 2));
}
await main();
