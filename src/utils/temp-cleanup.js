"use strict";

/**
 * Reclaim abandoned temporary entries.
 *
 * Both the pipeline and the test suite create `minitok-*` directories under the
 * OS temp directory and remove them in a `finally` block. A crash, a SIGKILL or
 * an interrupted test run skips that block, and nothing ever collected the
 * leftovers — measured residue reached 6,306 entries / 5.1 GB on this machine.
 *
 * The reclamation rule has to be safe against a *concurrent* run, so age is the
 * only signal used: an entry is reclaimed only when nothing has touched it for
 * longer than the retention window. A live run keeps writing inside its own
 * directory, which keeps its mtime current, so it is never a candidate.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const DEFAULT_RETENTION_MS = 6 * 60 * 60 * 1000;
const DEFAULT_PROTECT_MS = 10 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 200;
// The sweep runs on the pipeline startup path, so it is time-boxed: a large
// backlog is reclaimed progressively over successive runs instead of delaying
// every run while it drains. Pass timeBudgetMs: 0 for an unbounded sweep.
const DEFAULT_TIME_BUDGET_MS = 250;
const DEFAULT_MAX_SCAN = 20000;

/**
 * Prefixes owned by this product and its tests.
 *
 * A three character prefix such as `mt-` is deliberately absent: it is short
 * enough that unrelated tools use it, and reclaiming foreign entries would delete
 * another program's data. Add it back explicitly with `--prefixes minitok-,mt-`
 * when a machine has legacy `mt-` fixtures to collect.
 */
const DEFAULT_PREFIXES = Object.freeze(["minitok-", "mtok-", "evo-optin-"]);

function lastActivityMs(stat) {
  // mtime is the last write; ctime is the last inode change (creation time on
  // Windows). Whichever is newer is the best evidence that the entry is live.
  return Math.max(Number(stat.mtimeMs) || 0, Number(stat.ctimeMs) || 0);
}

/**
 * @param {object} [options]
 * @param {string} [options.tmpdir] directory to scan (defaults to os.tmpdir())
 * @param {string[]} [options.prefixes] name prefixes to consider
 * @param {number} [options.retentionMs] minimum untouched age before reclaiming
 * @param {number} [options.protectMs] age below which an entry is always kept
 * @param {number} [options.maxEntries] upper bound on removals per sweep
 * @param {number} [options.now] clock override (tests use a synthetic time)
 * @param {number} [options.maxScan] upper bound on entries inspected
 * @param {number} [options.timeBudgetMs] wall-clock budget for one sweep
 * @param {boolean} [options.dryRun] report candidates without removing them
 * @param {object} [options.fsImpl] fs implementation override
 * @returns {{scanned: number, removed: number, kept: number, errors: number, drained: boolean}}
 */
function sweepTempEntries(options = {}) {
  const {
    tmpdir = os.tmpdir(),
    prefixes = DEFAULT_PREFIXES,
    retentionMs = DEFAULT_RETENTION_MS,
    protectMs = DEFAULT_PROTECT_MS,
    maxEntries = DEFAULT_MAX_ENTRIES,
    maxScan = DEFAULT_MAX_SCAN,
    timeBudgetMs = DEFAULT_TIME_BUDGET_MS,
    dryRun = false,
    now = Date.now(),
    fsImpl = fs,
  } = options;

  const summary = { scanned: 0, candidates: 0, removed: 0, kept: 0, errors: 0, drained: true };
  const list = Array.isArray(prefixes) ? prefixes.filter(prefix => typeof prefix === "string" && prefix) : DEFAULT_PREFIXES;
  if (!list.length) return summary;

  let entries;
  try {
    entries = fsImpl.readdirSync(tmpdir, { withFileTypes: true });
  } catch {
    summary.drained = false;
    return summary;
  }

  const window = Math.max(Number(retentionMs) || 0, Number(protectMs) || 0);
  const budgetMs = Number(timeBudgetMs);
  const deadline = Number.isFinite(budgetMs) && budgetMs > 0 ? Date.now() + budgetMs : Infinity;
  const candidates = [];
  for (const entry of entries) {
    if (summary.scanned >= maxScan || Date.now() >= deadline) { summary.drained = false; break; }
    if (!entry.isDirectory() && !entry.isFile()) continue;
    if (!list.some(prefix => entry.name.startsWith(prefix))) continue;
    summary.scanned += 1;
    const full = path.join(tmpdir, entry.name);
    let stat;
    try {
      stat = fsImpl.statSync(full, { throwIfNoEntry: false });
    } catch {
      stat = null;
    }
    if (!stat) { summary.errors += 1; continue; }
    const activity = lastActivityMs(stat);
    if (now - activity < window) { summary.kept += 1; continue; }
    candidates.push({ full, activity });
  }

  // Oldest first, so a bounded budget reclaims the worst offenders.
  candidates.sort((a, b) => a.activity - b.activity);
  summary.candidates = candidates.length;
  const budget = Math.max(0, Number(maxEntries) || 0);
  let attempted = 0;
  for (const candidate of candidates.slice(0, budget)) {
    if (Date.now() >= deadline) { summary.drained = false; break; }
    attempted += 1;
    if (dryRun) { summary.kept += 1; continue; }
    try {
      fsImpl.rmSync(candidate.full, { recursive: true, force: true });
      summary.removed += 1;
    } catch {
      summary.errors += 1;
    }
  }
  const skipped = candidates.length - attempted;
  summary.kept += skipped;
  if (skipped > 0) summary.drained = false;
  return summary;
}

module.exports = { sweepTempEntries, DEFAULT_PREFIXES, DEFAULT_RETENTION_MS, DEFAULT_PROTECT_MS, DEFAULT_MAX_ENTRIES, DEFAULT_TIME_BUDGET_MS, DEFAULT_MAX_SCAN };
