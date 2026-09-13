"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { KnowledgeStore, sleepSync, LOCK_RETRY_DELAY_MS } = require("./knowledge");

function tmpStore() {
  return new KnowledgeStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mt-knowledge-")), "outcomes.json"));
}

describe("knowledge store: lock back-off", () => {
  it("sleeps instead of spinning while another process holds the lock", () => {
    const store = tmpStore();
    const lock = `${store._file}.lock`;
    fs.mkdirSync(path.dirname(store._file), { recursive: true });
    // Held by this live process, so it is never considered stale: the only way
    // out of the retry loop is the timeout.
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, host: os.hostname(), token: "held", created_at: Date.now(), heartbeat_at: Date.now() }));
    const before = process.cpuUsage();
    const startedAt = Date.now();
    assert.throws(() => store._acquireLock(400), /lock acquisition timed out/);
    const elapsed = Date.now() - startedAt;
    const cpu = process.cpuUsage(before);
    assert.ok(elapsed >= 350, `waited for the timeout (${elapsed}ms)`);
    // A busy-wait retry loop burned the whole wait in CPU; with the back-off the
    // process stays close to idle.
    const cpuMs = (cpu.user + cpu.system) / 1000;
    assert.ok(cpuMs < elapsed / 2, `expected a back-off, used ${cpuMs}ms CPU over ${elapsed}ms`);
    fs.rmSync(path.dirname(store._file), { recursive: true, force: true });
  });

  it("takes over a lock abandoned by a dead process", () => {
    const store = tmpStore();
    const lock = `${store._file}.lock`;
    fs.mkdirSync(path.dirname(store._file), { recursive: true });
    fs.writeFileSync(lock, JSON.stringify({ pid: 2147483646, host: os.hostname(), token: "dead", created_at: Date.now() - 600000, heartbeat_at: Date.now() - 600000 }));
    const state = store._acquireLock(2000);
    assert.equal(typeof state.token, "string");
    store._releaseLock(state);
    assert.equal(fs.existsSync(lock), false);
    fs.rmSync(path.dirname(store._file), { recursive: true, force: true });
  });

  it("blocks for at least the requested delay", () => {
    const startedAt = Date.now();
    sleepSync(60);
    assert.ok(Date.now() - startedAt >= 40, "sleepSync actually waits");
    assert.ok(LOCK_RETRY_DELAY_MS > 0);
  });
});
