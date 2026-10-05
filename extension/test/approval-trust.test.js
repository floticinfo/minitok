"use strict";

/**
 * Approvals were all-or-nothing: every run stopped and asked again, even for
 * files the operator had already cleared. This covers the remembered-per-file
 * trust list: the opt-in checkbox, the persisted list, the auto-answer when a
 * request is fully covered, and the escape hatches (reject, clear).
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const sidebarTs = fs.readFileSync(path.join(__dirname, "..", "src", "sidebar.ts"), "utf8");
const sidebarHtml = fs.readFileSync(path.join(__dirname, "..", "src", "sidebar.html"), "utf8");

test("the approval card offers an explicit opt-in for remembering files", () => {
  assert.match(sidebarHtml, /id="approvalAlways"/, "missing the always-allow checkbox");
  assert.match(sidebarHtml, /Always allow these files in this workspace/);
  // The choice must be labelled, not implied by the Approve button.
  assert.match(sidebarHtml, /<label class="approval-trust" for="approvalAlways">/);
});

test("Approve sends the trust choice only when the box is ticked", () => {
  assert.match(sidebarHtml, /command:"approve",trust:document\.getElementById\("approvalAlways"\)\?\.checked===true/);
});

test("Reject never records the pending files", () => {
  assert.match(sidebarTs, /if \(message\.command === "reject"\) this\.pendingApprovalFiles = \[\];/);
});

test("the remembered list is workspace-scoped and bounded", () => {
  assert.match(sidebarTs, /const ALLOWED_FILES_KEY = "minitok\.allowedFiles"/);
  assert.match(sidebarTs, /const MAX_ALLOWED_FILES = 200/);
  assert.match(sidebarTs, /workspaceState\.update\(ALLOWED_FILES_KEY, merged\)/);
});

test("a request whose files are all remembered is answered without prompting", () => {
  assert.match(sidebarTs, /if \(this\.isFullyAllowed\(files\)\)/);
  assert.match(sidebarTs, /void this\.respondToApproval\(\);/);
  // Every file must be covered; a partial match must still ask.
  assert.match(sidebarTs, /return files\.every\(file => allowed\.has\(minitokSidebar\.approvalKey\(file\)\)\);/);
});

test("an empty file list is never auto-approved", () => {
  assert.match(sidebarTs, /if \(!files\.length\) return false;/);
});

test("path comparison is case-insensitive on Windows and separator-normalised", () => {
  // Backslashes are folded to forward slashes so Windows and posix paths compare equal.
  assert.ok(sidebarTs.includes("replace(/\\\\/g, \"/\")"), "path separators are not normalised");
  assert.match(sidebarTs, /process\.platform === "win32" \? normalized\.toLowerCase\(\) : normalized/);
});

test("approving with the box ticked persists the pending files", () => {
  assert.match(sidebarTs, /message\.command === "approve" && message\.trust === true\) await this\.rememberApprovedFiles\(\)/);
});

test("the operator can clear remembered approvals, and can just read the count", () => {
  assert.match(sidebarTs, /if \(message\.command === "forget-approvals"\)/);
  assert.match(sidebarTs, /if \(message\.query !== true\) await this\.context\.workspaceState\.update\(ALLOWED_FILES_KEY, \[\]\);/);
  assert.match(sidebarHtml, /id="forgetApprovals"/);
  assert.match(sidebarHtml, /command:"forget-approvals"/);
});

test("the panel asks for the remembered count on load and reports it back", () => {
  assert.match(sidebarHtml, /vscode\.postMessage\(\{command:'forget-approvals',query:true\}\)/);
  assert.match(sidebarHtml, /if\(m\.type==='approval-trust'\)/);
  assert.match(sidebarHtml, /remembered/);
});

test("each new approval request resets the checkbox", () => {
  assert.match(sidebarHtml, /const always=document\.getElementById\('approvalAlways'\);if\(always\)always\.checked=false;/);
});

test("the auto-answer reuses the existing nonce-bound, atomic approval write", () => {
  // It must not invent a second write path that skips the nonce check.
  assert.match(sidebarTs, /const temp = `\$\{response\}\.tmp-\$\{process\.pid\}-\$\{randomUUID\(\)\}`;/);
  assert.match(sidebarTs, /mode: 0o600, flag: "wx"/);
});
