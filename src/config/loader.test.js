"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { validateConfig, loadConfig, DEFAULTS } = require("./loader");

describe("config: malformed configuration files", () => {
  const sandbox = () => fs.mkdtempSync(path.join(os.tmpdir(), "mt-cfg-"));

  it("reports a malformed project config instead of silently using the defaults", () => {
    const dir = sandbox();
    const file = path.join(dir, "minitok.yml");
    try {
      fs.writeFileSync(file, "roles: [\n");
      let error;
      try { loadConfig(file); } catch (caught) { error = caught; }
      assert.ok(error, "a malformed config must fail loudly");
      assert.equal(error.name, "ConfigError");
      assert.match(error.message, /Invalid YAML/);
      assert.match(error.message, /minitok\.yml/, "the error must name the file to fix");
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it("uses the defaults when the configuration file simply does not exist", () => {
    const dir = sandbox();
    try {
      const config = loadConfig(path.join(dir, "missing.yml"));
      assert.equal(config.validation.enabled, true);
      assert.equal(config.budget.max_cycles, DEFAULTS.budget.max_cycles);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it("ignores a directory that happens to be named minitok.yml", () => {
    const dir = sandbox();
    const candidate = path.join(dir, "minitok.yml");
    try {
      fs.mkdirSync(candidate);
      assert.doesNotThrow(() => loadConfig(candidate));
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

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
