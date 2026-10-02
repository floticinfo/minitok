import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Read-only parity check for the embedded extension runtime.
 *
 * scripts/sync-extension-runtime.mjs copies a dependency-closure of src/ into
 * extension/runtime/src/ and records both file lists plus canonical (LF) hashes
 * in extension/runtime/runtime-manifest.json. This verifier fails CI when the
 * tree drifts: a stale embedded copy, a file edited on only one side, or a
 * manifest that no longer describes the tree. It never writes; run
 * `npm run sync:extension-runtime` to repair.
 *
 * Hashes follow the manifest contract: text is normalized to LF before hashing
 * so Windows CRLF checkouts do not produce false mismatches.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = path.join(root, "src");
const runtimeRoot = path.join(root, "extension", "runtime");
const runtimeSourceRoot = path.join(runtimeRoot, "src");
const manifestPath = path.join(runtimeRoot, "runtime-manifest.json");

function sha256Canonical(file) {
  const canonical = readFileSync(file, "utf8").replaceAll("\r\n", "\n");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function listFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listFiles(full));
    else out.push(path.relative(runtimeSourceRoot, full).replaceAll(path.sep, "/"));
  }
  return out;
}

const problems = [];
const warnings = [];

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const manifestFiles = Array.isArray(manifest.files) ? manifest.files : [];
const manifestHashes = manifest.hashes && typeof manifest.hashes === "object" ? manifest.hashes : {};

const runtimeFiles = listFiles(runtimeSourceRoot).sort();
const runtimeSet = new Set(runtimeFiles);
const manifestSet = new Set(manifestFiles);

for (const relative of runtimeFiles) {
  if (!manifestSet.has(relative)) problems.push(`runtime file not in manifest.files: ${relative}`);
}
for (const relative of manifestFiles) {
  if (!runtimeSet.has(relative)) problems.push(`manifest.files entry missing on disk: ${relative}`);
}

for (const relative of manifestFiles) {
  const src = path.join(sourceRoot, relative);
  const embedded = path.join(runtimeSourceRoot, relative);

  let srcHash = null;
  let embeddedHash = null;
  try { srcHash = sha256Canonical(src); } catch { problems.push(`in manifest but missing from src/: ${relative}`); }
  try { embeddedHash = sha256Canonical(embedded); } catch { problems.push(`in manifest but missing from extension/runtime/src/: ${relative}`); }
  if (srcHash === null || embeddedHash === null) continue;

  if (srcHash !== embeddedHash) {
    problems.push(`content drift: ${relative} (src ${srcHash.slice(0, 12)} != embedded ${embeddedHash.slice(0, 12)})`);
  }
  const recorded = manifestHashes[relative];
  if (!recorded) {
    problems.push(`manifest.hashes entry missing: ${relative}`);
    continue;
  }
  if (recorded.embedded !== embeddedHash) {
    problems.push(`embedded copy edited outside sync: ${relative} (manifest ${String(recorded.embedded).slice(0, 12)} != actual ${embeddedHash.slice(0, 12)})`);
  }
  if (recorded.source !== srcHash) {
    warnings.push(`src/ changed since last sync: ${relative} (run npm run sync:extension-runtime)`);
  }
}

// A file present in src/ but not in the runtime closure is usually intentional
// (CLI-only commands, tests): the sync walks a dependency graph, not the whole
// tree. Those files are not flagged; drift detection covers the manifest set.
const manifestCount = manifestFiles.length;
const totalRuntime = runtimeFiles.length;

if (problems.length) {
  console.error(JSON.stringify({
    status: "drift",
    problems,
    warnings,
    hint: "Run `npm run sync:extension-runtime` to regenerate extension/runtime/src and runtime-manifest.json, then commit both sides.",
  }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({
  status: "in-sync",
  files: manifestCount,
  runtimeFiles: totalRuntime,
  srcAhead: warnings.length,
  warnings,
}, null, 2));
