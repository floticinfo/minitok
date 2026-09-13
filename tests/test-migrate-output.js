"use strict";

/**
 * `minitok migrate` writes files into a customer repository, so what it writes
 * has to be both accurate and non-destructive.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const yaml = require("js-yaml");

const { cmdMigrate } = require("../src/cli/commands/migrate");
const { loadConfig, resolveProviderName } = require("../src/config/loader");

function initRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "minitok-migrate-"));
  for (const args of [["init", "-q"], ["config", "user.email", "t@t.t"], ["config", "user.name", "t"]]) execFileSync("git", args, { cwd: repo, stdio: "pipe" });
  return repo;
}

function isolateHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "minitok-migrate-home-"));
  const previous = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME };
  process.env.USERPROFILE = home;
  process.env.HOME = home;
  return () => {
    if (previous.USERPROFILE === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = previous.USERPROFILE;
    if (previous.HOME === undefined) delete process.env.HOME; else process.env.HOME = previous.HOME;
    fs.rmSync(home, { recursive: true, force: true });
  };
}

test("the generated config is valid and matches how roles resolve", async () => {
  const repo = initRepo();
  const restoreHome = isolateHome();
  const originalLog = console.log;
  try {
    console.log = () => {};
    assert.equal(await cmdMigrate(repo, "probe"), 0);
    const configPath = path.join(repo, "minitok.yml");
    const raw = fs.readFileSync(configPath, "utf8");
    const parsed = yaml.load(raw);
    // The old template shipped a `providers.default` placeholder with an empty
    // base_url that could never work and a default_provider pointing at it.
    assert.deepEqual(parsed.providers, {}, "no unusable placeholder provider");
    assert.equal(parsed.default_provider, "");
    const config = loadConfig(configPath);
    for (const role of ["plan", "work", "review", "intel"]) {
      assert.equal(resolveProviderName(config, role), "claude", `${role} must resolve through its adapter`);
    }
    assert.match(raw, /--provider-override/, "the file must state how to use a non-Anthropic key");
  } finally {
    console.log = originalLog;
    fs.rmSync(repo, { recursive: true, force: true });
    restoreHome();
  }
});

test("migrate preserves the existing .gitignore line endings", async () => {
  const repo = initRepo();
  const restoreHome = isolateHome();
  const originalLog = console.log;
  try {
    console.log = () => {};
    const gitignore = path.join(repo, ".gitignore");
    fs.writeFileSync(gitignore, "node_modules/\r\n*.log\r\n", "utf8");
    assert.equal(await cmdMigrate(repo, "probe"), 0);
    const updated = fs.readFileSync(gitignore, "utf8");
    // Rewriting CRLF as LF marked every line as modified in the repository.
    assert.match(updated, /node_modules\/\r\n/, "existing entries must keep their CRLF endings");
    assert.match(updated, /\.minitok\/\r\n/);
    assert.match(updated, /minitok-evidence\/\r\n/);
    assert.equal(updated.includes("\n\n"), false, "no blank lines may be introduced");
  } finally {
    console.log = originalLog;
    fs.rmSync(repo, { recursive: true, force: true });
    restoreHome();
  }
});
