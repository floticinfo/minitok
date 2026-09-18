"use strict";

/**
 * Phase 0 baseline contracts.
 *
 * These tests exercise the existing task pipeline and MCP/runtime boundaries
 * without adding a goal-execution layer. They document behavior a future
 * GoalController must preserve.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");

function temporaryDirectory(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanup(directory) {
  fs.rmSync(directory, { recursive: true, force: true });
}

test("model done is task-generation metadata, not final run success", async () => {
  const { generateNextTask } = require(path.join(ROOT, "src", "pipeline", "next_task.js"));
  const { summarizeRunOutcome } = require(path.join(ROOT, "src", "pipeline", "loop.js"));
  const provider = {
    complete: async () => ({
      text: JSON.stringify({ done: true, summary: "the model says the goal is complete" }),
      tokens: { input: 1, output: 1 },
    }),
  };

  const nextTask = await generateNextTask(provider, "baseline goal", [], null);

  assert.equal(nextTask.done, true);
  assert.equal(summarizeRunOutcome([{ status: "REJECT" }]).success, false);
  assert.equal(summarizeRunOutcome([{ status: "REJECT" }, { status: "CHANGES_REQUESTED" }]).success, false);
});

test("final success is derived from the final verified cycle, not an earlier APPROVE", () => {
  const { summarizeRunOutcome } = require(path.join(ROOT, "src", "pipeline", "loop.js"));

  assert.deepEqual(summarizeRunOutcome([{ status: "APPROVE" }, { status: "REJECT" }]), {
    success: false,
    approved: true,
    last_cycle_status: "REJECT",
  });
  assert.deepEqual(summarizeRunOutcome([{ status: "REJECT" }, { status: "APPROVE" }]), {
    success: true,
    approved: true,
    last_cycle_status: "APPROVE",
  });
});

test("minitok_run awaits an async runner and exposes failed results as an error envelope", async () => {
  const { getToolHandler } = require(path.join(ROOT, "src", "mcp", "tools.js"));
  const workspaceRoot = temporaryDirectory("minitok-phase0-mcp-");
  const calls = [];

  try {
    const result = await getToolHandler("minitok_run", {
      task: "async baseline probe",
      repo: workspaceRoot,
      run_id: "phase0-run",
    }, {}, {
      workspaceRoot,
      permissions: new Set(["write", "verify_exec"]),
      runPipeline: async (task, options) => {
        calls.push({ task, hasSignal: Boolean(options.signal) });
        await new Promise(resolve => setTimeout(resolve, 5));
        return { success: false, last_cycle_status: "REJECT" };
      },
    });

    const payload = JSON.parse(result.content[0].text);
    assert.deepEqual(calls, [{ task: "async baseline probe", hasSignal: false }]);
    assert.equal(result.isError, true);
    assert.equal(payload.state, "failed");
    assert.equal(payload.result.success, false);
  } finally {
    cleanup(workspaceRoot);
  }
});

test("persisted running MCP runs recover as interrupted unknown state, not auto-resumed", () => {
  const { RuntimeStdio } = require(path.join(ROOT, "src", "runtime", "stdio.js"));
  const directory = temporaryDirectory("minitok-phase0-runtime-");
  const runStatePath = path.join(directory, "mcp-runs.json");

  try {
    const first = new RuntimeStdio({
      authToken: "phase0-token",
      workspaceRoot: directory,
      runStatePath,
    });
    first._runs.set("phase0-run", {
      runId: "phase0-run",
      requestId: 1,
      state: "running",
      controller: new AbortController(),
    });
    first._saveRunState();

    const recovered = new RuntimeStdio({
      authToken: "phase0-token",
      workspaceRoot: directory,
      runStatePath,
    });

    assert.deepEqual(recovered._recoveredRuns.map(run => ({
      run_id: run.run_id,
      state: run.state,
      recovery: run.recovery,
    })), [{ run_id: "phase0-run", state: "unknown", recovery: "interrupted" }]);
    assert.equal(recovered._runs.size, 0);
  } finally {
    cleanup(directory);
  }
});
