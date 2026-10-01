"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

// The compiled module is required so the real implementation runs, not a copy.
const { clipWithNote, buildProblemsTask, MAX_TASK_TEXT_CHARS, MAX_PROBLEM_ENTRIES } = require(path.join(__dirname, "..", "dist", "src", "truncate.js"));

test("clipWithNote returns text unchanged and no note when under the cap", () => {
  const { text, note } = clipWithNote("short text");
  assert.equal(text, "short text");
  assert.equal(note, "");
});

test("clipWithNote clips to the cap and signals the truncation", () => {
  const big = "x".repeat(MAX_TASK_TEXT_CHARS + 500);
  const { text, note } = clipWithNote(big);
  assert.equal(text.length, MAX_TASK_TEXT_CHARS);
  assert.match(note, /^\[truncated: showing 18000 of 18500 chars\]$/);
});

test("clipWithNote respects a custom cap", () => {
  const { text, note } = clipWithNote("abcdef", 3);
  assert.equal(text, "abc");
  assert.match(note, /showing 3 of 6 chars/);
});

test("buildProblemsTask adds no marker when nothing was truncated", () => {
  const entries = ["a.ts:1 [error] boom", "b.ts:2 [warning] meh"];
  const task = buildProblemsTask(entries, entries.length);
  assert.ok(task.includes("a.ts:1 [error] boom"));
  assert.ok(!task.includes("[truncated"), `no marker expected, got: ${task}`);
});

test("buildProblemsTask signals the per-file entry cap", () => {
  const entries = ["a.ts:1 [error] boom"];
  const task = buildProblemsTask(entries, 250);
  assert.match(task, /\[truncated: showing 1 of 250 diagnostics\]/);
});

test("buildProblemsTask signals the char cap on the joined entries", () => {
  const entries = ["e".repeat(MAX_TASK_TEXT_CHARS + 10)];
  const task = buildProblemsTask(entries, entries.length);
  assert.match(task, /\[truncated: showing 18000 of \d+ chars\]/);
});

test("buildProblemsTask can signal both caps at once", () => {
  const entries = ["e".repeat(MAX_TASK_TEXT_CHARS + 10)];
  const task = buildProblemsTask(entries, 500);
  assert.match(task, /showing 1 of 500 diagnostics/);
  assert.match(task, /showing 18000 of \d+ chars/);
});

test("the caps are the documented values", () => {
  assert.equal(MAX_TASK_TEXT_CHARS, 18000);
  assert.equal(MAX_PROBLEM_ENTRIES, 100);
});
