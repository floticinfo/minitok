"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");
const { setOwnerOnlyPermissions } = require("../utils/file-permissions");
const { packageManagerCommand } = require("../core/package-manager");
const { sweepTempEntries } = require("../utils/temp-cleanup");

const ISOLATION_TMP_PREFIX = "minitok-isolation-";
// Workspaces are removed in a `finally` block, so anything untouched for this
// long belongs to a run that no longer exists.
const ISOLATION_RETENTION_MS = 6 * 60 * 60 * 1000;
/** Upper bound for any git command this module runs, in milliseconds. */
const GIT_TIMEOUT_MS = 30000;

const workspaceBaselines = new Map();

function runGit(repo, args) {
  // A git command that waits for credentials (a private remote, a credential
  // helper prompt) would otherwise hang the pipeline forever while it holds the
  // run lock. The same guard already exists for the other git wrapper
  // (src/git/operations.js), which caps every call at 30s.
  return execFileSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: GIT_TIMEOUT_MS,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  }).trim();
}

function cachedWorkspacePatch(repo, baselineTree) {
  let patch = "";
  try {
    patch = runGit(repo, ["diff", "--cached", "--binary", "--full-index", baselineTree, "--"]);
  } catch {}
  // A staged diff against the current HEAD is the equivalent fallback when a
  // hosted Git version cannot resolve the temporary baseline tree as a diff
  // endpoint. The isolated baseline is committed as HEAD before pipeline work.
  if (!patch.trim()) patch = runGit(repo, ["diff", "--cached", "--binary", "--full-index", "--"]);
  return `${patch}\n`.replace(/\r\n/g, "\n");
}

function sameWorkspacePath(left, right) {
  try {
    const leftStat = fs.lstatSync(left);
    const rightStat = fs.lstatSync(right);
    if (leftStat.isFile() && rightStat.isFile()) return fs.readFileSync(left).equals(fs.readFileSync(right));
    if (!leftStat.isDirectory() || !rightStat.isDirectory()) return false;
    const leftEntries = fs.readdirSync(left).sort();
    const rightEntries = fs.readdirSync(right).sort();
    if (leftEntries.length !== rightEntries.length || leftEntries.some((entry, index) => entry !== rightEntries[index])) return false;
    return leftEntries.every(entry => sameWorkspacePath(path.join(left, entry), path.join(right, entry)));
  } catch {
    return false;
  }
}

/**
 * Compare two canonical paths.
 *
 * Windows paths are case-insensitive, and realpathSync.native returns the
 * on-disk casing, which need not match the casing the caller typed
 * (c:\src\app vs C:\src\app). A strict string comparison therefore rejected
 * perfectly safe workspaces with "Unsafe workspace path".
 */
function sameResolvedPath(left, right) {
  if (process.platform !== "win32") return left === right;
  const normalize = value => {
    let normalized = String(value);
    if (normalized.length >= 4 && normalized[0] === "\\" && normalized[1] === "\\" && (normalized[2] === "?" || normalized[2] === ".") && normalized[3] === "\\") normalized = normalized.slice(4);
    return normalized.replace(/[\\/]+$/, "").toLowerCase();
  };
  return normalize(left) === normalize(right);
}

function assertNoLinks(root) {
  const resolvedRoot = path.resolve(root);
  const visit = current => {
    const stat = fs.lstatSync(current);
    const isGitMetadata = path.basename(current).toLowerCase() === ".git";
    if (isGitMetadata) {
      if (stat.isSymbolicLink()) throw new Error(`Unsafe workspace path: ${path.relative(resolvedRoot, current)}`);
      return;
    }
    const real = fs.realpathSync.native(current);
    const isRoot = sameResolvedPath(current, resolvedRoot);
    if (stat.isSymbolicLink() || (!isRoot && !sameResolvedPath(real, path.resolve(current)))) throw new Error(`Unsafe workspace path: ${path.relative(resolvedRoot, current)}`);
    if (!stat.isDirectory()) return;
    for (const entry of fs.readdirSync(current)) visit(path.join(current, entry));
  };
  visit(resolvedRoot);
}

function prepareCanonicalVerification(workspace) {
  const packagePath = path.join(workspace, "package.json");
  if (!fs.existsSync(packagePath)) return null;
  try {
    const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));
    if (packageJson.name !== "@flotic/minitok") return null;
    const syncScript = path.join(workspace, "scripts", "sync-version-metadata.mjs");
    if (fs.existsSync(syncScript)) execFileSync(process.execPath, [syncScript], { cwd: workspace, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120000 });
    const runtimeScript = path.join(workspace, "scripts", "sync-extension-runtime.mjs");
    if (fs.existsSync(runtimeScript)) execFileSync(process.execPath, [runtimeScript], { cwd: workspace, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120000 });
    const extensionPackage = path.join(workspace, "extension", "package.json");
    const packageExtension = path.join(workspace, "scripts", "package-extension.mjs");
    if (fs.existsSync(extensionPackage) && fs.existsSync(packageExtension)) execFileSync(process.execPath, [packageExtension], { cwd: workspace, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120000 });
    return { prepared: true };
  } catch (error) {
    const detail = `${error.stdout || ""}${error.stderr || ""}`.trim().slice(-1000);
    const prepareError = Object.assign(new Error(`Could not prepare canonical verification artifacts: ${detail || error.message}`), { code: "minitok_canonical_prepare_failed" });
    prepareError.cause = error;
    throw prepareError;
  }
}

function installWorkspaceDependencies(workspace) {
  const installOne = directory => {
    const packageJson = path.join(directory, "package.json");
    if (!fs.existsSync(packageJson)) return null;
    const hasPnpmLock = fs.existsSync(path.join(directory, "pnpm-lock.yaml"));
    const hasYarnLock = fs.existsSync(path.join(directory, "yarn.lock"));
    const hasNpmLock = fs.existsSync(path.join(directory, "package-lock.json"));
    const manifest = JSON.parse(fs.readFileSync(packageJson, "utf8"));
    const dependencyCount = Object.keys({ ...(manifest.dependencies || {}), ...(manifest.devDependencies || {}), ...(manifest.optionalDependencies || {}) }).length;
    if (!hasPnpmLock && !hasYarnLock && !hasNpmLock && dependencyCount === 0) return null;
    const packageManager = hasPnpmLock ? "pnpm" : hasYarnLock ? "yarn" : "npm";
  const packageArgs = packageManager === "npm" ? [hasNpmLock ? "ci" : "install", "--ignore-scripts", "--no-audit", "--no-fund"] : packageManager === "pnpm" ? ["install", "--frozen-lockfile", "--ignore-scripts"] : ["install", "--frozen-lockfile", "--ignore-scripts"];
  const { command, args } = packageManagerCommand(packageManager, packageArgs);
    try {
      execFileSync(command, args, { cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 600000 });
      return { directory: path.relative(workspace, directory) || ".", package_manager: packageManager, installed: true };
    } catch (error) {
      const detail = `${error.stdout || ""}${error.stderr || ""}`.trim().slice(-1000);
      const installError = Object.assign(new Error(`Could not install isolated workspace dependencies with ${packageManager} in ${path.relative(workspace, directory) || "."}: ${detail || error.message}`), { code: "minitok_dependency_install_failed" });
    installError.cause = error;
      throw installError;
    }
  };
  const results = [];
  const rootResult = installOne(workspace);
  if (rootResult) results.push(rootResult);
  const extensionResult = installOne(path.join(workspace, "extension"));
  if (extensionResult) results.push(extensionResult);
  return results.length ? { installed: true, packages: results } : null;
}

function createIsolatedWorkspace(repoRoot, isolationRoot) {
  // Reclaim workspaces abandoned by crashed or killed runs. Only age is used as
  // evidence, so a concurrent run is never disturbed: a live run keeps writing
  // inside its own directory, which keeps its mtime and ctime current. The
  // previous inline sweep had the age comparison inverted (it skipped entries
  // older than the window and deleted recent ones), which preserved ancient
  // leftovers forever while putting concurrent runs at risk.
  if (!isolationRoot) {
    try {
      sweepTempEntries({ prefixes: [ISOLATION_TMP_PREFIX], retentionMs: ISOLATION_RETENTION_MS });
    } catch {}
  }
  const root = isolationRoot || fs.mkdtempSync(path.join(os.tmpdir(), ISOLATION_TMP_PREFIX));
  if (isolationRoot) fs.mkdirSync(root, { recursive: true });
  assertNoLinks(path.resolve(repoRoot));
  assertNoLinks(root);
  const workspace = fs.mkdtempSync(path.join(root, "workspace-"));
  try {
    // Clone HEAD, then layer the user's uncommitted working-tree changes on
    // top so the pipeline sees the same state the customer sees. Without
    // this, runs silently execute against stale code (paid tokens wasted).
    runGit(repoRoot, ["clone", "--no-hardlinks", "--local", repoRoot, workspace]);
    // Deterministic diffing: the isolated workspace must not translate line
    // endings (autocrlf), or generated patches corrupt on Windows.
    try {
      runGit(workspace, ["config", "core.autocrlf", "false"]);
      runGit(workspace, ["checkout", "--", "."]);
    } catch {}
    {
      // Snapshot ALL uncommitted work (staged + unstaged, binary included)
      // relative to HEAD and layer it onto the clone. Failing this is not
      // tolerable: the run would silently execute against stale code while
      // the customer believes their working tree was in scope.
      const trackedPatch = runGit(repoRoot, ["diff", "HEAD", "--binary", "--no-color"]) + "\n";
      if (trackedPatch.trim()) {
        const p = path.join(workspace, "..", "wt-tracked.patch");
        fs.writeFileSync(p, trackedPatch.replace(/\r\n/g, "\n"), "utf8");
        try {
          execFileSync("git", ["apply", "--ignore-whitespace", "--whitespace=nowarn", p], { cwd: workspace, stdio: ["pipe", "pipe", "pipe"] });
        } catch (applyErr) {
          const err = new Error(
            `Could not layer your uncommitted changes onto the isolated workspace ` +
            `(${(applyErr.stderr || applyErr.message || "").toString().trim().slice(0, 200)}). ` +
            `Commit or stash your changes and retry, so the run executes against the code you see.`
          );
          /** @type {NodeJS.ErrnoException} */ (err).code = "minitok_isolate_failed";
          err.cause = applyErr;
          throw err;
        }
        fs.rmSync(p, { force: true });
      }
      prepareCanonicalVerification(workspace);
      // Untracked files (excluding .gitignore'd noise is not possible via
      // diff; copy untracked-but-not-ignored files verbatim).
      let untracked = "";
      untracked = runGit(repoRoot, ["ls-files", "--others", "--exclude-standard"]);
      const baselineUntracked = [];
      for (const rel of untracked.split("\n").filter(Boolean)) {
        const src = path.join(repoRoot, rel);
        const dest = path.join(workspace, rel);
        const stat = fs.lstatSync(src);
        if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw new Error(`Unsafe untracked path: ${rel}`);
        const canonical = fs.realpathSync(src);
        const canonicalRoot = fs.realpathSync(repoRoot);
        if (!(canonical === canonicalRoot || canonical.startsWith(canonicalRoot + path.sep))) throw new Error(`Unsafe untracked path: ${rel}`);
        if (fs.existsSync(dest)) {
          const existing = fs.lstatSync(dest);
          if (existing.isSymbolicLink() || (!existing.isFile() && !existing.isDirectory())) throw new Error(`Unsafe isolated path: ${rel}`);
          continue;
        }
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.cpSync(src, dest);
        baselineUntracked.push(rel);
      }
      runGit(workspace, ["add", "-A"]);
      for (const name of baselineUntracked) {
        try { runGit(workspace, ["reset", "-q", "HEAD", "--", name]); } catch {}
      }
      runGit(workspace, ["commit", "--allow-empty", "-m", "minitok isolated baseline"]);
      const baselineTrackedTree = runGit(workspace, ["write-tree"]);
      workspaceBaselines.set(workspace, { untracked: new Set(baselineUntracked), trackedTree: baselineTrackedTree });
    }
    const dependencies = installWorkspaceDependencies(workspace);
    return { path: workspace, mode: "git-clone", dependencies };
  } catch (cloneError) {
    const isolationError = /** @type {NodeJS.ErrnoException} */ (cloneError);
    if (isolationError.code === "minitok_isolate_failed") {
      fs.rmSync(workspace, { recursive: true, force: true });
      throw cloneError;
    }
    let fallbackComplete = false;
    try {
      fs.rmSync(workspace, { recursive: true, force: true });
      fs.mkdirSync(workspace, { recursive: true });
      fs.cpSync(repoRoot, workspace, { recursive: true, filter: (source) => !source.split(path.sep).includes(".git") });
      runGit(workspace, ["init"]);
      runGit(workspace, ["config", "user.email", "minitok-isolation@invalid"]);
      runGit(workspace, ["config", "user.name", "minitok isolation"]);
      runGit(workspace, ["add", "-A"]);
      runGit(workspace, ["commit", "-m", "isolated workspace baseline"]);
      fallbackComplete = true;
      const dependencies = installWorkspaceDependencies(workspace);
      return { path: workspace, mode: "working-tree-snapshot", cloneError: cloneError.message, dependencies };
    } finally {
      if (!fallbackComplete) fs.rmSync(workspace, { recursive: true, force: true });
    }
  }
}

function applyWorkspaceDiff(repoRoot, isolatedRoot) {
  // Stage only pipeline-generated code changes. Runtime state written inside
  // the isolated clone (.minitok/run.lock, knowledge.json, evidence, etc.)
  // must NOT flow back into the real repository — run.lock especially cannot
  // be applied (the real repo has its own live lock file).
  const baseline = workspaceBaselines.get(isolatedRoot) || { untracked: new Set(), trackedTree: runGit(isolatedRoot, ["write-tree"]) };
  runGit(isolatedRoot, ["add", "-A"]);
  try {
    runGit(isolatedRoot, ["reset", "-q", "HEAD", "--", ".minitok/"]);
  } catch {}
  for (const name of baseline.untracked) {
    try { runGit(isolatedRoot, ["rm", "--cached", "--ignore-unmatch", "-r", "--", name]); } catch {}
  }
  const pipelineTree = runGit(isolatedRoot, ["write-tree"]);
  const patch = cachedWorkspacePatch(isolatedRoot, baseline.trackedTree);
  if (!patch.trim()) return { applied: false, files: [] };
  // Per-call unique name: two runs inside one process (MCP runtime) would
  // otherwise share this path, and the first `finally` unlink would delete the
  // other run's patch before it is applied.
  const patchFile = path.join(os.tmpdir(), `minitok-patch-${process.pid}-${crypto.randomBytes(6).toString("hex")}.diff`);
  // Persist the patch next to run evidence so a failed apply does NOT
  // destroy paid pipeline output — the user can re-apply it manually.
  const keptPatch = path.join(repoRoot, ".minitok", "last-run.patch");
  fs.mkdirSync(path.dirname(keptPatch), { recursive: true });
    fs.writeFileSync(patchFile, patch, { encoding: "utf8", flag: "wx", mode: 0o600 });
    setOwnerOnlyPermissions(patchFile);
  try {
    execFileSync("git", ["apply", "--index", "--whitespace=nowarn", patchFile], { cwd: repoRoot, stdio: ["pipe", "pipe", "pipe"] });
    try { fs.copyFileSync(patchFile, keptPatch); } catch {}
    const files = runGit(isolatedRoot, ["diff-tree", "--name-only", baseline.trackedTree, pipelineTree, "--"]).split("\n").filter(Boolean);
    const result = { applied: true, files };
    Object.defineProperties(result, {
      patch_generated: { value: true, enumerable: false },
      patch_signature: { value: crypto.createHash("sha256").update(patch, "utf8").digest("hex"), enumerable: false },
      patch_preserved: { value: fs.existsSync(keptPatch), enumerable: false },
    });
    return result;
  } catch (applyError) {
    try { fs.copyFileSync(patchFile, keptPatch); } catch {}
    const err = new Error(
      `Could not apply pipeline changes to the repository (the repository changed during the run, or the working tree diverged). ` +
      `The full change patch was preserved at ${keptPatch} — apply it manually with: git apply ${keptPatch}`
    );
    /** @type {NodeJS.ErrnoException} */ (err).code = "minitok_apply_failed";
    err.cause = applyError;
    throw err;
  } finally {
    fs.rmSync(patchFile, { force: true });
  }
}

function removeIsolatedWorkspace(workspacePath) {
  workspaceBaselines.delete(workspacePath);
  fs.rmSync(workspacePath, { recursive: true, force: true });
}

/**
 * Persist the isolated workspace's generated diff without applying it —
 * used when a run FAILED so paid pipeline output survives the clone removal.
 */
function preserveWorkspaceDiff(repoRoot, isolatedRoot) {
  try {
    runGit(isolatedRoot, ["add", "-A"]);
    try { runGit(isolatedRoot, ["reset", "-q", "HEAD", "--", ".minitok/"]); } catch {}
    const baseline = workspaceBaselines.get(isolatedRoot) || { untracked: new Set(), trackedTree: runGit(isolatedRoot, ["write-tree"]) };
    for (const rel of baseline.untracked) {
      const isolatedPath = path.join(isolatedRoot, rel);
      const repoPath = path.join(repoRoot, rel);
      if (sameWorkspacePath(isolatedPath, repoPath)) {
        try { runGit(isolatedRoot, ["rm", "--cached", "--ignore-unmatch", "-r", "--", rel]); } catch {}
      }
    }
    const patch = cachedWorkspacePatch(isolatedRoot, baseline.trackedTree);
    if (!patch.trim()) return null;
    const keptPatch = path.join(repoRoot, ".minitok", "last-run.patch");
    fs.mkdirSync(path.dirname(keptPatch), { recursive: true });
    fs.writeFileSync(keptPatch, patch, { encoding: "utf8", mode: 0o600 });
    setOwnerOnlyPermissions(keptPatch);
    return keptPatch;
  } catch {
    return null;
  }
}

module.exports = { createIsolatedWorkspace, prepareCanonicalVerification, installWorkspaceDependencies, applyWorkspaceDiff, removeIsolatedWorkspace, preserveWorkspaceDiff, assertNoLinks, sameResolvedPath };
