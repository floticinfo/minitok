"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { compactText } = require(path.join(__dirname, "..", "src", "context", "compaction.js"));
const { buildWorkflowIR, serializeWorkflowIR, projectWorkflowContext, attachFileExcerpts } = require(path.join(__dirname, "..", "src", "context", "workflow-ir.js"));

const ROOT = path.join(__dirname, "..");

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "minitok-large-context-test-"));
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "README.md"), "# fixture\n" + "context\n".repeat(1000));
  for (let index = 0; index < 40; index += 1) fs.writeFileSync(path.join(root, "src", `file-${index}.js`), `export const value = ${index};\n` + "implementation context\n".repeat(100));
  return root;
}

test("large repository fixture crosses the default compaction threshold", () => {
  const root = makeFixture();
  try {
    const ir = buildWorkflowIR(root, { task: "test large context" });
    const full = ["Repository: fixture", ...ir.files.map(file => `--- ${file.path} ---\n${fs.readFileSync(path.join(root, file.path), "utf8")}`)].join("\n");
    const compacted = compactText(full, { budget_chars: 40000 });
    assert.ok(full.length > 40000);
    assert.equal(compacted.compacted, true);
    assert.ok(compacted.final_chars <= 40000);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("workflow IR is deterministic metadata and omits repository file contents", () => {
  const root = makeFixture();
  try {
    const ir = buildWorkflowIR(root, {
      branch: "fixture",
      commit: "commit-1",
      task: "inspect fixture",
      changes: [{ file: "src/file-0.js", action: "modify" }],
    });
    const serialized = serializeWorkflowIR(ir, "work");
    assert.match(serialized, /src\/file-0\.js/);
    assert.match(serialized, /fingerprint/);
    assert.match(serialized, /[a-f0-9]{16}/);
    assert.doesNotMatch(serialized, /implementation context/);
    assert.equal(serialized, serializeWorkflowIR(ir, "work"));
    assert.ok(serialized.length < 40000);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("canonical workflow context has explicit stage projections", () => {
  const root = makeFixture();
  try {
    const context = buildWorkflowIR(root, {
      task: "modify the target",
      intelligence: { summary: "facts", relevant_files: ["src/file-0.js"] },
      plan: { steps: [{ id: 1, action: "modify", file: "src/file-0.js", description: "change target" }] },
      changes: [{ file: "src/file-0.js", action: "modify" }],
      verification: { passed: true, exit_code: 0, status: "passed" },
      review: { verdict: "APPROVE", confidence: 0.9, summary: "good" },
    });
    attachFileExcerpts(context, root, 120);
    const intel = projectWorkflowContext(context, "intel");
    const plan = projectWorkflowContext(context, "plan");
    const work = projectWorkflowContext(context, "work");
    const review = projectWorkflowContext(context, "review");
    assert.ok(intel.files.length > 0);
    assert.equal(Object.prototype.hasOwnProperty.call(intel.files[0], "excerpt"), false);
    assert.equal(plan.intelligence.summary, "facts");
    assert.equal(work.files.length, 1);
    assert.equal(work.files[0].path, "src/file-0.js");
    assert.match(work.files[0].excerpt, /export const value/);
    assert.equal(review.verification.passed, true);
    assert.equal(review.review.verdict, "APPROVE");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("context benchmark reports full, compaction, and IR reductions", () => {
  const script = path.join(ROOT, "scripts", "context-budget-benchmark.mjs");
  const report = JSON.parse(execFileSync(process.execPath, [script], { encoding: "utf8" }));
  assert.equal(report.status, "deterministic_context_benchmark");
  assert.equal(report.synthetic, true);
  assert.equal(report.fixture.exceeds_default_compaction_budget, true);
  assert.ok(report.workflow_ir.total_chars < report.stage_compaction.total_chars);
  assert.ok(report.workflow_ir.estimated_tokens < report.stage_compaction.estimated_tokens);
  assert.ok(report.focused_retrieval.total_chars < report.stage_compaction.total_chars);
  assert.ok(report.focused_retrieval.selected_files.includes("src/module-000.js"));
  assert.equal(report.focused_retrieval.fallback_reason, null);
  assert.ok(report.reduction_vs_full_pct.focused_retrieval > report.reduction_vs_full_pct.stage_compaction);
  assert.ok(report.reduction_vs_full_pct.workflow_ir > report.reduction_vs_full_pct.stage_compaction);
});
