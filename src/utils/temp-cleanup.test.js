"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { sweepTempEntries, DEFAULT_PREFIXES, DEFAULT_RETENTION_MS } = require("./temp-cleanup");

const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "minitok-tmpclean-"));
  return { root, clean: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function makeEntry(root, name, kind = "dir") {
  const full = path.join(root, name);
  if (kind === "dir") fs.mkdirSync(full, { recursive: true });
  else fs.writeFileSync(full, "x");
  return full;
}

describe("sweepTempEntries", () => {
  it("reclaims an entry that has been untouched past the retention window", () => {
    const { root, clean } = sandbox();
    try {
      const stale = makeEntry(root, "minitok-stale-aaa");
      const summary = sweepTempEntries({ tmpdir: root, retentionMs: 6 * HOUR, protectMs: 10 * MINUTE, now: Date.now() + 12 * HOUR });
      assert.equal(summary.removed, 1);
      assert.equal(summary.scanned, 1);
      assert.equal(fs.existsSync(stale), false);
    } finally { clean(); }
  });

  it("keeps an entry inside the retention window", () => {
    const { root, clean } = sandbox();
    try {
      const fresh = makeEntry(root, "minitok-fresh-aaa");
      const summary = sweepTempEntries({ tmpdir: root, retentionMs: 6 * HOUR, protectMs: 10 * MINUTE, now: Date.now() + 1 * HOUR });
      assert.equal(summary.removed, 0);
      assert.equal(summary.kept, 1);
      assert.equal(fs.existsSync(fresh), true);
    } finally { clean(); }
  });

  it("treats a recent inode change as activity even when mtime is old", () => {
    const { root, clean } = sandbox();
    try {
      // A workspace cloned hours ago keeps an old mtime on its own directory
      // while the inode change time stays current; it must still be protected.
      const active = makeEntry(root, "minitok-isolation-active");
      const tenHoursAgo = (Date.now() - 10 * HOUR) / 1000;
      fs.utimesSync(active, tenHoursAgo, tenHoursAgo);
      const summary = sweepTempEntries({ tmpdir: root, retentionMs: 6 * HOUR, protectMs: 10 * MINUTE, now: Date.now() + 1 * HOUR });
      assert.equal(summary.removed, 0, "an entry whose ctime is current must not be reclaimed");
      assert.equal(fs.existsSync(active), true);
    } finally { clean(); }
  });

  it("ignores entries that no configured prefix matches", () => {
    const { root, clean } = sandbox();
    try {
      const foreignDir = makeEntry(root, "unrelated-directory");
      const foreignFile = makeEntry(root, "minitok-not-a-prefix-match.txt", "file");
      const summary = sweepTempEntries({ tmpdir: root, prefixes: ["minitok-"], retentionMs: 1, protectMs: 0, now: Date.now() + 48 * HOUR });
      assert.equal(summary.scanned, 1);
      assert.equal(summary.removed, 1);
      assert.equal(fs.existsSync(foreignDir), true);
      assert.equal(fs.existsSync(foreignFile), false);
    } finally { clean(); }
  });

  it("reclaims matching files as well as directories", () => {
    const { root, clean } = sandbox();
    try {
      const patch = makeEntry(root, "minitok-patch-12345.diff", "file");
      const summary = sweepTempEntries({ tmpdir: root, retentionMs: 1 * HOUR, protectMs: 0, now: Date.now() + 24 * HOUR });
      assert.equal(summary.removed, 1);
      assert.equal(fs.existsSync(patch), false);
    } finally { clean(); }
  });

  it("bounds the work per sweep and reports that the backlog remains", () => {
    const { root, clean } = sandbox();
    try {
      for (let index = 0; index < 5; index += 1) makeEntry(root, `minitok-bulk-${index}`);
      const summary = sweepTempEntries({ tmpdir: root, retentionMs: 6 * HOUR, protectMs: 0, maxEntries: 2, now: Date.now() + 24 * HOUR });
      assert.equal(summary.removed, 2);
      assert.equal(summary.kept, 3);
      assert.equal(summary.drained, false);
      assert.equal(fs.readdirSync(root).length, 3);
    } finally { clean(); }
  });

  it("never throws when the temp directory cannot be read", () => {
    const summary = sweepTempEntries({ tmpdir: "Z:\\definitely-not-here", retentionMs: 1, protectMs: 0 });
    assert.deepEqual(summary, { scanned: 0, candidates: 0, removed: 0, kept: 0, errors: 0, drained: false });
  });

  it("reports eligible entries without deleting them in dry-run mode", () => {
    const { root, clean } = sandbox();
    try {
      const stale = makeEntry(root, "minitok-dryrun-aaa");
      const summary = sweepTempEntries({ tmpdir: root, retentionMs: 1, protectMs: 0, dryRun: true, now: Date.now() + 24 * HOUR });
      assert.equal(summary.candidates, 1);
      assert.equal(summary.removed, 0);
      assert.equal(summary.kept, 1);
      assert.equal(fs.existsSync(stale), true);
    } finally { clean(); }
  });

  it("counts a failed removal as an error and keeps going", () => {
    const { root, clean } = sandbox();
    try {
      makeEntry(root, "minitok-fails-aaa");
      makeEntry(root, "minitok-ok-bbb");
      const summary = sweepTempEntries({
        tmpdir: root,
        retentionMs: 1,
        protectMs: 0,
        now: Date.now() + 24 * HOUR,
        fsImpl: { ...fs, rmSync: () => { throw Object.assign(new Error("locked"), { code: "EPERM" }); } },
      });
      assert.equal(summary.errors, 2);
      assert.equal(summary.removed, 0);
    } finally { clean(); }
  });

  it("bounds the scan itself so a huge backlog cannot stall a run", () => {
    const { root, clean } = sandbox();
    try {
      for (let index = 0; index < 40; index += 1) makeEntry(root, `minitok-scan-${index}`);
      const summary = sweepTempEntries({ tmpdir: root, retentionMs: 1, protectMs: 0, maxScan: 5, maxEntries: 100, now: Date.now() + 24 * HOUR });
      assert.equal(summary.scanned, 5);
      assert.equal(summary.drained, false, "a truncated scan must report that work remains");
    } finally { clean(); }
  });

  it("treats a zero time budget as unbounded and still completes a small sweep", () => {
    const { root, clean } = sandbox();
    try {
      makeEntry(root, "minitok-unbounded-aaa");
      const summary = sweepTempEntries({ tmpdir: root, retentionMs: 1, protectMs: 0, timeBudgetMs: 0, now: Date.now() + 24 * HOUR });
      assert.equal(summary.removed, 1);
      assert.equal(summary.drained, true);
    } finally { clean(); }
  });

  it("exposes the documented defaults", () => {
    assert.equal(DEFAULT_RETENTION_MS, 6 * HOUR);
    assert.ok(DEFAULT_PREFIXES.includes("minitok-"));
    assert.ok(DEFAULT_PREFIXES.includes("mt-"));
  });
});
