"use strict";

/**
 * Run lock — prevents concurrent `minitok run` invocations from racing on
 * the same workspace (.minitok state, knowledge store, applied diffs).
 *
 * Cross-platform, dependency-free: an exclusive file creation (O_EXCL via
 * 'wx') plus PID/age-based stale detection. A lock left behind by a crashed
 * process is reported as stale when its PID is no longer alive on the same
 * host, or when it exceeds the maximum expected run duration.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const LOCK_FILE = path.join(".minitok", "run.lock");
const STALE_MS = 24 * 60 * 60 * 1000;
// An existing lock file that cannot be read yet may be mid-write by its owner:
// ownership is written immediately after the exclusive create, but a reader can
// observe the zero-byte window. Reclaiming such a file on sight let two runs own
// the same workspace at once, which is the race this lock exists to prevent.
const LOCK_GRACE_MS = 5 * 1000;

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function readLockInfo(lockPath) {
  try {
    const info = JSON.parse(fs.readFileSync(lockPath, "utf-8"));
    // A non-object payload is as unusable as a truncated one; treating it as
    // "no owner" keeps the stale decision in one place.
    return info && typeof info === "object" && !Array.isArray(info) ? info : null;
  } catch {
    return null;
  }
}

function lockIsStale(lockPath) {
  const info = readLockInfo(lockPath);
  if (!info) {
    // Empty, truncated or otherwise unreadable. Old enough ⇒ the writer died
    // between create and write; still fresh ⇒ the owner may be writing right now.
    try {
      return Date.now() - fs.statSync(lockPath).mtimeMs > LOCK_GRACE_MS;
    } catch {
      // The file vanished between EEXIST and this check: the owner released it.
      return true;
    }
  }
  const sameHost = !info.host || info.host === os.hostname();
  const pidKnown = Number.isInteger(info.pid) && info.pid > 0;
  // Only a lock that names a PID on this host can be judged by liveness, and an
  // unknown PID must not be read as "dead" — that turned a foreign or corrupt
  // record into an invitation to steal the lock.
  if (sameHost && pidKnown && !isPidAlive(info.pid)) return true;
  const startedAt = info.started_at ? new Date(info.started_at).getTime() : NaN;
  if (!Number.isNaN(startedAt) && Date.now() - startedAt > STALE_MS) return true;
  return false;
}

function acquireRunLock(workspaceRoot, _attempts = 0) {
  const directory = path.join(workspaceRoot, ".minitok");
  fs.mkdirSync(directory, { recursive: true });
  const lockPath = path.join(directory, "run.lock");
  let fd;
  try {
    fd = fs.openSync(lockPath, "wx");
  } catch (error) {
    const code = /** @type {NodeJS.ErrnoException} */ (error).code;
    if (code !== "EEXIST") throw error;
    if (!lockIsStale(lockPath)) {
      const info = readLockInfo(lockPath);
      const busy = new Error(
        `Another minitok run is already in progress for this workspace (PID ${info?.pid ?? "?"}). ` +
        `If no run is active, delete ${lockPath} and retry.`
      );
      /** @type {NodeJS.ErrnoException} */ (busy).code = "minitok_run_locked";
      throw busy;
    }
    try {
      fs.unlinkSync(lockPath);
    } catch (unlinkError) {
      // A stuck undeletable lock (AV scan, open handle) must not recurse
      // forever — fail with actionable guidance after a few bounded tries.
      if (_attempts >= 3) {
        const err = new Error(`Stale run lock at ${lockPath} could not be removed (${unlinkError.code || unlinkError.message}). Delete it manually and retry.`);
        /** @type {NodeJS.ErrnoException} */ (err).code = "minitok_run_lock_stuck";
        throw err;
      }
    }
    return acquireRunLock(workspaceRoot, _attempts + 1);
  }
  const token = crypto.randomBytes(16).toString("hex");
  const ownership = JSON.stringify({ pid: process.pid, host: os.hostname(), started_at: new Date().toISOString(), token });
  try {
    fs.writeFileSync(fd, ownership, "utf-8");
  } catch (writeError) {
    // If the ownership record cannot be written, the lock file is
    // empty/invalid: other processes would see an unreadable lock and
    // potentially reclaim it after the grace period. Close the fd and
    // remove the file so the next acquire can start clean.
    try { fs.closeSync(fd); } catch {}
    try { fs.unlinkSync(lockPath); } catch {}
    const err = new Error(`Failed to write run lock ownership: ${writeError.message}`);
    /** @type {NodeJS.ErrnoException} */ (err).code = "minitok_run_lock_write";
    throw err;
  }
  let released = false;
  return {
    path: lockPath,
    release() {
      if (released) return;
      released = true;
      try {
        fs.closeSync(fd);
      } catch {}
      const info = readLockInfo(lockPath);
      if (info?.pid !== process.pid || (info.host && info.host !== os.hostname()) || info.token !== token) return;
      try {
        fs.unlinkSync(lockPath);
      } catch {}
    },
  };
}

module.exports = { acquireRunLock, LOCK_FILE, STALE_MS, LOCK_GRACE_MS };
