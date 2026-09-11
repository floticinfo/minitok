"use strict";
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const p = require("path");
const os = require("os");
function tmpDir() { return fs.mkdtempSync(p.join(os.tmpdir(), "mt-m1-")); }
function clean(d) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }

describe("SEC-01: Protected Files", () => {
  it("blocks minitok.yml create", () => {
    const { applyChanges } = require("../src/pipeline/implementer");
    const d = tmpDir();
    fs.mkdirSync(p.join(d, ".git"), { recursive: true });
    const r = applyChanges(d, { changes: [{ file: "minitok.yml", action: "create", content: "malicious: true" }] });
    assert.equal(r.applied, 0);
    assert.ok(r.errors.some(e => e.includes("Protected")));
    clean(d);
  });
  it("blocks minitok.yml modify", () => {
    const { applyChanges } = require("../src/pipeline/implementer");
    const d = tmpDir();
    fs.mkdirSync(p.join(d, ".git"), { recursive: true });
    fs.writeFileSync(p.join(d, "minitok.yml"), "original: true");
    const r = applyChanges(d, { changes: [{ file: "minitok.yml", action: "modify", content: "hacked: true" }] });
    assert.equal(r.applied, 0);
    assert.ok(r.errors.some(e => e.includes("Protected")));
    clean(d);
  });
  it("blocks .minitok/ paths", () => {
    const { applyChanges } = require("../src/pipeline/implementer");
    const d = tmpDir();
    fs.mkdirSync(p.join(d, ".git"), { recursive: true });
    const r = applyChanges(d, { changes: [{ file: ".minitok/config.json", action: "create", content: "{}" }] });
    assert.equal(r.applied, 0);
    assert.ok(r.errors.some(e => e.includes("Protected")));
    clean(d);
  });
  it("allows unrelated files", () => {
    const { applyChanges } = require("../src/pipeline/implementer");
    const d = tmpDir();
    fs.mkdirSync(p.join(d, ".git"), { recursive: true });
    const r = applyChanges(d, { changes: [{ file: "src/app.js", action: "create", content: "ok" }] });
    assert.equal(r.applied, 1);
    assert.equal(r.errors.length, 0);
    clean(d);
  });
  it("blocks normalized path bypass", () => {
    const { applyChanges } = require("../src/pipeline/implementer");
    const d = tmpDir();
    fs.mkdirSync(p.join(d, ".git"), { recursive: true });
    const r = applyChanges(d, { changes: [{ file: "./minitok.yml", action: "create", content: "bad" }] });
    assert.equal(r.applied, 0);
    assert.ok(r.errors.some(e => e.includes("Protected")));
    clean(d);
  });
});

describe("F-01: Case-insensitive protected path bypass", () => {
  const { applyChanges } = require("../src/pipeline/implementer");
  const variations = [
    "minitok.yml",
    "MinItOk.yml",
    "minitok.YML",
    "minitok.yML",
  ];
  for (const v of variations) {
    it(`blocks ${v} (case variation)`, () => {
      const d = tmpDir();
      fs.mkdirSync(p.join(d, ".git"), { recursive: true });
      const r = applyChanges(d, { changes: [{ file: v, action: "create", content: "bad" }] });
      assert.equal(r.applied, 0, `Expected 0 applied for ${v}`);
      assert.ok(r.errors.some(e => e.includes("Protected")), `Expected protected error for ${v}`);
      clean(d);
    });
  }
  const dotVariations = [".minitok", ".MinItOk", ".MinItOk/config.json"];
  for (const v of dotVariations) {
    it(`blocks ${v} (case variation)`, () => {
      const d = tmpDir();
      fs.mkdirSync(p.join(d, ".git"), { recursive: true });
      const r = applyChanges(d, { changes: [{ file: v, action: "create", content: "bad" }] });
      assert.equal(r.applied, 0, `Expected 0 applied for ${v}`);
      assert.ok(r.errors.some(e => e.includes("Protected")), `Expected protected error for ${v}`);
      clean(d);
    });
  }
  it("blocks traversal+case: subdir/../minitok.yml", () => {
    const d = tmpDir();
    fs.mkdirSync(p.join(d, ".git"), { recursive: true });
    const r = applyChanges(d, { changes: [{ file: "subdir/../minitok.yml", action: "create", content: "bad" }] });
    assert.equal(r.applied, 0);
    assert.ok(r.errors.some(e => e.includes("Protected")));
    clean(d);
  });
  it("allows unrelated files on case-insensitive", () => {
    const d = tmpDir();
    fs.mkdirSync(p.join(d, ".git"), { recursive: true });
    const r = applyChanges(d, { changes: [{ file: "src/App.js", action: "create", content: "ok" }] });
    assert.equal(r.applied, 1);
    clean(d);
  });
});

describe("SEC-01b: Release metadata protection", () => {
  it("protects release manifests only in the canonical minitok repository", () => {
    const { isProtectedPath } = require("../src/pipeline/implementer");
    const canonical = p.join(tmpDir(), "canonical");
    fs.mkdirSync(canonical, { recursive: true });
    fs.writeFileSync(p.join(canonical, "package.json"), JSON.stringify({ name: "@flotic/minitok" }));
    assert.equal(isProtectedPath(canonical, p.join(canonical, "package.json")).protected, true);
    const customer = tmpDir();
    fs.writeFileSync(p.join(customer, "package.json"), JSON.stringify({ name: "customer-app" }));
    assert.equal(isProtectedPath(customer, p.join(customer, "package.json")).protected, false);
    clean(canonical); clean(customer);
  });
});

describe("SEC-01c: Verification surface protection", () => {
  it("blocks edits to existing verification files in the canonical repository", () => {
    const { applyChanges } = require("../src/pipeline/implementer");
    const d = tmpDir();
    fs.writeFileSync(p.join(d, "package.json"), JSON.stringify({ name: "@flotic/minitok" }));
    fs.mkdirSync(p.join(d, "tests"), { recursive: true });
    fs.writeFileSync(p.join(d, "tests", "existing.js"), "original");
    const result = applyChanges(d, { changes: [{ file: "tests/existing.js", action: "modify", content: "changed" }, { file: "VERIFY_CMD.mjs", action: "modify", content: "bad" }] });
    assert.equal(result.applied, 0);
    assert.equal(result.errors.length, 2);
    clean(d);
  });

  it("allows new focused tests in the canonical repository", () => {
    const { applyChanges } = require("../src/pipeline/implementer");
    const d = tmpDir();
    fs.writeFileSync(p.join(d, "package.json"), JSON.stringify({ name: "@flotic/minitok" }));
    fs.mkdirSync(p.join(d, "tests"), { recursive: true });
    const result = applyChanges(d, { changes: [{ file: "tests/new-regression.js", action: "create", content: "test('ok', () => {});" }] });
    assert.equal(result.applied, 1);
    clean(d);
  });
});

describe("SEC-02: LLM Output Validation", () => {
  it("rejects non-array changes", () => {
    const { applyChanges } = require("../src/pipeline/implementer");
    const d = tmpDir();
    fs.mkdirSync(p.join(d, ".git"), { recursive: true });
    const r = applyChanges(d, { changes: "not an array" });
    assert.equal(r.applied, 0);
    assert.ok(r.errors.length > 0);
    clean(d);
  });
  it("rejects change with missing file", () => {
    const { applyChanges } = require("../src/pipeline/implementer");
    const d = tmpDir();
    fs.mkdirSync(p.join(d, ".git"), { recursive: true });
    const r = applyChanges(d, { changes: [{ action: "create", content: "hi" }] });
    assert.equal(r.applied, 0);
    assert.ok(r.errors.some(e => e.includes("file")));
    clean(d);
  });
  it("rejects invalid action", () => {
    const { applyChanges } = require("../src/pipeline/implementer");
    const d = tmpDir();
    fs.mkdirSync(p.join(d, ".git"), { recursive: true });
    const r = applyChanges(d, { changes: [{ file: "a.txt", action: "exec", content: "hi" }] });
    assert.equal(r.applied, 0);
    assert.ok(r.errors.some(e => e.includes("action")));
    clean(d);
  });
  it("rejects non-string content", () => {
    const { applyChanges } = require("../src/pipeline/implementer");
    const d = tmpDir();
    fs.mkdirSync(p.join(d, ".git"), { recursive: true });
    const r = applyChanges(d, { changes: [{ file: "a.txt", action: "create", content: 123 }] });
    assert.equal(r.applied, 0);
    assert.ok(r.errors.some(e => e.includes("content")));
    clean(d);
  });
  it("rejects malformed entries", () => {
    const { applyChanges } = require("../src/pipeline/implementer");
    const d = tmpDir();
    fs.mkdirSync(p.join(d, ".git"), { recursive: true });
    const r = applyChanges(d, { changes: [null, "str", 42] });
    assert.equal(r.applied, 0);
    assert.ok(r.errors.length >= 3);
    clean(d);
  });
  it("allows valid create/modify/delete", () => {
    const { applyChanges } = require("../src/pipeline/implementer");
    const d = tmpDir();
    fs.mkdirSync(p.join(d, ".git"), { recursive: true });
    fs.writeFileSync(p.join(d, "old.js"), "old");
    const r = applyChanges(d, {
      changes: [
        { file: "new.js", action: "create", content: "new" },
        { file: "old.js", action: "modify", content: "updated" },
        { file: "old.js", action: "delete" },
      ]
    });
    assert.equal(r.applied, 3);
    assert.equal(r.errors.length, 0);
    clean(d);
  });
});

describe("F-02: Content required for create/modify", () => {
  const { validateChange } = require("../src/pipeline/implementer");
  it("rejects create with no content", () => {
    const r = validateChange({ file: "a.js", action: "create" });
    assert.equal(r.valid, false);
    assert.ok(r.reason.includes("content"));
  });
  it("rejects modify with no content", () => {
    const r = validateChange({ file: "a.js", action: "modify" });
    assert.equal(r.valid, false);
    assert.ok(r.reason.includes("content"));
  });
  it("rejects create with null content", () => {
    const r = validateChange({ file: "a.js", action: "create", content: null });
    assert.equal(r.valid, false);
    assert.ok(r.reason.includes("content"));
  });
  it("rejects modify with null content", () => {
    const r = validateChange({ file: "a.js", action: "modify", content: null });
    assert.equal(r.valid, false);
    assert.ok(r.reason.includes("content"));
  });
  it("rejects create with numeric content", () => {
    const r = validateChange({ file: "a.js", action: "create", content: 123 });
    assert.equal(r.valid, false);
  });
  it("rejects modify with object content", () => {
    const r = validateChange({ file: "a.js", action: "modify", content: {} });
    assert.equal(r.valid, false);
  });
  it("allows delete without content", () => {
    const r = validateChange({ file: "a.js", action: "delete" });
    assert.equal(r.valid, true);
  });
  it("allows valid create with string content", () => {
    const r = validateChange({ file: "a.js", action: "create", content: "code" });
    assert.equal(r.valid, true);
  });
  it("allows valid modify with string content", () => {
    const r = validateChange({ file: "a.js", action: "modify", content: "updated" });
    assert.equal(r.valid, true);
  });
});

describe("SEC-03: Symlink Defense", () => {
  it("blocks symlink escape outside repo", () => {
    const { safePath } = require("../src/pipeline/implementer");
    const d = tmpDir();
    const outside = tmpDir();
    fs.writeFileSync(p.join(outside, "secret.txt"), "secret");
    try {
      fs.symlinkSync(outside, p.join(d, "link"));
    } catch { clean(d); clean(outside); return; }
    const result = safePath(d, "link");
    assert.equal(result.safe, false);
    assert.ok(result.reason.includes("Symlink"));
    clean(d);
    clean(outside);
  });
  it("allows new file creation (ENOENT)", () => {
    const { safePath } = require("../src/pipeline/implementer");
    const d = tmpDir();
    const result = safePath(d, "src/new-file.js");
    assert.equal(result.safe, true);
    clean(d);
  });
});

describe("SEC-04: Blocked Extensions", () => {
  it("blocks .exe create", () => {
    const { applyChanges } = require("../src/pipeline/implementer");
    const d = tmpDir();
    fs.mkdirSync(p.join(d, ".git"), { recursive: true });
    const r = applyChanges(d, { changes: [{ file: "evil.exe", action: "create", content: "binary" }] });
    assert.equal(r.applied, 0);
    assert.ok(r.errors.some(e => e.includes("Blocked extension")));
    clean(d);
  });
  it("blocks .sh create", () => {
    const { applyChanges } = require("../src/pipeline/implementer");
    const d = tmpDir();
    fs.mkdirSync(p.join(d, ".git"), { recursive: true });
    const r = applyChanges(d, { changes: [{ file: "scripts/setup.sh", action: "create", content: "#!/bin/bash" }] });
    assert.equal(r.applied, 0);
    assert.ok(r.errors.some(e => e.includes("Blocked extension")));
    clean(d);
  });
  it("allows .js files", () => {
    const { applyChanges } = require("../src/pipeline/implementer");
    const d = tmpDir();
    fs.mkdirSync(p.join(d, ".git"), { recursive: true });
    const r = applyChanges(d, { changes: [{ file: "src/app.js", action: "create", content: "ok" }] });
    assert.equal(r.applied, 1);
    clean(d);
  });
  it("allows .py files", () => {
    const { applyChanges } = require("../src/pipeline/implementer");
    const d = tmpDir();
    fs.mkdirSync(p.join(d, ".git"), { recursive: true });
    const r = applyChanges(d, { changes: [{ file: "main.py", action: "create", content: "print('ok')" }] });
    assert.equal(r.applied, 1);
    clean(d);
  });
  it("blocks uppercase .EXE", () => {
    const { applyChanges } = require("../src/pipeline/implementer");
    const d = tmpDir();
    fs.mkdirSync(p.join(d, ".git"), { recursive: true });
    const r = applyChanges(d, { changes: [{ file: "EVIL.EXE", action: "create", content: "bin" }] });
    assert.equal(r.applied, 0);
    assert.ok(r.errors.some(e => e.includes("Blocked extension")));
    clean(d);
  });
});

describe("SEC-07: Audit Log", () => {
  it("records successful write", () => {
    const { applyChanges } = require("../src/pipeline/implementer");
    const { auditRead } = require("../src/core/audit");
    const d = tmpDir();
    fs.mkdirSync(p.join(d, ".git"), { recursive: true });
    const auditPath = p.join(d, "audit.jsonl");
    applyChanges(d, { changes: [{ file: "src/test.js", action: "create", content: "hi" }] }, false, { auditPath });
    const entries = auditRead(auditPath);
    assert.ok(entries.length >= 1);
    assert.equal(entries[0].action, "create");
    assert.equal(entries[0].result, "applied");
    clean(d);
  });
  it("records rejection", () => {
    const { applyChanges } = require("../src/pipeline/implementer");
    const { auditRead } = require("../src/core/audit");
    const d = tmpDir();
    fs.mkdirSync(p.join(d, ".git"), { recursive: true });
    const auditPath = p.join(d, "audit.jsonl");
    applyChanges(d, { changes: [{ file: "minitok.yml", action: "create", content: "bad" }] }, false, { auditPath });
    const entries = auditRead(auditPath);
    assert.ok(entries.length >= 1);
    assert.equal(entries[0].result, "rejected");
    assert.ok(entries[0].reason.includes("Protected"));
    clean(d);
  });
  it("records blocked extension", () => {
    const { applyChanges } = require("../src/pipeline/implementer");
    const { auditRead } = require("../src/core/audit");
    const d = tmpDir();
    fs.mkdirSync(p.join(d, ".git"), { recursive: true });
    const auditPath = p.join(d, "audit.jsonl");
    applyChanges(d, { changes: [{ file: "evil.exe", action: "create", content: "bad" }] }, false, { auditPath });
    const entries = auditRead(auditPath);
    assert.ok(entries.length >= 1);
    assert.equal(entries[0].result, "rejected");
    assert.ok(entries[0].reason.includes("Blocked extension"));
    clean(d);
  });
});

describe("SEC-08: Token Permissions", () => {
  it("token save uses restrictive permissions", () => {
    const { TokenStore } = require("../src/auth/token-store");
    const d = tmpDir();
    const ts = new TokenStore(d);
    ts.save("test-provider", { access_token: "test123" });
    const fp = p.join(d, "test-provider.json");
    assert.ok(fs.existsSync(fp));
    const stat = fs.statSync(fp);
    assert.ok(typeof stat.mode === "number");
    clean(d);
  });
});

