"use strict";

/**
 * Git operations — wraps git CLI for repo analysis.
 * Uses execFileSync (no shell) to prevent command injection.
 */

const { execFileSync } = require("child_process");
const { GitError } = require("../core/errors");

/**
 * Execute a git command safely using execFileSync (no shell interpretation).
 * @param {string} repoRoot
 * @param {string[]} args - git arguments as array
 * @returns {string}
 */
function git(repoRoot, args) {
  try {
    return execFileSync("git", args, {
      cwd: repoRoot,
      encoding: "utf-8",
      timeout: 30000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    throw new GitError(`Git command failed: git ${args.join(" ")}`, {
      code: error.code,
      command: ["git", ...args],
      status: error.status,
    });
  }
}

function isGitRepo(repoRoot) {
  try {
    return git(repoRoot, ["rev-parse", "--is-inside-work-tree"]) === "true";
  } catch (error) {
    if (error instanceof GitError) return false;
    throw error;
  }
}

function currentBranch(repoRoot) {
  try { return git(repoRoot, ["branch", "--show-current"]); } catch { return ""; }
}

function headCommit(repoRoot) {
  try { return git(repoRoot, ["rev-parse", "--short", "HEAD"]); } catch { return ""; }
}

function isRuntimeMetadataStatusLine(line) {
  const file = String(line || "").slice(3).replace(/^"|"$/g, "").replace(/\\/g, "/");
  return file === ".minitok" || file.startsWith(".minitok/");
}

function status(repoRoot, options = {}) {
  try {
    const output = git(repoRoot, ["status", "--porcelain"]);
    if (options.excludeRuntime === true) return output.split("\n").filter(line => line && !isRuntimeMetadataStatusLine(line)).join("\n");
    return output;
  } catch { return ""; }
}

function diffStat(repoRoot, options = {}) {
  try { return git(repoRoot, ["diff", "--stat"]); } catch { return ""; }
}

function logRecent(repoRoot, count = 10) {
  try { return git(repoRoot, ["log", "--oneline", `-${count}`]); } catch { return ""; }
}

function remoteUrl(repoRoot) {
  try { return git(repoRoot, ["remote", "get-url", "origin"]); } catch { return ""; }
}

function fileCount(repoRoot) {
  const output = git(repoRoot, ["ls-files"]);
  return output ? output.split("\n").length : 0;
}

function stagedFiles(repoRoot) {
  const output = git(repoRoot, ["diff", "--cached", "--name-only"]);
  return output ? output.split("\n").filter(Boolean) : [];
}

function commit(repoRoot, message) {
  return git(repoRoot, ["commit", "-m", String(message)]);
}

function addAll(repoRoot) {
  return git(repoRoot, ["add", "-A"]);
}

function hasUncommittedChanges(repoRoot) {
  return status(repoRoot).length > 0;
}

module.exports = {
  git,
  isGitRepo,
  currentBranch,
  headCommit,
  status,
  diffStat,
  logRecent,
  remoteUrl,
  fileCount,
  stagedFiles,
  commit,
  addAll,
  hasUncommittedChanges,
};
