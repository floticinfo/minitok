"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SIDEBAR_PATH = path.join(__dirname, "..", "src", "sidebar.html");
const PANEL_PATH = path.join(__dirname, "..", "src", "panel.html");
const sidebar = () => fs.readFileSync(SIDEBAR_PATH, "utf8");
const panel = () => fs.readFileSync(PANEL_PATH, "utf8");
const sidebarSource = () => fs.readFileSync(path.join(__dirname, "..", "src", "sidebar.ts"), "utf8");
const panelSource = () => fs.readFileSync(path.join(__dirname, "..", "src", "panel.ts"), "utf8");

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
  const html = sidebar().replace(/\s+/g, "");
  assert.match(html, /id="authPrompt"[^>]*>Checkingyourminitoksession/);
  assert.match(html, /id="loginForm"hidden/);
  // The login form stays visible during "checking" so a cancelled or failed
  // browser sign-in can be retried immediately; only the cancel button is
  // gated to the in-flight state.
  assert.match(html, /Keeptheloginformvisibleduring"checking"/);
  assert.match(html, /id="cancelLoginButton"[^>]*hidden/);
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
  assert.match(html, /const vscode=acquireVsCodeApi\(\)/);
  assert.match(html, /const authVscode=vscode/);
  assert.equal((html.match(/acquireVsCodeApi\(\)/g) || []).length, 1, "the panel must acquire the Webview API exactly once");
});

test("entitlement gates execution controls and explains access state", () => {
  const html = sidebar();
  assert.match(html, /id="run"[^>]*disabled/);
  assert.match(html, /run\.disabled=!entitled/);
  assert.match(html, /Signed in, but this account is not entitled/);
  assert.match(html, /Activate or manage your plan/);
  assert.match(html, /const notEntitled=state==='not-entitled'/);
  assert.match(html, /id="activateButton"[^>]*hidden/);
  assert.match(html, /command:"activate"/);
});

test("billing actions use the authenticated customer session", () => {
  const sidebarSource = fs.readFileSync(path.join(__dirname, "..", "src", "sidebar.ts"), "utf8");
  const panelSource = fs.readFileSync(path.join(__dirname, "..", "src", "panel.ts"), "utf8");
  for (const source of [sidebarSource, panelSource]) {
    assert.match(source, /--token-env/);
    assert.match(source, /--json/);
    assert.match(source, /MINITOK_UPDATE_CHECK: "0"/);
    assert.match(source, /openExternal\(vscode\.Uri\.parse\(target\)\)/);
  }
});

test("loading state is the initial visible surface before auth resolves", () => {
  const html = sidebar().replace(/\s+/g, "");
  assert.match(html, /<divid="loading"role="status"aria-live="polite">/);
  assert.match(html, /<sectionid="authGate"hidden/);
  assert.match(html, /<mainid="app"hidden>/);
  assert.match(html, /constloading=document\.getElementById\('loading'\)/);
  assert.match(html, /loading\.hidden=true;authGate\.hidden=authenticated;app\.hidden=!authenticated/);
});

test("loading spinner respects reduced motion and uses only vscode theme vars", () => {
  const html = sidebar().replace(/\s+/g, "");
  assert.match(html, /@media\(prefers-reduced-motion:reduce\)\{\.spinner\{animation:none\}\}/);
  const loadingCss = html.match(/#loading\{[^}]*\}[^]*?\.spinner\{[^}]*\}/)?.[0] || "";
  assert.doesNotMatch(loadingCss, /#[0-9a-fA-F]{3,8}\b/, "loading styles must not use hard-coded hex colors");
});

test("both webviews reveal the sign-in CTA when the auth check never answers", () => {
  // The auth gate is the only way in, so a reply that never arrives must not leave
  // the view on its initial surface ("Checking your minitok session..." / "Loading
  // minitok...") with the sign-in button still hidden.
  for (const html of [panel(), sidebar()]) {
    assert.match(html, /let authResolved=false/);
    assert.match(html, /const AUTH_WATCHDOG_MS=\d+/);
    assert.match(html, /if\(m\.type==='auth-state'\)\{authResolved=true;/);
    assert.match(html, /setTimeout\(\(\)=>\{if\(authResolved\)return;/);
    // The watchdog must show the CTA, never the authenticated app surface.
    assert.match(html, /showToast\('Could not confirm your minitok session\.','error'\)/);
  }
  assert.match(panel(), /setTimeout\([\s\S]*loginForm\.hidden=false;[\s\S]*authPrompt\.textContent='Sign-in did not answer\. Try again below\.'[\s\S]*\},AUTH_WATCHDOG_MS\)/);
  assert.match(sidebar(), /setTimeout\([\s\S]*loading\.hidden=true;[\s\S]*authGate\.hidden=false;[\s\S]*app\.hidden=true;[\s\S]*\},AUTH_WATCHDOG_MS\)/);
});

test("the panel task listener ignores auth-state traffic", () => {
  // auth-state carries no result text; without this guard the auth gate's own reply
  // blanks the status line with undefined and steals focus from the sign-in button.
  const html = panel();
  assert.match(html, /window\.addEventListener\('message',e=>\{const m=e\.data;if\(m\.type!=='result'\)return;/);
});

test("extension-side auth status always settles with an auth-state post", () => {
  // A rejection here was reported as a task result, which the auth gate ignores,
  // leaving the view stuck on its initial surface with no way to sign in. The panel
  // settles through postAuth, the sidebar through a raw auth-state post.
  assert.match(panelSource(), /authErrorText\(error\)/);
  assert.match(sidebarSource(), /state: "refresh-failed"/);
  assert.match(panelSource(), /private async authStatus\(\) \{[\s\S]*?try \{[\s\S]*?\} catch \(error\) \{[\s\S]*?this\.postAuth\("refresh-failed"/);
  // The sidebar's auth-status path was extracted into refreshAuth() so activation
  // can repaint the gate; the settle guarantee now lives on that method.
  assert.match(sidebarSource(), /public async refreshAuth\(\) \{[\s\S]*?try \{[\s\S]*?\} catch \(error\) \{[\s\S]*?state: "refresh-failed"/);
});

test("every webview script block parses as JavaScript", () => {
  // A single broken string literal (the esc() map was once split mid-line) made the
  // whole sidebar <script> a SyntaxError, so no listener, no auth-status request and
  // no watchdog ever ran: the view was stranded on "Loading minitok..." forever.
  // vm.Script compiles without executing, so acquireVsCodeApi() is safe here.
  for (const [name, html] of [["panel", panel()], ["sidebar", sidebar()]]) {
    const blocks = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)]
      .map(m => m[1])
      .filter(code => code.trim().length > 0);
    assert.ok(blocks.length > 0, `${name} must contain at least one script block`);
    blocks.forEach((code, i) => {
      assert.doesNotThrow(() => new vm.Script(code, { filename: `${name}.html#script${i + 1}` }), `${name} script block ${i + 1} has a syntax error`);
    });
  }
});

test("webview status and error messages surface as in-webview toasts", () => {
  // The toast UI must be webview-internal (not vscode.window.show*Message): a fixed
  // container plus a showToast helper that renders a themed, auto-dismissing toast.
  for (const [name, html] of [["sidebar", sidebar()], ["panel", panel()]]) {
    // The container and helper exist in both webviews.
    assert.match(html, /id="toastContainer" class="toast-container" aria-live="polite"/, `${name} must render a toast container`);
    assert.match(html, /function showToast\(text,kind\)/, `${name} must define showToast(text,kind)`);
    assert.match(html, /setTimeout\(\(\)=>\{t\.remove\(\)\},\d+\)/, `${name} toasts must auto-dismiss`);
    // Toasts stay on the editor's theme, never a hard-coded color.
    assert.match(html, /\.toast-container\s*\{/, `${name} must style the toast container`);
    assert.match(html, /background:\s*var\(--vscode-notifications-background\)/, `${name} toast uses the themed notification background`);
    assert.match(html, /\.toast\.error\s*\{/, `${name} must style the error toast variant`);
  }
});

test("error paths route their message through showToast", () => {
  const html = sidebar();
  // Auth failures (login / not-entitled / entitlement / watchdog) must toast, not
  // only paint inline, so the message is visible without scrolling to the auth card.
  assert.match(html, /if\(authMsg\)showToast\(authMsg,'error'\)/);
  assert.match(html, /showToast\(m\.text\|\|'An active paid plan is required\.','error'\)/);
  assert.match(html, /showToast\('Could not confirm your minitok session\.','error'\)/);
  // Billing and run failures toast as errors too.
  assert.match(html, /showToast\(m\.text\|\|'Billing action failed\.','error'\)/);
  assert.match(html, /m\.ok===false\)showToast\('Run failed/);
  // Previously invisible messages now reach the user: mcp-connect and summary had no
  // render path, and info/activation/update-result only wrote into the settings card.
  assert.match(html, /m\.type==='mcp-connect'\)\{showToast\(/);
  assert.match(html, /m\.type==='summary'\)\{if\(m\.text\)showToast\(/);
  assert.match(html, /m\.type==='info'\)\{[^}]*showToast\(m\.text,'info'\)/);
  assert.match(html, /m\.type==='activation'\)\{[^}]*showToast\(m\.text,'info'\)/);
  assert.match(html, /m\.type==='update-result'\)\{[^}]*showToast\(m\.text,m\.ok===false\?'error':'info'\)/);
});

// --- Execution-based webview harness ---------------------------------------
// The assertions above match source text; the ones below actually run the
// webview <script> blocks in a vm sandbox and drive window 'message' events,
// so a message-shape mismatch (e.g. panel.ts post() omitting type:'result')
// fails the test instead of silently dropping feedback in production.

function extractScripts(html) {
  return [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)]
    .map(m => m[1])
    .filter(code => code.trim().length > 0);
}

function makeEl(id) {
  return {
    id,
    hidden: false,
    disabled: false,
    textContent: "",
    className: "",
    value: "",
    dataset: {},
    focus() {},
    setAttribute() {},
    addEventListener() {},
  };
}

// Runs the scripts that attach window 'message' listeners, with a DOM stub
// rich enough for both webviews. `ids` are the element ids the scripts touch;
// blockIndex selects which <script> blocks to execute (auth handler block and,
// for the panel, the result handler block). Returns the recorded toasts plus
// a dispatch() for webview-bound messages.
function runWebview(html, blockIndexes, ids) {
  const listeners = [];
  const toasts = [];
  const els = new Map(ids.map(id => [id, makeEl(id)]));
  const documentStub = {
    getElementById: id => (els.has(id) ? els.get(id) : (els.set(id, makeEl(id)), els.get(id))),
    createElement: () => makeEl("created"),
    addEventListener() {},
  };
  const sandbox = {
    document: documentStub,
    window: { addEventListener: (type, fn) => { if (type === "message") listeners.push(fn); } },
    acquireVsCodeApi: () => ({ postMessage() {} }),
    setTimeout: () => 0,
    clearTimeout() {},
    console,
  };
  vm.createContext(sandbox);
  const scripts = extractScripts(html);
  // const/let declarations do not cross separate runInContext calls, but webview
  // blocks share them (block 1 does `const authVscode=vscode` from block 0), so
  // run the selected blocks as one combined script in declaration order.
  const combined = blockIndexes.map(i => scripts[i]).join("\n;\n");
  new vm.Script(combined, { filename: "webview#combined" }).runInContext(sandbox);
  // Neutralize the DOM-dependent toast renderer, keep a recorder instead.
  vm.runInContext("showToast = (text, kind) => { __toasts.push({ text, kind }); };", Object.assign(sandbox, { __toasts: toasts }));
  return {
    toasts,
    els,
    dispatch: data => { for (const fn of listeners) fn({ data }); },
  };
}

test("panel result listener drops messages without type:'result' (post() contract)", () => {
  // panel.ts post() must send { type:"result", ok, text }; if the type field is
  // dropped the webview returns early and the user sees nothing.
  const panelPost = panelSource().match(/private post\(ok: boolean, text: string\) \{[^}]*\}/)?.[0] || "";
  assert.match(panelPost, /type: "result"/, "panel post() must tag messages with type:\"result\" or the webview listener ignores them");

  const view = runWebview(panel(), [0], ["state", "task", "toastContainer"]);
  view.dispatch({ ok: false, text: "run exploded" }); // no type: must be ignored
  assert.equal(view.els.get("state").textContent, "", "untyped message must not reach the status element");
  assert.equal(view.toasts.length, 0, "untyped message must not toast");

  view.dispatch({ type: "result", ok: false, text: "run exploded" });
  assert.equal(view.els.get("state").textContent, "run exploded");
  assert.equal(view.els.get("state").className, "status error");
  assert.deepEqual(view.toasts.map(t => t.kind), ["error"], "failed runs must surface an error toast");
});

test("panel auth-state handler toasts signed-out errors and gates controls", () => {
  // Block 0 declares `const vscode=acquireVsCodeApi()` and showToast; block 1
  // (auth handler) depends on both, so run them together.
  const view = runWebview(panel(), [0, 1], ["state", "task", "toastContainer", "authGate", "app", "logoutButton", "loginForm", "authPrompt", "authError", "run", "dry", "status", "activateButton"]);
  view.dispatch({ type: "auth-state", authenticated: false, state: "signed-out", text: "Login failed: denied" });
  assert.equal(view.els.get("authGate").hidden, false);
  assert.equal(view.els.get("app").hidden, true);
  assert.deepEqual(view.toasts.map(t => t.text), ["Login failed: denied"], "login failure must surface as an error toast");
  assert.equal(view.els.get("authError").textContent, "", "no inline auth error may be painted");

  view.toasts.length = 0;
  view.dispatch({ type: "auth-state", authenticated: true, entitled: false });
  assert.equal(view.els.get("run").disabled, true, "run must stay disabled without entitlement");
  assert.ok(view.toasts.length >= 1, "not-entitled state must toast");
  assert.equal(view.els.get("activateButton").hidden, false, "not-entitled users need the activate CTA");
});

test("sidebar auth-state handler toasts errors and never paints them inline", () => {
  // Block 0 declares `const vscode=acquireVsCodeApi()`, showToast, add, esc and
  // the DOM refs; block 1 (auth handler) depends on them, so run both.
  const view = runWebview(sidebar(), [0, 1], ["loading", "authGate", "app", "logoutButton", "loginForm", "authPrompt", "authError", "run", "dry", "mcpBadge", "activateButton"]);
  view.dispatch({ type: "auth-state", authenticated: false, state: "signed-out", text: "Login failed: denied" });
  assert.equal(view.els.get("loading").hidden, true);
  assert.equal(view.els.get("app").hidden, true);
  assert.equal(view.els.get("authError").textContent, "", "inline auth error stays empty; feedback is toast-only");
  assert.deepEqual(view.toasts.map(t => t.text), ["Login failed: denied"]);

  view.toasts.length = 0;
  view.dispatch({ type: "billing", text: "Checkout could not be opened" });
  assert.deepEqual(view.toasts.map(t => t.text), ["Checkout could not be opened"], "billing failures must toast");
});

test("sidebar run/dry restore after run end still respects not-entitled state (B1 regression)", () => {
  // The result/stopped/timeout handlers used to hard-restore
  // run.disabled=dry.disabled=false, re-enabling Run for users the auth-state
  // handler had just disabled. entitledNow must carry the entitlement across.
  const html = sidebar();
  assert.match(html, /let entitledNow=false/, "entitlement must default to not-entitled until auth-state resolves");
  assert.match(html, /entitledNow=entitled/, "auth-state handler must record the latest entitlement");
  assert.equal(
    (html.match(/run\.disabled=dry\.disabled=!entitledNow/g) || []).length,
    3,
    "result, stopped and timeout handlers must all gate the restore on entitledNow"
  );

  const view = runWebview(html, [0, 1], ["loading", "authGate", "app", "logoutButton", "loginForm", "authPrompt", "authError", "run", "dry", "mcpBadge", "activateButton", "stop", "stage", "task", "state", "evidence"]);
  view.dispatch({ type: "auth-state", authenticated: true, entitled: false });
  assert.equal(view.els.get("run").disabled, true);
  view.dispatch({ type: "result", ok: true });
  assert.equal(view.els.get("run").disabled, true, "result must not re-enable run without entitlement");
  assert.equal(view.els.get("dry").disabled, true, "result must not re-enable dry without entitlement");
  view.dispatch({ type: "stopped" });
  assert.equal(view.els.get("run").disabled, true, "stopped must not re-enable run without entitlement");
  view.dispatch({ type: "timeout" });
  assert.equal(view.els.get("run").disabled, true, "timeout must not re-enable run without entitlement");

  view.dispatch({ type: "auth-state", authenticated: true, entitled: true });
  view.dispatch({ type: "result", ok: true });
  assert.equal(view.els.get("run").disabled, false, "entitled users get run back after a result");
});

test("the hidden attribute actually hides in both webviews", () => {
  // Regression: every auth state switches surfaces by toggling `hidden`, but an
  // author `display` value outranks the user-agent [hidden] rule. .auth-gate and
  // #loading are display:flex, so a successful sign-in set hidden=true and still
  // left the sign-in card painted over the app (position:fixed, inset:0, z-index:10)
  // -- the user was stuck on "Sign in to minitok" after signing in.
  for (const [name, html] of [["sidebar", sidebar()], ["panel", panel()]]) {
    assert.match(
      html,
      /\[hidden\]\s*\{\s*display:none!important\s*\}/,
      `${name} must force [hidden] to win over the author display values`
    );
  }
  // The per-selector patch is redundant once the global rule exists; keeping it
  // invited the belief that only .approval needed it.
  assert.doesNotMatch(sidebar(), /\.approval\[hidden\]\s*\{/);
});

test("the signed-in prompt never double-prefixes the extension's own sentence", () => {
  // The extension already sends a complete sentence ("Signed in as admin.",
  // "Signed in with Level 1 plan."), so the webview template used to render
  // "Signed in with Signed in as admin.".
  for (const [name, html] of [["sidebar", sidebar()], ["panel", panel()]]) {
    assert.doesNotMatch(
      html,
      /Signed in with \$\{m\.text/,
      `${name} must not prefix a message that is already a full sentence`
    );
    assert.match(
      html,
      /entitled\?\(m\.text\|\|'Signed in with your minitok account\.'\)/,
      `${name} must fall back to a default sentence only when the extension sent none`
    );
  }
});

test("both auth surfaces expose the same email sign-in and admin route", () => {
  // The admin route was wired to the sidebar's ID sign-in button only, so the
  // panel's auth gate had no way to reach it (it had no credentials form at all)
  // and an admin sign-in there fell through to "Unsupported command".
  for (const [name, html] of [["sidebar", sidebar()], ["panel", panel()]]) {
    assert.match(html, /id="loginEmail"/, `${name} must offer an email field`);
    assert.match(html, /id="loginPassword"/, `${name} must offer a password field`);
    assert.match(html, /id="loginButton"/, `${name} must offer an ID sign-in button`);
    assert.match(
      html,
      /const adminRoute=e\.ctrlKey&&e\.shiftKey/,
      `${name} must route a modifier-clicked sign-in to the admin endpoint`
    );
    assert.match(
      html,
      /command:adminRoute\?'admin-login':'customer-login'/,
      `${name} must post the admin or customer command accordingly`
    );
  }
  for (const [name, source] of [["sidebar", sidebarSource()], ["panel", panelSource()]]) {
    assert.match(source, /message\?\.command === "customer-login"/, `${name} must handle customer-login`);
    assert.match(source, /message\?\.command === "admin-login"/, `${name} must handle admin-login`);
  }
});

test("an admin session alone satisfies every signed-in check and is cleared on sign-out", () => {
  // The admin session bypasses the plan gate, so a view reopened after an admin
  // sign-in must not fall back to the customer session and re-paint the sign-in
  // card. A sign-out that left it behind would re-authenticate the next command.
  const auth = fs.readFileSync(path.join(__dirname, "..", "src", "device-auth.ts"), "utf8");
  assert.match(auth, /export async function hasAdminSession/, "a shared admin-session probe must exist");
  for (const [name, source] of [["sidebar", sidebarSource()], ["panel", panelSource()]]) {
    assert.match(source, /hasAdminSession\(this\.context\)/, `${name} auth status must consult the admin session`);
    assert.match(source, /await logoutAdmin\(this\.context\)/, `${name} sign-out must clear the admin session`);
  }
});

console.log("auth-ui tests: sidebar and panel authentication visibility contracts loaded");
