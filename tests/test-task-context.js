"use strict";

/**
 * The Extension offers "Attach file" / "Attach folder", which insert
 * `@file <path>` / `@folder <path>` markers into the task. The CLI used to pass
 * those markers through to the model as literal text it could not resolve, so
 * attaching a file silently did nothing. `expandTaskContext` now resolves them
 * against the repository before the task reaches the pipeline.
 *
 * These tests pin the safety envelope as much as the happy path: secrets are
 * redacted, binary files are skipped, oversized attachments are bounded, and a
 * marker can never read outside the repository.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { expandTaskContext, MAX_FOLDER_FILES } = require("../src/cli/commands/task-context");

function makeRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "minitok-task-context-"));
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  fs.writeFileSync(path.join(repo, "src", "a.js"), "const x = 1;\n");
  fs.writeFileSync(path.join(repo, "src", "b.js"), "module.exports = {};\n");
  return repo;
}

test("a task without markers is returned unchanged", () => {
  const repo = makeRepo();
  try {
    const result = expandTaskContext("Fix the login bug", repo);
    assert.equal(result.task, "Fix the login bug");
    assert.equal(result.expanded, 0);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test("@file inlines the file and redacts secrets", () => {
  const repo = makeRepo();
  try {
    fs.writeFileSync(path.join(repo, "secret.js"), 'const apiKey = "sk-live-abcdef123456";\n');
    const result = expandTaskContext("Review @file secret.js", repo);
    assert.equal(result.expanded, 1);
    assert.match(result.task, /### Attached file: secret\.js/);
    assert.match(result.task, /\[REDACTED\]/);
    assert.doesNotMatch(result.task, /sk-live-abcdef123456/);
    assert.match(result.task, /\[End attached context\]/);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test("@folder expands to a manifest plus contents", () => {
  const repo = makeRepo();
  try {
    const result = expandTaskContext("Review @folder src", repo);
    assert.equal(result.expanded, 1);
    assert.match(result.task, /### Attached folder: src/);
    assert.match(result.task, /- src\/a\.js/);
    assert.match(result.task, /module\.exports = \{\}/);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test("binary and missing files are skipped, not inlined", () => {
  const repo = makeRepo();
  try {
    fs.writeFileSync(path.join(repo, "blob.bin"), Buffer.from([0, 1, 2, 3]));
    const result = expandTaskContext("@file blob.bin @file missing.js", repo);
    assert.equal(result.skipped, 2);
    assert.match(result.task, /binary file/);
    assert.match(result.task, /could not read/);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test("a marker cannot escape the repository root", () => {
  const repo = makeRepo();
  try {
    const result = expandTaskContext("@file ../../etc/passwd", repo);
    assert.match(result.task, /escapes the repository/);
    assert.equal(result.expanded, 0);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test("folder expansion is bounded by the file cap", () => {
  const repo = makeRepo();
  try {
    for (let i = 0; i < MAX_FOLDER_FILES + 20; i += 1) {
      fs.writeFileSync(path.join(repo, "src", `gen${i}.js`), `// ${i}\n`);
    }
    const result = expandTaskContext("@folder src", repo);
    const listed = (result.task.match(/^- src\//gm) || []).length;
    assert.ok(listed <= MAX_FOLDER_FILES, `expected <= ${MAX_FOLDER_FILES} listed files, got ${listed}`);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test("node_modules is not walked when expanding a folder", () => {
  const repo = makeRepo();
  try {
    fs.mkdirSync(path.join(repo, "node_modules", "dep"), { recursive: true });
    fs.writeFileSync(path.join(repo, "node_modules", "dep", "index.js"), "// dep\n");
    const result = expandTaskContext("@folder .", repo);
    assert.doesNotMatch(result.task, /node_modules/);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});