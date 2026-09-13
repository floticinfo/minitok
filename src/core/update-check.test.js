"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { shouldNotify, isNewerVersion, notifyIfOutdated, scheduleRefresh, writeCacheAtomic } = require("./update-check");

function tmpCachePath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mt-upd-")), "update-check.json");
}

describe("isNewerVersion", () => {
  it("compares semver components", () => {
    assert.equal(isNewerVersion("1.3.2", "1.3.1"), true);
    assert.equal(isNewerVersion("1.4.0", "1.3.9"), true);
    assert.equal(isNewerVersion("2.0.0", "1.9.9"), true);
    assert.equal(isNewerVersion("1.3.1", "1.3.1"), false);
    assert.equal(isNewerVersion("1.3.0", "1.3.1"), false);
    assert.equal(isNewerVersion("1.3.0-beta.2", "1.3.0-beta.1"), true);
    assert.equal(isNewerVersion("1.3.0", "1.3.0-rc.1"), true);
    assert.equal(isNewerVersion("1.3.0-alpha", "1.3.0"), false);
    assert.equal(isNewerVersion("1.3.0-beta.10", "1.3.0-beta.2"), true);
  });
});

describe("shouldNotify", () => {
  const now = Date.now();
  it("notifies once for a newer cached version", () => {
    const cache = { lastCheck: now, latest: "1.4.0" };
    assert.equal(shouldNotify(cache, "1.3.1", now).notify, true);
    const after = { ...cache, notifiedVersion: "1.4.0" };
    assert.equal(shouldNotify(after, "1.3.1", now).notify, false);
  });
  it("does not notify without cache or for same/older versions", () => {
    assert.equal(shouldNotify(null, "1.3.1", now).notify, false);
    assert.equal(shouldNotify({ lastCheck: now, latest: "1.3.1" }, "1.3.1", now).notify, false);
    assert.equal(shouldNotify({ lastCheck: now, latest: "1.2.0" }, "1.3.1", now).notify, false);
  });
});

describe("update cache writes", () => {
  it("keeps concurrent refreshes parseable", async () => {
    const cachePath = tmpCachePath();
    const fetchImpl = async () => ({ ok: true, json: async () => ({ version: "9.9.9" }) });
    scheduleRefresh({ cachePath, fetchImpl, now: Date.now() });
    scheduleRefresh({ cachePath, fetchImpl, now: Date.now() });
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(JSON.parse(fs.readFileSync(cachePath, "utf8")).latest, "9.9.9");
  });

  it("merges concurrent notification and refresh fields", () => {
    const cachePath = tmpCachePath();
    fs.writeFileSync(cachePath, JSON.stringify({ lastCheck: 1, latest: "9.9.9" }), "utf8");
    writeCacheAtomic(cachePath, { notifiedVersion: "9.9.9" });
    writeCacheAtomic(cachePath, { lastCheck: 2, latest: "10.0.0" });
    assert.deepEqual(JSON.parse(fs.readFileSync(cachePath, "utf8")), { lastCheck: 2, latest: "10.0.0", notifiedVersion: "9.9.9" });
  });

  it("reclaims a lock whose owner process is gone", () => {
    const cachePath = tmpCachePath();
    fs.writeFileSync(`${cachePath}.lock`, JSON.stringify({ pid: 0x7ffffffe, host: os.hostname(), token: "dead", createdAt: Date.now() }), "utf8");
    writeCacheAtomic(cachePath, { lastCheck: 3, latest: "11.0.0" });
    assert.deepEqual(JSON.parse(fs.readFileSync(cachePath, "utf8")), { lastCheck: 3, latest: "11.0.0" });
    assert.equal(fs.existsSync(`${cachePath}.lock`), false, "the lock is released after the write");
  });

  it("does not steal a fresh lock written by another host", () => {
    const cachePath = tmpCachePath();
    // A shared home directory (roaming profile, network mount) cannot be probed
    // for liveness, so only age may decide: a live remote writer keeps its lock.
    fs.writeFileSync(`${cachePath}.lock`, JSON.stringify({ pid: 1, host: "another-host", token: "remote", createdAt: Date.now() }), "utf8");
    assert.throws(() => writeCacheAtomic(cachePath, { lastCheck: 4, latest: "12.0.0" }), /Unable to acquire update cache lock/);
    assert.equal(fs.existsSync(`${cachePath}.lock`), true, "the remote lock is left alone");
    assert.equal(fs.existsSync(cachePath), false, "nothing is written while another host holds the lock");
  });

  it("reclaims a lock that is older than the stale window", () => {
    const cachePath = tmpCachePath();
    fs.writeFileSync(`${cachePath}.lock`, JSON.stringify({ pid: 1, host: "another-host", token: "ancient", createdAt: Date.now() - 60000 }), "utf8");
    writeCacheAtomic(cachePath, { lastCheck: 5, latest: "13.0.0" });
    assert.deepEqual(JSON.parse(fs.readFileSync(cachePath, "utf8")), { lastCheck: 5, latest: "13.0.0" });
  });
});

describe("notifyIfOutdated", () => {
  it("writes a notice to the stream and marks the version notified", () => {
    const cachePath = tmpCachePath();
    fs.writeFileSync(cachePath, JSON.stringify({ lastCheck: Date.now(), latest: "9.9.9" }), "utf-8");
    const chunks = [];
    const stream = { write: (s) => chunks.push(s) };
    const d1 = notifyIfOutdated({ cachePath, stream, currentVersion: "1.3.1" });
    assert.equal(d1.notify, true);
    assert.ok(chunks[0].includes("9.9.9"));
    const d2 = notifyIfOutdated({ cachePath, stream, currentVersion: "1.3.1" });
    assert.equal(d2.notify, false, "second run must not repeat the notice");
  });
});
