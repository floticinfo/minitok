"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { OAuthFlow } = require("./oauth");
const { ServiceAccountResolver } = require("./service-account");
const { ReadableStream } = require("node:stream/web");

const emptyHeaders = { get: () => null };

describe("OAuth browser launch safety", () => {
  it("does not auto-launch a browser without an interactive terminal", () => {
    const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
    assert.equal(new OAuthFlow()._openBrowser, interactive);
  });

  it("honours an explicit choice for every environment", () => {
    assert.equal(new OAuthFlow({ openBrowser: true })._openBrowser, true);
    assert.equal(new OAuthFlow({ openBrowser: false })._openBrowser, false);
  });
});


describe("OAuth response safety", () => {
  it("offers only the shipped provider OAuth flow and rejects the removed ones", () => {
    const flow = new OAuthFlow({ openBrowser: false });
    assert.doesNotThrow(() => flow._getConfig("anthropic", { client_id: "id" }));
    // GitHub and Azure AD were separate OAuth logins; neither is one of the three
    // supported providers, and both are reachable as a custom provider instead.
    assert.throws(() => flow._getConfig("azure_ad", { client_id: "id", tenant_id: "common" }), /Unknown OAuth provider: azure_ad/);
    assert.throws(() => flow._getConfig("github", { client_id: "id" }), /Unknown OAuth provider: github/);
  });

  it("passes Windows authorization URLs as a single browser argument", () => {
    const flow = new OAuthFlow({ openBrowser: false });
    const originalPlatform = process.platform;
    const originalSpawn = require("child_process").spawn;
    let call;
    Object.defineProperty(process, "platform", { value: "win32" });
    require("child_process").spawn = (...args) => { call = args; return { unref() {} }; };
    try { flow._openBrowserUrl("https://example.test/authorize?a=1&b=2"); }
    finally {
      require("child_process").spawn = originalSpawn;
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
    assert.deepEqual(call, ["rundll32.exe", ["url.dll,FileProtocolHandler", "https://example.test/authorize?a=1&b=2"], { detached: true, stdio: "ignore", windowsHide: true }]);
  });

  it("rejects oversized streaming token responses", async () => {
    const oldFetch = global.fetch;
    global.fetch = async () => ({ ok: true, headers: emptyHeaders, body: new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(1024 * 1024 + 1)); controller.close(); } }) });
    try { await assert.rejects(new OAuthFlow({ openBrowser: false })._exchangeCode({ token_url: "https://example.test", client_id: "id", client_secret: "secret" }, "code", "verifier"), /too large/); }
    finally { global.fetch = oldFetch; }
  });

  it("uses proxy-aware fetch for service account token exchange", async () => {
    const oldFetch = global.fetch;
    let options;
    global.fetch = async (_url, opts) => { options = opts; return { ok: true, headers: emptyHeaders, body: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(JSON.stringify({ access_token: "token" }))); controller.close(); } }) }; };
    try {
      const resolver = new ServiceAccountResolver();
      assert.equal(await resolver._refreshAuthorizedUser({ refresh_token: "r", client_id: "id", client_secret: "secret" }), "token");
      assert.equal(options.method, "POST");
    } finally { global.fetch = oldFetch; }
  });
});
