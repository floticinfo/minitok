"use strict";

const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { acquireRunLock, LOCK_FILE, STALE_MS, LOCK_GRACE_MS } = require("../state/run-lock");

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mt-lock-"));
}

describe("run lock", () => {
  let root;
  beforeEach(() => { root = tmpDir(); });

  it("acquires and releases exclusively", () => {
    const lock = acquireRunLock(root);
    assert.ok(fs.existsSync(path.join(root, LOCK_FILE)));
    assert.throws(() => acquireRunLock(root), /already in progress/);
    lock.release();
    assert.ok(!fs.existsSync(path.join(root, LOCK_FILE)));
    const again = acquireRunLock(root);
    again.release();
  });

  it("treats a dead-PID lock as stale and reclaims it", () => {
    const lockPath = path.join(root, LOCK_FILE);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999999, host: os.hostname(), started_at: new Date().toISOString() }), "utf-8");
    const lock = acquireRunLock(root);
    assert.ok(lock);
    lock.release();
  });

  it("reports a live foreign lock as busy with the holder PID", () => {
    const lockPath = path.join(root, LOCK_FILE);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    const child = require("child_process").spawn("node", ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore", detached: true });
    try {
      fs.writeFileSync(lockPath, JSON.stringify({ pid: child.pid, host: os.hostname(), started_at: new Date().toISOString() }), "utf-8");
      assert.throws(() => acquireRunLock(root), (e) => e.code === "minitok_run_locked" && String(e.message).includes(String(child.pid)));
    } finally {
      try { process.kill(child.pid); } catch {}
    }
  });

  it("fails closed on an unreadable lock instead of stealing it", () => {
    // A writer is between `open(..., "wx")` and its first write, or the file was
    // truncated. Reclaiming it on sight let two runs own the same workspace.
    const lockPath = path.join(root, LOCK_FILE);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, "", "utf-8");
    assert.throws(() => acquireRunLock(root), (e) => e.code === "minitok_run_locked");
    assert.equal(fs.existsSync(lockPath), true, "a fresh unreadable lock must survive");
  });

  it("reclaims an unreadable lock once it is older than the grace window", () => {
    const lockPath = path.join(root, LOCK_FILE);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, "", "utf-8");
    const aged = new Date(Date.now() - LOCK_GRACE_MS - 1000);
    fs.utimesSync(lockPath, aged, aged);
    const lock = acquireRunLock(root);
    assert.ok(lock);
    lock.release();
  });

  it("does not treat a lock with an unknown owner as stale", () => {
    // No PID means liveness cannot be judged, so the record is only reclaimable by
    // age — reading a missing PID as "dead" stole foreign and corrupt locks.
    const lockPath = path.join(root, LOCK_FILE);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify({ host: os.hostname(), started_at: new Date().toISOString() }), "utf-8");
    assert.throws(() => acquireRunLock(root), (e) => e.code === "minitok_run_locked");
    assert.equal(fs.existsSync(lockPath), true);
  });

  it("reclaims a foreign-host lock only by age", () => {
    const lockPath = path.join(root, LOCK_FILE);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999999, host: "another-host", started_at: new Date().toISOString() }), "utf-8");
    assert.throws(() => acquireRunLock(root), (e) => e.code === "minitok_run_locked", "another host's PID must not be judged from here");
    const stale = JSON.stringify({ pid: 999999999, host: "another-host", started_at: new Date(Date.now() - STALE_MS - 1000).toISOString() });
    fs.writeFileSync(lockPath, stale, "utf-8");
    const lock = acquireRunLock(root);
    lock.release();
  });

  it("does not leave a lock file behind after release", () => {
    const lock = acquireRunLock(root);
    lock.release();
    assert.throws(() => fs.statSync(path.join(root, LOCK_FILE)), /ENOENT/);
  });

  it("does not release a replacement lock", () => {
    const lock = acquireRunLock(root);
    const lockPath = path.join(root, LOCK_FILE);
    const replacement = JSON.stringify({ pid: process.pid, host: os.hostname(), started_at: new Date().toISOString(), token: "replacement" });
    fs.writeFileSync(lockPath, replacement, "utf8");
    lock.release();
    assert.equal(fs.existsSync(lockPath), true);
  });
});
