"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { TokenStore, LOAD_CACHE_TTL_MS } = require("./token-store");

function tempStore() {
  return new TokenStore(fs.mkdtempSync(path.join(os.tmpdir(), "mt-token-store-")));
}

/**
 * A provider name that closes the single-quoted PowerShell string and injects a
 * statement. The shape is deliberately *syntactically valid* PowerShell: a
 * payload that breaks the parser never executes, so this is the form that was
 * reproduced against the previous implementation (it created the marker file).
 */
function hostileProviderName(markerPath) {
  return `x') ; Set-Content -Path '${markerPath}' -Value pwned ; (Get-Secret -Name 'y`;
}

describe("token store: keychain command construction", () => {
  it("escapes single quotes in the provider name for every PowerShell command", () => {
    const store = tempStore();
    const provider = "x') ; Remove-Item -Recurse -Force 'y";
    const commands = [
      store._powerShellLoadCommand(provider),
      store._powerShellSaveCommand(provider, JSON.stringify({ access_token: "t" })),
      store._powerShellRemoveCommand(provider),
    ];
    for (const command of commands) {
      assert.equal(command.includes(provider), false, "provider name must not be interpolated verbatim");
      assert.ok(command.includes("x'') ;"), "injected quote is doubled, keeping the payload inside the literal");
      assert.equal(command.includes("${"), false, "command has no unrendered template");
    }
  });

  it("escapes the stored secret payload as well", () => {
    const store = tempStore();
    const payload = JSON.stringify({ access_token: "a') ; Set-Content -Path 'x' -Value y ; ('" });
    const command = store._powerShellSaveCommand("anthropic", payload);
    assert.equal(command.includes("a') ; Set-Content"), false);
    assert.ok(command.includes("a'') ; Set-Content"));
  });

  it("leaves benign provider names untouched", () => {
    const store = tempStore();
    assert.match(store._powerShellLoadCommand("my-llm.v2"), /\(Get-Secret -Name 'minitok:my-llm\.v2' -AsPlainText/);
    assert.match(store._powerShellRemoveCommand("openai"), /Remove-Secret -Name 'minitok:openai'/);
  });
});

describe("token store: injection regression", () => {
  const marker = path.join(os.tmpdir(), `minitok-injection-marker-${process.pid}.txt`);

  it("never executes a provider name as PowerShell on Windows", { skip: process.platform !== "win32" }, () => {
    const store = tempStore();
    const provider = hostileProviderName(marker);
    try { fs.unlinkSync(marker); } catch {}
    try { store._keychainLoad(provider); } catch {}
    try { store._keychainRemove(provider); } catch {}
    const created = fs.existsSync(marker);
    if (created) fs.unlinkSync(marker);
    assert.equal(created, false, "a provider name from minitok.yml must not run as a command");
  });
});
describe("token store: read cache", () => {
  function countingStore() {
    const store = tempStore();
    const reads = { count: 0 };
    store._keychainLoad = () => { reads.count += 1; return { access_token: "token", expires_at: new Date(Date.now() + 600000).toISOString() }; };
    return { store, reads };
  }

  it("reads the keychain once per token instead of once per request", () => {
    const { store, reads } = countingStore();
    assert.equal(store.isValid("anthropic"), true);
    assert.equal(store.load("anthropic").access_token, "token");
    store.load("anthropic");
    // isValid() and load() both read; without the cache every auth resolve paid
    // two PowerShell processes (~1s) on Windows.
    assert.equal(reads.count, 1);
  });

  it("re-reads after a write so a rotated token is not served from cache", () => {
    const { store, reads } = countingStore();
    store.load("anthropic");
    store.save("anthropic", { access_token: "rotated" });
    store._keychainLoad = () => { reads.count += 1; return { access_token: "rotated" }; };
    assert.equal(store.load("anthropic").access_token, "rotated");
    assert.equal(reads.count, 2);
  });

  it("re-reads after a removal", () => {
    const { store, reads } = countingStore();
    store.load("anthropic");
    store.remove("anthropic");
    store._keychainLoad = () => { reads.count += 1; return null; };
    assert.equal(store.load("anthropic"), null);
    assert.equal(reads.count, 2);
  });

  it("expires cached reads", () => {
    const { store, reads } = countingStore();
    store.load("anthropic");
    store._cache.set("anthropic", { at: Date.now() - LOAD_CACHE_TTL_MS - 1, record: { access_token: "stale" } });
    assert.equal(store.load("anthropic").access_token, "token");
    assert.equal(reads.count, 2);
  });
});

