"use strict";

/**
 * The CLI emits MINITOK_PROGRESS (phase/state/tokens/cost) and the approval
 * request already carries a files[] array, but the sidebar consumed neither:
 * the stage label stayed on the scraped "Planning..." text and the approval
 * card showed a generic sentence with no idea which files were at stake.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = path.resolve(__dirname, "..", "src");
const sidebar = fs.readFileSync(path.join(source, "sidebar.ts"), "utf8");
const html = fs.readFileSync(path.join(source, "sidebar.html"), "utf8");

test("the sidebar parses MINITOK_PROGRESS from stdout", () => {
  assert.match(sidebar, /MINITOK_PROGRESS /, "the progress line must be parsed");
  assert.match(
    sidebar,
    /line\.startsWith\("MINITOK_PROGRESS "\)[\s\S]{0,500}type: "phase"/,
    "the parsed event must be forwarded to the webview as a phase message",
  );
});

test("the webview renders phase progress with token and cost totals", () => {
  assert.match(html, /m\.type==='phase'/, "the webview must handle the phase message");
  assert.match(html, /productStatus'\)\.textContent=`\$\{tin\+tout\} tokens/, "phase totals must surface in productStatus");
  assert.match(html, /stage\.textContent=done\?`\$\{label\} ✓/, "a completed phase must be marked done");
});

test("the approval card lists the files awaiting approval", () => {
  assert.match(html, /id="approvalFiles"/, "the approval card must have a file list");
  assert.match(
    html,
    /m\.type==='approval-request'[\s\S]{0,600}approvalFiles/,
    "the approval-request handler must render the files",
  );
});

test("a failed verification phase paints the stage as an error", () => {
  assert.match(
    html,
    /e\.phase==='verify'&&e\.state==='completed'&&e\.passed===false\?'error':'running'/,
    "verify completion with passed=false must set the error class",
  );
});