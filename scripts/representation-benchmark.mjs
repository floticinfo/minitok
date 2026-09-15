import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const reps = ["text", "workflow_ir", "edit_ir", "adaptive"];
const count = Math.max(3, Number(process.env.MINITOK_BENCHMARK_RUNS) || 3);
const seed = Number(process.env.MINITOK_BENCHMARK_SEED) || 17;
const selected = process.argv.slice(2).filter(value => reps.includes(value));

function order(values) {
  let state = seed;
  return [...values].sort(() => { state = (state * 1664525 + 1013904223) % 4294967296; return state / 4294967296 - 0.5; });
}
function fixture(index) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), `minitok-rep-${index}-`));
  for (const args of [["init", "-q"], ["config", "user.email", "benchmark@example.test"], ["config", "user.name", "benchmark"]]) execFileSync("git", args, { cwd: repo, stdio: "pipe" });
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ name: `fixture-${index}`, version: "1.0.0" }));
  fs.writeFileSync(path.join(repo, "src", "target.mjs"), "export const value = 2;\n");
  fs.writeFileSync(path.join(repo, "VERIFY_CMD.mjs"), "import { value } from './src/target.mjs';\nprocess.exit(value === 2 ? 0 : 1);\n");
  fs.writeFileSync(path.join(repo, "minitok.yml"), "default_provider: mock\nproviders:\n  mock: { model: benchmark }\nroles:\n  intel: { provider: mock }\n  plan: { provider: mock }\n  work: { provider: mock }\n  review: { provider: mock }\nvalidation:\n  enabled: true\n  script_path: VERIFY_CMD.mjs\n");
  execFileSync("git", ["add", "-A"], { cwd: repo, stdio: "pipe" });
  execFileSync("git", ["commit", "-qm", "fixture"], { cwd: repo, stdio: "pipe" });
  return repo;
}
function stub(calls) {
  const providerPath = require.resolve(path.join(ROOT, "src", "llm", "provider.js"));
  const loopPath = require.resolve(path.join(ROOT, "src", "pipeline", "loop.js"));
  const fake = { createProvider: name => ({ name, isAvailable: async () => true, complete: async messages => {
    const prompt = messages.map(message => message.content).join("\n"); calls.push(prompt);
    let text = /compact JSON/i.test(prompt) ? JSON.stringify({ s: "facts", f: ["src/target.mjs"], p: [], r: [], c: [], n: [] }) : JSON.stringify({ summary: "facts", relevant_files: ["src/target.mjs"], existing_patterns: [], risks: [], constraints: [], recommendations: [] });
    if (/senior software architect/i.test(prompt)) text = /compact JSON/i.test(prompt) ? JSON.stringify({ t: "change", s: [{ i: 1, a: "modify", f: "src/target.mjs", d: "set value to 2", r: "task" }], n: 1, risk: "low" }) : JSON.stringify({ steps: [{ id: 1, action: "modify", file: "src/target.mjs", description: "set value to 2" }] });
    if (/expert software engineer/i.test(prompt)) {
      const edit = /prefer edits with before_hash/i.test(prompt);
      text = edit
        ? (/precise code edit engine/i.test(prompt) ? JSON.stringify({ v: 2, changes: [{ f: "f0", h: createHash("sha256").update("export const value = 2;\n").digest("hex"), e: [{ k: "x", b: "export const value = 2;", a: "export const value = 2;" }] }] }) : JSON.stringify({ changes: [{ file: "src/target.mjs", action: "modify", before_hash: createHash("sha256").update("export const value = 2;\n").digest("hex"), edits: [{ kind: "replace_exact", before: "export const value = 2;", after: "export const value = 2;" }] }], summary: "updated", files_changed: 1 }))
        : JSON.stringify({ changes: [{ file: "src/target.mjs", action: "modify", content: "export const value = 2;\n" }], summary: "updated", files_changed: 1 });
    }
    if (/meticulous code reviewer/i.test(prompt)) text = /compact JSON/i.test(prompt) ? JSON.stringify({ v: "A", c: 0.95, f: [] }) : JSON.stringify({ verdict: "APPROVE", confidence: 0.95, summary: "ok", findings: [] });
    return { text, model: "benchmark-stub", usage: {}, tokens: { input: Math.ceil(prompt.length / 4), output: Math.ceil(text.length / 4) } };
  } }), FallbackProvider: class { constructor(primary) { this.primary = primary; } get name() { return this.primary.name; } isAvailable() { return this.primary.isAvailable(); } complete(...args) { return this.primary.complete(...args); } }, configureRetries: () => {}, _estimateCost: () => ({ total: 0 }) };
  require.cache[providerPath] = /** @type {any} */ ({ id: providerPath, filename: providerPath, loaded: true, exports: fake }); delete require.cache[loopPath];
  return () => { delete require.cache[providerPath]; delete require.cache[loopPath]; };
}
async function runOne(representation, index) {
  const repo = fixture(index); const calls = []; const restore = stub(calls); const log = console.log;
  try {
    console.log = () => {};
    const { TEST_AUTHORIZATION } = require(path.join(ROOT, "src", "pipeline", "test-seam.js"));
    const { runPipelineInWorkspace } = require(path.join(ROOT, "src", "pipeline", "loop.js"));
    const result = await runPipelineInWorkspace("Change target value to 2 in src/target.mjs", { repoRoot: repo, authorization: TEST_AUTHORIZATION, autoAccept: true, overrides: { budget: { max_cycles: 1 }, execution: representation === "text" ? { research_enabled: true, strict_optimization: true, compact_output: false, context_retrieval: "full", context_representation: "text", edit_representation: "full_file" } : { research_enabled: true, strict_optimization: false, compact_output: true, context_retrieval: representation === "adaptive" ? "focused" : "full", context_representation: representation === "adaptive" ? "adaptive" : representation === "workflow_ir" ? "workflow_ir" : "text", edit_representation: representation === "adaptive" ? "adaptive" : representation === "edit_ir" ? "edit_ir" : "full_file" } } });
    const last = result.cycles.at(-1); const metrics = result.metrics;
    return { model: "benchmark-stub", provider: "mock", repository_commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim(), task: "Change target value to 2", representation, verification_exit_code: last?.check?.exit_code ?? (result.success ? 0 : 1), duration_ms: metrics.latency_ms, total_tokens: result.totalTokens.input + result.totalTokens.output, total_cost_usd: metrics.provider_cost_usd || 0, manual_interventions: 0, provider_usage: metrics.provider_usage, provider_cost_usd: metrics.provider_cost_usd || 0, verification: metrics.verification, review_verdict: last?.review?.verdict || "NONE", repair_cycles: metrics.repair_cycles, changed_files: metrics.changed_files, compaction: metrics.compaction, context: metrics.context, final_status: metrics.final_status, provider_calls: metrics.provider_calls, captured_prompt_chars: calls.reduce((sum, value) => sum + value.length, 0), edits: metrics.edits, effective: metrics.effective, stage_metrics: metrics.stages };
  } finally { console.log = log; restore(); fs.rmSync(repo, { recursive: true, force: true }); }
}
const runs = [];
for (let index = 0; index < count; index += 1) for (const representation of order(selected.length ? selected : reps)) runs.push(await runOne(representation, index));
const groups = Object.fromEntries((selected.length ? selected : reps).map(representation => {
  const values = runs.filter(run => run.representation === representation);
  const average = key => values.reduce((sum, run) => sum + Number(run[key] || 0), 0) / values.length;
  return [representation, { runs: values.length, success_rate: values.filter(run => run.final_status === "success").length / values.length, avg_total_tokens: average("total_tokens"), avg_duration_ms: average("duration_ms"), avg_prompt_chars: average("captured_prompt_chars"), avg_provider_cost_usd: average("provider_cost_usd"), avg_repair_cycles: average("repair_cycles") }];
}));
const report = { status: "repeated_representation_benchmark", synthetic: true, repetitions: count, seed, randomized_order: true, representations: selected.length ? selected : reps, summary: groups, runs, limitations: ["provider is deterministic stub", "edit_ir measures prompt contract and compatibility path; stub returns full-file content", "token estimates divide captured characters by four"] };
const output = process.env.MINITOK_BENCHMARK_OUTPUT;
if (output) fs.writeFileSync(path.resolve(output), `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify(report, null, 2));
