"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { validateConfig } = require("./loader");

describe("config: provider name validation", () => {
  it("rejects provider names that could break out of a shell or path context", () => {
    const names = ["x') ; Start-Process calc ; ('", "a\"b", "a`b", "a$(b)", "a;b", "a&b", "a|b", "a\nb", "a\\b", "a..b"];
    for (const name of names) {
      assert.throws(
        () => validateConfig({ providers: { [name]: { base_url: "https://example.test" } } }),
        /provider name/,
        `expected ${JSON.stringify(name)} to be rejected`
      );
    }
  });

  it("rejects unsafe role provider, adapter and default_provider names", () => {
    assert.throws(() => validateConfig({ roles: { plan: { provider: "x'); evil; ('" } } }), /roles\.plan\.provider/);
    assert.throws(() => validateConfig({ roles: { work: { adapter: "x'; evil; '" } } }), /roles\.work\.adapter/);
    assert.throws(() => validateConfig({ default_provider: "x'; evil; '" }), /default_provider/);
  });

  it("treats empty or non-string provider names as unset", () => {
    assert.doesNotThrow(() => validateConfig({ roles: { plan: { provider: "" } }, default_provider: "" }));
    assert.doesNotThrow(() => validateConfig({ roles: { plan: { provider: "   " } } }));
  });

  it("accepts ordinary provider names", () => {
    const config = validateConfig({
      providers: { "my-llm.v2": { base_url: "https://example.test" }, local_ollama: { base_url: "http://localhost:11434" } },
      roles: { plan: { provider: "my-llm.v2" } },
      default_provider: "local_ollama",
    });
    assert.equal(config.default_provider, "local_ollama");
  });
});
