"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const root = path.join(__dirname, "..");
const sidebar = fs.readFileSync(path.join(root, "src", "sidebar.ts"), "utf8");
const html = fs.readFileSync(path.join(root, "src", "sidebar.html"), "utf8");
const auth = fs.readFileSync(path.join(root, "src", "device-auth.ts"), "utf8");
const workspace = fs.readFileSync(path.join(root, "src", "workspace.ts"), "utf8");

test("browser device auth contract", () => {
  assert.match(html, /Sign in with browser/);
  assert.match(html, /Sign out \/ switch account/);
  assert.match(sidebar, /device-login/);
  assert.match(sidebar, /device-logout/);
  assert.match(auth, /context\.secrets\.store/);
  assert.match(auth, /normalizeCustomerSession/);
  assert.match(auth, /token_type: string/);
  assert.match(auth, /openExternal/);
  // Server-origin validation is shared by device auth and every Extension-owned
  // subprocess through workspace.configuredServerUrl(). Keep this contract on the
  // shared validator rather than duplicating its implementation in device-auth.
  assert.match(workspace, /url\.protocol !== "https:"/);
  assert.match(workspace, /api\.minitok\.dev/);
  assert.match(workspace, /url\.username \|\| url\.password/);
  assert.doesNotMatch(auth, /MINITOK_CUSTOMER_PASSWORD/);
  assert.doesNotMatch(auth, /console\.log\(.*access_token/);
});

test("auth failure categories are explicit", () => {
  assert.match(auth, /Network error/);
  assert.match(sidebar, /Entitlement error/);
  assert.match(auth, /Login failed/);
});
