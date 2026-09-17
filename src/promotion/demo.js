"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { minitokVersion } = require("../core/version");

function runGit(repo, args) {
  execFileSync("git", args, { cwd: repo, stdio: "ignore" });
}

function createDemoRepository(target) {
  const repo = path.resolve(target || fs.mkdtempSync(path.join(os.tmpdir(), "minitok-demo-")));
  fs.mkdirSync(repo, { recursive: true });
  runGit(repo, ["init"]);
  runGit(repo, ["config", "user.email", "minitok-demo@example.invalid"]);
  runGit(repo, ["config", "user.name", "minitok demo"]);
  fs.writeFileSync(path.join(repo, "README.md"), "# minitok demo\n\nA disposable repository for the agent workflow walkthrough.\n", "utf8");
  fs.writeFileSync(path.join(repo, "health.js"), "export function health() { return { status: 'ok' }; }\n", "utf8");
  fs.writeFileSync(path.join(repo, ".gitignore"), ".minitok/\nminitok-evidence/\n", "utf8");
  runGit(repo, ["add", "."]);
  runGit(repo, ["commit", "-m", "Create minitok demo fixture"]);
  return repo;
}

function demoPlan(repo) {
  return {
    schemaVersion: 1,
    status: "fixture_created",
    package: "@flotic/minitok",
    version: minitokVersion,
    repository: repo,
    networkRequests: false,
    providerCredentialsRequired: true,
    repositoryChanges: false,
    commands: [
      `minitok migrate "${repo}"`,
      "minitok doctor",
      `minitok run --dry-run --repo "${repo}" "Add tests for health.js and preserve its API"`,
      `minitok status --workspace "${path.basename(repo)}"`,
    ],
    activation: [
      "Configure a provider in the generated minitok.yml; dry-run still uses the configured model provider.",
      "Run minitok doctor and resolve the entitlement check before the model-backed preview.",
      "Run the same task without --dry-run only after reviewing the proposed workflow.",
    ],
    trust: "This fixture demonstrates onboarding and command shape only; it is not model output, a benchmark, or deployment proof.",
  };
}

function createDemo(target) {
  const repo = createDemoRepository(target);
  return demoPlan(repo);
}

module.exports = { createDemo, createDemoRepository, demoPlan };
