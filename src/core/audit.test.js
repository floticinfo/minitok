"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { auditLog, auditRead } = require("./audit");

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "minitok-audit-"));
  return { dir, file: path.join(dir, "audit.jsonl") };
}

function clean(dir) { fs.rmSync(dir, { recursive: true, force: true }); }

describe("auditRead", () => {
  it("returns an empty list for a missing file", () => {
    const { dir, file } = tmpFile();
    try { assert.deepEqual(auditRead(path.join(dir, "absent.jsonl")), []); }
    finally { clean(dir); }
  });

  it("returns an empty list for an empty file", () => {
    const { dir, file } = tmpFile();
    try { fs.writeFileSync(file, ""); assert.deepEqual(auditRead(file), []); }
    finally { clean(dir); }
  });

  it("returns the newest entries in chronological order", () => {
    const { dir, file } = tmpFile();
    try {
      for (let n = 1; n <= 5; n += 1) auditLog({ n }, file);
      const entries = auditRead(file, 3);
      assert.deepEqual(entries.map(e => e.n), [3, 4, 5]);
    } finally { clean(dir); }
  });

  it("reads only the tail of a large log", () => {
    const { dir, file } = tmpFile();
    try {
      const lines = [];
      for (let n = 1; n <= 20000; n += 1) lines.push(JSON.stringify({ n }));
      fs.writeFileSync(file, `${lines.join("\n")}\n`);
      const entries = auditRead(file, 2);
      assert.deepEqual(entries.map(e => e.n), [19999, 20000]);
    } finally { clean(dir); }
  });

  it("reassembles multi-byte characters across chunk boundaries", () => {
    const { dir, file } = tmpFile();
    try {
      const lines = [];
      // ~250KB with 3-byte characters guarantees several 64KB chunks and a
      // chunk boundary landing inside a character.
      for (let n = 1; n <= 6000; n += 1) lines.push(JSON.stringify({ n, text: "한글테스트값" }));
      fs.writeFileSync(file, `${lines.join("\n")}\n`);
      const entries = auditRead(file, 6000);
      assert.equal(entries.length, 6000);
      assert.equal(entries[0].n, 1);
      assert.equal(entries[5999].n, 6000);
      for (const entry of entries) assert.equal(entry.text, "한글테스트값");
    } finally { clean(dir); }
  });

  it("treats a non-positive limit as everything, bounded by the tail cap", () => {
    const { dir, file } = tmpFile();
    try {
      for (let n = 1; n <= 4; n += 1) auditLog({ n }, file);
      assert.deepEqual(auditRead(file, 0).map(e => e.n), [1, 2, 3, 4]);
    } finally { clean(dir); }
  });

  it("skips records that are not valid JSON", () => {
    const { dir, file } = tmpFile();
    try {
      fs.writeFileSync(file, ["{\"n\":1}", "not json", "{\"n\":2}"].join("\n") + "\n");
      assert.deepEqual(auditRead(file, 10).map(e => e.n), [1, 2]);
    } finally { clean(dir); }
  });
});
