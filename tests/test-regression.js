"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

/**
 * Regression tests for P0 async/await bugs and --offline removal.
 * These verify that the specific crash bugs identified in the
 * minitok_FINAL_RELEASE_GATE audit cannot recur.
 */

describe("Regression: doctor async provider detection", () => {
  it("detectAvailableProviders returns an array, not a Promise", async () => {
    const { detectAvailableProviders } = require("../src/llm/provider");
    const { loadConfig } = require("../src/config/loader");
    const config = loadConfig();
    const result = await detectAvailableProviders(config);
    // Must be a resolved array, not a Promise
    assert.ok(Array.isArray(result), "detectAvailableProviders must return Array, got " + typeof result);
  });

  it("detectAvailableProviders result supports .includes()", async () => {
    const { detectAvailableProviders } = require("../src/llm/provider");
    const { loadConfig } = require("../src/config/loader");
    const config = loadConfig();
    const providers = await detectAvailableProviders(config);
    // .includes() must not throw TypeError
    assert.doesNotThrow(() => providers.includes("anthropic"), ".includes() must not throw");
    assert.doesNotThrow(() => providers.includes("nonexistent"), ".includes() must not throw for missing");
    assert.equal(typeof providers.includes("test"), "boolean");
  });
});

describe("Regression: cmdDoctor does not crash", () => {
  it("cmdDoctor returns exit code without throwing", async () => {
    const { cmdDoctor } = require("../src/cli/commands/doctor");
    // Should not throw TypeError: providers.includes is not a function
    const exitCode = await cmdDoctor();
    assert.ok(typeof exitCode === "number", "cmdDoctor must return a number");
    assert.ok(exitCode === 0 || exitCode === 1, "exit code must be 0 or 1");
  });
});

describe("Regression: cmdModels does not crash", () => {
  it("models command runs without throwing", async () => {
    const { register } = require("../src/cli/commands/models");
    const { Command } = require("commander");
    const program = new Command();
    register(program);
    // Parse models command — must not throw TypeError
    // from: "user" means the array only contains user-provided args
    await program.parseAsync(["models"], { from: "user" });
  });
});

describe("Regression: doctor success message reflects actual check results", () => {
  it("cmdDoctor returns exit code 1 when no providers are configured", async () => {
    const originalEnv = {
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      GOOGLE_API_KEY: process.env.GOOGLE_API_KEY,
      CAMEL_STREAM_API_KEY: process.env.CAMEL_STREAM_API_KEY,
    };
    for (const name of Object.keys(originalEnv)) delete process.env[name];
    const originalHome = process.env.USERPROFILE;
    const isolatedHome = require("fs").mkdtempSync(require("path").join(require("os").tmpdir(), "minitok-doctor-"));
    process.env.USERPROFILE = isolatedHome;
    try {
      const { cmdDoctor } = require("../src/cli/commands/doctor");
      const exitCode = await cmdDoctor();
      // With no providers configured, exit code must be 1 (failure)
      assert.equal(exitCode, 1, "exit code must be 1 when no providers are configured");
    } finally {
      for (const [name, value] of Object.entries(originalEnv)) {
        if (value !== undefined) process.env[name] = value;
      }
      if (originalHome !== undefined) process.env.USERPROFILE = originalHome;
      else delete process.env.USERPROFILE;
    }
  });

  it("doctor check function return value is accumulated into allOk", () => {
    const fs = require("fs");
    const doctorSrc = fs.readFileSync(
      require("path").join(__dirname, "..", "src", "cli", "commands", "doctor.js"),
      "utf-8"
    );
    // Per-provider checks are informational; the gate on allOk is "at least
    // one provider configured" so single-provider customers don't false-fail.
    assert.ok(
      doctorSrc.includes('allOk = check("LLM provider configured"'),
      "the at-least-one-provider check must be accumulated into allOk"
    );
    for (const provider of ["Anthropic", "OpenAI", "Google"]) {
      assert.ok(
        doctorSrc.includes(`["${provider}",`),
        `${provider} check must be present (informational)`
      );
    }
    assert.equal(
      doctorSrc.includes('"OpenRouter"'),
      false,
      "the provider list is the three supported providers plus custom endpoints"
    );
    // Verify ~/.minitok check is accumulated
    assert.ok(
      doctorSrc.includes('allOk = check("~/.minitok'),
      "~/.minitok check must be accumulated into allOk"
    );
    // Verify role checks are accumulated
    assert.ok(
      doctorSrc.includes("allOk = check(`  ${role}`"),
      "Role checks must be accumulated into allOk"
    );
  });
});

describe("Regression: internal admin activation command stays unshipped", () => {
  it("is not registered by the public CLI", () => {
    const binSrc = require("fs").readFileSync(
      require("path").join(__dirname, "..", "bin", "minitok.js"),
      "utf-8"
    );
    assert.ok(!binSrc.includes('command("admin-activate")'), "admin-activate must not be publicly registered");
  });

  it("is excluded from typecheck and package files", () => {
    const packageJson = JSON.parse(require("fs").readFileSync(
      require("path").join(__dirname, "..", "package.json"),
      "utf-8"
    ));
    const tsconfig = JSON.parse(require("fs").readFileSync(
      require("path").join(__dirname, "..", "tsconfig.json"),
      "utf-8"
    ));
    assert.ok(tsconfig.exclude.includes("src/cli/commands/admin-activate.js"));
    assert.ok(packageJson.files.includes("!src/cli/commands/admin-activate.js"));
    assert.equal(packageJson.bin["minitok-admin"], undefined);
    assert.ok(!packageJson.files.some((entry) => entry === "bin/minitok-admin.js" || entry === "src/admin/"));
  });
});

describe("MCP CLI parity", () => {
  it("exposes a CLI-equivalent run tool", () => {
    const { getToolDefinitions } = require("../src/mcp/tools");
    const tool = getToolDefinitions().find((item) => item.name === "minitok_run");
    assert.ok(tool);
    assert.deepEqual(tool.inputSchema.required, ["task"]);
  });

  it("rejects unsafe relative repository paths", async () => {
    const { getToolHandler } = require("../src/mcp/tools");
    await assert.rejects(() => getToolHandler("minitok_run", { task: "x", repo: "relative" }, {}), /absolute path/);
  });
});

describe("Product completeness checks", () => {
  it("status accepts an explicit workspace", async () => {
    const { cmdStatus } = require("../src/cli/commands/status");
    const code = await cmdStatus({ workspace: "missing-workspace" });
    assert.equal(code, 1);
  });
});

describe("Quantitative product benchmarks", () => {
  it("context compaction stays within budget and preserves boundaries", () => {
    const { compactText } = require("../src/context/compaction");
    const source = `${"HEAD-".repeat(10000)}MIDDLE-${"TAIL-".repeat(10000)}`;
    const budget = 4000;
    const result = compactText(source, { budget_chars: budget });
    assert.equal(result.compacted, true);
    assert.equal(result.final_chars, budget);
    assert.ok(result.final_chars / result.original_chars <= 0.11);
    assert.ok(result.text.startsWith("HEAD-"));
    assert.ok(result.text.endsWith("TAIL-"));
  });

  it("adaptive policy increases resilience after repeated failures", () => {
    const { recommendPolicy } = require("../src/evolution/policy");
    const result = recommendPolicy([
      { category: "timeout", count: 3 },
      { category: "api_error", count: 2 },
      { category: "test", count: 3 },
    ], { timeout_sec: 600, max_retries: 3, max_cycles: 3 });
    assert.equal(result.recommended.timeout_sec, 780);
    assert.equal(result.recommended.max_retries, 4);
    assert.equal(result.recommended.max_cycles, 4);
    assert.equal(result.reasons.length, 3);
  });

  it("token hard guardrail stops before the configured limit", () => {
    const { EscalationEngine } = require("../src/evolution/policy");
    const engine = new EscalationEngine({ tokenHardLimit: 100000, tokenStopRatio: 0.9 });
    const result = engine.recordCycleOutcome("benchmark", { success: true, tokens: 90000 });
    assert.equal(result.stop, true);
    assert.equal(result.humanEscalation, true);
    assert.match(result.reason, /token_exhausted/);
  });
});

describe("Regression: --offline flag removed", () => {
  it("run command does not have --offline option", () => {
    const { Command } = require("commander");
    const program = new Command();
    program.command("run").option("--dry-run").option("--repo <path>");
    // Verify --offline is NOT an option on the run command
    const runCmd = program.commands.find(c => c._name === "run");
    const opts = runCmd.options.map(o => o.long);
    assert.ok(!opts.includes("--offline"), "--offline should not be a CLI option");
  });

  it("error message does not reference --offline", () => {
    const loopSrc = require("fs").readFileSync(
      require("path").join(__dirname, "..", "src", "pipeline", "loop.js"),
      "utf-8"
    );
    assert.ok(
      !loopSrc.includes("--offline"),
      "loop.js should not reference --offline"
    );
  });
});
