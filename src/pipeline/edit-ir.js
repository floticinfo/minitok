"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

function fileHash(content) {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function normalizeRelativePath(value) {
  return String(value || "").replaceAll("\\", "/").replace(/^\.\//, "");
}

/** Build a compact file codebook for Edit IR prompts. */
function buildEditManifest(repoRoot, targetPaths = []) {
  const seen = new Set();
  const files = [];
  for (const rawPath of Array.isArray(targetPaths) ? targetPaths : []) {
    const file = normalizeRelativePath(rawPath);
    if (!file || seen.has(file)) continue;
    seen.add(file);
    try {
      const absolute = safeExistingFile(repoRoot, file);
      const content = fs.readFileSync(absolute, "utf8");
      files.push({ id: `f${files.length}`, file, hash: fileHash(content), bytes: Buffer.byteLength(content), lines: content.split("\n").length });
    } catch {}
  }
  return { version: 2, files };
}

function serializeEditManifest(manifest) {
  return JSON.stringify({ v: 2, f: (manifest?.files || []).map(file => ({ id: file.id, h: file.hash, b: file.bytes, l: file.lines })) });
}

function resolveManifestFile(manifest, id) {
  const key = String(id || "");
  return (manifest?.files || []).find(file => file.id === key || file.file === key) || null;
}

function normalizeCompactEdit(edit) {
  if (!edit || typeof edit !== "object") return edit;
  if (edit.k === "x" || edit.k === "replace_exact") return { kind: "replace_exact", before: edit.b ?? edit.before, after: edit.a ?? edit.after };
  if (edit.k === "l" || edit.k === "replace_lines") return { kind: "replace_lines", start_line: edit.s ?? edit.start_line, end_line: edit.n ?? edit.end_line, content: edit.c ?? edit.content ?? edit.a ?? edit.after };
  return edit;
}

function decodeEditChanges(changesResult, manifest) {
  if (!changesResult || !Array.isArray(changesResult.changes)) return changesResult;
  const changes = changesResult.changes.map(change => {
    if (!change || typeof change !== "object") return change;
    const entry = resolveManifestFile(manifest, change.file_id ?? change.f);
    return entry ? { ...change, file: entry.file, action: change.action || "modify", before_hash: change.before_hash || change.h, edits: (change.edits || change.e || []).map(normalizeCompactEdit) } : change;
  });
  return { ...changesResult, changes };
}

function safeExistingFile(repoRoot, relative) {
  const root = fs.realpathSync(repoRoot);
  const absolute = path.resolve(repoRoot, relative);
  if (!(absolute === root || absolute.startsWith(root + path.sep))) throw new Error(`Edit target is outside the repository: ${relative}`);
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) throw new Error(`Edit target is not an existing file: ${relative}`);
  const real = fs.realpathSync(absolute);
  if (!(real === root || real.startsWith(root + path.sep))) throw new Error(`Edit target resolves outside the repository: ${relative}`);
  return real;
}

function replaceExact(content, edit, label) {
  const before = typeof edit.before === "string" ? edit.before : typeof edit.before_text === "string" ? edit.before_text : null;
  const after = typeof edit.after === "string" ? edit.after : typeof edit.after_text === "string" ? edit.after_text : null;
  if (before === null || after === null) throw new Error(`${label} exact edit requires before and after strings`);
  const first = content.indexOf(before);
  if (first < 0) throw new Error(`${label} exact before block was not found`);
  if (content.indexOf(before, first + 1) >= 0) throw new Error(`${label} exact before block matched more than once`);
  return content.slice(0, first) + after + content.slice(first + before.length);
}

function replaceLines(content, edit, label) {
  const start = Number(edit.start_line);
  const end = Number(edit.end_line);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) throw new Error(`${label} line range is invalid`);
  const lines = content.split("\n");
  if (end > lines.length) throw new Error(`${label} line range exceeds the current file`);
  const replacement = String(edit.content ?? edit.after ?? "").split("\n");
  lines.splice(start - 1, end - start + 1, ...replacement);
  return lines.join("\n");
}

function applyEditList(content, edits, label) {
  let result = content;
  for (const [index, edit] of (Array.isArray(edits) ? edits : []).entries()) {
    if (!edit || typeof edit !== "object") throw new Error(`${label} edit ${index + 1} must be an object`);
    result = edit.kind === "replace_lines" || edit.start_line !== undefined
      ? replaceLines(result, edit, `${label} edit ${index + 1}`)
      : replaceExact(result, edit, `${label} edit ${index + 1}`);
  }
  return result;
}

function expandEditChange(repoRoot, change) {
  if (!change || !Array.isArray(change.edits)) return change;
  if (change.action !== "modify") throw new Error(`Edit IR only supports modify actions for ${change.file}`);
  const filePath = safeExistingFile(repoRoot, change.file);
  const original = fs.readFileSync(filePath, "utf8");
  if (typeof change.before_hash !== "string" || !/^[a-f0-9]{64}$/i.test(change.before_hash)) throw new Error(`${change.file} edit IR requires a full 64-character before_hash`);
  if (change.before_hash !== fileHash(original)) throw new Error(`${change.file} before_hash does not match the current file`);
  const content = applyEditList(original, change.edits, change.file);
  return { ...change, content, edits: undefined };
}

function expandEditChanges(repoRoot, changesResult) {
  if (!changesResult || !Array.isArray(changesResult.changes)) return changesResult;
  const errors = [];
  const changes = changesResult.changes.map(change => {
    try { return expandEditChange(repoRoot, change); } catch (error) { errors.push(`${change?.file || "unknown"}: ${error.message}`); return change; }
  });
  return errors.length ? { ...changesResult, error: errors.join("; ") } : { ...changesResult, changes };
}

module.exports = { fileHash, buildEditManifest, serializeEditManifest, resolveManifestFile, decodeEditChanges, applyEditList, expandEditChange, expandEditChanges };
