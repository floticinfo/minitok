"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { TokenStore } = require("./token-store");
const { AuthManager } = require("./index");

/**
 * A store whose keychain layer is inert.
 *
 * The OS keychain is shared and machine-wide: a test that saved or removed
 * `minitok:openai` would overwrite the developer's real credential. The alias
 * behaviour under test lives entirely in the file layer, so only that layer is
 * exercised. Stubbing private methods matches how token-store.test.js already
 * inspects the keychain command construction.
 */
function fileOnlyStore() {
  const store = new TokenStore(fs.mkdtempSync(path.join(os.tmpdir(), "mt-token-alias-")));
  store._keychainLoad = () => null;
  store._keychainSave = () => false;
  store._keychainRemove = () => {};
  return store;
}

/** Write a credential the way the pre-fix CLI did: under the raw argument. */
function writePreAliasCredential(store, provider, accessToken) {
  fs.mkdirSync(store._dir, { recursive: true });
  fs.writeFileSync(store._filePath(provider), JSON.stringify({ provider, access_token: accessToken, token_type: "api_key" }));
}

const FUTURE = new Date(Date.now() + 3600_000).toISOString();

describe("token store: pre-alias credential keys", () => {
  it("resolves a credential that was stored under its alias", () => {
    const store = fileOnlyStore();
    writePreAliasCredential(store, "gpt", "sk-legacy-gpt");
    // `auth login gpt` used to write gpt.json while every consumer asked for
    // openai, so the login appeared to succeed and then never authenticated.
    assert.equal(store.load("openai").access_token, "sk-legacy-gpt");
  });

  it("resolves an alias-keyed credential through the auth resolver", async () => {
    const store = fileOnlyStore();
    writePreAliasCredential(store, "gpt", "sk-legacy-gpt");
    store.save("gpt", { access_token: "sk-legacy-gpt", token_type: "api_key", expires_at: FUTURE });
    const manager = new AuthManager();
    manager._tokenStore = store;
    const resolved = await manager.resolve("gpt", { auth: { type: "oauth" } });
    assert.equal(resolved.token, "sk-legacy-gpt");
  });

  it("prefers the canonical key when both exist", () => {
    const store = fileOnlyStore();
    writePreAliasCredential(store, "gpt", "sk-legacy-gpt");
    writePreAliasCredential(store, "openai", "sk-canonical");
    assert.equal(store.load("openai").access_token, "sk-canonical");
  });

  it("does not revive a deleted credential through the alias copy", () => {
    const store = fileOnlyStore();
    writePreAliasCredential(store, "gpt", "sk-legacy-gpt");
    // `auth logout openai` must clear the alias file too, otherwise the next
    // resolve() finds it again and the logout looks like it did nothing.
    store.remove("openai");
    assert.equal(store.load("openai"), null);
    assert.equal(store.load("gpt"), null);
    assert.equal(fs.existsSync(store._filePath("gpt")), false);
    assert.equal(fs.existsSync(store._filePath("openai")), false);
  });

  it("drops the alias copy when the canonical key is written", () => {
    const store = fileOnlyStore();
    writePreAliasCredential(store, "gpt", "sk-legacy-gpt");
    store.save("openai", { access_token: "sk-fresh", token_type: "api_key" });
    // Two files for one account makes "which credential wins?" depend on the
    // read order, so a fresh canonical login supersedes the stale copy.
    assert.equal(fs.existsSync(store._filePath("gpt")), false);
    assert.equal(store.load("openai").access_token, "sk-fresh");
  });

  it("reports the pre-alias key so the CLI can offer a re-login", () => {
    const store = fileOnlyStore();
    writePreAliasCredential(store, "gpt", "sk-legacy-gpt");
    const listed = store.list();
    assert.deepEqual(listed.map(entry => entry.provider), ["gpt"]);
    assert.equal(listed[0].valid, true);
  });

  it("keeps unrelated keys free of alias fan-out", () => {
    const store = fileOnlyStore();
    const resourceKey = "https://mcp.example.test/sse";
    store.save(resourceKey, { access_token: "mcp-token", token_type: "bearer" });
    writePreAliasCredential(store, "openai", "sk-canonical");
    // A remote MCP resource key has no aliases, so removing it must not touch
    // the provider credentials that happen to share the store.
    store.remove(resourceKey);
    assert.equal(fs.existsSync(store._filePath(resourceKey)), false);
    assert.equal(store.load("openai").access_token, "sk-canonical");
  });

  it("removes a canonical name without leaving the alias behind", () => {
    const store = fileOnlyStore();
    store.save("anthropic", { access_token: "sk-anthropic", token_type: "api_key" });
    store.save("gpt", { access_token: "sk-gpt", token_type: "api_key" });
    store.remove("anthropic");
    assert.equal(fs.existsSync(store._filePath("anthropic")), false);
    assert.equal(fs.existsSync(store._filePath("claude")), false);
    assert.equal(store.load("claude"), null);
    assert.equal(store.load("gpt").access_token, "sk-gpt");
  });
});
