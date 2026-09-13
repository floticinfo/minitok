"use strict";
const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const p = require("path");
const os = require("os");
function tmpDir() { return fs.mkdtempSync(p.join(os.tmpdir(), "minitok-test-")); }
function clean(d) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
function knowledgePath() { return p.join(tmpDir(), "outcomes.json"); }
function withoutProviderEnvironment(fn) {
  const names = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY"];
  const saved = Object.fromEntries(names.map(name => [name, process.env[name]]));
  names.forEach(name => delete process.env[name]);
  return Promise.resolve().then(fn).finally(() => names.forEach(name => {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }));
}

describe("F1: Workspace", () => {
  let home, wm;
  beforeEach(() => { home = tmpDir(); wm = new (require("../src/workspace/manager").WorkspaceManager)(home); });
  it("add", () => { const d = tmpDir(); fs.writeFileSync(p.join(d, "pyproject.toml"), ""); const ws = wm.add("tw", d); assert.equal(ws.name, "tw"); assert.equal(ws.project_type, "python"); clean(d); });
  it("detect types", () => { const { detectProjectType } = require("../src/workspace/manager"); for (const [t, f] of [["python","pyproject.toml"],["node","package.json"],["rust","Cargo.toml"],["go","go.mod"]]) { const d = tmpDir(); fs.writeFileSync(p.join(d, f), ""); assert.equal(detectProjectType(d), t); clean(d); } const e = tmpDir(); assert.equal(detectProjectType(e), "generic"); clean(e); });
  it("list", () => { const d1 = tmpDir(), d2 = tmpDir(); fs.writeFileSync(p.join(d1, "a.txt"), ""); fs.writeFileSync(p.join(d2, "b.txt"), ""); wm.add("a", d1); wm.add("b", d2); assert.equal(Object.keys(wm.listAll()).length, 2); clean(d1); clean(d2); });
  it("use", () => { const d = tmpDir(); fs.writeFileSync(p.join(d, "a.txt"), ""); wm.add("sw", d); wm.use("sw"); assert.equal(wm.currentName, "sw"); assert.ok(wm.currentWorkspace().last_used); clean(d); });
  it("get", () => { const d = tmpDir(); fs.writeFileSync(p.join(d, "Cargo.toml"), ""); wm.add("g", d); assert.equal(wm.get("g").project_type, "rust"); clean(d); });
  it("dup error", () => { const d = tmpDir(); fs.writeFileSync(p.join(d, "a.txt"), ""); wm.add("dup", d); assert.throws(() => wm.add("dup", d), /already exists/); clean(d); });
  it("missing", () => assert.throws(() => wm.get("nope"), /not found/));
  it("remove", () => { const d = tmpDir(); fs.writeFileSync(p.join(d, "a.txt"), ""); wm.add("rm", d); wm.remove("rm"); assert.ok(!wm.listAll()["rm"]); clean(d); });
  it("remove clears", () => { const d = tmpDir(); fs.writeFileSync(p.join(d, "a.txt"), ""); wm.add("cr", d); wm.use("cr"); wm.remove("cr"); assert.equal(wm.currentName, null); clean(d); });
  it("resolve explicit", () => { const d = tmpDir(); fs.writeFileSync(p.join(d, "a.txt"), ""); wm.add("ex", d); assert.equal(wm.resolve("ex").name, "ex"); clean(d); });
  it("resolve CWD", () => { const d = tmpDir(); const s = p.join(d, "src"); fs.mkdirSync(s); fs.writeFileSync(p.join(d, "a.txt"), ""); wm.add("cw", d); assert.equal(wm.resolve(null, s).name, "cw"); clean(d); });
  it("ambiguous", () => { const d = tmpDir(); fs.writeFileSync(p.join(d, "a.txt"), ""); wm.add("x", d); wm.add("y", d); assert.throws(() => wm.resolve(null, d), /Ambiguous/); clean(d); });
  it("persist", () => { const d = tmpDir(); fs.writeFileSync(p.join(d, "package.json"), "{}"); wm.add("p", d); const w2 = new (require("../src/workspace/manager").WorkspaceManager)(home); assert.ok(w2.listAll()["p"]); clean(d); });
  it("fails closed on an unreadable registry lock", () => {
    // The owner is between `open(..., "wx")` and its first write, or the lock was
    // truncated. Reading that as "stale" deleted a live lock and let a second
    // writer into the registry.
    const lockPath = p.join(home, "workspaces.json.lock");
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(lockPath, "");
    const d = tmpDir(); fs.writeFileSync(p.join(d, "a.txt"), "");
    assert.throws(() => wm.add("busy", d), /busy/);
    assert.equal(fs.existsSync(lockPath), true, "a fresh unreadable lock must survive");
    clean(d);
  });
  it("repoRoot", () => { assert.equal(wm.repositoryRoot, null); const d = tmpDir(); fs.writeFileSync(p.join(d, "a.txt"), ""); wm.add("r", d); wm.use("r"); assert.equal(wm.repositoryRoot, p.resolve(d)); clean(d); });
});

describe("F2: LLM Providers", () => {
  it("anthropic", () => { const p2 = require("../src/llm/provider").createProvider("anthropic"); assert.equal(p2.name, "anthropic"); /* isAvailable now async */; });
  it("claude alias", () => assert.equal(require("../src/llm/provider").createProvider("claude").name, "anthropic"));
  it("openai", () => { const p2 = require("../src/llm/provider").createProvider("openai"); assert.equal(p2.name, "openai"); });
  it("gpt alias", () => assert.equal(require("../src/llm/provider").createProvider("gpt").name, "openai"));
  it("google", () => { const p2 = require("../src/llm/provider").createProvider("google"); assert.equal(p2.name, "google"); });
  it("gemini alias", () => assert.equal(require("../src/llm/provider").createProvider("gemini").name, "google"));
  it("unknown throws", () => assert.throws(() => require("../src/llm/provider").createProvider("nope"), /Unknown/));
  it("detect none", async () => withoutProviderEnvironment(async () => assert.equal((await require("../src/llm/provider").detectAvailableProviders({})).length, 0)));
  it("detect anthropic", async () => assert.ok((await require("../src/llm/provider").detectAvailableProviders({ providers: { anthropic: { api_key: "k" } } })).includes("anthropic")));
  it("detect openai", async () => assert.ok((await require("../src/llm/provider").detectAvailableProviders({ providers: { openai: { api_key: "k" } } })).includes("openai")));
  it("detect google", async () => assert.ok((await require("../src/llm/provider").detectAvailableProviders({ providers: { google: { api_key: "k" } } })).includes("google")));
  it("detect env", async () => { process.env.ANTHROPIC_API_KEY = "e"; process.env.OPENAI_API_KEY = "e2"; const pp = await require("../src/llm/provider").detectAvailableProviders({}); assert.ok(pp.includes("anthropic")); assert.ok(pp.includes("openai")); delete process.env.ANTHROPIC_API_KEY; delete process.env.OPENAI_API_KEY; });
  it("detect all 3", async () => withoutProviderEnvironment(async () => { const p = await require("../src/llm/provider").detectAvailableProviders({ providers: { anthropic: { api_key: "k" }, openai: { api_key: "k" }, google: { api_key: "k" } } }); assert.equal(p.length, 3); }));
  it("complete throws", async () => await assert.rejects(() => require("../src/llm/provider").createProvider("anthropic").complete([]), /no credentials|API error/));
  it("config key", async () => assert.equal(await new (require("../src/llm/provider").AnthropicProvider)({ api_key: "k" }).isAvailable(), true));
  it("custom url", () => assert.equal(new (require("../src/llm/provider").AnthropicProvider)({ api_key: "k", endpoint: "https://x.com" }).baseUrl, "https://x.com"));
});
describe("F3: Pipeline", () => {
  it("getRepoContext", () => { const ctx = require("../src/pipeline/loop").getRepoContext(p.resolve(__dirname, "..")); assert.ok(ctx.includes("Repository:")); assert.ok(ctx.includes("Branch:")); assert.ok(ctx.includes("Commit:")); });
  it("planner prompt", () => assert.ok(require("../src/pipeline/planner").PLAN_SYSTEM_PROMPT.includes("architect")));
  it("implementer prompt", () => assert.ok(require("../src/pipeline/implementer").IMPLEMENT_SYSTEM_PROMPT.includes("engineer")));
  it("verifier prompt", () => assert.ok(require("../src/pipeline/verifier").REVIEW_SYSTEM_PROMPT.includes("reviewer")));
  it("apply creates", () => { const d = tmpDir(); const r = require("../src/pipeline/implementer").applyChanges(d, { changes: [{ file: "a.txt", action: "create", content: "hi" }, { file: "sub/b.js", action: "create", content: "x" }] }); assert.equal(r.applied, 2); assert.equal(r.errors.length, 0); assert.equal(fs.readFileSync(p.join(d, "a.txt"), "utf-8"), "hi"); assert.equal(fs.readFileSync(p.join(d, "sub", "b.js"), "utf-8"), "x"); clean(d); });
  it("apply modifies", () => { const d = tmpDir(); fs.writeFileSync(p.join(d, "f.js"), "old"); require("../src/pipeline/implementer").applyChanges(d, { changes: [{ file: "f.js", action: "modify", content: "new" }] }); assert.equal(fs.readFileSync(p.join(d, "f.js"), "utf-8"), "new"); clean(d); });
  it("apply deletes", () => { const d = tmpDir(); fs.writeFileSync(p.join(d, "d.txt"), "x"); require("../src/pipeline/implementer").applyChanges(d, { changes: [{ file: "d.txt", action: "delete" }] }); assert.ok(!fs.existsSync(p.join(d, "d.txt"))); clean(d); });
  it("apply error", () => { const r = require("../src/pipeline/implementer").applyChanges(tmpDir(), { error: "fail" }); assert.equal(r.applied, 0); assert.ok(r.errors.length > 0); });
  it("dry run", () => { const d = tmpDir(); require("../src/pipeline/implementer").applyChanges(d, { changes: [{ file: "x.txt", action: "create", content: "n" }] }, true); assert.ok(!fs.existsSync(p.join(d, "x.txt"))); clean(d); });
  it("modify missing", () => { const d = tmpDir(); const r = require("../src/pipeline/implementer").applyChanges(d, { changes: [{ file: "no.txt", action: "modify", content: "x" }] }); assert.equal(r.applied, 0); assert.ok(r.errors[0].includes("not found")); clean(d); });
  it("rejects non-git", async () => { const d = tmpDir(); await assert.rejects(() => require("../src/pipeline/loop").runPipeline("t", { repoRoot: d, authorization: require("../src/pipeline/test-seam").TEST_AUTHORIZATION, knowledgePath: knowledgePath() }), /Not a git/); clean(d); });
  it("rejects unavailable", async () => { const { execSync } = require("child_process"); const d = tmpDir(); execSync("git init", { cwd: d, stdio: "pipe" }); execSync("git config user.email t@t.com", { cwd: d, stdio: "pipe" }); execSync("git config user.name T", { cwd: d, stdio: "pipe" }); fs.writeFileSync(p.join(d, "a.txt"), "a"); execSync("git add -A", { cwd: d, stdio: "pipe" }); execSync("git commit -m init", { cwd: d, stdio: "pipe" }); await assert.rejects(() => require("../src/pipeline/loop").runPipeline("t", { repoRoot: d, providerOverride: "anthropic", authorization: require("../src/pipeline/test-seam").TEST_AUTHORIZATION, knowledgePath: knowledgePath() }), /not available|no credentials|API error/); clean(d); });
  it("releases the lock when isolation setup fails", async () => {
    const { execSync } = require("child_process");
    const d = tmpDir();
    execSync("git init", { cwd: d, stdio: "pipe" });
    execSync("git config user.email t@t.com", { cwd: d, stdio: "pipe" });
    execSync("git config user.name T", { cwd: d, stdio: "pipe" });
    fs.writeFileSync(p.join(d, "a.txt"), "a");
    execSync("git add -A && git commit -m init", { cwd: d, stdio: "pipe" });
    const isolation = require("../src/workspace/isolation");
    const original = isolation.createIsolatedWorkspace;
    isolation.createIsolatedWorkspace = () => { throw new Error("isolation failed"); };
    try {
      await assert.rejects(() => require("../src/pipeline/loop").runPipeline("t", { repoRoot: d, authorization: require("../src/pipeline/test-seam").TEST_AUTHORIZATION }), /isolation failed/);
      assert.equal(fs.existsSync(p.join(d, ".minitok", "run.lock")), false);
    } finally {
      isolation.createIsolatedWorkspace = original;
      clean(d);
    }
  });
  it("e2e mock", async () => {
    const { runPipeline } = require("../src/pipeline/loop");
    const { LLMProvider } = require("../src/llm/provider");
    const { execSync } = require("child_process");
    class Mock extends LLMProvider {
      constructor() { super("mock"); } isAvailable() { return true; }
      async complete(msgs) {
        const sys = msgs.find(m => m.role === "system")?.content || "";
        let text;
        if (sys.includes("architect")) text = JSON.stringify({ task_summary: "t", steps: [{ id: 1, action: "create", file: "helper.js", description: "h", rationale: "r" }], estimated_files: 1, risk_level: "low" });
        else if (sys.includes("engineer")) text = JSON.stringify({ changes: [{ file: "helper.js", action: "create", content: "module.exports=()=>42;" }], summary: "done", files_changed: 1 });
        else text = JSON.stringify({ verdict: "APPROVE", confidence: 0.95, summary: "ok", findings: [], security_findings: [], risk_level: "low" });
        return { text, model: "mock", usage: {}, tokens: { input: 100, output: 50 } };
      }
    }
    const d = tmpDir(); execSync("git init", { cwd: d, stdio: "pipe" });
    execSync("git config user.email t@t.com", { cwd: d, stdio: "pipe" });
    execSync("git config user.name T", { cwd: d, stdio: "pipe" });
    fs.writeFileSync(p.join(d, "package.json"), "{}");
    // The default gate is VERIFY_CMD.mjs — fixture provides a repo-local one
    // (as `minitok migrate` would), exercising the real default path.
    fs.writeFileSync(p.join(d, "VERIFY_CMD.mjs"), "process.exit(0);\n");
    execSync("git add -A && git commit -m init", { cwd: d, stdio: "pipe" });
    const pm = require("../src/llm/provider"); const orig = pm.createProvider;
    pm.createProvider = (name) => { if (name === "mock") return new Mock(); return orig(name); };
    try {
      const r = await runPipeline("Add helper", { repoRoot: d, providerOverride: "mock", authorization: require("../src/pipeline/test-seam").TEST_AUTHORIZATION, autoAccept: true, knowledgePath: knowledgePath(), overrides: { budget: { max_cycles: 1 } } });
      assert.equal(r.cycles.length, 1); assert.equal(r.cycles[0].status, "APPROVE");
      assert.equal(r.cycles[0].plan.steps[0].file, "helper.js");
      assert.equal(r.cycles[0].verify.confidence, 0.95); assert.ok((r.totalTokens.input + r.totalTokens.output) > 0);
      assert.ok(fs.existsSync(p.join(d, "helper.js")));
    } finally { pm.createProvider = orig; clean(d); }
  });
  it("max_cycles", async () => {
    const { runPipeline } = require("../src/pipeline/loop");
    const { LLMProvider } = require("../src/llm/provider");
    const { execSync } = require("child_process");
    class Rej extends LLMProvider {
      constructor() { super("r"); } isAvailable() { return true; }
      async complete(msgs) {
        const sys = msgs.find(m => m.role === "system")?.content || "";
        let text;
        if (sys.includes("architect")) text = JSON.stringify({ task_summary: "t", steps: [{ id: 1, action: "create", file: "x.js", description: "d", rationale: "r" }], estimated_files: 1, risk_level: "low" });
        else if (sys.includes("engineer")) text = JSON.stringify({ changes: [{ file: "x.js", action: "create", content: "x" }], summary: "d", files_changed: 1 });
        else text = JSON.stringify({ verdict: "CHANGES_REQUESTED", confidence: 0.3, summary: "no", findings: [] });
        return { text, model: "m", usage: {}, tokens: { input: 100, output: 50 } };
      }
    }
    const d = tmpDir(); execSync("git init", { cwd: d, stdio: "pipe" });
    execSync("git config user.email t@t.com", { cwd: d, stdio: "pipe" });
    execSync("git config user.name T", { cwd: d, stdio: "pipe" });
    fs.writeFileSync(p.join(d, "a.txt"), "a");
    fs.writeFileSync(p.join(d, "VERIFY_CMD.mjs"), "process.exit(0);\n");
    execSync("git add -A && git commit -m init", { cwd: d, stdio: "pipe" });
    const pm = require("../src/llm/provider"); const orig = pm.createProvider;
    pm.createProvider = (name) => { if (name === "r") return new Rej(); return orig(name); };
    try {
      const r = await runPipeline("t", { repoRoot: d, providerOverride: "r", authorization: require("../src/pipeline/test-seam").TEST_AUTHORIZATION, autoAccept: true, knowledgePath: knowledgePath(), overrides: { budget: { max_cycles: 3 } } });
      assert.equal(r.cycles.length, 3);
      r.cycles.forEach(c => assert.equal(c.status, "CHANGES_REQUESTED"));
    } finally { pm.createProvider = orig; clean(d); }
  });
});
describe("Config", () => {
  it("loads uppercase environment variable names into budget settings", () => {
    const loader = require("../src/config/loader");
    const original = process.env.MINITOK_BUDGET_STAGNATION_LIMIT;
    process.env.MINITOK_BUDGET_STAGNATION_LIMIT = "100";
    try { assert.equal(loader.loadConfig(p.join(tmpDir(), "missing.yml")).budget.stagnation_limit, 100); }
    finally { if (original === undefined) delete process.env.MINITOK_BUDGET_STAGNATION_LIMIT; else process.env.MINITOK_BUDGET_STAGNATION_LIMIT = original; }
  });
  it("defaults", () => { const d = tmpDir(); const orig = process.cwd(); process.chdir(d); try { const c = require("../src/config/loader").loadConfig(p.join(d, "n.yml")); assert.equal(c.project.name, "unknown"); assert.equal(c.roles.plan.adapter, "claude"); assert.equal(c.budget.token_budget, "unlimited"); assert.equal(c.budget.token_hard_limit, 2000000); assert.equal(c.budget.max_cycles_hard_limit, 100); } finally { process.chdir(orig); clean(d); } });
  it("deep merge", () => { const r = require("../src/config/loader").deepMerge({ a: 1, b: { c: 2, d: 3 } }, { b: { c: 99 } }); assert.equal(r.a, 1); assert.equal(r.b.c, 99); assert.equal(r.b.d, 3); });
  it("loads yaml", () => { const d = tmpDir(); fs.writeFileSync(p.join(d, "m.yml"), "project:\n  name: test\n"); assert.equal(require("../src/config/loader").loadConfig(p.join(d, "m.yml")).project.name, "test"); clean(d); });
  it("loads only explicit non-secret environment settings", () => { const loader = require("../src/config/loader"); const names = ["minitok_project_name", "minitok_api_key", "minitok_prompt", "minitok_operator_key"]; const old = Object.fromEntries(names.map(name => [name, process.env[name]])); try { process.env.minitok_project_name = "env-project"; process.env.minitok_api_key = "should-not-load"; process.env.minitok_prompt = "should-not-load"; process.env.minitok_operator_key = "should-not-load"; const config = loader.loadConfig(p.join(tmpDir(), "missing.yml")); assert.equal(config.project.name, "env-project"); assert.equal(JSON.stringify(config).includes("should-not-load"), false); } finally { for (const [name, value] of Object.entries(old)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } } });
});

describe("Git Ops", () => {
  let dir;
  before(() => { const { execSync } = require("child_process"); dir = tmpDir(); execSync("git init", { cwd: dir, stdio: "pipe" }); execSync("git config user.email t@t.com", { cwd: dir, stdio: "pipe" }); execSync("git config user.name T", { cwd: dir, stdio: "pipe" }); fs.writeFileSync(p.join(dir, "R.md"), "# t"); execSync("git add -A && git commit -m init", { cwd: dir, stdio: "pipe" }); });
  after(() => clean(dir));
  const g = require("../src/git/operations");
  it("isGitRepo", () => assert.equal(g.isGitRepo(dir), true));
  it("not git", () => { const d = tmpDir(); assert.equal(g.isGitRepo(d), false); clean(d); });
  it("branch", () => assert.ok(g.currentBranch(dir).length > 0));
  it("commit hash", () => assert.ok(g.headCommit(dir).length >= 7));
  it("status clean", () => assert.equal(g.status(dir), ""));
  it("status dirty", () => { fs.writeFileSync(p.join(dir, "n.txt"), "n"); assert.ok(g.status(dir).includes("n.txt")); fs.unlinkSync(p.join(dir, "n.txt")); });
  it("log", () => assert.ok(g.logRecent(dir, 5).includes("init")));
  it("fileCount", () => assert.ok(g.fileCount(dir) >= 1));
  it("remoteUrl", () => assert.equal(g.remoteUrl(dir), ""));
  it("staged", () => assert.ok(Array.isArray(g.stagedFiles(dir))));
});

describe("Package manager execution", () => {
  it("uses a Windows shell wrapper for npm", () => {
    const { packageManagerCommand } = require("../src/core/package-manager");
    const result = packageManagerCommand("npm", ["test"]);
    if (process.platform === "win32") {
      assert.equal(result.command, process.env.ComSpec || "cmd.exe");
      assert.deepEqual(result.args.slice(-2), ["npm", "test"]);
    } else {
      assert.equal(result.command, "npm");
      assert.deepEqual(result.args, ["test"]);
    }
  });
});

describe("Evidence", () => {
  it("Node tests", () => { const d = tmpDir(); fs.writeFileSync(p.join(d, "package.json"), JSON.stringify({ scripts: { test: "echo ok" } })); const ev = require("../src/evidence/collector").collectEvidence(d); assert.ok(ev.timestamp); assert.ok(ev.tests); clean(d); });
  it("save", () => { const d = tmpDir(); const pp = require("../src/evidence/collector").saveEvidence(d, { timestamp: "t" }); assert.ok(fs.existsSync(pp)); assert.equal(JSON.parse(fs.readFileSync(pp, "utf-8")).timestamp, "t"); clean(d); });
});
