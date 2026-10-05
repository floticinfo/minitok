"use strict";

// Expand the @file / @folder / @problems markers the Extension inserts into a
// task into actual file contents, so the model receives them without needing a
// read tool. The Extension has always offered these attachments, but the CLI
// only ever passed the raw "@file src/x.ts" string through to the model, which
// could not resolve it — an attachment was therefore a no-op.
//
// Design constraints:
//   - Expansion is best-effort: an unreadable path is reported inline and the
//     run continues. Context is an ergonomic aid, never a correctness gate.
//   - Contents are redacted with the same helper the evidence writer uses, so a
//     secret that would be masked in logs is masked in the prompt too.
//   - Size is bounded per file and in total, and binary-looking files are
//     skipped, because a runaway attachment must not blow the model's context.

const fs = require("fs");
const path = require("path");
const { redact } = require("../../run-evidence");

const MAX_FILE_BYTES = 256 * 1024;
const MAX_FOLDER_FILES = 40;
const MAX_TOTAL_BYTES = 1024 * 1024;
const BLOCKED_SEGMENTS = new Set([".git", "node_modules", ".minitok"]);

function isBinary(buffer) {
  // A NUL byte in the first chunk is the classic cheap binary heuristic.
  const sample = buffer.subarray(0, 8000);
  return sample.includes(0);
}

function safeRelative(repoRoot, target) {
  const resolved = path.resolve(repoRoot, target);
  const root = path.resolve(repoRoot) + path.sep;
  if (resolved !== path.resolve(repoRoot) && !resolved.startsWith(root)) return null;
  return resolved;
}

function readOneFile(repoRoot, relPath) {
  const absolute = safeRelative(repoRoot, relPath);
  if (!absolute) return { marker: relPath, error: "path escapes the repository" };
  let stat;
  try { stat = fs.statSync(absolute); } catch (error) { return { marker: relPath, error: error.code || "unreadable" }; }
  if (!stat.isFile()) return { marker: relPath, error: "not a file" };
  if (stat.size > MAX_FILE_BYTES) return { marker: relPath, error: `too large (${stat.size} bytes)` };
  let buffer;
  try { buffer = fs.readFileSync(absolute); } catch (error) { return { marker: relPath, error: error.code || "unreadable" }; }
  if (isBinary(buffer)) return { marker: relPath, error: "binary file" };
  return { marker: relPath, content: String(redact(buffer.toString("utf8"))) };
}

function collectFolder(repoRoot, relDir) {
  const absolute = safeRelative(repoRoot, relDir);
  if (!absolute) return null;
  let stat;
  try { stat = fs.statSync(absolute); } catch { return null; }
  if (!stat.isDirectory()) return null;
  const found = [];
  const walk = (dir) => {
    if (found.length >= MAX_FOLDER_FILES) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (found.length >= MAX_FOLDER_FILES) return;
      if (BLOCKED_SEGMENTS.has(entry.name)) continue;
      const next = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(next);
      else if (entry.isFile()) found.push(path.relative(repoRoot, next).split(path.sep).join("/"));
    }
  };
  walk(absolute);
  return found;
}

/**
 * Expand @file / @folder / @problems markers in a task string.
 *
 * @param {string} task raw task text from the Extension
 * @param {string} repoRoot repository root used to resolve relative paths
 * @returns {{ task: string, expanded: number, skipped: number }}
 */
function expandTaskContext(task, repoRoot) {
  if (typeof task !== "string" || !task.includes("@")) return { task, expanded: 0, skipped: 0 };
  const blocks = [];
  let expanded = 0;
  let skipped = 0;
  let totalBytes = 0;

  // @file <path>   → single file block
  const fileRe = /@file\s+([^\s@]+)/g;
  let match;
  while ((match = fileRe.exec(task)) !== null) {
    const rel = match[1];
    const result = readOneFile(repoRoot, rel);
    if (result.error) {
      skipped += 1;
      blocks.push(`### Attached file: ${rel}\n(could not read: ${result.error})`);
      continue;
    }
    if (totalBytes + result.content.length > MAX_TOTAL_BYTES) {
      skipped += 1;
      blocks.push(`### Attached file: ${rel}\n(skipped: attachment budget exhausted)`);
      continue;
    }
    totalBytes += result.content.length;
    expanded += 1;
    blocks.push(`### Attached file: ${rel}\n\`\`\`\n${result.content}\n\`\`\``);
  }

  // @folder <path> → manifest + contents up to the budget
  const folderRe = /@folder\s+([^\s@]+)/g;
  while ((match = folderRe.exec(task)) !== null) {
    const rel = match[1];
    const files = collectFolder(repoRoot, rel);
    if (!files || files.length === 0) {
      skipped += 1;
      blocks.push(`### Attached folder: ${rel}\n(no readable files found)`);
      continue;
    }
    const parts = [`### Attached folder: ${rel}\n${files.length} file(s):\n${files.map(f => `- ${f}`).join("\n")}`];
    for (const f of files) {
      const result = readOneFile(repoRoot, f);
      if (result.error) continue;
      if (totalBytes + result.content.length > MAX_TOTAL_BYTES) break;
      totalBytes += result.content.length;
      parts.push(`#### ${f}\n\`\`\`\n${result.content}\n\`\`\``);
    }
    expanded += 1;
    blocks.push(parts.join("\n\n"));
  }

  // @problems is already expanded to literal text by the Extension, so it needs
  // no CLI-side work; it is listed here only to document the marker vocabulary.

  if (blocks.length === 0) return { task, expanded, skipped };
  return {
    task: `${task}\n\n[Attached context]\n${blocks.join("\n\n")}\n[End attached context]`,
    expanded,
    skipped,
  };
}

module.exports = { expandTaskContext, MAX_FILE_BYTES, MAX_TOTAL_BYTES, MAX_FOLDER_FILES };