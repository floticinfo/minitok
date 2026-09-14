"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SIDEBAR_PATH = path.join(__dirname, "..", "src", "sidebar.html");
const PANEL_PATH = path.join(__dirname, "..", "src", "panel.html");
const sidebar = () => fs.readFileSync(SIDEBAR_PATH, "utf8");
const panel = () => fs.readFileSync(PANEL_PATH, "utf8");

test("logout is hidden before authentication is confirmed", () => {
  const html = sidebar();
  assert.match(
    html,
    /<button id="logoutButton"[^>]*\shidden(?:\s|>)/,
    "logout must not flash in the signed-out auth gate"
  );
});

test("auth UI only reveals logout for an explicit authenticated state", () => {
  const html = sidebar();
  assert.match(html, /const authenticated=m\.authenticated===true/);
  assert.match(html, /const entitled=m\.entitled===true/);
  assert.match(html, /const state=m\.state\|\|/);
  assert.match(html, /logoutButton\.hidden=!authenticated/);
  assert.match(html, /authGate\.hidden=authenticated/);
  assert.match(html, /app\.hidden=!authenticated/);
});

test("auth UI hides logout again after sign-out or session failure", () => {
  const html = sidebar();
  const stateHandler = html.match(/window\.addEventListener\('message',[\s\S]*?vscode\.postMessage\(\{command:'auth-status'\}\)/)?.[0] || "";
  assert.match(stateHandler, /m\.authenticated===true/);
  assert.match(stateHandler, /logoutButton\.hidden=!authenticated/);
  assert.match(stateHandler, /state==='checking'/);
  assert.match(stateHandler, /state==='not-entitled'/);
  assert.doesNotMatch(stateHandler, /logoutButton\.hidden=m\.ok/);
});

test("initial auth UI is loading-only and signed-out copy is not entitlement copy", () => {
  const html = sidebar();
  assert.match(html, /id="authPrompt"[^>]*>Checking your minitok session/);
  assert.match(html, /id="loginForm" hidden/);
  assert.match(html, /'Sign in to continue'/);
  assert.match(html, /state==='checking'/);
  const sidebarSource = fs.readFileSync(path.join(__dirname, "..", "src", "sidebar.ts"), "utf8");
  assert.match(sidebarSource, /state: "refresh-failed"/);
});

test("panel does not expose task controls before authentication", () => {
  const html = panel();
  assert.match(html, /id="authGate"/);
  assert.match(html, /<main id="app" hidden>/);
  assert.match(html, /id="logoutButton"[^>]*hidden/);
  assert.match(html, /id="run"[^>]*disabled/);
  assert.match(html, /m\.authenticated===true/);
  assert.match(html, /const entitled=m\.entitled===true/);
  assert.match(html, /document\.getElementById\('run'\)\.disabled=!entitled/);
  assert.match(html, /logoutButton\.hidden=!authenticated/);
  assert.match(html, /id="loginForm" hidden/);
  assert.match(html, /const authVscode=acquireVsCodeApi\(\)/);
});

test("entitlement gates execution controls and explains access state", () => {
  const html = sidebar();
  assert.match(html, /id="run"[^>]*disabled/);
  assert.match(html, /run\.disabled=!entitled/);
  assert.match(html, /Signed in, but this account is not entitled/);
  assert.match(html, /Activate or manage your plan/);
  assert.match(html, /const notEntitled=state==='not-entitled'/);
  assert.match(html, /id="activateButton"[^>]*hidden/);
  assert.match(html, /id="manageButton"[^>]*hidden/);
  assert.match(html, /command:\"activate\"/);
  assert.match(html, /command:\"manage-plan\"/);
});

test("billing actions use the authenticated customer session", () => {
  const sidebarSource = fs.readFileSync(path.join(__dirname, "..", "src", "sidebar.ts"), "utf8");
  const panelSource = fs.readFileSync(path.join(__dirname, "..", "src", "panel.ts"), "utf8");
  for (const source of [sidebarSource, panelSource]) {
    assert.match(source, /--token-env/);
    assert.match(source, /--json/);
    assert.match(source, /MINITOK_UPDATE_CHECK: \"0\"/);
    assert.match(source, /openExternal\(vscode\.Uri\.parse\(target\)\)/);
  }
});

console.log("auth-ui tests: sidebar and panel authentication visibility contracts loaded");
