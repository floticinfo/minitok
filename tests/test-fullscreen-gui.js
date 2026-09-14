"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { visibleWidth, fit, frame, editTask, clampTranscriptOffset, scrollTranscript, createFullscreenGui } = require("../src/cli/fullscreen-gui");
const { BRAND, ansiBackground, ansiForeground } = require("../src/core/palette");

function createFocusGui(options = {}) {
  const stdout = new EventEmitter();
  const stdin = new EventEmitter();
  const writes = [];
  stdout.columns = 80;
  stdout.rows = 24;
  stdout.write = value => { writes.push(value); return true; };
  stdin.isTTY = false;
  const processStub = new EventEmitter();
  processStub.stdout = stdout;
  processStub.stdin = stdin;
  processStub.env = { NO_COLOR: "1" };
  processStub.cwd = () => process.cwd();
  const readlineStub = { emitKeypressEvents: () => {}, createInterface: () => { const input = new EventEmitter(); input.close = () => input.emit("close"); return input; } };
  const gui = createFullscreenGui({ process: processStub, readline: readlineStub, exit: () => {}, ...options });
  return { gui, stdin, writes };
}

test("fullscreen layout ignores ANSI sequences when measuring width", () => {
  const colored = "\x1b[31mred\x1b[0m";
  assert.equal(visibleWidth(colored), 3);
  assert.equal(visibleWidth(fit(colored, 6)), 6);
});

test("fullscreen layout measures wide and combining graphemes", () => {
  assert.equal(visibleWidth("界"), 2);
  assert.equal(visibleWidth("e\u0301"), 1);
  assert.equal(visibleWidth("a\u200db"), 2);
});

test("fullscreen layout fits Unicode without splitting graphemes", () => {
  assert.equal(fit("界界", 3), "...");
  assert.equal(fit("e\u0301x", 1), "e\u0301");
  assert.equal(fit("x", 2), "x ");
});

test("fullscreen editor inserts printable characters and preserves graphemes", () => {
  let edited = editTask("ac", 1, "界", {});
  assert.equal(edited.task, "a界c");
  edited = editTask(edited.task, edited.cursor, "", { name: "left" });
  assert.equal(edited.cursor, 1);
  edited = editTask(edited.task, edited.cursor, "", { name: "right" });
  assert.equal(edited.cursor, 2);
});

test("fullscreen editor backspace removes one grapheme", () => {
  const edited = editTask("ac", "a".length, "", { name: "backspace" });
  assert.equal(edited.task, "c");
});

test("fullscreen layout stays bounded at narrow widths and short heights", () => {
  for (const width of [0, 1, 2, 3, 4, 8]) {
    for (const height of [0, 1, 2, 3, 4]) {
      const lines = frame("TITLE", ["界e\u0301 long session row"], width, height, false);
      assert.ok(lines.length <= Math.max(1, height), `${width}x${height}: ${JSON.stringify(lines)}`);
      assert.ok(lines.every(line => visibleWidth(line) <= Math.max(1, width)), `${width}x${height}: ${JSON.stringify(lines)}`);
    }
  }
});

test("fullscreen transcript scrolling clamps and moves by lines and pages", () => {
  assert.equal(clampTranscriptOffset(-3, 20, 5), 0);
  assert.equal(clampTranscriptOffset(99, 20, 5), 15);
  assert.equal(scrollTranscript(0, 1, 20, 5), 1);
  assert.equal(scrollTranscript(1, -5, 20, 5), 0);
  assert.equal(scrollTranscript(0, 5, 20, 5), 5);
});

test("fullscreen conversation scrolling is separate from compose history", async () => {
  const { gui, stdin } = createFocusGui({ runTask: async () => {} });
  gui.state.transcript = Array.from({ length: 30 }, (_, index) => `line ${index}`);
  const originalTask = gui.state.task;
  stdin.emit("keypress", "", { name: "up" });
  assert.equal(gui.state.transcriptOffset, 1);
  assert.equal(gui.state.task, originalTask);
  stdin.emit("keypress", "", { name: "pageup" });
  assert.ok(gui.state.transcriptOffset > 1);
  stdin.emit("keypress", "", { name: "end" });
  assert.equal(gui.state.transcriptOffset, 0);
  stdin.emit("keypress", "", { name: "tab" });
  gui.state.composeHistory.push("history");
  stdin.emit("keypress", "", { name: "up" });
  assert.equal(gui.state.task, "history");
  gui.cleanup();
});

test("fullscreen rendering exposes transcript scroll position without breaking compact layout", () => {
  const { gui, writes } = createFocusGui();
  gui.state.transcript = Array.from({ length: 30 }, (_, index) => `line ${index}`);
  gui.state.transcriptOffset = 2;
  gui.render();
  assert.match(writes.join(""), /↑2/);
  gui.cleanup();
});

test("fullscreen focus switches from conversation to compose with Tab", () => {
  const { gui, stdin, writes } = createFocusGui();
  assert.equal(gui.state.focus, "conversation");
  stdin.emit("keypress", "", { name: "tab" });
  assert.equal(gui.state.focus, "compose");
  assert.match(writes.at(-1), /> TASK/);
  gui.cleanup();
});

test("fullscreen focus switches from compose to conversation with Shift+Tab", () => {
  const { gui, stdin, writes } = createFocusGui();
  stdin.emit("keypress", "", { name: "tab" });
  stdin.emit("keypress", "", { name: "tab", shift: true });
  assert.equal(gui.state.focus, "conversation");
  assert.match(writes.join(""), /Focus: Conversation/);
  gui.cleanup();
});

test("fullscreen compose history navigates submitted tasks without duplicates", async () => {
  const submitted = [];
  const { gui, stdin } = createFocusGui({ runTask: async task => { submitted.push(task); } });
  gui.state.task = "first";
  await gui.run();
  gui.state.task = "first";
  gui.state.focus = "compose";
  await gui.run();
  gui.state.focus = "compose";
  assert.deepEqual(gui.state.composeHistory, ["first"]);
  stdin.emit("keypress", "", { name: "up" });
  assert.equal(gui.state.task, "first");
  stdin.emit("keypress", "", { name: "down" });
  assert.equal(gui.state.task, "");
  assert.deepEqual(submitted, ["first", "first"]);
  gui.cleanup();
});

test("fullscreen Escape cancels composition and returns to conversation", () => {
  const { gui, stdin } = createFocusGui();
  gui.state.task = "discard me";
  stdin.emit("keypress", "", { name: "tab" });
  stdin.emit("keypress", "", { name: "escape" });
  assert.equal(gui.state.task, "");
  assert.equal(gui.state.focus, "conversation");
  gui.cleanup();
});

test("fullscreen Enter submits immediately and Shift+Enter inserts newline", async () => {
  const submitted = [];
  const { gui, stdin } = createFocusGui({ runTask: async task => { submitted.push(task); } });
  gui.state.task = "run now";
  stdin.emit("keypress", "", { name: "tab" });
  stdin.emit("keypress", "", { name: "return", shift: true });
  assert.equal(gui.state.task, "run now\n");
  assert.equal(gui.state.focus, "compose");
  stdin.emit("keypress", "", { name: "return" });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(submitted, ["run now\n"]);
  assert.equal(gui.state.focus, "conversation");
  gui.cleanup();
});

test("fullscreen cleanup restores terminal state once and q exits successfully", () => {
  const stdout = new EventEmitter();
  const stdin = new EventEmitter();
  const exits = [];
  let rawModeCalls = 0;
  stdout.columns = 20;
  stdout.rows = 20;
  stdout.write = () => true;
  stdin.isTTY = true;
  stdin.setRawMode = value => { rawModeCalls++; stdin.rawMode = value; };
  const processStub = new EventEmitter();
  processStub.stdout = stdout;
  processStub.stdin = stdin;
  processStub.env = {};
  processStub.cwd = () => process.cwd();
  const readlineStub = { emitKeypressEvents: () => {}, createInterface: () => { const input = new EventEmitter(); input.close = () => input.emit("close"); return input; } };
  const gui = createFullscreenGui({ process: processStub, readline: readlineStub, exit: code => exits.push(code) });
  assert.equal(stdin.rawMode, true);
  stdin.emit("keypress", "q", { name: "q" });
  gui.cleanup();
  assert.deepEqual(exits, [0]);
  assert.equal(rawModeCalls, 2);
  assert.equal(stdout.listenerCount("resize"), 0);
  assert.equal(stdin.listenerCount("keypress"), 0);
  assert.equal(processStub.listenerCount("SIGINT"), 0);
});

test("fullscreen signal aborts an active run and removes signal listeners", async () => {
  const stdout = new EventEmitter();
  const stdin = new EventEmitter();
  const exits = [];
  stdout.columns = 20;
  stdout.rows = 20;
  stdout.write = () => true;
  stdin.isTTY = false;
  const processStub = new EventEmitter();
  processStub.stdout = stdout;
  processStub.stdin = stdin;
  processStub.env = {};
  processStub.cwd = () => process.cwd();
  const readlineStub = { emitKeypressEvents: () => {}, createInterface: () => { const input = new EventEmitter(); input.close = () => input.emit("close"); return input; } };
  let resolveRun;
  let aborted = false;
  const gui = createFullscreenGui({ process: processStub, readline: readlineStub, exit: code => exits.push(code), runTask: async (_task, _repo, _input, state) => { state.activeAbort = new AbortController(); state.activeAbort.signal.addEventListener("abort", () => { aborted = true; }); await new Promise(resolve => { resolveRun = resolve; }); } });
  gui.state.task = "run";
  const running = gui.run();
  await new Promise(resolve => process.nextTick(resolve));
  processStub.emit("SIGTERM");
  resolveRun();
  await running;
  assert.equal(aborted, true);
  assert.deepEqual(exits, [143]);
  assert.equal(processStub.listenerCount("SIGTERM"), 0);
  assert.equal(processStub.listenerCount("uncaughtException"), 0);
  assert.equal(stdin.listenerCount("keypress"), 0);
});


test("fullscreen renderer rerenders on resize and removes its listener during cleanup", () => {
  const originalStdout = process.stdout;
  const originalStdin = process.stdin;
  const stdout = new EventEmitter();
  const stdin = new EventEmitter();
  stdout.columns = 20;
  stdout.rows = 20;
  stdout.write = () => true;
  stdin.isTTY = false;
  stdin.resume = () => stdin;
  stdin.pause = () => stdin;
  stdin.on = stdin.addListener.bind(stdin);
  Object.defineProperty(process, "stdout", { configurable: true, value: stdout });
  Object.defineProperty(process, "stdin", { configurable: true, value: stdin });
  try {
    const gui = createFullscreenGui({ repo: process.cwd() });
    assert.equal(stdout.listenerCount("resize"), 1);
    const before = stdout.listenerCount("resize");
    stdout.emit("resize");
    assert.equal(stdout.listenerCount("resize"), before);
    gui.cleanup();
    assert.equal(stdout.listenerCount("resize"), 0);
    gui.cleanup();
    assert.equal(stdout.listenerCount("resize"), 0);
  } finally {
    Object.defineProperty(process, "stdout", { configurable: true, value: originalStdout });
    Object.defineProperty(process, "stdin", { configurable: true, value: originalStdin });
  }
});

test("fullscreen mode badges paint the brand palette as filled tiles", () => {
  const stdout = new EventEmitter();
  const stdin = new EventEmitter();
  const writes = [];
  stdout.columns = 80;
  stdout.rows = 24;
  stdout.write = value => { writes.push(value); return true; };
  stdin.isTTY = false;
  const processStub = new EventEmitter();
  processStub.stdout = stdout;
  processStub.stdin = stdin;
  processStub.env = {};
  processStub.cwd = () => process.cwd();
  const readlineStub = { emitKeypressEvents: () => {}, createInterface: () => { const input = new EventEmitter(); input.close = () => input.emit("close"); return input; } };
  const gui = createFullscreenGui({ process: processStub, readline: readlineStub, exit: () => {} });
  const painted = () => { const index = writes.length; gui.render(); return writes.slice(index).join(""); };
  // The brand is carried by a filled tile rather than by coloured text:
  // `primary` is 2.6:1 against a black terminal and would be unreadable as a
  // foreground, so the badge paints a background and white glyphs on top.
  assert.equal(painted().includes(`${ansiBackground(BRAND.primary)}${ansiForeground(BRAND.onPrimary)} ACT `), true);
  gui.state.mode = "plan";
  assert.equal(painted().includes(`${ansiBackground(BRAND.deepNavy)}${ansiForeground(BRAND.pale)} PLAN `), true);
  // `secondaryBlue` is the one palette member that clears 4.5:1 on a light
  // surface and 4.3:1 on a dark one, which is why it is the only text tone.
  gui.state.mode = "act";
  gui.state.status = "Running";
  assert.equal(painted().includes(`${ansiForeground(BRAND.secondaryBlue)} Running `), true);
  gui.cleanup();
});

test("fullscreen plain mode drops the brand tones without dropping the label", () => {
  const { gui, writes } = createFocusGui();
  const index = writes.length;
  gui.render();
  const output = writes.slice(index).join("");
  assert.equal(output.includes("ACT"), true);
  // render() still clears the screen, so this asserts on tones only: no 24-bit
  // brand sequence and no semantic tone survives MINITOK_NO_COLOR/NO_COLOR.
  for (const sequence of ["\x1b[38;2;", "\x1b[48;2;", "\x1b[32m", "\x1b[33m", "\x1b[31m"]) assert.equal(output.includes(sequence), false, `${JSON.stringify(sequence)} must be dropped in plain mode`);
  gui.cleanup();
});
