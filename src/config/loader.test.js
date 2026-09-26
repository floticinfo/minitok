"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { validateConfig, loadConfig, DEFAULTS, redactGoalExecutionConfig } = require("./loader");

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

  it("validates the environment variable name a provider points at", () => {
    assert.doesNotThrow(() => validateConfig({ providers: { openrouter: { base_url: "https://openrouter.ai/api/v1", api_key_env: "OPENROUTER_API_KEY" } } }));
    // A value that is not an environment variable name used to be ignored, which
    // left the provider without credentials and without a message.
    assert.throws(() => validateConfig({ providers: { openrouter: { base_url: "https://openrouter.ai/api/v1", api_key_env: "sk-or-literal-key" } } }), /api_key_env must name an environment variable/);
    assert.throws(() => validateConfig({ providers: { openrouter: { base_url: "https://openrouter.ai/api/v1", api_key_env: "" } } }), /api_key_env must name an environment variable/);
  });
});

describe("config: explicit unrestricted goal policy", () => {
  it("defaults to safe and keeps unrestricted disabled", () => {
    assert.equal(DEFAULTS.goal.default_mode, "safe");
    assert.equal(DEFAULTS.goal.unrestricted.enabled, false);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mt-goal-cfg-"));
    const previous = { home: os.homedir, xdg: process.env.XDG_CONFIG_HOME, appdata: process.env.APPDATA };
    try {
      os.homedir = () => dir;
      process.env.XDG_CONFIG_HOME = path.join(dir, "xdg");
      process.env.APPDATA = path.join(dir, "appdata");
      const config = loadConfig(path.join(dir, "missing.yml"));
      assert.equal(config.goal.default_mode, "safe");
      assert.equal(config.goal.unrestricted.enabled, false);
    } finally {
      os.homedir = previous.home;
      if (previous.xdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = previous.xdg;
      if (previous.appdata === undefined) delete process.env.APPDATA; else process.env.APPDATA = previous.appdata;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("validates goal mode, booleans, capability allowlist, and always-blocked floor", () => {
    assert.doesNotThrow(() => validateConfig({ goal: { default_mode: "safe", unrestricted: { enabled: true, capabilities: ["publish"] } } }));
    assert.throws(() => validateConfig({ goal: { default_mode: "always_blocked" } }), /goal.default_mode/);
    assert.throws(() => validateConfig({ goal: { unrestricted: { enabled: "yes" } } }), /must be a boolean/);
    assert.throws(() => validateConfig({ goal: { unrestricted: { capabilities: ["unknown"] } } }), /unknown capability/);
    assert.throws(() => validateConfig({ goal: { unrestricted: { capabilities: ["protected_path_write"] } } }), /always-blocked/);
    assert.throws(() => validateConfig({ goal: { unexpected: true } }), /Unknown goal configuration field/);
    assert.throws(() => validateConfig({ goal: { unrestricted: { unexpected: true } } }), /Unknown goal\.unrestricted configuration field/);
  });

  it("redacts configuration to policy metadata only", () => {
    const config = validateConfig({ goal: { default_mode: "safe", unrestricted: { enabled: true, capabilities: ["publish"] } }, providers: { openai: { api_key: "secret-value" } } });
    const safe = redactGoalExecutionConfig(config);
    assert.deepEqual(safe, { default_mode: "safe", unrestricted: { enabled: true, require_explicit_confirmation: true, require_auto_accept: true, capabilities: ["publish"] } });
    assert.doesNotMatch(JSON.stringify(safe), /secret-value|api_key|token|password/i);
  });


  it("validates and redacts unrestricted_general without exposing secrets", () => {
    const config = validateConfig({ goal: { unrestricted_general: { enabled: true, allow_goal_inference: true, allow_provisional_criteria: true, allow_replanning: true, allow_tool_discovery: true, capabilities: ["goal_inference", "criteria_inference"], max_plan_depth: 50, max_replan_count: 20, max_assumption_count: 100 } }, providers: { openai: { api_key: "secret-value" } } });
    const safe = redactGoalExecutionConfig(config);
    assert.equal(safe.unrestricted_general.enabled, true);
    assert.deepEqual(safe.unrestricted_general.capabilities, ["goal_inference", "criteria_inference"]);
    assert.doesNotMatch(JSON.stringify(safe), /secret-value|api_key|token|password/i);
    assert.throws(() => validateConfig({ goal: { unrestricted_general: { max_replan_count: -1 } } }), /max_replan_count/);
    assert.throws(() => validateConfig({ goal: { unrestricted_general: { capabilities: ["protected_path_write"] } } }), /always-blocked/);
  });

  it("keeps repository-local goal policy above the global policy", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mt-goal-priority-"));
    const globalRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mt-goal-global-"));
    const previousXdg = process.env.XDG_CONFIG_HOME;
    const local = path.join(root, "minitok.yml");
    try {
      process.env.XDG_CONFIG_HOME = globalRoot;
      fs.mkdirSync(path.join(globalRoot, "minitok"), { recursive: true });
      fs.writeFileSync(path.join(globalRoot, "minitok", "config.yml"), "goal:\n  default_mode: supervised\n  unrestricted:\n    enabled: true\n    capabilities: [publish]\n");
      fs.writeFileSync(local, "goal:\n  default_mode: safe\n  unrestricted:\n    enabled: false\n    capabilities: []\n");
      const config = loadConfig(local, { repoRoot: root });
      assert.equal(config.goal.default_mode, "safe");
      assert.equal(config.goal.unrestricted.enabled, false);
    } finally {
      if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = previousXdg;
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(globalRoot, { recursive: true, force: true });
    }
  });
});
