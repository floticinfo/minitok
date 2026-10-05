"use strict";

/**
 * Append-only session store for `minitok run` — the CLI-owned single source
 * of truth for conversational follow-up ("run --resume").
 *
 * Pattern borrowed from src/goal/session.js: atomic write (temp + rename,
 * mode 0o600), redaction of user task text, graceful handling of corrupt
 * files. Deliberately minimal: no locks (a run is guarded by the extension's
 * single-process gate) and no workspace snapshots (runPipeline already
 * produces evidence + checkpoints).
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { redact } = require("../../run-evidence");

const SESSIONS_DIRECTORY = "sessions";
const SESSION_SCHEMA_VERSION = 1;
const MAX_EVENTS = 200; // append cap: file stays bounded

function sessionsDirectory(repoRoot) {
  return path.join(repoRoot, ".minitok", SESSIONS_DIRECTORY);
}

function sessionFilePath(repoRoot, sessionId) {
  return path.join(sessionsDirectory(repoRoot), `${sessionId}.json`);
}

/** Atomic write: temp file (wx flag — never clobber) + rename. */
function atomicWrite(filePath, value) {
  const temporary = `${filePath}.tmp.${process.pid}.${crypto.randomBytes(6).toString("hex")}`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  fs.renameSync(temporary, filePath);
  return filePath;
}

function redactText(value) {
  if (typeof value !== "string" || !value) return value;
  try { return redact(value); } catch { return value; }
}

/** Create a new session. Returns the session record. */
function createRunSession(repoRoot, firstTask) {
  const session = {
    schema: SESSION_SCHEMA_VERSION,
    id: crypto.randomUUID(),
    repo_root: repoRoot,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    events: [{ type: "task", text: redactText(firstTask), ts: new Date().toISOString() }],
  };
  atomicWrite(sessionFilePath(repoRoot, session.id), session);
  return session;
}

/** Load a session by id. Returns null when missing or corrupt. */
function loadRunSession(repoRoot, sessionId) {
  if (typeof sessionId !== "string" || !/^[a-zA-Z0-9-]+$/.test(sessionId)) return null;
  const filePath = sessionFilePath(repoRoot, sessionId);
  let raw;
  try { raw = fs.readFileSync(filePath, "utf8"); }
  catch { return null; }
  try {
    const session = JSON.parse(raw);
    if (!session || session.schema !== SESSION_SCHEMA_VERSION || !Array.isArray(session.events)) return null;
    if (session.repo_root && path.resolve(session.repo_root) !== path.resolve(repoRoot)) return null;
    return session;
    } catch { return null; }
}

/** Most recent session for a repo (by updated_at). Returns null when none. */
function latestRunSession(repoRoot) {
  let entries;
  try { entries = fs.readdirSync(sessionsDirectory(repoRoot)); } catch { return null; }
  let best = null;
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const session = loadRunSession(repoRoot, entry.slice(0, -5));
    if (!session) continue;
    if (!best || (session.updated_at || "") > (best.updated_at || "")) best = session;
  }
  return best;
}

/** Append an event (task / result). Best-effort: never fails a run. */
function appendRunEvent(repoRoot, session, event) {
  if (!session || !session.id) return session;
  const normalized = { type: event.type, ts: new Date().toISOString() };
  if (event.type === "task") normalized.text = redactText(event.text);
  if (event.type === "result") {
    normalized.ok = event.ok === true;
    if (event.runId) normalized.run_id = event.runId;
    if (event.evidencePath) normalized.evidence_path = event.evidencePath;
    if (event.filesChanged) normalized.files_changed = event.filesChanged;
  }
  session.events.push(normalized);
  if (session.events.length > MAX_EVENTS) session.events = session.events.slice(-MAX_EVENTS);
  session.updated_at = new Date().toISOString();
  try { atomicWrite(sessionFilePath(repoRoot, session.id), session); }
  catch (error) { console.warn(`[warn] Could not append run session event: ${error.message}`); }
  return session;
}

/**
 * Build the context block prepended to a follow-up task on --resume.
 * Recent N turns only, so context stays bounded.
 */
function buildSessionContextBlock(session, maxTurns = 8) {
  if (!session || !session.events.length) return "";
  const pairs = [];
  let pendingTask = null;
  for (const event of session.events) {
    if (event.type === "task") { pendingTask = event.text; continue; }
    if (event.type === "result" && pendingTask !== null) {
      pairs.push({ task: pendingTask, result: event });
      pendingTask = null;
    }
  }
  const omitted = Math.max(0, pairs.length - maxTurns);
  const recent = pairs.slice(-maxTurns);
  const lines = recent.map((pair, index) => {
    const status = pair.result.ok ? "Verified" : "Failed";
    const runId = pair.result.run_id ? ` (run ${pair.result.run_id})` : "";
    const files = Number.isInteger(pair.result.files_changed) ? `, ${pair.result.files_changed} files` : "";
    return `${index + 1}. ${pair.task} → ${status}${runId}${files}`;
  });
  const header = `[Session context — ${pairs.length} prior turn${pairs.length === 1 ? "" : "s"}, resume of ${session.id}${omitted ? `, showing ${maxTurns} most recent` : ""}]`;
  return `${header}\n${lines.join("\n")}\n[End session context]\n\n`;
}

/** List sessions (for `minitok sessions --json` and the extension restore). */
function listRunSessions(repoRoot) {
  let entries;
  try { entries = fs.readdirSync(sessionsDirectory(repoRoot)); } catch { return []; }
  const sessions = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const session = loadRunSession(repoRoot, entry.slice(0, -5));
    if (!session) continue;
    const lastTask = session.events.filter(event => event.type === "task").pop();
    sessions.push({
      id: session.id,
      created_at: session.created_at,
      updated_at: session.updated_at,
      turns: session.events.filter(event => event.type === "task").length,
      last_task: lastTask ? lastTask.text : "",
    });
  }
  sessions.sort((a, b) => (b.updated_at || "").localeCompare(a.updated_at || ""));
  return sessions;
}

module.exports = {
  SESSIONS_DIRECTORY,
  SESSION_SCHEMA_VERSION,
  sessionsDirectory,
  sessionFilePath,
  createRunSession,
  loadRunSession,
  latestRunSession,
  appendRunEvent,
  buildSessionContextBlock,
  listRunSessions,
  redactText,
};