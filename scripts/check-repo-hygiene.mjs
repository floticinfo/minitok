#!/usr/bin/env node
/**
 * Repository hygiene checks — regression guards for Phase 2 findings.
 *
 * 1. Zero-byte tracked files (A: root `gui` was a 0-byte file tracked since v1.3.4)
 * 2. package.json `files[]` paths exist on disk (B: VIDEO_* entries were missing)
 * 3. .gitignore ↔ git ls-files cross-check (C: extension/dist/ was tracked despite
 *    being ignored; vsce excludes gitignored files from vsix, so this must stay clean)
 *
 * Run: node scripts/check-repo-hygiene.mjs
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
let failed = false;

function fail(msg) {
  console.error(`[error] ${msg}`);
  failed = true;
}

function pass(msg) {
  console.log(`[ok] ${msg}`);
}

// --- 1. Zero-byte tracked files -------------------------------------------
{
  const output = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" });
  const zeroByte = [];
  for (const rel of output.split(/\r?\n/).filter(Boolean)) {
    const abs = join(root, rel);
    try {
      if (statSync(abs).size === 0) zeroByte.push(rel);
    } catch {
      // deleted or unreadable — skip
    }
  }
  if (zeroByte.length === 0) pass("no zero-byte tracked files");
  else fail(`zero-byte tracked files found: ${zeroByte.join(", ")}`);
}

// --- 2. package.json files[] paths exist -----------------------------------
{
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const missing = [];
  for (const entry of pkg.files || []) {
    if (entry.startsWith("!")) continue; // negation patterns, not paths
    if (!existsSync(join(root, entry))) missing.push(entry);
  }
  if (missing.length === 0) pass(`all ${pkg.files.length} files[] entries exist`);
  else fail(`files[] entries missing on disk: ${missing.join(", ")}`);
}

// --- 3. .gitignore ↔ git ls-files cross-check -------------------------------
{
  const output = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" });
  const tracked = output.split(/\r?\n/).filter(Boolean);
  // git check-ignore exits 1 when nothing matches — that is a pass, not an error.
  let ignoredOutput = "";
  try {
    ignoredOutput = execFileSync("git", ["check-ignore", "--stdin"], {
      cwd: root,
      encoding: "utf8",
      input: tracked.join("\n"),
    });
  } catch (err) {
    if (err.status !== 1) throw err;
  }
  const ignored = new Set(ignoredOutput.split(/\r?\n/).filter(Boolean));
  const conflicts = tracked.filter(f => ignored.has(f));
  // extension/dist is intentionally tracked (vsce excludes gitignored files from vsix)
  const allowed = conflicts.filter(f => f.startsWith("extension/dist/"));
  const violations = conflicts.filter(f => !f.startsWith("extension/dist/"));
  if (violations.length === 0) {
    if (allowed.length > 0) pass(`${allowed.length} extension/dist/ files intentionally tracked (vsce requires)`);
    else pass("no tracked file is gitignored");
  } else fail(`tracked files that are also gitignored: ${violations.join(", ")}`);
}

if (failed) process.exit(1);
console.log("repo hygiene passed");
