"use strict";

/**
 * KnowledgeStore — append-only evolution outcome storage.
 *
 * Mirrors Python version's knowledge/store.py:
 * stores EvolutionOutcome records in ~/.minitok/evolution/outcomes.json
 * with a bounded rolling window.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const { randomUUID } = require("crypto");
const { setOwnerOnlyPermissions } = require("../utils/file-permissions");

const MAX_OUTCOMES = 100; // rolling window
const LOCK_TIMEOUT_MS = 30000;
const LOCK_STALE_MS = 120000;
const LOCK_RETRY_DELAY_MS = 50;
const DEFAULT_PATH = path.join(os.homedir(), ".minitok", "evolution", "outcomes.json");

/**
 * Blocking sleep used by the lock retry loop. The loop is synchronous, and
 * re-reading the lock file with no delay burned a full CPU core for the whole
 * LOCK_TIMEOUT_MS whenever another run held the lock.
 */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

class KnowledgeStore {
  constructor(filePath) {
    this._file = filePath || DEFAULT_PATH;
    this._outcomes = this._load();
  }

  _load() {
    try {
      const data = fs.readFileSync(this._file, "utf-8");
      const parsed = JSON.parse(data);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  _acquireLock(timeoutMs = LOCK_TIMEOUT_MS) {
    const lock = this._file + ".lock";
    const started = Date.now();
    fs.mkdirSync(path.dirname(this._file), { recursive: true });
    while (Date.now() - started < timeoutMs) {
      try {
        const token = randomUUID();
        const fd = fs.openSync(lock, "wx", 0o600);
        fs.writeSync(fd, JSON.stringify({ pid: process.pid, host: os.hostname(), token, created_at: Date.now(), heartbeat_at: Date.now() }), 0, "utf8");
        const heartbeat = setInterval(() => {
          try {
            const owner = JSON.parse(fs.readFileSync(lock, "utf8"));
            if (owner.pid === process.pid && owner.host === os.hostname() && owner.token === token) {
              fs.ftruncateSync(fd, 0);
              fs.writeSync(fd, JSON.stringify({ ...owner, heartbeat_at: Date.now() }), 0, "utf8");
              fs.futimesSync(fd, new Date(), new Date());
            }
          } catch {}
        }, Math.max(1000, Math.floor(LOCK_STALE_MS / 3)));
        heartbeat.unref();
        return { fd, lock, token, heartbeat };
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        try {
          const current = JSON.parse(fs.readFileSync(lock, "utf8"));
          let alive = false;
          if (current.host === os.hostname() && Number.isInteger(current.pid)) {
            try { process.kill(current.pid, 0); alive = true; } catch {}
          }
          const stat = fs.statSync(lock);
          const heartbeatAt = Number(current.heartbeat_at || current.created_at || stat.mtimeMs);
          if (!alive && Number.isFinite(heartbeatAt) && Date.now() - heartbeatAt > LOCK_STALE_MS) {
            const observedToken = current.token;
            const latest = JSON.parse(fs.readFileSync(lock, "utf8"));
            if (latest.token === observedToken) fs.unlinkSync(lock);
          }
        } catch (staleError) {
          if (staleError.code !== "ENOENT") throw staleError;
        }
        // Back off instead of spinning: the holder keeps the lock for the whole
        // duration of its write.
        sleepSync(LOCK_RETRY_DELAY_MS);
      }
    }
    throw new Error("KnowledgeStore lock acquisition timed out");
  }

  _releaseLock(lockState) {
    clearInterval(lockState.heartbeat);
    try { fs.closeSync(lockState.fd); } catch {}
    try {
      const owner = JSON.parse(fs.readFileSync(lockState.lock, "utf8"));
      if (owner.pid === process.pid && owner.host === os.hostname() && owner.token === lockState.token) fs.unlinkSync(lockState.lock);
    } catch (error) {
      // A corrupt lock file (crash mid-write) parses as a syntax error with no
      // `code`; it must not mask the caller's real error path.
      if (error.code && error.code !== "ENOENT") throw error;
    }
  }

  _save() {
    const dir = path.dirname(this._file);
    fs.mkdirSync(dir, { recursive: true });
    if (this._outcomes.length > MAX_OUTCOMES) this._outcomes = this._outcomes.slice(-MAX_OUTCOMES);
    const tmp = this._file + ".tmp." + process.pid + "." + Date.now();
    try {
      fs.writeFileSync(tmp, JSON.stringify(this._outcomes, null, 2), { encoding: "utf-8", mode: 0o600 });
      fs.renameSync(tmp, this._file);
      setOwnerOnlyPermissions(this._file);
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch {}
      throw e;
    }
  }

  /**
   * Record an evolution outcome.
   * @param {object} outcome
   * @param {string} outcome.goal - original task goal
   * @param {string} outcome.status - success|failure|partial
   * @param {number} outcome.cycles - number of cycles taken
   * @param {number} outcome.total_cost - total LLM cost
   * @param {number} outcome.duration_ms - wall clock time
   * @param {number} outcome.files_changed - files modified
   * @param {string} [outcome.failure_category] - lint|test|validation|timeout|api_error
   * @param {string} [outcome.summary] - human-readable summary
   * @param {object} [outcome.policy_snapshot] - execution policy at time of run
   */
  record(outcome) {
    const record = {
      timestamp: new Date().toISOString(),
      ...outcome,
    };
    const lockState = this._acquireLock();
    try {
      this._outcomes = this._load();
      this._outcomes.push(record);
      this._save();
    } finally {
      this._releaseLock(lockState);
    }
    return record;
  }

  /** Get all recorded outcomes. */
  getAll(project) {
    const outcomes = [...this._outcomes];
    return project ? outcomes.filter(outcome => outcome.project === project) : outcomes;
  }

  /** Get the last N outcomes. */
  recent(n = 10, project) { return this.getAll(project).slice(-n); }

  /** Count outcomes with a given status. */
  countByStatus(status) { return this._outcomes.filter(o => o.status === status).length; }

  /** Total number of outcomes. */
  get size() { return this._outcomes.length; }

  /** Compute aggregate stats. */
  stats() {
    const total = this._outcomes.length;
    if (total === 0) return { total: 0, success_rate: 0, avg_cycles: 0, avg_cost: 0 };

    const successes = this._outcomes.filter(o => o.status === "success").length;
    const avgCycles = this._outcomes.reduce((s, o) => s + (o.cycles || 0), 0) / total;
    const avgCost = this._outcomes.reduce((s, o) => s + (o.total_cost || 0), 0) / total;

    return {
      total,
      success_rate: successes / total,
      avg_cycles: Math.round(avgCycles * 100) / 100,
      avg_cost: Math.round(avgCost * 10000) / 10000,
    };
  }
}

module.exports = { KnowledgeStore, MAX_OUTCOMES, DEFAULT_PATH, sleepSync, LOCK_RETRY_DELAY_MS };
