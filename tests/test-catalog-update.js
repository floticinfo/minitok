"use strict";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");

// Isolate the catalog cache in a temp XDG dir so tests never touch the real
// user cache. Must be set before requiring the module under test.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "minitok-catalog-test-"));
process.env.XDG_CONFIG_HOME = tmpRoot;
delete process.env.MINITOK_CATALOG_URL;

const { ensureFreshCatalog, getCatalog, cachePath, TTL_MS } = require("../src/llm/catalog-update");
const { CATALOG, listModels, findModel } = require("../src/llm/models");

after(() => { fs.rmSync(tmpRoot, { recursive: true, force: true }); });

describe("Online catalog updater", () => {
  it("resolves the cache under XDG_CONFIG_HOME", () => {
    assert.equal(cachePath(), path.join(tmpRoot, "minitok", "catalog-cache.json"));
  });

  it("getCatalog returns built-ins untouched when no cache exists", () => {
    const { models, updated_at } = getCatalog(CATALOG);
    assert.equal(updated_at, null);
    assert.equal(models.length, CATALOG.length);
    assert.equal(models.every((m, i) => m === CATALOG[i]), true);
  });

  it("offline config never fetches and reports source offline", async () => {
    const r = await ensureFreshCatalog({ offline: true });
    assert.equal(r.source, "offline");
    assert.equal(r.updated, false);
  });

  it("fresh cache is used without a network fetch", async () => {
    const models = [{ id: "test-new-model-1", display: "Test New Model", provider: "openai", tier: "balanced", context_window: 100000, max_output: 4096 }];
    fs.mkdirSync(path.dirname(cachePath()), { recursive: true });
    fs.writeFileSync(cachePath(), JSON.stringify({ fetched_at: Date.now(), updated_at: "2026-10-02", models }), "utf8");
    const r = await ensureFreshCatalog({ offline: false });
    assert.equal(r.source, "cache");
    assert.equal(r.updated, false);
    assert.equal(r.updated_at, "2026-10-02");
  });

  it("cached entries override built-ins by id and append new ids", () => {
    const models = [
      { id: "o3", display: "o3 (remote override)", provider: "openai", tier: "reasoning", context_window: 999000, max_output: 99999 },
      { id: "test-new-model-2", provider: "anthropic", context_window: 200000 },
    ];
    fs.writeFileSync(cachePath(), JSON.stringify({ fetched_at: Date.now(), updated_at: "2026-10-02", models }), "utf8");
    const { models: eff } = getCatalog(CATALOG);
    assert.equal(eff.length, CATALOG.length + 1, "one new id appended, one override in place");
    const o3 = eff.find(m => m.id === "o3");
    assert.equal(o3.display, "o3 (remote override)");
    assert.equal(o3.context_window, 999000);
    const added = eff.find(m => m.id === "test-new-model-2");
    assert.equal(added.provider, "anthropic");
    assert.equal(added.reasoning.supported, false);
  });

  it("listModels and findModel read the overlaid catalog", () => {
    assert.ok(listModels("anthropic").some(m => m.id === "test-new-model-2"));
    assert.equal(findModel("o3").display, "o3 (remote override)");
    assert.equal(findModel("claude-opus-4-6").provider, "anthropic", "built-ins still present");
  });

  it("malformed cache entries are dropped", () => {
    const models = [
      { id: "", provider: "openai" },
      { id: "valid-1", provider: "openai", context_window: 1000 },
      "not-an-object",
      { id: "no-provider" },
      { id: "bad-ctx", provider: "openai", context_window: -5 },
    ];
    fs.writeFileSync(cachePath(), JSON.stringify({ fetched_at: Date.now(), updated_at: null, models }), "utf8");
    const { models: eff } = getCatalog(CATALOG);
    assert.ok(eff.some(m => m.id === "valid-1"));
    assert.ok(!eff.some(m => m.id === "bad-ctx"));
    assert.ok(!eff.some(m => m.id === "no-provider"));
    assert.equal(eff.length, CATALOG.length + 1);
  });

  it("corrupt cache file falls back to built-ins", () => {
    fs.writeFileSync(cachePath(), "{not json", "utf8");
    const { models, updated_at } = getCatalog(CATALOG);
    assert.equal(updated_at, null);
    assert.equal(models.length, CATALOG.length);
  });

  it("empty remote model list in cache is ignored", () => {
    fs.writeFileSync(cachePath(), JSON.stringify({ fetched_at: Date.now(), updated_at: null, models: [] }), "utf8");
    const { models } = getCatalog(CATALOG);
    assert.equal(models.length, CATALOG.length);
  });

  it("TTL constant is 24 hours", () => {
    assert.equal(TTL_MS, 24 * 60 * 60 * 1000);
  });
});
