"use strict";

/**
 * Tests for the shipped provider surface: the three first-class providers and the
 * custom (OpenAI-compatible) provider everything else is reached through.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

describe("Provider surface", () => {
  it("keeps the three first-class providers and routes removed names through custom", () => {
    const { createProvider } = require("../src/llm/provider");
    assert.equal(createProvider("anthropic", { api_key: "k" }).constructor.name, "AnthropicProvider");
    assert.equal(createProvider("openai", { api_key: "k" }).constructor.name, "OpenAIProvider");
    assert.equal(createProvider("google", { api_key: "k" }).constructor.name, "GoogleProvider");
    // Aliases stay valid for the three providers.
    assert.equal(createProvider("claude", { api_key: "k" }).constructor.name, "AnthropicProvider");
    assert.equal(createProvider("gpt", { api_key: "k" }).constructor.name, "OpenAIProvider");
    assert.equal(createProvider("gemini", { api_key: "k" }).constructor.name, "GoogleProvider");
    // Everything else is a custom provider: a name alone is refused, and the same
    // name with base_url reaches the vendor's OpenAI-compatible endpoint.
    for (const removed of ["openrouter", "xai", "deepseek", "mistral", "cohere", "azure_ad"]) {
      assert.throws(() => createProvider(removed, { api_key: "k" }), /Unknown LLM provider/);
      const custom = createProvider(removed, { base_url: "https://gateway.example/v1", api_key: "k" });
      assert.equal(custom.constructor.name, "CustomProvider");
      assert.equal(custom.name, removed);
    }
  });

  it("has no removed provider in the OAuth login surface", () => {
    const { OAUTH_CONFIGS } = require("../src/auth/oauth");
    assert.deepEqual(Object.keys(OAUTH_CONFIGS), ["anthropic"]);
  });
});

describe("Custom Provider", () => {
  it("creates with base_url", () => {
    const { createProvider } = require("../src/llm/provider");
    const p = createProvider("ollama", { base_url: "http://localhost:11434/v1" });
    assert.equal(p.name, "ollama");
    assert.equal(p.baseUrl, "http://localhost:11434/v1");
  });

  it("creates with models array", () => {
    const { createProvider } = require("../src/llm/provider");
    const p = createProvider("bedrock", {
      base_url: "https://proxy.internal/v1",
      models: [
        { id: "claude-sonnet-5", display: "Claude Sonnet 5", context_window: 200000 },
      ],
    });
    assert.equal(p.name, "bedrock");
    assert.equal(p.models.length, 1);
    assert.equal(p.models[0].id, "claude-sonnet-5");
  });

  it("isAvailable with base_url", async () => {
    const { createProvider } = require("../src/llm/provider");
    const p = createProvider("ollama", { base_url: "http://localhost:11434/v1" });
    assert.equal(await p.isAvailable(), true);
  });

  it("isAvailable false without base_url", async () => {
    const { CustomProvider } = require("../src/llm/provider");
    const p = new CustomProvider({});
    assert.equal(await p.isAvailable(), false);
  });

  it("strips trailing slashes", () => {
    const { CustomProvider } = require("../src/llm/provider");
    const p = new CustomProvider({ base_url: "http://localhost:8080///" });
    assert.equal(p.baseUrl, "http://localhost:8080");
  });

  it("fetchModels returns empty without url", async () => {
    const { CustomProvider } = require("../src/llm/provider");
    const models = await CustomProvider.fetchModels("");
    assert.deepEqual(models, []);
  });
});

describe("createProvider tier routing", () => {
  it("tier 1: anthropic", () => {
    const { createProvider } = require("../src/llm/provider");
    const p = createProvider("anthropic", { api_key: "k" });
    assert.equal(p.constructor.name, "AnthropicProvider");
  });

  it("tier 2: a removed provider name needs base_url", () => {
    const { createProvider } = require("../src/llm/provider");
    assert.throws(() => createProvider("openrouter", { api_key: "k" }), /Unknown LLM provider/);
    assert.equal(createProvider("openrouter", { base_url: "https://openrouter.ai/api/v1", api_key: "k" }).constructor.name, "CustomProvider");
  });

  it("tier 3: custom via base_url", () => {
    const { createProvider } = require("../src/llm/provider");
    const p = createProvider("ollama", { base_url: "http://localhost:11434/v1" });
    assert.equal(p.constructor.name, "CustomProvider");
  });

  it("tier 3: custom via models", () => {
    const { createProvider } = require("../src/llm/provider");
    const p = createProvider("myllm", { models: [{ id: "m1" }] });
    assert.equal(p.constructor.name, "CustomProvider");
  });

  it("throws for unknown without base_url", () => {
    const { createProvider } = require("../src/llm/provider");
    assert.throws(() => createProvider("unknown"), /Unknown|Set base_url/);
  });
});

describe("Provider selection by role", () => {
  it("prefers role provider over default provider", () => {
    const { resolveProviderName } = require("../src/config/loader");
    const config = { default_provider: "default", providers: { default: {}, review: {} }, roles: { plan: {}, review: { provider: "review" } } };
    assert.equal(resolveProviderName(config, "plan"), "default");
    assert.equal(resolveProviderName(config, "review"), "review");
  });

  it("uses legacy adapter before default for compatibility", () => {
    const { resolveProviderName } = require("../src/config/loader");
    const config = { default_provider: "default", providers: { default: {}, plan: {} }, roles: { plan: { adapter: "plan" } } };
    assert.equal(resolveProviderName(config, "plan"), "plan");
  });

  it("uses the first configured provider when no default is named", () => {
    const { resolveProviderName } = require("../src/config/loader");
    const config = { providers: { first: {}, second: {} }, roles: { plan: {} } };
    assert.equal(resolveProviderName(config, "plan"), "first");
  });

  it("uses a CLI override for every role", () => {
    const { resolveProviderName } = require("../src/config/loader");
    const config = { default_provider: "default", roles: { plan: { provider: "plan" } } };
    assert.equal(resolveProviderName(config, "plan", "override"), "override");
  });
});

describe("detectAvailableProviders with custom", () => {
  it("detects a custom provider that replaced a removed one", async () => {
    const { detectAvailableProviders } = require("../src/llm/provider");
    const p = await detectAvailableProviders({ providers: { openrouter: { base_url: "https://openrouter.ai/api/v1", api_key: "k" } } });
    assert.ok(p.includes("openrouter"));
  });

  it("reads a custom provider key from the environment variable it names", async () => {
    // minitok.yml and README documented api_key_env, but nothing read it, so a
    // custom provider could not point at its vendor key at all.
    const { detectAvailableProviders } = require("../src/llm/provider");
    process.env.MINITOK_TEST_VENDOR_KEY = "vendor-secret";
    try {
      const p = await detectAvailableProviders({ providers: { openrouter: { base_url: "https://openrouter.ai/api/v1", api_key_env: "MINITOK_TEST_VENDOR_KEY" } } });
      assert.ok(p.includes("openrouter"));
    } finally {
      delete process.env.MINITOK_TEST_VENDOR_KEY;
    }
  });

  it("does not detect a removed provider by name alone", async () => {
    const { detectAvailableProviders } = require("../src/llm/provider");
    const p = await detectAvailableProviders({ providers: { openrouter: { api_key: "k" } } });
    assert.equal(p.includes("openrouter"), false, "a name without base_url is not a provider");
  });

  it("detects custom provider", async () => {
    const { detectAvailableProviders } = require("../src/llm/provider");
    const p = await detectAvailableProviders({ providers: { ollama: { base_url: "http://localhost:11434/v1" } } });
    assert.ok(p.includes("ollama"));
  });
});
