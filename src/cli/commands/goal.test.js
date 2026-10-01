"use strict";
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { compileGoal } = require("../../goal/compiler");
const { createGoalSession, releaseGoalSessionLock } = require("../../goal/session");
const { cmdGoalStatus, cmdGoalList, register } = require("./goal");

function captureConsole(fn) {
  const logs = [];
  const errors = [];
  const savedLog = console.log;
  const savedError = console.error;
  console.log = (...args) => logs.push(args.join(" "));
  console.error = (...args) => errors.push(args.join(" "));
  return Promise.resolve()
    .then(() => fn())
    .then(result => ({ result, logs, errors }), error => ({ result: error, logs, errors }))
    .finally(() => {
      console.log = savedLog;
      console.error = savedError;
    });
}

function tempWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "minitok-goal-cli-"));
}

function makeSession(root, objective) {
  const compiled = compileGoal(objective, { goalId: `goal-${Date.now()}-${Math.random().toString(16).slice(2, 8)}` });
  assert.equal(compiled.status, "ready", `objective must compile: ${objective}`);
  return createGoalSession({ goalSpec: compiled.spec, workspaceRoot: root });
}

describe("goal cli human output and listing", () => {
  it("goal status prints the goal id and an actionable command in human mode", async () => {
    const root = tempWorkspace();
    let session = null;
    try {
      session = makeSession(root, "verify that the file index.js exists");
      const goalId = session.goalSpec.goal_id;
      const run = await captureConsole(() => cmdGoalStatus(goalId, { repo: root }));
      assert.equal(run.result, 0);
      const out = run.logs.join("\n");
      assert.ok(out.includes(`goal_id: ${goalId}`), "goal_id must be printed");
      assert.ok(out.includes(`id: ${goalId}`), "explicit id field must be printed");
      assert.ok(out.includes(`minitok goal status --goal-id ${goalId}`), "an actionable command must reference the id");
    } finally {
      releaseGoalSessionLock(session);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("goal list prints every goal id in human mode", async () => {
    const root = tempWorkspace();
    let first = null;
    let second = null;
    try {
      first = makeSession(root, "verify that the file index.js exists");
      second = makeSession(root, "verify that the file README.md exists");
      releaseGoalSessionLock(first);
      releaseGoalSessionLock(second);
      first = null;
      second = null;
      const run = await captureConsole(() => cmdGoalList({ repo: root }));
      assert.equal(run.result, 0);
      const idLines = run.logs.filter(line => line.startsWith("goal-"));
      assert.equal(idLines.length, 2, `two goal ids must be listed, saw: ${run.logs.join(" | ")}`);
      assert.ok(idLines.every(line => line.includes("running")), "state must be listed next to the id");
    } finally {
      releaseGoalSessionLock(first);
      releaseGoalSessionLock(second);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("goal list --json returns structured entries including goal_id", async () => {
    const root = tempWorkspace();
    let session = null;
    try {
      session = makeSession(root, "verify that the file index.js exists");
      const goalId = session.goalSpec.goal_id;
      releaseGoalSessionLock(session);
      session = null;
      const run = await captureConsole(() => cmdGoalList({ repo: root, json: true }));
      assert.equal(run.result, 0);
      const parsed = JSON.parse(run.logs.join("\n"));
      assert.equal(parsed.goals.length, 1);
      assert.equal(parsed.goals[0].goal_id, goalId);
      assert.equal(parsed.goals[0].state, "running");
    } finally {
      releaseGoalSessionLock(session);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("goal list reports an empty workspace without throwing", async () => {
    const root = tempWorkspace();
    try {
      const run = await captureConsole(() => cmdGoalList({ repo: root }));
      assert.equal(run.result, 0);
      assert.ok(run.logs.join("\n").includes("No goal sessions found"), "empty workspaces must be reported");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("goal list skips stray directories that are not valid goal sessions", async () => {
    const root = tempWorkspace();
    let session = null;
    try {
      session = makeSession(root, "verify that the file index.js exists");
      const goalId = session.goalSpec.goal_id;
      releaseGoalSessionLock(session);
      session = null;
      fs.mkdirSync(path.join(root, ".minitok", "goals", "stray-dir"), { recursive: true });
      const run = await captureConsole(() => cmdGoalList({ repo: root, json: true }));
      assert.equal(run.result, 0);
      const parsed = JSON.parse(run.logs.join("\n"));
      assert.equal(parsed.goals.length, 1);
      assert.equal(parsed.goals[0].goal_id, goalId);
    } finally {
      releaseGoalSessionLock(session);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("register exposes a goal list subcommand", () => {
    const commands = [];
    const fakeCommand = name => {
      const chainable = {
        description: () => chainable,
        argument: () => chainable,
        requiredOption: () => chainable,
        option: () => chainable,
        action: () => chainable,
        command: sub => { commands.push(`${name} ${sub}`); return fakeCommand(sub); },
      };
      return chainable;
    };
    register({ command: name => { commands.push(name); return fakeCommand(name); } });
    assert.ok(commands.includes("goal list"), `goal list must be registered, saw: ${commands.join(", ")}`);
  });
});
