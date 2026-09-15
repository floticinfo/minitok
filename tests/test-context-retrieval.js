"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { buildFocusedContext, lineRangesFor } = require("../src/context/retrieval");
const { loadConfig, validateConfig } = require("../src/config/loader");

function tempRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "minitok-retrieval-"));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "auth.js"), [
    "import tokenStore from './token-store.js';",
    "",
    "export function refreshToken(value) {",
    "  return tokenStore.rotate(value);",
    "}",
    ...Array.from({ length: 80 }, (_, index) => `const unrelatedAuthLine${index} = ${index};`),
  ].join("\n"));
  fs.writeFileSync(path.join(root, "src", "token-store.js"), "export function rotate(value) { return value; }\n");
  fs.writeFileSync(path.join(root, "src", "unrelated.js"), "export function billing() { return true; }\n");
  return root;
}

test("focused retrieval selects task files and preserves relevant ranges", () => {
  const root = tempRepo();
  try {
    const base = `Repository: ${root}\n\n--- package.json ---\n${"x".repeat(500)}\n`;
    const result = buildFocusedContext(root, { base_context: base, task: "Fix refreshToken in src/auth.js", max_files: 2, max_file_chars: 500, max_total_chars: 3000 });
    assert.deepEqual(result.selected_files, ["src/auth.js", "src/token-store.js"]);
    assert.equal(result.fallback_reason, null);
    assert.match(result.text, /src\/auth\.js lines/);
    assert.match(result.text, /refreshToken/);
    assert.doesNotMatch(result.text, /billing/);
    fs.writeFileSync(path.join(root, "src", "unrelated-00.js"), "export const billing = true;\n".repeat(100));
    const withUnrelated = buildFocusedContext(root, { base_context: base, task: "Fix refreshToken in src/auth.js", protected_paths: ["VERIFY_CMD.mjs"], max_files: 12, max_file_chars: 500, max_total_chars: 3000 });
    assert.deepEqual(withUnrelated.selected_files, ["src/auth.js", "src/token-store.js"]);
    assert.doesNotMatch(withUnrelated.text, /unrelated-00/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("focused retrieval falls back when no source file is relevant", () => {
  const root = tempRepo();
  try {
    const base = `Repository: ${root}\nfull context\n`;
    const result = buildFocusedContext(root, { base_context: base, task: "Update database migration", max_files: 2 });
    assert.equal(result.text, base);
    assert.equal(result.selected_files.length, 0);
    assert.equal(result.fallback_reason, "no_relevant_source_files");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("long source files are represented by bounded relevant ranges", () => {
  const content = ["import x from 'x';", ...Array.from({ length: 200 }, (_, index) => index === 100 ? "export function target() { return true; }" : `const line${index} = ${index};`)].join("\n");
  const ranges = lineRangesFor(content, ["target"], 500);
  assert.ok(ranges.length >= 1);
  assert.ok(ranges.every(range => range.text.length <= 500));
  assert.ok(ranges.some(range => /target/.test(range.text)));
});

test("focused retrieval config has safe defaults and validation", () => {
  const config = loadConfig(path.join(os.tmpdir(), "minitok-retrieval-config-does-not-exist.yml"));
  assert.equal(config.execution.context_retrieval, "focused");
  assert.equal(config.execution.context_retrieval_min_savings_ratio, 0.1);
  assert.throws(() => validateConfig({ execution: { context_retrieval: "semantic" } }), /context_retrieval must be/);
  assert.throws(() => validateConfig({ execution: { context_retrieval_max_files: 0 } }), /must be a positive number/);
});
