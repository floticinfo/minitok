"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { fileHash } = require("../src/pipeline/edit-ir");
const { tokenize, parseDsl, validateDslAst, compileDslToEditIr, executeDsl, DslSyntaxError, DslValidationError } = require("../src/pipeline/dsl");

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "minitok-dsl-"));
  fs.writeFileSync(path.join(root, "VERIFY_CMD.mjs"), "process.exit(0);\n");
  fs.writeFileSync(path.join(root, "a.js"), "const a = 1;\nconst b = 2;\n");
  return root;
}

const source = `task "Change values" {
  target file "a.js"
  operation replace_exact {
    before "const a = 1;"
    after "const a = 3;"
  }
  verify command "VERIFY_CMD.mjs"
}`;

test("DSL tokenizer and parser produce a typed task AST", () => {
  const ast = parseDsl(source);
  assert.equal(parseDsl(`# comment\n${source.replace("verify command", "// inline comment\n  verify command")}`).description, "Change values");
  assert.equal(tokenize(source).at(-1).type, "eof");
  assert.equal(ast.description, "Change values");
  assert.equal(ast.targets[0].operations[0].kind, "replace_exact");
  assert.equal(ast.verification.path, "VERIFY_CMD.mjs");
});

test("DSL rejects unknown syntax, missing verification, and traversal", () => {
  assert.throws(() => parseDsl('task "x" { nope "y" }'), DslSyntaxError);
  assert.throws(() => validateDslAst(parseDsl('task "x" { target file "a.js" operation replace_exact { before "a" after "b" } }')), /verify command/);
  assert.throws(() => validateDslAst(parseDsl(source.replace('"a.js"', '"../a.js"'))), DslValidationError);
});

test("DSL compiles exact edits to Compact Edit IR v2 with a current hash", () => {
  const root = fixture();
  try {
    const compiled = compileDslToEditIr(root, parseDsl(source));
    assert.equal(compiled.v, 2);
    assert.equal(compiled.changes[0].f, "f0");
    assert.equal(compiled.changes[0].h, fileHash("const a = 1;\nconst b = 2;\n"));
    assert.deepEqual(compiled.changes[0].e[0], { k: "x", b: "const a = 1;", a: "const a = 3;" });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("DSL supports new files and rejects protected verification targets before writing", () => {
  const root = fixture();
  const create = `task "Create" { target file "new.js" operation create { content "export const ok = true;" } verify command "VERIFY_CMD.mjs" }`;
  try {
    const compiled = compileDslToEditIr(root, parseDsl(create));
    assert.equal(compiled.changes[0].action, "create");
    const protectedDsl = create.replace("new.js", "VERIFY_CMD.mjs");
    assert.throws(() => compileDslToEditIr(root, parseDsl(protectedDsl)), DslValidationError);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("DSL execution applies edits and runs the repository verification gate", async () => {
  const root = fixture();
  try {
    const result = await executeDsl(root, source, { dryRun: false });
    assert.equal(result.success, true);
    assert.equal(result.verification_result.passed, true);
    assert.equal(fs.readFileSync(path.join(root, "a.js"), "utf8"), "const a = 3;\nconst b = 2;\n");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("DSL rejects a stale hash through the existing Edit IR expansion gate", () => {
  const root = fixture();
  try {
    const compiled = compileDslToEditIr(root, parseDsl(source));
    fs.writeFileSync(path.join(root, "a.js"), "changed\n");
    const { expandEditChanges, decodeEditChanges } = require("../src/pipeline/edit-ir");
    const expanded = expandEditChanges(root, decodeEditChanges({ changes: compiled.changes }, compiled.manifest));
    assert.match(expanded.error, /before_hash/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
