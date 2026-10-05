"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  createRunSession,
  appendRunEvent,
  listRunSessions,
} = require("../src/cli/commands/run-session-store");

function withTempRepo(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mt-sess-"));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("listRunSessions returns a renderable summary with last_task (no raw events)", () =>
  withTempRepo((repo) => {
    const session = createRunSession(repo, "first task text");
    appendRunEvent(repo, session, { type: "task", text: "follow up task text" });
    const sessions = listRunSessions(repo);
    assert.equal(sessions.length, 1);
    const summary = sessions[0];
    assert.equal(summary.turns, 2);
    assert.equal(summary.last_task, "follow up task text");
    assert.equal(summary.events, undefined, "summary must not leak raw event history");
    assert.ok(summary.id && summary.updated_at);
  }));

test("listRunSessions last_task is empty when the session has no task events", () =>
  withTempRepo((repo) => {
    const session = createRunSession(repo, "seed");
    // strip the auto-recorded first task to simulate an empty session
    session.events = session.events.filter((e) => e.type !== "task");
    appendRunEvent(repo, session, { type: "result", text: "done" });
    const [summary] = listRunSessions(repo);
    assert.equal(summary.turns, 0);
    assert.equal(summary.last_task, "");
  }));

test("listRunSessions returns [] for a repository with no sessions", () =>
  withTempRepo((repo) => {
    assert.deepEqual(listRunSessions(repo), []);
  }));
