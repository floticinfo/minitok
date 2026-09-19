"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { discoverWorkspace, discoverProviders } = require("./index");
const { saveSelection, loadSelection } = require("./selection");
const { WorkspaceManager } = require("../workspace/manager");

function tempDir() { return fs.mkdtempSync(path.join(os.tmpdir(), "minitok-discovery-")); }
function makeRepo(root, name = "repo") { const repo = path.join(root, name); fs.mkdirSync(path.join(repo, ".git"), { recursive: true }); fs.writeFileSync(path.join(repo, "package.json"), "{}\n"); return repo; }

function managerFor(root) { return new WorkspaceManager(path.join(root, "home")); }

test("workspace discovery resolves a nested cwd to the marked repository", () => {
  const root = tempDir();
  try {
    const repo = makeRepo(root);
    const nested = path.join(repo, "src", "nested");
    fs.mkdirSync(nested, { recursive: true });
    const result = discoverWorkspace({ cwd: nested, manager: managerFor(root) });
    assert.equal(result.status, "candidate");
    assert.equal(result.selected.repository_root, fs.realpathSync.native(repo));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("workspace discovery preserves explicit repository precedence", () => {
  const root = tempDir();
  try {
    const repo = makeRepo(root);
    const result = discoverWorkspace({ explicitRepo: repo, cwd: root, manager: managerFor(root) });
    assert.equal(result.status, "selected");
    assert.equal(result.selected.repository_root, fs.realpathSync.native(repo));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("provider discovery reports authenticated environment candidates without secrets", async () => {
  const previous = Object.fromEntries(["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GOOGLE_API_KEY", "GEMINI_API_KEY"].map(key => [key, process.env[key]]));
  for (const key of Object.keys(previous)) delete process.env[key];
  process.env.OPENAI_API_KEY = ["test", "secret-that-must-not-appear"].join("-");
  try {
    const result = await discoverProviders({ config: { providers: {}, roles: {}, default_provider: "" }, tokenStore: { list: () => [], load: () => null } });
    const candidate = result.candidates.find(item => item.provider === "openai");
    assert.equal(candidate.authenticated, true);
    assert.equal(candidate.source, "environment");
    assert.equal(JSON.stringify(result).includes("test-secret"), false);
    assert.equal(result.status, "candidate");
  } finally {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});

test("selection persistence stores only workspace and provider identifiers", () => {
  const root = tempDir();
  try {
    saveSelection(root, { workspace: root, provider: "openai", api_key: "must-not-persist" });
    const saved = loadSelection(root);
    assert.equal(saved.schema_version, 1);
    assert.equal(saved.workspace_root, path.resolve(root));
    assert.equal(saved.provider, "openai");
    assert.equal(typeof saved.selected_at, "string");
    assert.equal(fs.readFileSync(path.join(root, ".minitok", "selection.json"), "utf8").includes("must-not-persist"), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("provider discovery requires approval when multiple providers are authenticated", async () => {
  const oldOpenAI = process.env.OPENAI_API_KEY;
  const oldAnthropic = process.env.ANTHROPIC_API_KEY;
  process.env.OPENAI_API_KEY = "openai-test";
  process.env.ANTHROPIC_API_KEY = "anthropic-test";
  try {
    const result = await discoverProviders({ config: { providers: {}, roles: {}, default_provider: "" }, tokenStore: { list: () => [], load: () => null } });
    assert.equal(result.status, "approval_required");
    assert.equal(result.selected, null);
    assert.equal(result.authenticated_count >= 2, true);
  } finally {
    if (oldOpenAI === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = oldOpenAI;
    if (oldAnthropic === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = oldAnthropic;
  }
});
