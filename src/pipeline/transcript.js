"use strict";

/**
 * Optional transcript recording for pipeline runs.
 *
 * Lives under `src/pipeline/` (not `src/runtime/`) because the pipeline must
 * stay independent of the runtime/MCP layer — see the M4.6 "Standalone
 * Independence" launch contract. It only depends on evidence redaction and the
 * shared file-permission helper.
 *
 * The evidence contract deliberately keeps prompts and provider responses out
 * of the persisted record (`run-evidence.js` redacts and drops them). Some
 * operators still need to inspect what the model actually said, so this module
 * offers an explicit opt-in: `transcript.enabled: true` in minitok.yml (or
 * `MINITOK_TRANSCRIPT_ENABLED=1`) records every role-level prompt/response pair
 * into `.minitok/transcripts/<run_id>.jsonl`, one JSON line per call.
 *
 * Like every other minitok artifact it is:
 * - append-only JSONL (audit-friendly, streaming-friendly),
 * - written atomically per line with owner-only permissions,
 * - redacted with the same `redact()` the run evidence uses, so a leaked API
 *   key in a prompt never lands on disk verbatim.
 * Disabled by default: when the option is off, no file is created and no
 * message content is retained in memory beyond the call itself.
 */

const fs = require("fs");
const path = require("path");
const { redact } = require("../run-evidence");
const { setOwnerOnlyPermissions } = require("../utils/file-permissions");

const TRANSCRIPT_DIRECTORY = path.join(".minitok", "transcripts");
const MAX_RECORDED_CHARS = 128 * 1024;

function transcriptDirectory(workspaceRoot) {
  return path.resolve(workspaceRoot, TRANSCRIPT_DIRECTORY);
}

function transcriptPath(workspaceRoot, runId) {
  if (typeof workspaceRoot !== "string" || !workspaceRoot.trim()) throw new TypeError("workspaceRoot is required for transcript path");
  if (typeof runId !== "string" || !/^[\w.-]+$/.test(runId)) throw new TypeError("Invalid run id for transcript path");
  const root = transcriptDirectory(workspaceRoot) + path.sep;
  const file = path.resolve(root, `${runId}.jsonl`);
  if (!file.startsWith(root)) throw new Error("Transcript path must stay inside the workspace");
  return file;
}

function boundedText(value) {
  if (value == null) return null;
  const text = String(value);
  return text.length > MAX_RECORDED_CHARS ? `${text.slice(0, MAX_RECORDED_CHARS)}...[truncated]` : text;
}

/**
 * Append one exchange (prompt messages + response) to the run transcript.
 * Failures are swallowed and reported: recording must never change the run's
 * outcome, mirroring the audit-log persistence contract.
 */
function appendTranscriptEntry(workspaceRoot, runId, entry) {
  try {
    const record = {
      recorded_at: new Date().toISOString(),
      run_id: runId,
      cycle: Number.isInteger(entry?.cycle) ? entry.cycle : null,
      role: typeof entry?.role === "string" ? entry.role : null,
      provider: typeof entry?.provider === "string" ? entry.provider : null,
      model: typeof entry?.model === "string" ? entry.model : null,
      messages: Array.isArray(entry?.messages)
        ? entry.messages.map(message => ({ role: message?.role, content: boundedText(message?.content) }))
        : [],
      response: entry?.response == null ? null : {
        text: boundedText(entry.response.text),
        truncated: entry.response.truncated === true,
        finish_reason: typeof entry.response.finish_reason === "string" ? entry.response.finish_reason : null,
        // Named `usage`, not `tokens`: the shared redaction masks any key
        // containing "token", and usage counts are not secrets.
        usage: entry.response.tokens || null,
      },
    };
    const filePath = transcriptPath(workspaceRoot, runId);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, `${JSON.stringify(redact(record))}\n`, { encoding: "utf8" });
    setOwnerOnlyPermissions(filePath);
    return { persisted: true };
  } catch (error) {
    const warning = { persisted: false, warning: `Transcript persistence failed: ${error.message}` };
    process.emitWarning(warning.warning, { code: "MINITOK_TRANSCRIPT_PERSISTENCE" });
    return warning;
  }
}

/**
 * Read the recorded transcript for a run. Missing files are an empty list,
 * matching how `listSessions` treats unreadable evidence artifacts.
 */
function readTranscript(workspaceRoot, runId) {
  const filePath = transcriptPath(workspaceRoot, runId);
  try {
    return fs.readFileSync(filePath, "utf8").split(/\r?\n/).filter(Boolean).map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Wrap a provider so every `complete()` call is recorded before the result is
 * returned. The wrapper is transparent: it forwards the exact arguments and
 * result, and recording failures never break the underlying call.
 */
function withTranscriptRecording(provider, { workspaceRoot, runId, role, cycleProvider }) {
  const name = provider?.name;
  return {
    name,
    primary: provider,
    isAvailable: () => provider.isAvailable(),
    async complete(messages, options = {}) {
      const result = await provider.complete(messages, options);
      try {
        appendTranscriptEntry(workspaceRoot, runId, {
          cycle: typeof cycleProvider === "function" ? cycleProvider() : null,
          role,
          provider: name,
          model: result?.model || options.model || null,
          messages,
          response: result,
        });
      } catch { /* recording must never fail the call */ }
      return result;
    },
  };
}

module.exports = { TRANSCRIPT_DIRECTORY, transcriptDirectory, transcriptPath, appendTranscriptEntry, readTranscript, withTranscriptRecording };