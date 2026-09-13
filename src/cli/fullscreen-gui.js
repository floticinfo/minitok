"use strict";
const readline = require("readline");
const { listSessions } = require("../runtime/sessions");
const { runTask } = require("./gui-run");
const { BRAND, ansiBackground, ansiForeground } = require("../core/palette");
/**
 * Terminal tones, derived from the brand palette in `src/core/palette.js`.
 *
 * The brand is carried by *filled tiles*, never by coloured text: `primary` is
 * 2.6:1 against a black terminal and would be unreadable as a foreground, so
 * the mode badges paint a 24-bit background instead -- ` ACT ` is white on
 * primary (the logo pairing) and ` PLAN ` is pale on deep navy. Text tones use
 * `secondaryBlue`, the one palette member that clears 4.5:1 on a light surface
 * and 4.3:1 on a dark one, while `accent` stays a decorative brand echo for the
 * wordmark. `green`/`yellow`/`red` are deliberately the terminal's own colours
 * rather than brand hues, because a success or failure status must not be
 * re-tinted to a brand colour, and `MINITOK_NO_COLOR=1` still drops every
 * sequence.
 */
const ansi = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  brand: ansiForeground(BRAND.secondaryBlue),
  accent: ansiForeground(BRAND.cyanAccent),
  actBadge: `${ansiBackground(BRAND.primary)}${ansiForeground(BRAND.onPrimary)}`,
  planBadge: `${ansiBackground(BRAND.deepNavy)}${ansiForeground(BRAND.pale)}`,
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
};
const ansiPattern = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, "g");
function tone(text, name, enabled) { return enabled ? `${ansi[name]}${text}${ansi.reset}` : text; }
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const combiningPattern = /^(?:\p{Mark}|\p{Join_Control}|\p{Variation_Selector})/u;
const widePattern = /[\u1100-\u115f\u231a-\u231b\u2329-\u232a\u23e9-\u23ec\u23f0\u23f3\u25fd-\u25fe\u2614-\u2615\u2648-\u2653\u267f\u2693\u26a1\u26aa-\u26ab\u26bd-\u26be\u26c4-\u26c5\u26ce\u26d4\u26ea\u26f2-\u26f3\u26f5\u26fa\u26fd\u2705\u270a-\u270b\u2728\u274c\u274e\u2753-\u2755\u2757\u2795-\u2797\u27b0\u27bf\u2934-\u2935\u2b05-\u2b07\u2b1b-\u2b1c\u2b50\u2b55\u2e80-\u303e\u3040-\u3247\u3250-\ua4c6\ua960-\ua97c\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6b\uff01-\uff60\uffe0-\uffe6\u{1f000}-\u{1faff}]/u;
function clusterWidth(cluster) { if (!cluster || combiningPattern.test(cluster)) return 0; const codePoint = cluster.codePointAt(0); if (codePoint < 32 || codePoint === 127 || codePoint >= 128 && codePoint <= 159) return 0; if (/\p{Regional_Indicator}/u.test(cluster) || widePattern.test(cluster)) return 2; return 1; }
function visibleWidth(text) { return [...graphemeSegmenter.segment(String(text || "").replace(ansiPattern, ""))].reduce((total, segment) => total + clusterWidth(segment.segment), 0); }
function graphemeBoundaries(text) { return [...graphemeSegmenter.segment(text)].map(segment => segment.index).concat(text.length); }
function normalizeCursor(text, cursor) { const boundaries = graphemeBoundaries(text); let result = boundaries[0]; for (const boundary of boundaries) { if (boundary > cursor) break; result = boundary; } return result; }
function editTask(task, cursor, char, key = {}) { const value = String(task || ""); const position = normalizeCursor(value, cursor); if (key.name === "backspace") { const boundaries = graphemeBoundaries(value); const index = Math.max(0, boundaries.indexOf(position) - 1); const start = boundaries[index]; return { task: value.slice(0, start) + value.slice(position), cursor: start }; } if (key.name === "left") return { task: value, cursor: Math.max(0, graphemeBoundaries(value)[Math.max(0, graphemeBoundaries(value).indexOf(position) - 1)]) }; if (key.name === "right") { const boundaries = graphemeBoundaries(value); return { task: value, cursor: boundaries[Math.min(boundaries.length - 1, boundaries.indexOf(position) + 1)] }; } if (typeof char === "string" && char.length > 0 && !key.ctrl && !key.meta && !["backspace", "left", "right", "up", "down", "return", "escape", "delete", "tab"].includes(key.name)) return { task: value.slice(0, position) + char + value.slice(position), cursor: position + char.length }; return { task: value, cursor: position }; }
function fit(text, width) { const value = String(text || "").replace(/\r?\n/g, " "); const limit = Math.max(0, width); if (visibleWidth(value) > limit) { const plain = value.replace(ansiPattern, ""); const suffix = limit >= 3 ? "..." : ""; const target = Math.max(0, limit - suffix.length); let output = ""; let used = 0; for (const segment of graphemeSegmenter.segment(plain)) { const next = clusterWidth(segment.segment); if (used + next > target) break; output += segment.segment; used += next; } return `${output}${suffix}${" ".repeat(Math.max(0, limit - used - suffix.length))}`; } return `${value}${" ".repeat(Math.max(0, limit - visibleWidth(value)))}`; }
function frame(title, rows, width, height, enabled) { const safeWidth = Math.max(1, width); const safeHeight = Math.max(1, height); if (safeWidth < 6) { const compact = rows.slice(-safeHeight); while (compact.length < safeHeight) compact.unshift(""); return compact.map(row => fit(row, safeWidth)); } const label = fit(` ${title} `, safeWidth - 2); const top = `+${label}${"-".repeat(Math.max(0, safeWidth - visibleWidth(label) - 2))}+`; const innerWidth = safeWidth - 4; const bodyHeight = Math.max(0, safeHeight - 2); const body = bodyHeight ? rows.slice(-bodyHeight).map(row => `| ${fit(row, innerWidth)} |`) : []; while (body.length < bodyHeight) body.unshift(`| ${" ".repeat(innerWidth)} |`); return safeHeight === 1 ? [tone(top, "dim", enabled)] : [tone(top, "dim", enabled), ...body.map(row => tone(row, "dim", enabled)), tone(`+${"-".repeat(safeWidth - 2)}+`, "dim", enabled)]; }
function clampTranscriptOffset(offset, transcriptLength, viewportHeight) { return Math.min(Math.max(0, Number.isFinite(offset) ? offset : 0), Math.max(0, transcriptLength - Math.max(1, viewportHeight))); }
function scrollTranscript(offset, delta, transcriptLength, viewportHeight) { return clampTranscriptOffset(offset + delta, transcriptLength, viewportHeight); }
function createFullscreenGui(options = {}) {
  const proc = options.process || process;
  const out = proc.stdout;
  const inputStream = proc.stdin;
  const readlineApi = options.readline || readline;
  const exit = options.exit || (code => { proc.exitCode = code; });
  const repo = options.repo || proc.cwd?.() || process.cwd();
  const enabled = proc.env?.NO_COLOR !== "1" && proc.env?.MINITOK_NO_COLOR !== "1";
  const state = { mode: "act", status: "Ready", task: "", cursor: 0, transcript: [], transcriptOffset: 0, sessions: listSessions(repo).slice(0, 10), activeAbort: undefined, overlay: null, focus: "conversation", cancelArmed: false, selectedSession: 0, composeHistory: [], historyIndex: -1 };
  let screenEntered = false;
  let closed = false;
  let resizeHandler;
  let keypressHandler;
  let closeHandler;
  let signalHandlers = [];
  const render = () => {
    if (closed) return;
    const cols = Math.max(1, out.columns || 100); const rows = Math.max(1, (out.rows || 30) - 7); const leftWidth = cols < 80 ? Math.max(1, Math.floor((cols - 3) / 2)) : Math.min(34, Math.floor(cols * .25)); const rightWidth = Math.max(1, cols - leftWidth - 3);
    const sessions = frame("SESSIONS", state.sessions.length ? state.sessions.map((s, i) => `${i === state.selectedSession ? ">" : " "}${i + 1} ${s.status || s.outcome || "idle"} ${s.task || s.run_id}`) : ["No sessions"], leftWidth, rows, enabled);
    const viewportHeight = Math.max(1, rows - 2);
    state.transcriptOffset = clampTranscriptOffset(state.transcriptOffset, state.transcript.length, viewportHeight);
    const start = Math.max(0, state.transcript.length - viewportHeight - state.transcriptOffset);
    const messages = state.transcript.length ? state.transcript.slice(start, start + viewportHeight) : ["Start a conversation", "Press t to compose"];
    const scrollLabel = state.transcript.length > viewportHeight ? ` ${state.transcriptOffset ? `↑${state.transcriptOffset}` : "↓latest"} ` : "";
    const conversation = frame(`${state.focus === "conversation" ? "> " : "  "}${state.mode.toUpperCase()} / ${state.status}${scrollLabel}`, messages, rightWidth, rows, enabled);
    if (!screenEntered) { out.write("\x1b[?1049h\x1b[2J\x1b[H\x1b[?25l"); screenEntered = true; } else out.write("\x1b[2J\x1b[H");
    out.write(`${tone(" minitok", "bold", enabled)}  ${tone(state.mode === "act" ? " ACT " : " PLAN ", state.mode === "act" ? "actBadge" : "planBadge", enabled)}  ${tone(` ${state.status} `, state.status === "Completed" ? "green" : state.status === "Failed" ? "red" : state.status === "Running" ? "brand" : "dim", enabled)}  ${tone(`Focus: ${state.focus === "conversation" ? "Conversation" : "Compose"}`, "bold", enabled)}\n${tone("-".repeat(cols), "dim", enabled)}\n`);
    const width = Math.max(1, cols - 2); for (let i = 0; i < Math.max(sessions.length, conversation.length); i++) out.write(fit(`${sessions[i] || ""} ${conversation[i] || ""}`, width) + "\n"); out.write(`${tone(`${state.focus === "compose" ? ">" : " "} TASK`, state.focus === "compose" ? "bold" : "dim", enabled)} ${fit(state.task, width)}\n`);
  };
  const input = readlineApi.createInterface({ input: inputStream, output: out });
  readlineApi.emitKeypressEvents(inputStream, input);
  if (inputStream.isTTY && typeof inputStream.setRawMode === "function") inputStream.setRawMode(true);
  const cleanup = (code) => {
    if (closed) { if (code !== undefined) exit(code); return; }
    closed = true;
    if (state.activeAbort && !state.activeAbort.signal.aborted) state.activeAbort.abort();
    if (resizeHandler) out.removeListener("resize", resizeHandler);
    if (keypressHandler) inputStream.removeListener("keypress", keypressHandler);
    if (closeHandler) input.removeListener("close", closeHandler);
    for (const [event, handler] of signalHandlers) proc.removeListener(event, handler);
    if (inputStream.isTTY && typeof inputStream.setRawMode === "function") inputStream.setRawMode(false);
    input.close();
    if (screenEntered) { out.write("\x1b[?25h\x1b[?1049l\x1b[0m\n"); screenEntered = false; }
    if (code !== undefined) exit(code);
  };
  const compose = () => { state.focus = "compose"; state.cursor = state.task.length; state.historyIndex = -1; render(); };
  const submitTask = options.runTask || runTask;
  const run = async () => { const task = state.task; if (closed || !task.trim() || state.activeAbort) return; if (!state.composeHistory.includes(task)) state.composeHistory.push(task); state.historyIndex = -1; state.focus = "conversation"; state.status = "Running"; state.transcript.push(`You  ${task}`); state.transcript.push(`${tone("minitok", "accent", enabled)}  Working...`); render(); try { await submitTask(task, repo, input, state); state.status = "Completed"; state.transcript.push(`${tone("minitok", "green", enabled)}  Completed`); } catch (error) { state.status = state.activeAbort?.signal.aborted ? "Cancelled" : "Failed"; state.transcript.push(`${tone("minitok", "red", enabled)}  ${error.message}`); } finally { state.activeAbort = undefined; if (!closed) render(); } };
  const onSignal = signal => { if (state.activeAbort) { state.activeAbort.abort(); state.status = "Cancelling"; cleanup(signal === "SIGINT" ? 130 : 143); } else cleanup(signal === "SIGINT" ? 130 : 143); };
  for (const event of ["SIGINT", "SIGTERM"]) { const handler = () => onSignal(event); proc.on(event, handler); signalHandlers.push([event, handler]); }
  const onException = error => { if (state.activeAbort) state.activeAbort.abort(); state.status = "Failed"; state.transcript.push(`${error?.message || error}`); cleanup(1); };
  proc.on("uncaughtException", onException); proc.on("unhandledRejection", onException); signalHandlers.push(["uncaughtException", onException], ["unhandledRejection", onException]);
  resizeHandler = () => render(); out.on("resize", resizeHandler);
  keypressHandler = async (char, key = {}) => { if (closed) return; if (key.ctrl && key.name === "c") { if (state.activeAbort && !state.cancelArmed) { state.cancelArmed = true; state.transcript.push("Ctrl+C again to interrupt"); render(); } else cleanup(130); return; } if (key.name === "tab") { state.focus = key.shift ? "conversation" : "compose"; if (state.focus === "compose") state.cursor = state.task.length; return render(); } if (state.focus === "conversation" && ["up", "down", "pageup", "pagedown", "home", "end"].includes(key.name)) { const viewportHeight = Math.max(1, Math.max(1, (out.rows || 30) - 7) - 2); const page = Math.max(1, viewportHeight); const delta = key.name === "up" ? 1 : key.name === "down" ? -1 : key.name === "pageup" ? page : key.name === "pagedown" ? -page : key.name === "home" ? state.transcript.length : key.name === "end" ? -state.transcript.length : 0; state.transcriptOffset = scrollTranscript(state.transcriptOffset, delta, state.transcript.length, viewportHeight); return render(); } if (state.focus === "conversation" && key.name === "q") return cleanup(0); if (state.focus === "conversation" && key.name === "t") return compose(); if (state.focus === "compose" && key.name === "escape") { state.task = ""; state.cursor = 0; state.historyIndex = -1; state.focus = "conversation"; return render(); } if (state.focus === "compose" && key.name === "up") { if (state.composeHistory.length) { state.historyIndex = Math.min(state.composeHistory.length - 1, state.historyIndex < 0 ? state.composeHistory.length - 1 : state.historyIndex + 1); state.task = state.composeHistory[state.composeHistory.length - 1 - state.historyIndex]; state.cursor = state.task.length; } return render(); } if (state.focus === "compose" && key.name === "down") { if (state.historyIndex > 0) { state.historyIndex--; state.task = state.composeHistory[state.composeHistory.length - 1 - state.historyIndex]; state.cursor = state.task.length; } else if (state.historyIndex === 0) { state.historyIndex = -1; state.task = ""; state.cursor = 0; } return render(); } if (state.focus === "compose" && ["backspace", "left", "right"].includes(key.name)) { const edited = editTask(state.task, state.cursor, char, key); state.task = edited.task; state.cursor = edited.cursor; state.historyIndex = -1; return render(); } if (state.focus === "compose" && key.name === "return") { if (key.shift) { const edited = editTask(state.task, state.cursor, "\n", {}); state.task = edited.task; state.cursor = edited.cursor; return render(); } return run(); } if (state.focus === "conversation" && key.name === "return") return run(); if (state.focus === "compose" && typeof char === "string" && char.length > 0 && !key.ctrl && !key.meta) { const edited = editTask(state.task, state.cursor, char, key); state.task = edited.task; state.cursor = edited.cursor; state.historyIndex = -1; render(); } };
  inputStream.on("keypress", keypressHandler);
  closeHandler = () => cleanup(0); input.on("close", closeHandler);
  render();
  return { cleanup, render, run, state };
}
module.exports = { createFullscreenGui, visibleWidth, fit, frame, graphemeBoundaries, normalizeCursor, editTask, clampTranscriptOffset, scrollTranscript };