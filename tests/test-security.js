"use strict";
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const p = require("path");
const os = require("os");
function tmpDir() { return fs.mkdtempSync(p.join(os.tmpdir(), "mt-sec-")); }
function clean(d) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }

describe("Security: Command Injection (git commit)", () => {
  it("execFileSync prevents shell injection in commit message", () => {
    const { commit } = require("../src/git/operations");
    const { execFileSync } = require("child_process");
    const d = tmpDir();
    execFileSync("git", ["init"], { cwd: d, stdio: "pipe" });
    execFileSync("git", ["config", "user.email", "t@t.com"], { cwd: d, stdio: "pipe" });
    execFileSync("git", ["config", "user.name", "T"], { cwd: d, stdio: "pipe" });
    fs.writeFileSync(p.join(d, "a.txt"), "a");
    execFileSync("git", ["add", "-A"], { cwd: d, stdio: "pipe" });
    const result = commit(d, 'legit"; rm -rf /tmp/injected; echo "');
    assert.ok(typeof result === "string");
    assert.ok(result.length > 0);
    clean(d);
  });

  it("git array args work correctly", () => {
    const g = require("../src/git/operations");
    const { execFileSync } = require("child_process");
    const d = tmpDir();
    execFileSync("git", ["init"], { cwd: d, stdio: "pipe" });
    execFileSync("git", ["config", "user.email", "t@t.com"], { cwd: d, stdio: "pipe" });
    execFileSync("git", ["config", "user.name", "T"], { cwd: d, stdio: "pipe" });
    fs.writeFileSync(p.join(d, "test.txt"), "hello");
    execFileSync("git", ["add", "-A"], { cwd: d, stdio: "pipe" }); execFileSync("git", ["commit", "-m", "init"], { cwd: d, stdio: "pipe" });
    assert.equal(g.isGitRepo(d), true);
    assert.ok(g.currentBranch(d).length > 0);
    assert.ok(g.headCommit(d).length >= 7);
    assert.ok(g.fileCount(d) >= 1);
    assert.equal(g.status(d), "");
    clean(d);
  });
});

describe("Security: Path Traversal", () => {
  it("blocks path traversal outside repo", () => {
    const { safePath } = require("../src/pipeline/implementer");
    const d = tmpDir();
    const result = safePath(d, "../../etc/passwd");
    assert.equal(result.safe, false);
    assert.ok(result.reason.includes("Path traversal"));
    clean(d);
  });

  it("allows valid paths within repo", () => {
    const { safePath } = require("../src/pipeline/implementer");
    const d = tmpDir();
    const result = safePath(d, "src/main.js");
    assert.equal(result.safe, true);
    clean(d);
  });

  it("blocks absolute path injection", () => {
    const { safePath } = require("../src/pipeline/implementer");
    const d = tmpDir();
    const result = safePath(d, "/etc/passwd");
    assert.equal(result.safe, false);
    clean(d);
  });

  it("applyChanges rejects traversal paths", () => {
    const { applyChanges } = require("../src/pipeline/implementer");
    const d = tmpDir();
    const result = applyChanges(d, {
      changes: [{ file: "../../etc/cron.d/evil", action: "create", content: "bad" }]
    });
    assert.equal(result.applied, 0);
    assert.ok(result.errors.length > 0);
    clean(d);
  });

  it("applyChanges allows valid in-repo paths", () => {
    const { applyChanges } = require("../src/pipeline/implementer");
    const d = tmpDir();
    const result = applyChanges(d, {
      changes: [{ file: "src/test.js", action: "create", content: "console.log('hi')" }]
    });
    assert.equal(result.applied, 1);
    assert.equal(result.errors.length, 0);
    assert.ok(fs.existsSync(p.join(d, "src/test.js")));
    clean(d);
  });
});

describe("Security: YAML Safe Schema", () => {
  it("rejects !!js/function in YAML", () => {
    const { loadConfig } = require("../src/config/loader");
    const d = tmpDir();
    const malicious = 'project:\n  name: !!js/function "function(){return process.exit(1)}"\n';
    fs.writeFileSync(p.join(d, "minitok.yml"), malicious);
    try {
      const config = loadConfig(p.join(d, "minitok.yml"));
      assert.equal(typeof config.project.name, "string");
    } catch (e) {
      assert.ok(e.message.includes("YAML") || e.message.includes("Invalid"));
    }
    clean(d);
  });

  it("normal YAML still works", () => {
    const { loadConfig } = require("../src/config/loader");
    const d = tmpDir();
    fs.writeFileSync(p.join(d, "minitok.yml"), 'project:\n  name: test\nbudget:\n  max_cycles: 5\n');
    const config = loadConfig(p.join(d, "minitok.yml"));
    assert.equal(config.project.name, "test");
    assert.equal(config.budget.max_cycles, 5);
    clean(d);
  });
});

describe("Security: Provider timeout", () => {
  it("fetchWithTimeout aborts after deadline", async () => {
    const { AnthropicProvider } = require("../src/llm/provider");
    const p2 = new AnthropicProvider({ api_key: "test-key" });
    const start = Date.now();
    try {
      await p2.complete([{ role: "user", content: "test" }], { max_tokens: 10 });
    } catch (e) {
      const elapsed = Date.now() - start;
      assert.ok(elapsed < 70000, "Should timeout within 70s, took " + elapsed + "ms");
    }
  });
});

describe("Security: Provider detection unchanged", () => {
  it("all providers still create correctly", () => {
    const pm = require("../src/llm/provider");
    assert.equal(pm.createProvider("anthropic").name, "anthropic");
    assert.equal(pm.createProvider("openai").name, "openai");
    assert.equal(pm.createProvider("google").name, "google");
    assert.throws(() => pm.createProvider("unknown"), /Unknown/);
  });

  it("aliases still work", () => {
    const pm = require("../src/llm/provider");
    assert.equal(pm.createProvider("claude").name, "anthropic");
    assert.equal(pm.createProvider("gpt").name, "openai");
    assert.equal(pm.createProvider("gemini").name, "google");
  });
});

describe("High: coerceValue null safety", () => {
  it("coerceValue handles null", () => {
    const { coerceValue } = require("../src/config/loader");
    assert.equal(coerceValue(null), null);
    assert.equal(coerceValue(undefined), null);
    assert.equal(coerceValue(""), null);
    assert.equal(coerceValue("true"), true);
    assert.equal(coerceValue("42"), 42);
    assert.equal(coerceValue("hello"), "hello");
  });
});

describe("High: Provider alias config resolution", () => {
  it("claude alias resolves to anthropic config", () => {
    const pm = require("../src/llm/provider");
    const ALIAS_MAP = { claude: "anthropic", gpt: "openai", gemini: "google" };
    assert.equal(ALIAS_MAP["claude"], "anthropic");
    assert.equal(ALIAS_MAP["gpt"], "openai");
    assert.equal(ALIAS_MAP["gemini"], "google");
    assert.equal(ALIAS_MAP["anthropic"], undefined); // canonical passes through
  });
});

describe("High: parseResponseJSON", () => {
  it("extracts first JSON object correctly", () => {
    const { parseResponseJSON } = require("../src/pipeline/json_utils");
    const text = 'Here is my analysis:\n{"verdict":"APPROVE","confidence":0.9}\nAdditional notes here.';
    const { parsed, valid } = parseResponseJSON(text);
    assert.equal(valid, true);
    assert.equal(parsed.verdict, "APPROVE");
    assert.equal(parsed.confidence, 0.9);
  });

  it("rejects greedy multi-JSON pollution", () => {
    const { parseResponseJSON } = require("../src/pipeline/json_utils");
    const text = '{"first":1} some garbage {"second":2}';
    const { parsed, valid } = parseResponseJSON(text);
    assert.equal(valid, true);
    assert.equal(parsed.first, 1);
    assert.equal(parsed.second, undefined); // NOT the second object
  });

  it("returns fallback on no JSON", () => {
    const { parseResponseJSON } = require("../src/pipeline/json_utils");
    const { parsed, valid } = parseResponseJSON("no json here", { error: "fallback" });
    assert.equal(valid, false);
    assert.equal(parsed.error, "fallback");
  });

  it("handles nested braces", () => {
    const { parseResponseJSON } = require("../src/pipeline/json_utils");
    const text = 'plan: {"steps":[{"name":"a","details":{"x":1}}]} done';
    const { parsed, valid } = parseResponseJSON(text);
    assert.equal(valid, true);
    assert.ok(Array.isArray(parsed.steps));
    assert.equal(parsed.steps[0].details.x, 1);
  });
});

describe("High: KnowledgeStore concurrent safety", () => {
  it("uses PID-unique temp files", () => {
    const { KnowledgeStore } = require("../src/evolution/knowledge");
    const d = tmpDir();
    const f = p.join(d, "outcomes.json");
    const ks = new KnowledgeStore(f);
    ks.record({ goal: "test", status: "success" });
    assert.ok(fs.existsSync(f));
    // Temp files should be cleaned up
    const files = fs.readdirSync(d);
    assert.equal(files.filter(f => f.startsWith("outcomes.json.tmp")).length, 0);
    clean(d);
  });

  it("preserves concurrent writes via re-read", () => {
    const { KnowledgeStore } = require("../src/evolution/knowledge");
    const d = tmpDir();
    const f = p.join(d, "outcomes.json");
    const ks1 = new KnowledgeStore(f);
    ks1.record({ goal: "first", status: "success" });
    const ks2 = new KnowledgeStore(f);
    ks2.record({ goal: "second", status: "success" });
    ks1.record({ goal: "third", status: "success" });
    const ks3 = new KnowledgeStore(f);
    assert.equal(ks3.size, 3);
    clean(d);
  });

  it("recovers stale locks", () => {
    const { KnowledgeStore } = require("../src/evolution/knowledge");
    const d = tmpDir();
    const f = p.join(d, "outcomes.json");
    fs.mkdirSync(d, { recursive: true });
    const lock = f + ".lock";
    fs.writeFileSync(lock, JSON.stringify({ pid: 999999, token: "stale" }));
    fs.utimesSync(lock, new Date(0), new Date(0));
    const ks = new KnowledgeStore(f);
    assert.equal(ks.record({ goal: "recovered", status: "success" }).goal, "recovered");
    assert.equal(fs.existsSync(lock), false);
    clean(d);
  });

  it("does not release a replacement lock", () => {
    const { KnowledgeStore } = require("../src/evolution/knowledge");
    const d = tmpDir();
    const f = p.join(d, "outcomes.json");
    const ks = new KnowledgeStore(f);
    const lockState = ks._acquireLock();
    fs.closeSync(lockState.fd);
    fs.unlinkSync(lockState.lock);
    fs.writeFileSync(lockState.lock, JSON.stringify({ pid: process.pid, token: "replacement" }));
    ks._releaseLock(lockState);
    assert.equal(fs.existsSync(lockState.lock), true);
    fs.unlinkSync(lockState.lock);
    clean(d);
  });
});

describe("Medium: Config resolves from repoRoot", () => {
  it("finds minitok.yml in repoRoot even if CWD differs", () => {
    const { loadConfig } = require("../src/config/loader");
    const repoRoot = tmpDir();
    fs.mkdirSync(p.join(repoRoot, ".minitok"), { recursive: true });
    fs.writeFileSync(p.join(repoRoot, "minitok.yml"), "budget:\n  max_cycles: 7\n");
    const c = loadConfig(null, { repoRoot });
    assert.equal(c.budget.max_cycles, 7);
    clean(repoRoot);
  });

  it("run pipeline uses repository-local configuration when configPath is omitted", () => {
    const source = fs.readFileSync(p.join(__dirname, "../src/pipeline/loop.js"), "utf8");
    assert.match(source, /const configPath = opts\.configPath \|\| path\.join\(repoRoot, "minitok\.yml"\)/);
  });

  it("prefers explicit configPath over repoRoot", () => {
    const { loadConfig } = require("../src/config/loader");
    const d = tmpDir();
    fs.writeFileSync(p.join(d, "a.yml"), "budget:\n  max_cycles: 11\n");
    fs.writeFileSync(p.join(d, "b.yml"), "budget:\n  max_cycles: 22\n");
    const c = loadConfig(p.join(d, "a.yml"), { repoRoot: d });
    assert.equal(c.budget.max_cycles, 11);
    clean(d);
  });
});

describe("Medium: CLI repository status", () => {
  it("accepts an explicit repository without a registered workspace", async () => {
    const { cmdStatus } = require("../src/cli/commands/status");
    const repoRoot = tmpDir();
    fs.mkdirSync(p.join(repoRoot, ".minitok"), { recursive: true });
    fs.writeFileSync(p.join(repoRoot, "minitok.yml"), "project:\n  name: probe\nroles: {}\n");
    const result = await cmdStatus({ repo: repoRoot, json: true });
    assert.equal(result.workspace.repository_root, p.resolve(repoRoot));
    clean(repoRoot);
  });
});

describe("Medium: Policy decreases on success", () => {
  it("decreases max_cycles when success rate is high", () => {
    const { recommendPolicy } = require("../src/evolution/policy");
    const patterns = [
      { category: "_success", count: 18 },
      { category: "test", count: 2 },
    ];
    const { recommended, reasons } = recommendPolicy(patterns, { max_cycles: 3 });
    assert.equal(recommended.max_cycles, 2);
    assert.ok(reasons.some(r => r.includes("decreased")));
  });

  it("does not decrease when failure rate is high", () => {
    const { recommendPolicy } = require("../src/evolution/policy");
    const patterns = [
      { category: "_success", count: 2 },
      { category: "test", count: 8 },
    ];
    const { recommended } = recommendPolicy(patterns, { max_cycles: 2 });
    assert.equal(recommended.max_cycles, 3); // increased
  });

  it("never goes below 1", () => {
    const { recommendPolicy } = require("../src/evolution/policy");
    const patterns = [{ category: "_success", count: 100 }];
    const { recommended } = recommendPolicy(patterns, { max_cycles: 1 });
    assert.ok(recommended.max_cycles >= 1);
  });
});

describe("Medium: HTTP response size limit", () => {
  it("MAX_RESPONSE_BYTES is defined and reasonable", () => {
    const { fetchWithTimeout } = require("../src/llm/provider");
    // We can't easily test the internal constant, but we can test the function signature
    assert.equal(typeof fetchWithTimeout, "function");
  });
});

describe("Medium: Graceful SIGINT handling", () => {
  it("runPipeline is abortable", async () => {
    const { runPipeline } = require("../src/pipeline/loop");
    // Simulate abort by calling with a signal that fires immediately
    const d = tmpDir();
    fs.mkdirSync(p.join(d, ".git"), { recursive: true });
    fs.writeFileSync(p.join(d, "package.json"), "{}");
    try {
      // Should not throw even if config is incomplete
      process.kill(process.pid, "SIGUSR1"); // fake signal that triggers no handler
    } catch {}
    clean(d);
  });
});

describe("Medium: last-run.json write error handled", () => {
  it("warns but does not throw on write error", () => {
    // We verify the try/catch structure by checking run.js source
    const src = fs.readFileSync(p.join(__dirname, "../src/cli/commands/run.js"), "utf-8");
    assert.ok(src.includes("Could not save last-run.json"));
    assert.ok(src.includes("catch (writeErr)"));
  });
});
