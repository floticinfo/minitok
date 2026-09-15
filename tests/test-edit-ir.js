"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { fileHash, buildEditManifest, serializeEditManifest, decodeEditChanges, applyEditList, expandEditChanges } = require("../src/pipeline/edit-ir");
const { chooseEditRepresentation } = require("../src/pipeline/edit-policy");

test("adaptive edit policy avoids IR overhead for small and new-file changes", () => {
  assert.deepEqual(chooseEditRepresentation({ requested: "adaptive", optimization_allowed: true, files: [{ action: "modify", bytes: 200 }] }), { representation: "full_file", reason: "small_single_file" });
  assert.deepEqual(chooseEditRepresentation({ requested: "adaptive", optimization_allowed: true, files: [{ action: "create", bytes: 0 }] }), { representation: "full_file", reason: "new_or_deleted_file" });
  assert.deepEqual(chooseEditRepresentation({ requested: "adaptive", optimization_allowed: true, files: [{ action: "modify", bytes: 5000 }] }), { representation: "edit_ir", reason: "large_existing_file" });
  assert.deepEqual(chooseEditRepresentation({ requested: "adaptive", optimization_allowed: true, files: [{ action: "modify", bytes: 200 }, { action: "modify", bytes: 200 }] }), { representation: "edit_ir", reason: "multi_file_change" });
  assert.deepEqual(chooseEditRepresentation({ requested: "edit_ir", optimization_allowed: true, files: [{ action: "modify", bytes: 200 }] }), { representation: "edit_ir", reason: "explicit_edit_ir" });
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "minitok-edit-ir-"));
  fs.writeFileSync(path.join(root, "a.js"), "const a = 1;\nconst b = 2;\n");
  return root;
}

test("edit IR applies an exact block only once", () => {
  const result = applyEditList("const a = 1;\nconst b = 2;\n", [{ kind: "replace_exact", before: "const a = 1;", after: "const a = 3;" }], "a.js");
  assert.equal(result, "const a = 3;\nconst b = 2;\n");
});

test("edit IR rejects ambiguous exact blocks", () => {
  assert.throws(() => applyEditList("x\nx\n", [{ before: "x", after: "y" }], "a.js"), /matched more than once/);
});

test("compact Edit IR v2 uses file IDs and decodes short edit aliases", () => {
  const root = fixture();
  try {
    const before = fs.readFileSync(path.join(root, "a.js"), "utf8");
    const manifest = buildEditManifest(root, ["a.js"]);
    assert.equal(manifest.files[0].id, "f0");
    assert.match(serializeEditManifest(manifest), /"id":"f0"/);
    const decoded = decodeEditChanges({ changes: [{ f: "f0", h: fileHash(before), e: [{ k: "x", b: "const b = 2;", a: "const b = 4;" }] }] }, manifest);
    const expanded = expandEditChanges(root, decoded);
    assert.equal(expanded.error, undefined);
    assert.equal(expanded.changes[0].content, "const a = 1;\nconst b = 4;\n");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("edit IR enforces before_hash and expands to a safe full content change", () => {
  const root = fixture();
  try {
    const before = fs.readFileSync(path.join(root, "a.js"), "utf8");
    const expanded = expandEditChanges(root, { changes: [{ file: "a.js", action: "modify", before_hash: fileHash(before), edits: [{ before: "const b = 2;", after: "const b = 4;" }] }] });
    assert.equal(expanded.error, undefined);
    assert.equal(expanded.changes[0].content, "const a = 1;\nconst b = 4;\n");
    assert.equal(expanded.changes[0].edits, undefined);
    const rejected = expandEditChanges(root, { changes: [{ file: "a.js", action: "modify", before_hash: "wrong", edits: [{ before: "const b = 2;", after: "const b = 4;" }] }] });
    assert.match(rejected.error, /before_hash/);
    const missingHash = expandEditChanges(root, { changes: [{ file: "a.js", action: "modify", edits: [{ before: "const b = 2;", after: "const b = 4;" }] }] });
    assert.match(missingHash.error, /requires a full 64-character/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
