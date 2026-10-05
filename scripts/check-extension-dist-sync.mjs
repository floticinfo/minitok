#!/usr/bin/env node
// Read-only staleness gate for the tracked extension build output.
//
// extension/dist/src/*.js is committed to git because vsce excludes
// gitignored files from the .vsix, so a fresh clone can package the extension
// without running tsc. The risk is that someone edits extension/src/*.ts
// without rebuilding, leaving the shipped .js silently behind the .ts.
//
// This check compiles every extension source into a temp directory and
// compares the result against the committed dist/, so CI fails on drift
// instead of packaging a stale bundle. Run `npm run typecheck:extension`
// (or npx tsc -p extension/tsconfig.json) to regenerate dist/ and repair.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distRoot = path.join(root, "extension", "dist");

function sha256Canonical(file) {
  // Same canonicalisation as check-runtime-sync.mjs: LF-normalise so CRLF
  // checkouts and tsc LF emission compare equal.
  const canonical = readFileSync(file, "utf8").replaceAll("\r\n", "\n");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function listJs(dir, base = dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listJs(full, base));
    else if (entry.endsWith(".js")) out.push(path.relative(base, full).replaceAll(path.sep, "/"));
  }
  return out;
}

let tmp;
try {
  tmp = mkdtempSync(path.join(tmpdir(), "mt-dist-sync-"));
  // Run the local tsc entrypoint directly via the node binary. This avoids the
  // npx/.cmd shim entirely — no shell, no DEP0190, and no cmd-spawn quirks.
  const tscBin = path.join(root, "node_modules", "typescript", "bin", "tsc");
  execFileSync(process.execPath, [tscBin, "-p", "extension/tsconfig.json", "--outDir", tmp, "--pretty", "false"], {
    cwd: root, stdio: ["ignore", "pipe", "pipe"],
  });

  const committed = listJs(distRoot);
  const emitted = listJs(tmp);
  const problems = [];

  for (const rel of committed) {
    if (!emitted.includes(rel)) problems.push(`committed but tsc no longer emits it: extension/dist/${rel}`);
  }
  for (const rel of emitted) {
    if (!committed.includes(rel)) problems.push(`tsc emits but git does not track it (add with git add -f): extension/dist/${rel}`);
  }
  for (const rel of committed) {
    if (!emitted.includes(rel)) continue;
    if (sha256Canonical(path.join(distRoot, rel)) !== sha256Canonical(path.join(tmp, rel))) {
      problems.push(`stale build output: extension/dist/${rel} (run npm run typecheck:extension to rebuild)`);
    }
  }

  if (problems.length) {
    console.error(`extension/dist staleness check failed (${problems.length}):`);
    for (const p of problems) console.error(`- ${p}`);
    process.exitCode = 1;
  } else {
    console.log(`extension/dist staleness check passed (${committed.length} tracked .js files match tsc output)`);
  }
} catch (error) {
  console.error("extension/dist staleness check could not run tsc:", error.message);
  process.exitCode = 1;
} finally {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
}
