"use strict";

const crypto = require("crypto");
const { createTerminalResult } = require("./failure");

function taskId(task) {
  return `task-${crypto.createHash("sha256").update(String(task)).digest("hex").slice(0, 16)}`;
}

function statusFor(result) {
  if (result?.success === true) return "success";
  if (result?.cancelled || result?.blocked || result?.humanEscalation) return "blocked";
  if (result?.approved === true) return "partial";
  return "failure";
}

function normalizeTaskResult(task, result, startedAt) {
  const tokens = result?.totalTokens || result?.tokens || { input: 0, output: 0 };
  const cycles = Array.isArray(result?.cycles) ? result.cycles : [];
  const last = cycles.at(-1) || {};
  return {
    task_id: result?.task_id || taskId(task),
    task,
    success: result?.success === true,
    status: result?.status || statusFor(result),
    changes: result?.changes || last.implement || {},
    verification: result?.verification || last.check || {},
    review: result?.review || last.verify || last.review || {},
    evidence: Array.isArray(result?.evidence) ? result.evidence : [],
    cycle_evidence: Array.isArray(result?.cycle_evidence)
      ? result.cycle_evidence
      : cycles.map(cycle => cycle.evidence).filter(Boolean),
    terminal_status: result?.terminal_status || createTerminalResult(result, { valid_evidence: result?.success === true && result?.terminal_status === "completed" }).terminal_status,
    failure_category: result?.failure_category || createTerminalResult(result).failure_category,
    failure_stage: result?.failure_stage || createTerminalResult(result).failure_stage,
    recoverable: result?.recoverable ?? createTerminalResult(result).recoverable,
    human_escalation_required: result?.human_escalation_required ?? createTerminalResult(result).human_escalation_required,
    last_cycle_evidence_id: result?.last_cycle_evidence_id || createTerminalResult(result).last_cycle_evidence_id,
    tokens: { input: Number(tokens.input) || 0, output: Number(tokens.output) || 0 },
    duration_ms: Number.isFinite(result?.duration_ms) ? result.duration_ms : Date.now() - startedAt,
    raw: result,
  };
}

async function runTask(task, options = {}) {
  if (typeof task !== "string" || task.trim() === "") throw new TypeError("Task must be a non-empty string");
  const startedAt = Date.now();
  const pipeline = options.pipeline || require("../pipeline/loop").runPipeline;
  try {
    const result = await pipeline(task, options);
    return normalizeTaskResult(task, result, startedAt);
  } catch (error) {
    const terminal = createTerminalResult({ ...error, error: error.message, merge_failed: error.code === "minitok_apply_failed" }, { terminal_status: error.code === "minitok_apply_failed" ? "merge_failed" : undefined });
    return {
      task_id: taskId(task), task, success: false, status: "failure", changes: {}, verification: {}, review: {}, evidence: [],
      terminal_status: terminal.terminal_status, failure_category: terminal.failure_category, failure_stage: terminal.failure_stage, recoverable: terminal.recoverable, human_escalation_required: terminal.human_escalation_required, last_cycle_evidence_id: terminal.last_cycle_evidence_id,
      tokens: { input: 0, output: 0 }, duration_ms: Date.now() - startedAt, error: error.message, error_code: error.code,
    };
  }
}

module.exports = { runTask, normalizeTaskResult, taskId };
