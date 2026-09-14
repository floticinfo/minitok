"use strict";

/**
 * Regression coverage for configuration keys and CLI flags that used to be
 * accepted, documented (and env-mapped) without reaching any consumer.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const { loadConfig, DEFAULTS } = require(path.join(ROOT, "src", "config", "loader.js"));
const { applyChanges, DEFAULT_BLOCKED_EXTENSIONS } = require(path.join(ROOT, "src", "pipeline", "implementer.js"));

const loopSource = fs.readFileSync(path.join(ROOT, "src", "pipeline", "loop.js"), "utf8");
const providerSource = fs.readFileSync(path.join(ROOT, "src", "llm", "provider.js"), "utf8");
const migrateSource = fs.readFileSync(path.join(ROOT, "src", "cli", "commands", "migrate.js"), "utf8");
const runSource = fs.readFileSync(path.join(ROOT, "src", "cli", "commands", "run.js"), "utf8");

test("the built-in blocked extensions stay a floor when configuration is merged", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "minitok-blocked-"));
  const changes = { changes: [
    { file: "schema.sql", action: "create", content: "select 1;\n" },
    { file: "danger.ps1", action: "create", content: "Write-Host 'no'\n" },
  ] };
  try {
    // Atomic preflight rejects the complete set when any entry is blocked; the
    // valid SQL file must not be partially applied.
    const baseline = applyChanges(repo, changes, false, { blockedExtensions: DEFAULT_BLOCKED_EXTENSIONS });
    assert.equal(baseline.applied, 0);
    assert.equal(fs.existsSync(path.join(repo, "schema.sql")), false);
    assert.equal(fs.existsSync(path.join(repo, "danger.ps1")), false, "the built-in list blocks executables");

    // A configured entry blocks the SQL file too, and the built-in floor still
    // covers the script: configuration can extend the list but never weaken it.
    const configured = applyChanges(repo, changes, false, { blockedExtensions: [...DEFAULT_BLOCKED_EXTENSIONS, ".sql"] });
    assert.equal(configured.applied, 0);
    assert.equal(fs.existsSync(path.join(repo, "schema.sql")), false, "the configured extension is enforced");
    assert.equal(configured.errors.length, 2);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("loadConfig no longer advertises an unimplemented commit section", () => {
  assert.equal(Object.prototype.hasOwnProperty.call(DEFAULTS, "commit"), false);
  assert.doesNotMatch(migrateSource, /^commit:/m, "the generated config must not promise auto-commit");
  const config = loadConfig(path.join(os.tmpdir(), "minitok-does-not-exist.yml"));
  assert.equal(config.commit, undefined);
  assert.equal(config.validation.confidence_threshold, 0.8);
  assert.equal(config.validation.max_changed_files, 20);
  assert.equal(config.validation.enabled, true);
});

test("the pipeline consumes the options the CLI and configuration expose", () => {
  // security.blocked_extensions reaches applyChanges instead of being a no-op.
  assert.match(loopSource, /const blockedExtensions = \[\.\.\.new Set\(\[\.\.\.DEFAULT_BLOCKED_EXTENSIONS/);
  // validation.script_path is the gate the run is judged by, so it is passed to
  // applyChanges as a protected path: a model that rewrites its own verifier must
  // be refused rather than trusted.
  assert.match(loopSource, /const protectedExtraPaths = typeof config\.validation\?\.script_path === "string"/);
  assert.match(loopSource, /const applyOptions = \{ blockedExtensions, protectedExtraPaths \};/);
  // Both call sites — already-confirmed and first-confirmation — must carry those
  // options, not just one of them.
  assert.equal((loopSource.match(/applyChanges\(repoRoot, implResult\.changes, opts\.dryRun, applyOptions\)/g) || []).length, 2);
  // --coding-adapter / --research-adapter / --review-adapter map onto roles.
  assert.match(loopSource, /const adapterOverrides = \{ work: opts\.codingAdapter, intel: opts\.researchAdapter, review: opts\.reviewAdapter \}/);
  // validation.enabled, max_changed_files, and confidence_threshold are enforced.
  assert.match(loopSource, /const validationEnabled = config\.validation\?\.enabled !== false/);
  assert.match(loopSource, /maxChangedFiles > 0 && changeList\.length > maxChangedFiles/);
  assert.match(loopSource, /reportedConfidence < confidenceThreshold/);
  // roles.<role>.timeout_sec travels into the request.
  assert.match(loopSource, /roleOptions\.timeout_ms = Number\(timeoutMs\)/);
  assert.match(loopSource, /buildRoleOptions\(config\.roles\[role\], opts\.signal, roleTimeoutMs\(role\)\)/);
  // One occurrence per provider request: Anthropic, OpenAI, Google, and custom.
  assert.equal((providerSource.match(/timeout_ms: options\.timeout_ms/g) || []).length, 4, "every provider request carries the role budget");
  assert.match(providerSource, /const requestedTimeout = Number\.isFinite\(Number\(opts\.timeout_ms\)\)/);
});

test("role provider and model environment overrides reach the loaded config", () => {
  const names = ["MINITOK_PLAN_PROVIDER", "MINITOK_PLAN_MODEL", "MINITOK_MODEL"];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  try {
    process.env.MINITOK_PLAN_PROVIDER = "openai";
    process.env.MINITOK_PLAN_MODEL = "gpt-test";
    process.env.MINITOK_MODEL = "fallback-model";
    const config = loadConfig(path.join(os.tmpdir(), "minitok-does-not-exist.yml"));
    assert.equal(config.roles.plan.provider, "openai");
    assert.equal(config.roles.plan.model, "gpt-test");
    assert.equal(config.model, "fallback-model");
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});

test("CLI role adapter overrides win over default_provider in preflight and pipeline", () => {
  assert.match(runSource, /preflightRoles\.roles\[role\][\s\S]{0,180}provider: adapter\.trim\(\), adapter: adapter\.trim\(\)/);
  assert.match(loopSource, /config\.roles\[role\] = \{ \.\.\.config\.roles\[role\], provider: adapter\.trim\(\), adapter: adapter\.trim\(\) \}/);
});

test("research-disabled preflight skips the intel role", () => {
  assert.match(runSource, /const researchEnabled = preflightRoles\.execution\?\.research_enabled !== false/);
  assert.match(runSource, /filter\(role => researchEnabled \|\| role !== "intel"\)/);
});

test("provider aliases are normalized before discovery and role resolution", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "minitok-provider-alias-"));
  const file = path.join(dir, "minitok.yml");
  try {
    fs.writeFileSync(file, "default_provider: gpt\nproviders:\n  gpt:\n    api_key: configured\nroles:\n  plan:\n    provider: claude\n");
    const config = loadConfig(file);
    assert.equal(config.default_provider, "openai");
    assert.equal(config.roles.plan.provider, "anthropic");
    assert.ok(config.providers.openai);
    assert.equal(config.providers.gpt, undefined);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("unknown roles fail configuration validation instead of being ignored", () => {
  assert.throws(() => loadConfig(path.join(os.tmpdir(), "minitok-unknown-role.yml"), { roles: { coding: {} } }), /Unknown role 'coding'/);
});

test("default_provider must be a string", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "minitok-config-type-"));
  const file = path.join(dir, "minitok.yml");
  try {
    fs.writeFileSync(file, "default_provider: 123\n");
    assert.throws(() => loadConfig(file), /default_provider must be a string/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("configuration no longer advertises role options without a consumer", () => {
  for (const role of ["plan", "review", "work", "intel"]) {
    for (const key of ["tools", "variant", "mode"]) {
      assert.equal(Object.prototype.hasOwnProperty.call(DEFAULTS.roles[role], key), false, `roles.${role}.${key} had no reader`);
    }
    assert.equal(typeof DEFAULTS.roles[role].timeout_sec, "number", "the keys that are enforced stay");
  }
  assert.equal(Object.prototype.hasOwnProperty.call(DEFAULTS.execution, "search"), false, "the web/GitHub search subsystem does not exist");
  assert.equal(DEFAULTS.project.name, "unknown");
  assert.equal(DEFAULTS.project.stack, "generic");
});

test("project.name and project.stack label the prompts", () => {
  assert.match(loopSource, /const projectLabel = \[config\.project\?\.name, config\.project\?\.stack\]/);
  assert.match(loopSource, /const promptContext = projectLabel \? `Project: \$\{projectLabel\}\\n\$\{repoContext\}` : repoContext;/);
  assert.match(loopSource, /intel\(roleProviders\.intel\.provider, task, promptContext,/);
  assert.match(loopSource, /plan\(roleProviders\.plan\.provider, task, promptContext,/);
  assert.match(loopSource, /implement\(roleProviders\.work\.provider, planResult, promptContext,/);
});

test("the project label reaches the planner and implementer prompts", async () => {
  const { plan } = require(path.join(ROOT, "src", "pipeline", "planner.js"));
  const { implement } = require(path.join(ROOT, "src", "pipeline", "implementer.js"));
  const context = "Project: test · node\nREPOSITORY CONTEXT";
  const captured = [];
  const planProvider = { complete: async messages => { captured.push(messages.map(message => message.content).join("\n")); return { text: JSON.stringify({ steps: [{ id: 1, description: "step" }], files: [] }), tokens: { input: 1, output: 1 }, model: "mock" }; } };
  const workProvider = { complete: async messages => { captured.push(messages.map(message => message.content).join("\n")); return { text: JSON.stringify({ changes: [{ file: "src/a.js", action: "create", content: "module.exports = 1;\n" }], summary: "s", files_changed: 1 }), tokens: { input: 1, output: 1 }, model: "mock" }; } };

  const planResult = await plan(planProvider, "task", context, {});
  await implement(workProvider, planResult, context, {});
  assert.equal(captured.length, 2);
  for (const prompt of captured) assert.match(prompt, /Project: test · node/, "the project label must reach the model");
});

test("a role timeout cannot exceed the configured hard ceiling", () => {
  // The ceiling is execution.timeout_hard_limit_sec (default 86400s), and it is
  // applied with Math.min over the role value.
  assert.match(loopSource, /const timeoutCeilingMs = Math\.max\(1000, \(Number\(config\.execution\?\.timeout_hard_limit_sec\) \|\| 86400\) \* 1000\)/);
  assert.match(loopSource, /Math\.min\(seconds \* 1000, timeoutCeilingMs\)/);
});
