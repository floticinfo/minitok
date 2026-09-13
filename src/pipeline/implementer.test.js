"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { applyChanges, temporaryWritePath } = require("./implementer");

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mt-implementer-"));
}

describe("implementer: change application", () => {
  it("records an overwrite when create replaces an existing file", () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "a.txt"), "original");
    const result = applyChanges(dir, { changes: [{ file: "a.txt", action: "create", content: "replaced" }] }, false, { auditPath: path.join(dir, "audit.jsonl") });
    assert.equal(result.applied, 1);
    assert.equal(fs.readFileSync(path.join(dir, "a.txt"), "utf8"), "replaced");
    assert.ok(result.audit.warnings.some(warning => warning.includes("Overwrote existing file: a.txt")), "overwrite is reported");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("stays quiet when create adds a new file", () => {
    const dir = tmpDir();
    const result = applyChanges(dir, { changes: [{ file: "new.txt", action: "create", content: "fresh" }] }, false, { auditPath: path.join(dir, "audit.jsonl") });
    assert.equal(result.applied, 1);
    assert.equal(result.audit.warnings.some(warning => warning.includes("Overwrote")), false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("never reuses a temporary write path", () => {
    const target = path.join(os.tmpdir(), "mt-implementer-temp", "file.js");
    const names = new Set();
    for (let i = 0; i < 200; i += 1) names.add(temporaryWritePath(target));
    assert.equal(names.size, 200);
    for (const name of names) assert.ok(name.startsWith(`${target}.tmp.${process.pid}.`));
  });
});
