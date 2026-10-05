"use strict";

/**
 * The Extension inserts `@file <path>` / `@folder <path>` when the user clicks
 * "Attach file" / "Attach folder". The CLI now resolves those markers to file
 * contents and reports back on the MINITOK_CONTEXT_INFO line. This suite pins
 * the Extension half of that contract: the markers must be inserted verbatim,
 * and the report must reach the user.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = path.resolve(__dirname, "..", "src");
const sidebar = fs.readFileSync(path.join(source, "sidebar.ts"), "utf8");
const html = fs.readFileSync(path.join(source, "sidebar.html"), "utf8");

test("attach-file inserts an @file marker the CLI can resolve", () => {
  assert.match(
    sidebar,
    /command === "attach-file"[\s\S]{0,400}@file \$\{vscode\.workspace\.asRelativePath/,
    "attach-file must emit a resolvable @file marker",
  );
});

test("attach-folder inserts an @folder marker the CLI can resolve", () => {
  assert.match(
    sidebar,
    /command === "attach-folder"[\s\S]{0,400}@folder \$\{vscode\.workspace\.asRelativePath/,
    "attach-folder must emit a resolvable @folder marker",
  );
});

test("the sidebar parses MINITOK_CONTEXT_INFO from stdout", () => {
  assert.match(sidebar, /MINITOK_CONTEXT_INFO /, "the context report line must be parsed");
  assert.match(
    sidebar,
    /line\.startsWith\("MINITOK_CONTEXT_INFO "\)[\s\S]{0,900}type: "context-info"/,
    "the parsed report must be forwarded to the webview as context-info",
  );
});

test("the webview surfaces the context report to the user", () => {
  assert.match(html, /m\.type==='context-info'/, "the webview must handle context-info");
  assert.match(
    html,
    /context-info'\)\{[\s\S]{0,200}add\('\[context\] '/,
    "the context report must be written to the activity log",
  );
});