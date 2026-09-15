import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { compactText } from "../src/context/compaction.js";
import { buildFocusedContext } from "../src/context/retrieval.js";
import workflowIR from "../src/context/workflow-ir.js";

const { buildWorkflowIR, serializeWorkflowIR } = workflowIR;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "minitok-context-fixture-"));
const outputFile = process.argv[2] ? path.resolve(process.argv[2]) : null;
const stages = ["intel", "plan", "work"];
const stageBudgets = { intel: 12000, plan: 18000, work: 30000 };

function writeFixture() {
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "large-context-fixture", version: "1.0.0" }));
  fs.writeFileSync(path.join(root, "README.md"), "# Large deterministic fixture\n" + "documentation line\n".repeat(300));
  for (let index = 0; index < 72; index += 1) {
    const file = path.join(root, "src", `module-${String(index).padStart(3, "0")}.js`);
    const body = `// deterministic module ${index}\nexport const value${index} = ${index};\n` + `// repeated implementation context ${index}\n`.repeat(55);
    fs.writeFileSync(file, body);
  }
}

function fullContext() {
  const files = workflowIR.listRepositoryFiles(root);
  return ["Repository: large-context-fixture", ...files.map(file => `\n--- ${file.path} ---\n${fs.readFileSync(path.join(root, file.path), "utf8")}`)].join("\n");
}

function summarize(entries) {
  const byStage = Object.fromEntries(entries.map(entry => [entry.stage, { chars: entry.chars, estimated_tokens: Math.ceil(entry.chars / 4) }]));
  const totalChars = entries.reduce((sum, entry) => sum + entry.chars, 0);
  return { by_stage: byStage, total_chars: totalChars, estimated_tokens: Math.ceil(totalChars / 4) };
}

try {
  writeFixture();
  const original = fullContext();
  const ir = buildWorkflowIR(root, {
    branch: "fixture",
    commit: "fixture-commit",
    task: "inspect the large fixture",
    plan: { steps: [{ id: 1, action: "modify", file: "src/module-000.js", description: "update fixture" }] },
    changes: [{ action: "modify", file: "src/module-000.js", digest: "fixture-change" }],
    verification: { passed: true, exit_code: 0, status: "passed" },
    review: { verdict: "APPROVE", confidence: 0.95, summary: "fixture review" },
  });
  const legacy = summarize(stages.map(stage => ({ stage, chars: compactText(original, { budget_chars: 40000 }).final_chars })));
  const stageCompaction = summarize(stages.map(stage => ({ stage, chars: compactText(original, { budget_chars: stageBudgets[stage] }).final_chars })));
  const full = summarize(stages.map(stage => ({ stage, chars: original.length })));
  const workflow = summarize(stages.map(stage => ({ stage, chars: serializeWorkflowIR(ir, stage).length })));
  const focused = buildFocusedContext(root, { base_context: original, task: "update src/module-000.js", plan: { steps: [{ file: "src/module-000.js", description: "update value" }] }, max_files: 3, max_file_chars: 6000, max_total_chars: 18000 });
  const focusedByStage = summarize(stages.map(stage => ({ stage, chars: compactText(focused.text, { budget_chars: stageBudgets[stage] }).final_chars })));
  focusedByStage.selected_files = focused.selected_files;
  focusedByStage.selected_ranges = focused.selected_ranges;
  focusedByStage.fallback_reason = focused.fallback_reason;
  const report = {
    status: "deterministic_context_benchmark",
    synthetic: true,
    fixture: { files: ir.files.length, original_chars: original.length, exceeds_default_compaction_budget: original.length > 40000 },
    budgets: { legacy: 40000, stage: stageBudgets },
    full_context: full,
    legacy_compaction: legacy,
    stage_compaction: stageCompaction,
    focused_retrieval: focusedByStage,
    workflow_ir: workflow,
    reduction_vs_full_pct: {
      legacy_compaction: (1 - legacy.total_chars / full.total_chars) * 100,
      stage_compaction: (1 - stageCompaction.total_chars / full.total_chars) * 100,
      focused_retrieval: (1 - focusedByStage.total_chars / full.total_chars) * 100,
      workflow_ir: (1 - workflow.total_chars / full.total_chars) * 100,
    },
  };
  const text = JSON.stringify(report, null, 2);
  if (outputFile) fs.writeFileSync(outputFile, `${text}\n`, "utf8");
  console.log(text);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
