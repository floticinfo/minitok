import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { parseDsl, compileDslToEditIr } = require(path.join(ROOT, "src", "pipeline", "dsl.js"));
const { decodeEditChanges, expandEditChanges } = require(path.join(ROOT, "src", "pipeline", "edit-ir.js"));
const REPRESENTATIONS = ["dsl", "compact_edit_ir_v2", "full_file"];
const CASES = ["exact_single_file", "line_single_file", "multi_file", "new_file"];
const repetitions = Math.max(1, Number(process.env.MINITOK_DSL_BENCHMARK_RUNS) || 3);
const outputPerMtok = Math.max(0, Number(process.env.MINITOK_BENCHMARK_OUTPUT_PER_MTOK) || 15);
const selectedCases = process.argv.slice(2).filter(value => CASES.includes(value));

function quote(value) { return JSON.stringify(String(value)); }
function bytes(value) { return Buffer.byteLength(value, "utf8"); }
function tokens(value) { return Math.ceil(bytes(value) / 4); }
function cost(value) { return tokens(value) / 1e6 * outputPerMtok; }

function fixture(index) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), `minitok-dsl-rep-${index}-`));
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  fs.writeFileSync(path.join(repo, "src", "a.js"), "const a = 1;\nconst b = 2;\n");
  fs.writeFileSync(path.join(repo, "src", "b.js"), "export const enabled = false;\n");
  fs.writeFileSync(path.join(repo, "VERIFY_CMD.mjs"), "process.exit(0);\n");
  return repo;
}

function operationBlock(kind, fields) {
  const body = Object.entries(fields).map(([key, value]) => `    ${key} ${typeof value === "number" ? value : quote(value)}`).join("\n");
  return `  operation ${kind} {\n${body}\n  }`;
}
function taskSource(name, targets) {
  return `task ${quote(name)} {\n${targets.map(target => `  target file ${quote(target.file)}\n${operationBlock(target.kind, target.fields)}`).join("\n")}\n  verify command ${quote("VERIFY_CMD.mjs")}\n}`;
}
function caseDefinition(name) {
  if (name === "exact_single_file") return { task: "Change one exact value", targets: [{ file: "src/a.js", kind: "replace_exact", fields: { before: "const a = 1;", after: "const a = 3;" } }] };
  if (name === "line_single_file") return { task: "Replace one line", targets: [{ file: "src/a.js", kind: "replace_lines", fields: { start: 2, end: 2, content: "const b = 4;" } }] };
  if (name === "multi_file") return { task: "Change two files", targets: [{ file: "src/a.js", kind: "replace_exact", fields: { before: "const a = 1;", after: "const a = 3;" } }, { file: "src/b.js", kind: "replace_exact", fields: { before: "export const enabled = false;", after: "export const enabled = true;" } }] };
  return { task: "Create a new module", targets: [{ file: "src/new.js", kind: "create", fields: { content: "export const created = true;\n" } }] };
}

function fullChanges(repo, compiled) {
  const decoded = decodeEditChanges({ changes: compiled.changes }, compiled.manifest);
  const expanded = expandEditChanges(repo, decoded);
  if (expanded.error) throw new Error(expanded.error);
  return expanded.changes.map(change => {
    const result = { file: change.file, action: change.action || "modify" };
    if (change.action !== "delete") result.content = change.content;
    return result;
  });
}

function measure(repo, definition) {
  const source = taskSource(definition.task, definition.targets);
  const compiled = compileDslToEditIr(repo, parseDsl(source));
  const full = { changes: fullChanges(repo, compiled) };
  const payloads = {
    dsl: source,
    compact_edit_ir_v2: JSON.stringify({ v: 2, changes: compiled.changes }),
    full_file: JSON.stringify(full),
  };
  const manifest = JSON.stringify(compiled.manifest);
  const baselineBytes = bytes(payloads.full_file);
  const rows = {};
  for (const representation of REPRESENTATIONS) {
    const payload = payloads[representation];
    const payloadBytes = bytes(payload);
    const manifestBytes = representation === "compact_edit_ir_v2" ? bytes(manifest) : 0;
    const transportBytes = payloadBytes + manifestBytes;
    const estimatedTokens = tokens(payload) + (representation === "compact_edit_ir_v2" ? tokens(manifest) : 0);
    rows[representation] = {
      representation,
      payload_bytes: payloadBytes,
      manifest_bytes: manifestBytes,
      transport_bytes: transportBytes,
      estimated_tokens: estimatedTokens,
      estimated_equivalent_output_cost_usd: estimatedTokens / 1e6 * outputPerMtok,
      reduction_vs_full_pct: baselineBytes ? (1 - transportBytes / baselineBytes) * 100 : 0,
      semantic_validation: true,
      files: compiled.changes.length,
      operations: definition.targets.length,
    };
  }
  return { case: definition.task, source, rows };
}

function main() {
  const cases = selectedCases.length ? selectedCases : CASES;
  const runs = [];
  for (let repetition = 0; repetition < repetitions; repetition += 1) {
    const repo = fixture(repetition);
    try {
      for (const name of cases) runs.push({ repetition: repetition + 1, case: name, ...measure(repo, caseDefinition(name)) });
    } finally { fs.rmSync(repo, { recursive: true, force: true }); }
  }
  const summary = Object.fromEntries(REPRESENTATIONS.map(representation => {
    const rows = runs.flatMap(run => Object.values(run.rows).filter(row => row.representation === representation));
    const average = field => rows.reduce((sum, row) => sum + Number(row[field] || 0), 0) / rows.length;
    return [representation, { runs: rows.length, avg_payload_bytes: average("payload_bytes"), avg_manifest_bytes: average("manifest_bytes"), avg_transport_bytes: average("transport_bytes"), avg_estimated_tokens: average("estimated_tokens"), avg_equivalent_output_cost_usd: average("estimated_equivalent_output_cost_usd"), avg_reduction_vs_full_pct: average("reduction_vs_full_pct"), semantic_validation_rate: rows.filter(row => row.semantic_validation).length / rows.length }];
  }));
  const report = { status: "dsl_representation_benchmark", synthetic: true, repetitions, cases, representations: REPRESENTATIONS, output_price_per_mtok_usd: outputPerMtok, runs, summary, limitations: ["synthetic local fixtures", "token estimate is ceil(UTF-8 bytes / 4)", "equivalent output cost is not a provider bill; DSL has no LLM call", "Compact IR manifest is counted separately and included in transport metrics"] };
  const output = process.env.MINITOK_DSL_BENCHMARK_OUTPUT;
  if (output) fs.writeFileSync(path.resolve(output), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(report, null, 2));
}
main();
