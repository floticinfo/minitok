"use strict";

/**
 * Opt-in transcript recording for pipeline runs.
 *
 * Prompts and provider responses are deliberately absent from the run
 * evidence (redacted away in run-evidence.js). `transcript.enabled: true`
 * opt-in records them, redacted, into .minitok/transcripts/<run_id>.jsonl so
 * an operator can replay what the model actually saw and answered.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { appendTranscriptEntry, readTranscript, transcriptPath, withTranscriptRecording } = require("../src/pipeline/transcript");

function tempWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "minitok-transcript-"));
  return { root: dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test("appendTranscriptEntry writes a redacted JSONL line inside the workspace", () => {
  const { root, cleanup } = tempWorkspace();
  try {
    const result = appendTranscriptEntry(root, "run-1", {
      cycle: 2,
      role: "plan",
      provider: "openai",
      model: "gpt-test",
      messages: [{ role: "user", content: "Task with a key: sk-abcdefghijklmnop1234" }],
      response: { text: "Authorization: Bearer eyJhbGciOi.JOSE.9sig", tokens: { input: 10, output: 5 } },
    });
    assert.equal(result.persisted, true);
    const file = transcriptPath(root, "run-1");
    assert.equal(fs.existsSync(file), true);
    // The file lives under .minitok/transcripts, never outside the workspace.
    assert.equal(path.dirname(file).startsWith(path.resolve(root, ".minitok", "transcripts")), true);
    const raw = fs.readFileSync(file, "utf8");
    const entry = JSON.parse(raw.trim());
    // Secret patterns are masked by the same redaction the evidence uses.
    assert.doesNotMatch(raw, /sk-abcdefghijklmnop1234/);
    assert.doesNotMatch(raw, /eyJhbGciOi\.JOSE\.9sig/);
    assert.match(entry.messages[0].content, /\[REDACTED\]/);
    // Usage counts survive: the field is named `usage` so key-based redaction
    // ("token" matches) does not mask the numbers an operator wants to audit.
    assert.deepEqual(entry.response.usage, { input: 10, output: 5 });
    assert.equal(entry.cycle, 2);
    assert.equal(entry.role, "plan");
    assert.equal(entry.run_id, "run-1");
  } finally {
    cleanup();
  }
});

test("appendTranscriptEntry is append-only across entries", () => {
  const { root, cleanup } = tempWorkspace();
  try {
    for (let i = 1; i <= 3; i++) {
      appendTranscriptEntry(root, "run-append", { role: "work", messages: [], response: { text: `r${i}` } });
    }
    const entries = readTranscript(root, "run-append");
    assert.equal(entries.length, 3);
    assert.deepEqual(entries.map(entry => entry.response.text), ["r1", "r2", "r3"]);
  } finally {
    cleanup();
  }
});

test("readTranscript returns an empty list when nothing was recorded", () => {
  const { root, cleanup } = tempWorkspace();
  try {
    assert.deepEqual(readTranscript(root, "missing-run"), []);
  } finally {
    cleanup();
  }
});

test("withTranscriptRecording records the exchange without changing the result", async () => {
  const { root, cleanup } = tempWorkspace();
  try {
    const inner = {
      name: "stub",
      isAvailable: async () => true,
      complete: async (messages, options) => ({ text: "the answer", model: options.model || "stub-model", tokens: { input: 1, output: 1 } }),
    };
    const wrapped = withTranscriptRecording(inner, { workspaceRoot: root, runId: "run-wrap", role: "review", cycleProvider: () => 7 });
    assert.equal(await wrapped.isAvailable(), true);
    const messages = [{ role: "system", content: "sys" }, { role: "user", content: "prompt" }];
    const result = await wrapped.complete(messages, { model: "m1" });
    // The wrapper is transparent: same result, same provider name.
    assert.equal(result.text, "the answer");
    assert.equal(wrapped.name, "stub");
    const entries = readTranscript(root, "run-wrap");
    assert.equal(entries.length, 1);
    assert.equal(entries[0].role, "review");
    assert.equal(entries[0].cycle, 7);
    assert.equal(entries[0].messages.length, 2);
    assert.equal(entries[0].response.text, "the answer");
  } finally {
    cleanup();
  }
});

test("transcript persistence failure is reported, never thrown", () => {
  const { root, cleanup } = tempWorkspace();
  try {
    // A run id with path separators is rejected before any write happens.
    const result = appendTranscriptEntry(root, "../escape", { role: "plan", messages: [], response: null });
    assert.equal(result.persisted, false);
    assert.match(result.warning, /Invalid run id/);
    assert.equal(fs.existsSync(path.join(root, ".minitok")), false);
  } finally {
    cleanup();
  }
});

test("oversized message content is bounded before persistence", () => {
  const { root, cleanup } = tempWorkspace();
  try {
    const huge = "x".repeat(200 * 1024);
    appendTranscriptEntry(root, "run-big", { role: "work", messages: [{ role: "user", content: huge }], response: { text: "ok" } });
    const entries = readTranscript(root, "run-big");
    assert.match(entries[0].messages[0].content, /\[truncated\]$/);
    assert.ok(entries[0].messages[0].content.length < 140 * 1024);
  } finally {
    cleanup();
  }
});