"use strict";

const crypto = require("crypto");

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
    return {
      task_id: taskId(task), task, success: false, status: "failure", changes: {}, verification: {}, review: {}, evidence: [],
      tokens: { input: 0, output: 0 }, duration_ms: Date.now() - startedAt, error: error.message, error_code: error.code,
    };
  }
}

module.exports = { runTask, normalizeTaskResult, taskId };
