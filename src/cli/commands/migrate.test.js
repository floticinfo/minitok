"use strict";
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

const { atomicWriteNewFile } = require("./migrate");

describe("migrate atomic file writes", () => {
  it("creates a new file through the temp+rename pattern without leaving temp files", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "minitok-migrate-atomic-"));
    try {
      const target = path.join(dir, "minitok.yml");
      atomicWriteNewFile(target, "project: {}\n");
      assert.equal(fs.readFileSync(target, "utf8"), "project: {}\n");
      assert.deepEqual(fs.readdirSync(dir), ["minitok.yml"], "no temp file may remain");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("cleans up the temp file when the rename fails", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "minitok-migrate-atomic-"));
    const originalRename = fs.renameSync;
    fs.renameSync = () => { throw Object.assign(new Error("simulated rename failure"), { code: "EPERM" }); };
    try {
      assert.throws(() => atomicWriteNewFile(path.join(dir, "minitok.yml"), "x\n"), /simulated rename failure/);
      assert.deepEqual(fs.readdirSync(dir), [], "the failed write must not leak temp files or partial content");
    } finally {
      fs.renameSync = originalRename;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never overwrites an existing file via the exclusive temp creation flag", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "minitok-migrate-atomic-"));
    const originalWrite = fs.writeFileSync;
    fs.writeFileSync = (target, content, options) => {
      if (String(target).includes(".tmp.")) throw Object.assign(new Error("temp file already exists"), { code: "EEXIST" });
      return originalWrite(target, content, options);
    };
    try {
      assert.throws(() => atomicWriteNewFile(path.join(dir, "VERIFY_CMD.mjs"), "x\n"), /already exists/);
      assert.deepEqual(fs.readdirSync(dir), []);
    } finally {
      fs.writeFileSync = originalWrite;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses a unique same-directory temp name per write", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "minitok-migrate-atomic-"));
    const seenTemps = [];
    const originalRename = fs.renameSync;
    fs.renameSync = (from, to) => { seenTemps.push(path.basename(from)); return originalRename(from, to); };
    try {
      atomicWriteNewFile(path.join(dir, "a.txt"), "a");
      atomicWriteNewFile(path.join(dir, "b.txt"), "b");
      assert.equal(seenTemps.length, 2);
      assert.notEqual(seenTemps[0], seenTemps[1]);
      assert.match(seenTemps[0], /^a\.txt\.tmp\.\d+\.[0-9a-f]{12}$/);
    } finally {
      fs.renameSync = originalRename;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
