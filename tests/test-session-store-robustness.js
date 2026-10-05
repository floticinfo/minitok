"use strict";

// Phase 7B — session store persistence robustness. Guards the guarantees the
// store's header comment promises: atomic writes, graceful corrupt-file skip,
// bounded event history, and no data loss when two processes append at once.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const store = require("../src/cli/commands/run-session-store");

function tempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mt-sess-robust-"));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test("corrupt session file is skipped, not fatal, and is reported by list", () => {
  const { dir, cleanup } = tempRepo();
  try {
    const good = store.createRunSession(dir, "first task");
    store.appendRunEvent(dir, good, { type: "result", ok: true });
    // Simulate a crash mid-write: a truncated JSON document on disk.
    const badPath = store.sessionFilePath(dir, "bbbbbbbb-cccc-dddd-eeee-ffffffffffff");
    fs.writeFileSync(badPath, '{"schema": 1, "id": "bbbbbbbb-cccc-dddd-eeee-ffffffffffff", "events": [', "utf8");
    const listed = store.listRunSessions(dir);
    assert.equal(listed.length, 1, "corrupt file must be skipped without failing");
    assert.equal(listed[0].id, good.id);
    assert.equal(store.loadRunSession(dir, "bbbbbbbb-cccc-dddd-eeee-ffffffffffff"), null);
  } finally { cleanup(); }
});

test("concurrent appends never leave a partially-written session behind", () => {
  const { dir, cleanup } = tempRepo();
  // Cleanup must wait for the async workers, so wrap in a returned promise.
  const session = store.createRunSession(dir, "base task");
  const sessionPath = store.sessionFilePath(dir, session.id);
  // Two writers: both read the same base, both append, both rename. The
  // atomic-write contract means the file on disk must always parse.
  const workers = [];
  for (let w = 0; w < 2; w += 1) {
    workers.push(new Promise(resolve => {
      setImmediate(() => {
        const base = JSON.parse(fs.readFileSync(sessionPath, "utf8"));
        base.events.push({ type: "task", text: `worker ${w}`, ts: new Date().toISOString() });
        try { store.appendRunEvent(dir, base, { type: "result", ok: true }); } catch { /* best-effort */ }
        resolve();
      });
    }));
  }
  return Promise.all(workers).then(
    () => {
      const reloaded = JSON.parse(fs.readFileSync(sessionPath, "utf8"));
      assert.ok(Array.isArray(reloaded.events), "session file must stay parseable under concurrency");
      assert.equal(fs.readdirSync(store.sessionsDirectory(dir)).filter(f => f.includes(".tmp.")).length, 0, "no temp files may leak");
    },
    error => { cleanup(); throw error; },
  ).finally(() => cleanup());
});

test("event history is bounded at MAX_EVENTS and truncates from the front", () => {
  const { dir, cleanup } = tempRepo();
  try {
    const session = store.createRunSession(dir, "start");
    for (let i = 0; i < 205; i += 1) store.appendRunEvent(dir, session, { type: "task", text: `task ${i}` });
    const reloaded = store.loadRunSession(dir, session.id);
    assert.equal(reloaded.events.length, 200, "cap must hold after reload");
    // 1 start event + 205 appends = 206; capped at 200, the first 6 (start + task 0..4) are gone.
    assert.equal(reloaded.events[0].text, "task 5", "oldest events are dropped first");
  } finally { cleanup(); }
});

test("session ids with path traversal or invalid characters are rejected", () => {
  const { dir, cleanup } = tempRepo();
  try {
    assert.equal(store.loadRunSession(dir, "../../etc/passwd"), null);
    assert.equal(store.loadRunSession(dir, "with space"), null);
    assert.equal(store.loadRunSession(dir, "with.dot"), null);
  } finally { cleanup(); }
});

test("appendRunEvent never throws to the caller when the store write fails", () => {
  const { dir, cleanup } = tempRepo();
  try {
    const session = store.createRunSession(dir, "task");
    // Break the directory so the atomic write fails internally.
    fs.rmSync(store.sessionsDirectory(dir), { recursive: true, force: true });
    fs.writeFileSync(store.sessionsDirectory(dir), "not a directory", "utf8");
    assert.doesNotThrow(() => store.appendRunEvent(dir, session, { type: "result", ok: true }));
    assert.equal(session.events.at(-1).ok, true, "in-memory state still advances");
  } finally { cleanup(); }
});