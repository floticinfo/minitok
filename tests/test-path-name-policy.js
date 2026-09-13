"use strict";

/**
 * Regression coverage for the path-name policy.
 *
 * The policy compares names as strings, so a name that only differs by characters
 * the operating system strips used to pass both the protected-path and the
 * blocked-extension check and was written as a near-miss file (`minitok.yml.`,
 * `evil.ps1 `). On a volume where trailing-dot normalization or 8.3 aliases are
 * active the same input lands on the real file, which would let a change set
 * overwrite the protected `minitok.yml` or the verification gate.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const { applyChanges, safePath, isProtectedPath, isBlockedExtension, unsafeFileNameReason, validateChange } = require(path.join(ROOT, "src", "pipeline", "implementer.js"));

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "minitok-pathname-"));
  fs.writeFileSync(path.join(dir, "minitok.yml"), "ORIGINAL\n");
  fs.writeFileSync(path.join(dir, "VERIFY_CMD.mjs"), "process.exit(0);\n");
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "@flotic/minitok" }));
  return dir;
}

test("rejects names the filesystem would normalize into a different file", () => {
  const rejected = [
    ["minitok.yml.", /dot or a space/],
    ["minitok.yml ", /dot or a space/],
    ["VERIFY_CMD.mjs.", /dot or a space/],
    ["evil.ps1.", /dot or a space/],
    ["evil.ps1 ", /dot or a space/],
    ["evil.ps1:hidden", /must not contain/],
    ["dir/evil.ps1:stream", /must not contain/],
    ["NUL", /reserved device name/],
    ["con.txt", /reserved device name/],
    ["src/COM1", /reserved device name/],
    ["bad\u0000name.js", /must not contain/],
  ];
  for (const [file, pattern] of rejected) {
    const result = validateChange({ file, action: "create", content: "x\n" });
    assert.equal(result.valid, false, `${JSON.stringify(file)} must be rejected`);
    assert.match(result.reason, pattern, `reason for ${JSON.stringify(file)}`);
  }
});

test("accepts ordinary repository paths", () => {
  for (const file of ["src/a.js", "README.md", ".env.example", "dir.with.dots/file.js", "file-name_test.js", "docs/2.0/guide.md", "src/utils/temp-cleanup.js"]) {
    assert.equal(validateChange({ file, action: "create", content: "x\n" }).valid, true, `${file} must be accepted`);
    assert.equal(unsafeFileNameReason(file), null);
  }
});

test("Windows-only 8.3 short names are rejected on Windows", () => {
  const reason = unsafeFileNameReason("MINITO~1.YML");
  if (process.platform === "win32") assert.match(reason, /8\.3 short name/);
  else assert.equal(reason, null, "a name containing ~1 is an ordinary file on POSIX");
});

test("a near-miss protected name is still recognized as protected", () => {
  const dir = sandbox();
  try {
    assert.equal(isProtectedPath(dir, path.join(dir, "minitok.yml")).protected, true);
    assert.equal(isProtectedPath(dir, path.join(dir, "minitok.yml.")).protected, true);
    assert.equal(isProtectedPath(dir, path.join(dir, "minitok.yml ")).protected, true);
    assert.equal(isBlockedExtension(path.join(dir, "evil.ps1."), [".ps1"]).blocked, true);
    assert.equal(isBlockedExtension(path.join(dir, "evil.ps1 "), [".ps1"]).blocked, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("applyChanges refuses the bypass instead of writing a near-miss file", () => {
  const dir = sandbox();
  try {
    const result = applyChanges(dir, { changes: [
      { file: "minitok.yml.", action: "create", content: "PWNED\n" },
      { file: "evil.ps1.", action: "create", content: "PWNED\n" },
      { file: "evil.ps1:hidden", action: "create", content: "PWNED\n" },
      { file: "ok.js", action: "create", content: "module.exports = 1;\n" },
    ] }, false, { auditPath: path.join(dir, ".minitok-audit.jsonl") });
    // Validation is all-or-nothing, so a change set that carries an unusable name
    // is refused as a whole rather than partially applied.
    assert.equal(result.applied, 0, "nothing from a suspicious change set is written");
    assert.equal(result.errors.length, 3);
    for (const reason of result.errors) assert.match(reason, /dot or a space|must not contain/);
    assert.equal(fs.readFileSync(path.join(dir, "minitok.yml"), "utf8"), "ORIGINAL\n", "the protected file is untouched");
    assert.equal(fs.existsSync(path.join(dir, "minitok.yml.")), false);
    assert.equal(fs.existsSync(path.join(dir, "evil.ps1.")), false);
    assert.equal(fs.existsSync(path.join(dir, "evil.ps1")), false, "no 0-byte base file is left behind");
    assert.equal(fs.existsSync(path.join(dir, "ok.js")), false);

    // An ordinary change set is unaffected.
    const clean = applyChanges(dir, { changes: [{ file: "ok.js", action: "create", content: "module.exports = 1;\n" }] }, false, { auditPath: path.join(dir, ".minitok-audit.jsonl") });
    assert.equal(clean.applied, 1);
    assert.equal(fs.readFileSync(path.join(dir, "ok.js"), "utf8"), "module.exports = 1;\n");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("safePath reports the name rejection before any policy check", () => {
  const dir = sandbox();
  try {
    const result = safePath(dir, "minitok.yml.");
    assert.equal(result.safe, false);
    assert.match(result.reason, /dot or a space/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
