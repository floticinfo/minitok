"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { createIsolatedWorkspace, applyWorkspaceDiff, removeIsolatedWorkspace } = require("./isolation");

function git(repo, args) {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
}

function tmpRepo() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "mt-iso-"));
  git(d, ["init"]);
  git(d, ["config", "user.email", "t@t.com"]);
  git(d, ["config", "user.name", "T"]);
  fs.writeFileSync(path.join(d, "base.txt"), "base\n");
  git(d, ["add", "-A"]);
  git(d, ["commit", "-m", "init"]);
  return d;
}

describe("isolation: canonical verification preparation", () => {
  it("prepares canonical metadata and artifacts before verification", () => {
    const repo = tmpRepo();
    fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ name: "customer-app" }));
    const { prepareCanonicalVerification } = require("./isolation");
    assert.equal(prepareCanonicalVerification(repo), null);
    fs.rmSync(repo, { recursive: true, force: true });
  });
});

describe("isolation: dependency preparation", () => {
  it("installs locked Node dependencies for isolated verification", () => {
    const repo = tmpRepo();
    fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0", dependencies: {} }));
    fs.writeFileSync(path.join(repo, "package-lock.json"), JSON.stringify({ name: "fixture", version: "1.0.0", lockfileVersion: 3, requires: true, packages: { "": { name: "fixture", version: "1.0.0" } } }));
    const { installWorkspaceDependencies } = require("./isolation");
    const result = installWorkspaceDependencies(repo);
    assert.equal(result.installed, true);
    assert.equal(result.installed, true);
    assert.equal(result.packages[0].package_manager, "npm");
    fs.rmSync(repo, { recursive: true, force: true });
  });
});

describe("isolation: working-tree layering", () => {
  let repo, iso;
  beforeEach(() => { repo = tmpRepo(); });
  afterEach(() => { if (iso) removeIsolatedWorkspace(iso.path); });

  it("uncommitted tracked changes are visible in the isolated clone", () => {
    fs.writeFileSync(path.join(repo, "base.txt"), "modified-uncommitted\n");
    iso = createIsolatedWorkspace(repo);
    assert.equal(iso.mode, "git-clone");
    assert.equal(
      fs.readFileSync(path.join(iso.path, "base.txt"), "utf8").replace(/\r\n/g, "\n"),
      "modified-uncommitted\n",
      "clone must include uncommitted tracked changes"
    );
  });

  it("untracked files are copied into the isolated clone", () => {
    fs.writeFileSync(path.join(repo, "new-untracked.txt"), "hello\n");
    iso = createIsolatedWorkspace(repo);
    assert.equal(fs.readFileSync(path.join(iso.path, "new-untracked.txt"), "utf8"), "hello\n");
  });

  it("does not reapply a pre-existing untracked file as pipeline output", () => {
    fs.writeFileSync(path.join(repo, "new-untracked.txt"), "hello\n");
    iso = createIsolatedWorkspace(repo);
    const r = applyWorkspaceDiff(repo, iso.path);
    assert.deepEqual(r, { applied: false, files: [] });
  });

  it("applies pipeline changes without reapplying pre-existing tracked changes", () => {
    fs.writeFileSync(path.join(repo, "base.txt"), "user-change\n");
    iso = createIsolatedWorkspace(repo);
    fs.writeFileSync(path.join(iso.path, "base.txt"), "user-change\n");
    fs.writeFileSync(path.join(iso.path, "pipeline.txt"), "pipeline\n");
    const r = applyWorkspaceDiff(repo, iso.path);
    assert.deepEqual(r, { applied: true, files: ["pipeline.txt"] });
    assert.equal(fs.readFileSync(path.join(repo, "base.txt"), "utf8"), "user-change\n");
    assert.equal(fs.readFileSync(path.join(repo, "pipeline.txt"), "utf8").replace(/\r\n/g, "\n"), "pipeline\n");
  });

  it("rejects recursive symlink paths before cloning", () => {
    const nested = path.join(repo, "nested");
    fs.mkdirSync(nested);
    try { fs.symlinkSync(nested, path.join(repo, "link"), "junction"); } catch { return; }
    assert.throws(() => createIsolatedWorkspace(repo), /Unsafe workspace path/);
  });
});

describe("isolation: diff apply failure keeps the paid output", () => {
  let repo, iso;
  beforeEach(() => { repo = tmpRepo(); });
  afterEach(() => { if (iso) removeIsolatedWorkspace(iso.path); });

  it("apply failure preserves the patch and throws a clear error", () => {
    iso = createIsolatedWorkspace(repo);
    // Change the file in isolation
    fs.writeFileSync(path.join(iso.path, "base.txt"), "pipeline-change\n");
    // Diverge the real repo so apply cannot cleanly match
    fs.writeFileSync(path.join(repo, "base.txt"), "user-diverged\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-m", "user committed during run"]);

    assert.throws(
      () => applyWorkspaceDiff(repo, iso.path),
      (e) => e.code === "minitok_apply_failed" && /last-run\.patch/.test(e.message) && /git apply/.test(e.message)
    );
    const kept = path.join(repo, ".minitok", "last-run.patch");
    assert.ok(fs.existsSync(kept), "patch must be preserved for manual application");
    const patchContent = fs.readFileSync(kept, "utf8");
    assert.match(patchContent, /pipeline-change/, "preserved patch contains pipeline output");
  });

  it("empty cached diffs are a no-op", () => {
    iso = createIsolatedWorkspace(repo);
    const r = applyWorkspaceDiff(repo, iso.path);
    assert.deepEqual(r, { applied: false, files: [] });
    assert.equal(fs.existsSync(path.join(repo, ".minitok", "last-run.patch")), false);
  });

  it("successful apply stages the changes and reports files", () => {
    iso = createIsolatedWorkspace(repo);
    fs.writeFileSync(path.join(iso.path, "feature.txt"), "feature\n");
    const r = applyWorkspaceDiff(repo, iso.path);
    assert.equal(r.applied, true);
    assert.ok(r.files.includes("feature.txt"));
    assert.equal(fs.readFileSync(path.join(repo, "feature.txt"), "utf8").replace(/\r\n/g, "\n"), "feature\n");
  });
});
describe("isolation: workspace link safety", () => {
  it("accepts a normal workspace tree", () => {
    const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "mt-links-")));
    fs.mkdirSync(path.join(dir, "src"));
    fs.writeFileSync(path.join(dir, "src", "app.js"), "ok\n");
    const { assertNoLinks } = require("./isolation");
    assert.doesNotThrow(() => assertNoLinks(dir));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("accepts the same directory when only the path casing differs (Windows)", { skip: process.platform !== "win32" }, () => {
    const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "mt-links-case-")));
    fs.writeFileSync(path.join(dir, "app.js"), "ok\n");
    const { assertNoLinks } = require("./isolation");
    // realpathSync.native returns the on-disk casing, so a lowercase drive letter
    // (c:\repo) never matched a strict string comparison against C:\repo and the
    // whole run was refused with "Unsafe workspace path".
    const lowered = dir.replace(/^([A-Za-z]):/, (_, drive) => `${drive.toLowerCase()}:`);
    assert.notEqual(lowered, dir);
    assert.doesNotThrow(() => assertNoLinks(lowered));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("compares canonical paths case-insensitively only on Windows", () => {
    const { sameResolvedPath } = require("./isolation");
    assert.equal(sameResolvedPath("C:\\Repo\\App", "C:\\Repo\\App"), true);
    assert.equal(sameResolvedPath("/repo/app", "/repo/app"), true);
    if (process.platform === "win32") {
      assert.equal(sameResolvedPath("c:\\repo\\app", "C:\\Repo\\App"), true);
    } else {
      assert.equal(sameResolvedPath("/repo/app", "/repo/App"), false);
    }
  });
});

