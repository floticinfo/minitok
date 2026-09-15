"use strict";

/**
 * Update check — cache-then-notify, zero added latency.
 *
 * On every invocation the cached registry snapshot is compared against the
 * running version; a newer version prints a one-line stderr notice. A
 * registry refresh is scheduled in the background (unref'd, 2s timeout) and
 * only ever affects the NEXT invocation.
 *
 * Opt-out: MINITOK_UPDATE_CHECK=0, minitok_no_update_check=1, or NO_UPDATE_NOTIFIER=1. Skipped in CI.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { minitokVersion } = require("./version");
const { readEnv } = require("./env");

const PKG_NAME = "@flotic/minitok";
const REGISTRY_URL = `https://registry.npmjs.org/${encodeURIComponent(PKG_NAME).replace("%40", "@").replace("/", "%2F")}/latest`;
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

function cacheFilePath() {
  return path.join(os.homedir(), ".minitok", "update-check.json");
}

function parseVersion(value) {
  const match = String(value).trim().match(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!match) return null;
  const identifiers = match[4] ? match[4].split(".") : [];
  return { numbers: match.slice(1, 4).map(Number), identifiers };
}

function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return null;
  for (let index = 0; index < 3; index++) if (a.numbers[index] !== b.numbers[index]) return a.numbers[index] > b.numbers[index] ? 1 : -1;
  if (!a.identifiers.length && !b.identifiers.length) return 0;
  if (!a.identifiers.length) return 1;
  if (!b.identifiers.length) return -1;
  for (let index = 0; index < Math.max(a.identifiers.length, b.identifiers.length); index++) {
    if (a.identifiers[index] === undefined) return -1;
    if (b.identifiers[index] === undefined) return 1;
    if (a.identifiers[index] === b.identifiers[index]) continue;
    const aNumeric = /^\d+$/.test(a.identifiers[index]);
    const bNumeric = /^\d+$/.test(b.identifiers[index]);
    if (aNumeric && bNumeric) return Number(a.identifiers[index]) > Number(b.identifiers[index]) ? 1 : -1;
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
    return a.identifiers[index] > b.identifiers[index] ? 1 : -1;
  }
  return 0;
}

function isNewerVersion(candidate, current) {
  return compareVersions(candidate, current) === 1;
}

function readCache(cachePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath, "utf-8"));
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Decide whether a notice should be shown, given the current cache state.
 * @returns {{ notify: boolean, latest: string|null }}
 */
function shouldNotify(cache, currentVersion, now = Date.now()) {
  if (!cache || typeof cache.lastCheck !== "number" || typeof cache.latest !== "string") {
    return { notify: false, latest: null };
  }
  if (!isNewerVersion(cache.latest, currentVersion)) return { notify: false, latest: cache.latest };
  if (cache.notifiedVersion === cache.latest) return { notify: false, latest: cache.latest };
  if (now - cache.lastCheck > CHECK_INTERVAL_MS * 7) return { notify: false, latest: cache.latest };
  return { notify: true, latest: cache.latest };
}

function writeCacheAtomic(cachePath, data) {
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  const lockPath = `${cachePath}.lock`;
  let lockFd;
  const token = crypto.randomBytes(8).toString("hex");
  // 40 attempts of ~5 ms bound the wait at roughly 200 ms: update-check runs on
  // every CLI invocation, so a slower writer must not delay the command.
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      lockFd = fs.openSync(lockPath, "wx", 0o600);
      fs.writeFileSync(lockFd, JSON.stringify({ pid: process.pid, host: os.hostname(), token, createdAt: Date.now() }));
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let stale;
      let observedToken;
      try {
        const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
        observedToken = lock.token;
        let alive = false;
        if (lock.host === os.hostname() && Number.isInteger(lock.pid)) {
          try { process.kill(lock.pid, 0); alive = true; } catch {}
        } else {
          // A lock written by another machine that shares this home directory
          // (a roaming profile, a network mount) cannot be probed for liveness:
          // only its age may decide, so a live remote writer is not overridden.
          alive = true;
        }
        stale = !lock || typeof lock.createdAt !== "number" || Date.now() - lock.createdAt > 30000 || !alive;
      } catch { stale = true; }
      if (stale) {
        try {
          const current = JSON.parse(fs.readFileSync(lockPath, "utf8"));
          if (current.token === observedToken) fs.unlinkSync(lockPath);
        } catch {}
      } else Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  }
  if (lockFd === undefined) throw new Error("Unable to acquire update cache lock");
  try {
    const current = readCache(cachePath) || {};
    const merged = { ...current, ...data };
    const tmp = `${cachePath}.tmp.${process.pid}.${crypto.randomBytes(6).toString("hex")}`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(merged, null, 2), { encoding: "utf-8", flag: "wx" });
      fs.renameSync(tmp, cachePath);
    } finally {
      try { fs.unlinkSync(tmp); } catch {}
    }
  } finally {
    try { fs.closeSync(lockFd); } catch {}
    try {
      const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
      if (lock.token === token && lock.pid === process.pid && lock.host === os.hostname()) fs.unlinkSync(lockPath);
    } catch {}
  }
}

function notifyIfOutdated({ cachePath = cacheFilePath(), now = Date.now(), stream = process.stderr, currentVersion = minitokVersion } = {}) {
  const cache = readCache(cachePath);
  const decision = shouldNotify(cache, currentVersion, now);
  if (decision.notify && stream && typeof stream.write === "function") {
    stream.write(`Update available: minitok ${decision.latest} (installed: ${currentVersion}). Run 'npm install -g ${PKG_NAME}' to update.\n`);
    try {
      writeCacheAtomic(cachePath, { ...cache, notifiedVersion: decision.latest });
    } catch {}
  }
  return decision;
}

function scheduleRefresh({ cachePath = cacheFilePath(), fetchImpl = fetch, timeoutMs = 2000, now = Date.now() } = {}) {
  const timer = setTimeout(() => {
    const controller = new AbortController();
    const kill = setTimeout(() => controller.abort(), timeoutMs);
    // The refresh is best-effort and must never keep a short-lived CLI alive.
    kill.unref();
    const { getProxyDispatcher } = require("./http");
    const dispatcher = getProxyDispatcher(REGISTRY_URL);
    fetchImpl(REGISTRY_URL, { signal: controller.signal, ...(dispatcher ? { dispatcher } : {}) })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        clearTimeout(kill);
        if (data && typeof data.version === "string") {
          const cache = readCache(cachePath) || {};
          writeCacheAtomic(cachePath, { ...cache, lastCheck: now, latest: data.version });
        }
      })
      .catch(() => {})
      .finally(() => clearTimeout(kill));
  }, 50);
  timer.unref();
}

/**
 * Public entry point: print a notice if a newer release was already seen,
 * and schedule a silent registry refresh for future invocations.
 */
function checkForUpdate() {
  if (readEnv("MINITOK_UPDATE_CHECK") === "0" || readEnv("minitok_no_update_check") === "1" || process.env.NO_UPDATE_NOTIFIER === "1" || process.env.CI) return;
  try {
    notifyIfOutdated();
    scheduleRefresh();
  } catch {}
}

function getUpdateStatus({ cachePath = cacheFilePath(), currentVersion = minitokVersion } = {}) {
  const cache = readCache(cachePath);
  return { current: currentVersion, latest: cache?.latest || currentVersion, updateAvailable: Boolean(cache?.latest && isNewerVersion(cache.latest, currentVersion)) };
}

module.exports = { checkForUpdate, shouldNotify, isNewerVersion, notifyIfOutdated, scheduleRefresh, cacheFilePath, REGISTRY_URL, CHECK_INTERVAL_MS, writeCacheAtomic, getUpdateStatus };
