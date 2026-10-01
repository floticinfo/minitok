"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { requireGoalRepo } = require("./goal-tools");

test("requireGoalRepo rejects non-absolute paths", () => {
  assert.throws(() => requireGoalRepo("relative/path", os.tmpdir()), /goal repo must be an absolute path/);
});

test("requireGoalRepo accepts a directory inside the workspace", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "minitok-goal-root-"));
  try {
    const inner = path.join(root, "project");
    fs.mkdirSync(inner);
    const resolved = requireGoalRepo(inner, root);
    assert.equal(resolved, fs.realpathSync.native(inner));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("requireGoalRepo rejects a path outside the workspace", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "minitok-goal-root-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "minitok-goal-outside-"));
  try {
    assert.throws(() => requireGoalRepo(outside, root), /goal repo is outside the MCP workspace/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("requireGoalRepo rejects a symlink that escapes the workspace", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "minitok-goal-root-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "minitok-goal-outside-"));
  const link = path.join(root, "escape-link");
  try {
    fs.symlinkSync(outside, link, "dir");
    assert.throws(() => requireGoalRepo(link, root), /goal repo is outside the MCP workspace/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("requireGoalRepo rejects a symlink pointing to a parent of the workspace", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "minitok-goal-root-"));
  const parent = path.dirname(root);
  const link = path.join(root, "parent-link");
  try {
    fs.symlinkSync(parent, link, "dir");
    assert.throws(() => requireGoalRepo(link, root), /goal repo is outside the MCP workspace/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("requireGoalRepo resolves to the realpath of the workspace root itself", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "minitok-goal-root-"));
  try {
    const resolved = requireGoalRepo(root, root);
    assert.equal(resolved, fs.realpathSync.native(root));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
