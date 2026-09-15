"use strict";

const crypto = require("node:crypto");

function capText(value, maxChars = 8000) {
  const text = String(value || "");
  if (text.length <= maxChars) return text;
  const head = Math.floor(maxChars * 0.65);
  const tail = maxChars - head;
  return `${text.slice(0, head)}\n...[truncated ${text.length - maxChars} chars]...\n${text.slice(-tail)}`;
}

function compactJson(value) {
  return JSON.stringify(value);
}

function shortHash(value, length = 16) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex").slice(0, length);
}

function summarizeChanges(changesResult) {
  const changes = Array.isArray(changesResult?.changes) ? changesResult.changes : [];
  return {
    summary: changesResult?.summary || "",
    files_changed: changesResult?.files_changed || changes.length,
    changes: changes.map(change => ({
      file: change.file,
      action: change.action,
      content_chars: typeof change.content === "string" ? change.content.length : undefined,
      content_hash: typeof change.content === "string" ? shortHash(change.content) : undefined,
      edit_count: Array.isArray(change.edits) ? change.edits.length : undefined,
      before_hash: typeof change.before_hash === "string" ? change.before_hash.slice(0, 16) : undefined,
    })),
  };
}

module.exports = { capText, compactJson, shortHash, summarizeChanges };
