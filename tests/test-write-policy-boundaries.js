"use strict";

/**
 * Boundary coverage for the autonomous write policy.
 *
 * The existing tests asserted that `minitok.yml` and `.minitok/` are protected,
 * which is true and was also the entire list. A customer repository therefore
 * allowed the pipeline to overwrite `.env`, install a git hook, edit a CI
 * workflow, or rewrite the very verification gate that judges the change. The old
 * rule also matched extensions (`path.extname(".env") === ""`), so the documented
 * `security.blocked_extensions: [".env"]` never matched a file called `.env`, and
 * the truncation guard that should stop a shortened file did not exist at all.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { applyChanges, isProtectedPath, sensitiveFileNameReason, suspiciousShrinkReason, SHRINK_GUARD_MIN_BYTES } = require("../src/pipeline/implementer");

/** A customer repository: not the canonical minitok release repository. */
function customerRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "minitok-write-policy-"));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "customer-app" }));
  return root;
}

function write(repo, file, content, action = "create", options = {}) {
  return applyChanges(repo, { changes: [{ file, action, content }] }, false, options);
}

test("credential files are protected by name, not by extension", () => {
  const names = [".env", ".env.local", ".env.production", "config/.env", ".envrc", "id_rsa", "id_ed25519", "secrets.pem", "service.key", "bundle.p12", "client.pfx", ".npmrc", ".yarnrc", ".netrc", "credentials.json", ".git-credentials"];
  for (const name of names) {
    assert.equal(sensitiveFileNameReason(name), `Sensitive file is protected from autonomous writes: ${path.basename(name)}`, `${name} must be recognized as sensitive`);
  }
});

test("committed env templates stay writable", () => {
  for (const name of [".env.example", ".env.sample", ".env.template", ".env.dist"]) {
    assert.equal(sensitiveFileNameReason(name), null, `${name} holds no secret and must stay writable`);
  }
  assert.equal(sensitiveFileNameReason("src/config.js"), null);
});

test("the pipeline refuses to write credential and execution-path files", () => {
  const repo = customerRepo();
  try {
    const targets = [
      ".env",
      ".env.local",
      "config/.env",
      "id_rsa",
      "secrets.pem",
      ".npmrc",
      ".git/hooks/pre-commit",
      ".git/config",
      ".github/workflows/deploy.yml",
      ".husky/pre-commit",
      ".gitlab-ci.yml",
    ];
    for (const target of targets) {
      const result = write(repo, target, "attacker controlled\n");
      assert.equal(result.applied, 0, `${target} must not be written`);
      assert.equal(result.errors.length, 1, `${target} must report exactly one rejection`);
    }
    assert.equal(fs.existsSync(path.join(repo, ".env")), false);
    assert.equal(fs.existsSync(path.join(repo, ".git", "hooks", "pre-commit")), false);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test("the verification gate is protected in a customer repository too", () => {
  const repo = customerRepo();
  try {
    fs.writeFileSync(path.join(repo, "VERIFY_CMD.mjs"), "process.exit(0);\n");
    for (const [file, action] of [["VERIFY_CMD.mjs", "modify"], ["VERIFY_CMD.sh", "create"]]) {
      const result = write(repo, file, "process.exit(0);\n", action);
      assert.equal(result.applied, 0, `${file} must not be rewritten by the model`);
      assert.match(result.errors[0], /Protected path/);
    }
    // A gate named by validation.script_path is protected as well, because the
    // gate is whatever the configuration points at.
    fs.writeFileSync(path.join(repo, "gate.mjs"), "process.exit(0);\n");
    const configured = write(repo, "gate.mjs", "process.exit(0);\n", "modify", { protectedExtraPaths: ["gate.mjs"] });
    assert.equal(configured.applied, 0);
    assert.match(configured.errors[0], /Protected path: gate\.mjs/);
    // Ordinary project files stay writable — the gate protection must not become
    // a general ban on touching the repository.
    assert.equal(write(repo, "src/app.js", "ok\n").applied, 1);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test("isProtectedPath reports the reason for each boundary", () => {
  const repo = customerRepo();
  try {
    assert.equal(isProtectedPath(repo, path.join(repo, ".env")).protected, true);
    assert.equal(isProtectedPath(repo, path.join(repo, ".github", "workflows", "ci.yml")).protected, true);
    assert.equal(isProtectedPath(repo, path.join(repo, "VERIFY_CMD.mjs")).protected, true);
    assert.equal(isProtectedPath(repo, path.join(repo, "src", "app.js")).protected, false);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test("a large file is not silently replaced by truncated content", () => {
  const repo = customerRepo();
  try {
    const target = path.join(repo, "src", "big.js");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const original = "// padding\n".repeat(SHRINK_GUARD_MIN_BYTES / 5);
    fs.writeFileSync(target, original);

    const truncated = write(repo, "src/big.js", "// padding\n", "modify");
    assert.equal(truncated.applied, 0, "a large size reduction must be refused");
    assert.match(truncated.errors[0], /Refusing to replace/);
    assert.equal(fs.readFileSync(target, "utf8"), original, "the original file must be untouched");

    // A legitimate edit of the same file still goes through.
    const edited = write(repo, "src/big.js", `${original}// extra line\n`, "modify");
    assert.equal(edited.applied, 1);

    // The guard is documented as overridable for a deliberate reduction.
    const overridden = write(repo, "src/big.js", "small\n", "modify", { allowLargeReduction: true });
    assert.equal(overridden.applied, 1);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test("suspiciousShrinkReason ignores small files and directories", () => {
  const repo = customerRepo();
  try {
    const small = path.join(repo, "small.js");
    fs.writeFileSync(small, "x".repeat(100));
    assert.equal(suspiciousShrinkReason(small, "y"), null, "small files are not guarded");
    assert.equal(suspiciousShrinkReason(path.join(repo, "missing.js"), "y"), null);
    assert.equal(suspiciousShrinkReason(repo, "y"), null, "a directory is not a file to shrink");
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test("a protected file rejects the entire change set without partial apply", () => {
  const repo = customerRepo();
  try {
    const result = applyChanges(repo, {
      changes: [
        { file: "src/allowed.js", action: "create", content: "allowed\n" },
        { file: "VERIFY_CMD.mjs", action: "modify", content: "process.exit(0);\n" },
      ],
    });
    assert.equal(result.applied, 0);
    assert.equal(result.errors.length, 1);
    assert.equal(fs.existsSync(path.join(repo, "src", "allowed.js")), false, "atomic rejection must not partially apply valid changes");
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test("an empty change set is reported as non-actionable by the caller contract", () => {
  const repo = customerRepo();
  try {
    const result = applyChanges(repo, { changes: [] });
    assert.equal(result.applied, 0);
    assert.deepEqual(result.errors, []);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test("isolation git calls are bounded and never prompt for credentials", () => {
  // A git command that waits on a credential prompt used to hang the pipeline
  // forever while it held the run lock; src/git/operations.js already capped its
  // calls, src/workspace/isolation.js did not.
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "workspace", "isolation.js"), "utf8");
  assert.match(source, /const GIT_TIMEOUT_MS = 30000;/);
  assert.match(source, /timeout: GIT_TIMEOUT_MS/);
  assert.match(source, /GIT_TERMINAL_PROMPT: "0"/);
});
