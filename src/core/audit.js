"use strict";

/**
 * Append-only audit log for file operations.
 * Records all file mutations for forensic analysis.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");

const DEFAULT_AUDIT_PATH = path.join(os.homedir(), ".minitok", "audit.jsonl");

/**
 * Record an audit event.
 * @param {object} entry
 * @param {string} auditPath
 */
function auditLog(entry, auditPath) {
  const fp = auditPath || DEFAULT_AUDIT_PATH;
  const record = {
    timestamp: new Date().toISOString(),
    pid: process.pid,
    ...entry,
  };
  try {
    const dir = path.dirname(fp);
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(fp, JSON.stringify(record) + "\n", "utf-8");
  } catch (error) {
    const warning = { persisted: false, record, warning: `Audit persistence failed: ${error.message}` };
    process.emitWarning(warning.warning, { code: "MINITOK_AUDIT_PERSISTENCE" });
    return warning;
  }
  return { persisted: true, record };
}

// The audit log is append-only and never rotated, so it grows without bound.
// Reading it whole just to return the last `limit` records cost O(file) in both
// memory and JSON parsing; walk backwards in bounded chunks instead.
const TAIL_CHUNK_BYTES = 64 * 1024;
const TAIL_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Read the trailing newline-delimited records of a file.
 * @param {string} fp
 * @param {number} limit
 * @returns {string[]}
 */
function readTailRecords(fp, limit) {
  if (fs.statSync(fp).size === 0) return [];
  const fd = fs.openSync(fp, "r");
  try {
    const chunks = [];
    let position = fs.fstatSync(fd).size;
    let bytes = 0;
    let newlines = 0;
    // `limit` records are terminated by at most `limit` newlines, so once that
    // many separators are behind us nothing earlier can matter. TAIL_MAX_BYTES
    // bounds the work for a pathological file with no newlines at all.
    while (position > 0 && newlines < limit && bytes < TAIL_MAX_BYTES) {
      const length = Math.min(TAIL_CHUNK_BYTES, position, TAIL_MAX_BYTES - bytes);
      const buffer = Buffer.allocUnsafe(length);
      const read = fs.readSync(fd, buffer, 0, length, position - length);
      if (read <= 0) break;
      position -= read;
      chunks.unshift(buffer.subarray(0, read));
      bytes += read;
      const slice = buffer.subarray(0, read);
      for (let index = 0; index < slice.length; index += 1) if (slice[index] === 10) newlines += 1;
    }
    // Decode once: a multi-byte character split across a chunk boundary is only
    // reassembled correctly when the buffers are concatenated first.
    return Buffer.concat(chunks).toString("utf8").split("\n").filter(Boolean);
  } finally {
    try { fs.closeSync(fd); } catch {}
  }
}

/**
 * Read audit log entries.
 * @param {string} auditPath
 * @param {number} limit
 * @returns {Array}
 */
function auditRead(auditPath, limit = 100) {
  const fp = auditPath || DEFAULT_AUDIT_PATH;
  // A non-positive limit historically meant "everything" (slice(-0) is slice(0));
  // keep that contract while still bounding the read.
  const effective = Number.isFinite(limit) && limit > 0 ? limit : Number.MAX_SAFE_INTEGER;
  try {
    const lines = readTailRecords(fp, effective).slice(-effective);
    return lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch {
    return [];
  }
}

module.exports = { auditLog, auditRead, DEFAULT_AUDIT_PATH };
