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
  assert.match(html, /Sign out/);
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

// --- Behavioral polling tests ------------------------------------------------
// deviceLogin is compiled from extension/src/device-auth.ts (test:unit runs
// `npm run compile` first), so require the dist build and drive it with a fake
// vscode module, a scripted global fetch and a shortened poll interval.

function loadDeviceAuth() {
  delete require.cache[require.resolve("../dist/src/device-auth.js")];
  const deviceAuthPath = require.resolve("../dist/src/device-auth.js");
  const vscodeStub = {
    env: { openExternal: async () => true },
    Uri: { parse: (value) => ({ toString: () => String(value) }) },
    workspace: {
      getConfiguration: () => ({ get: (key, fallback) => fallback }),
      workspaceFolders: [],
      isTrusted: true,
    },
    window: {},
  };
  const stubs = { vscode: vscodeStub };
  const Module = require("node:module");
  const originalResolve = Module._resolveFilename;
  Module._resolveFilename = function (request, ...rest) {
    if (stubs[request]) return request;
    return originalResolve.call(this, request, ...rest);
  };
  const originalLoad = Module._load;
  Module._load = function (request, ...rest) {
    if (stubs[request]) return stubs[request];
    return originalLoad.call(this, request, ...rest);
  };
  try {
    return require(deviceAuthPath);
  } finally {
    Module._resolveFilename = originalResolve;
    Module._load = originalLoad;
  }
}

function fakeContext() {
  const store = new Map();
  return {
    secrets: {
      store: async (key, value) => { store.set(key, value); },
      get: async (key) => store.get(key),
      delete: async (key) => { store.delete(key); },
    },
  };
}

function scriptPollFetch(t, pollResponses) {
  const originalFetch = global.fetch;
  let polls = 0;
  global.fetch = async (url) => {
    if (String(url).includes("/v1/auth/device/authorize")) {
      return new Response(JSON.stringify({
        device_code: "dc-test",
        verification_uri: "https://example.test/device",
        verification_uri_complete: "https://example.test/device?code=dc-test",
        expires_in: 60,
        interval: 1, // minimum 2s poll interval; keep the scripted responses short
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    polls += 1;
    const next = pollResponses.shift();
    if (typeof next === "function") return next();
    return next;
  };
  t.after(() => { global.fetch = originalFetch; });
  return () => polls;
}

const networkFailure = () => { throw new TypeError("fetch failed"); };
const pendingResponse = () => new Response(JSON.stringify({ error: "authorization_pending" }), { status: 400, headers: { "content-type": "application/json" } });
const successResponse = () => new Response(JSON.stringify({ access_token: "at-test", refresh_token: "rt-test", token_type: "Bearer" }), { status: 200, headers: { "content-type": "application/json" } });

test("device polling retries a transient network error and succeeds", async (t) => {
  const deviceAuth = loadDeviceAuth();
  const polls = scriptPollFetch(t, [networkFailure, pendingResponse, successResponse]);
  const statuses = [];
  const session = await deviceAuth.deviceLogin(fakeContext(), (text) => statuses.push(text));
  assert.equal(session.access_token, "at-test");
  assert.equal(polls(), 3, "one network retry plus one pending poll before success");
  assert.ok(statuses.some((text) => /retry 1\/2/.test(text)), "the user sees the retry status");
});

test("device polling throws the original network error after retries are exhausted", async (t) => {
  const deviceAuth = loadDeviceAuth();
  const polls = scriptPollFetch(t, [networkFailure, networkFailure, networkFailure, networkFailure]);
  const statuses = [];
  await assert.rejects(
    deviceAuth.deviceLogin(fakeContext(), (text) => statuses.push(text)),
    (error) => {
      assert.equal(error.kind, "network");
      assert.equal(error.message, "fetch failed");
      return true;
    }
  );
  assert.equal(polls(), 3, "initial attempt plus exactly two network retries");
  assert.ok(statuses.some((text) => /retry 2\/2/.test(text)));
});

test("device polling still honours cancellation during network retries", async (t) => {
  const deviceAuth = loadDeviceAuth();
  const cancellation = { cancelled: false };
  const polls = scriptPollFetch(t, [() => { cancellation.cancelled = true; return networkFailure(); }, successResponse]);
  await assert.rejects(
    deviceAuth.deviceLogin(fakeContext(), () => {}, cancellation),
    (error) => error.code === "cancelled" && error.kind === "login"
  );
  assert.equal(polls(), 1, "cancellation stops the loop on the tick after the network error");
});
