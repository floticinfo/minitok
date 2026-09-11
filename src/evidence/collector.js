"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { packageManagerCommand } = require("../core/package-manager");

function collectEvidence(repoRoot, options = {}) {
  const evidence = { timestamp: new Date().toISOString(), tests: {}, lint: {}, types: {} };

  // Test evidence
  try {
    if (fs.existsSync(path.join(repoRoot, "package.json"))) {
      const npm = packageManagerCommand("npm");
      const output = execFileSync(npm.command, [...npm.args, "test"], { cwd: repoRoot, encoding: "utf-8", timeout: 120000, stdio: ["ignore", "pipe", "pipe"] });
      evidence.tests = { status: "passed", output: output.slice(-2000) };
    } else if (fs.existsSync(path.join(repoRoot, "pyproject.toml"))) {
      const output = execFileSync("python", ["-m", "pytest", "tests/", "-q", "--tb=short"], { cwd: repoRoot, encoding: "utf-8", timeout: 120000, stdio: ["ignore", "pipe", "pipe"] });
      evidence.tests = { status: output.includes("failed") ? "failed" : "passed", output: output.slice(-2000) };
    } else {
      evidence.tests = { status: "skipped", reason: "No test runner detected" };
    }
  } catch (e) {
    evidence.tests = { status: "error", error: e.message, output: `${e.stdout || ""}${e.stderr || ""}`.slice(-2000) };
  }

  // Lint evidence
  try {
    if (fs.existsSync(path.join(repoRoot, "package.json"))) {
      const npm = packageManagerCommand("npm");
      const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
      if (!pkg.scripts || typeof pkg.scripts.lint !== "string" || pkg.scripts.lint.trim() === "") {
        evidence.lint = { status: "skipped", reason: "No lint script detected" };
      } else {
        const output = execFileSync(npm.command, [...npm.args, "run", "lint", "--", "--quiet"], { cwd: repoRoot, encoding: "utf-8", timeout: 60000, stdio: ["ignore", "pipe", "pipe"] });
        evidence.lint = { status: "clean", output: output.slice(-2000) };
      }
    }
  } catch (e) {
    evidence.lint = { status: "issues_found", output: `${e.stdout || ""}${e.stderr || ""}`.slice(-2000) };
  }

  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
    if (pkg.scripts && pkg.scripts.typecheck) {
      const npm = packageManagerCommand("npm");
      const output = execFileSync(npm.command, [...npm.args, "run", "typecheck"], { cwd: repoRoot, encoding: "utf-8", timeout: 120000, stdio: ["ignore", "pipe", "pipe"] });
      evidence.types = { status: "passed", output: output.slice(-2000) };
    } else evidence.types = { status: "skipped", reason: "No typecheck script detected" };
  } catch (e) {
    evidence.types = { status: "failed", output: `${e.stdout || ""}${e.stderr || ""}`.slice(-2000) };
  }

  return evidence;
}

function saveEvidence(repoRoot, evidence) {
  const evidenceDir = path.join(repoRoot, ".minitok", "evidence");
  fs.mkdirSync(evidenceDir, { recursive: true });
  const filename = `evidence-${Date.now()}.json`;
  fs.writeFileSync(path.join(evidenceDir, filename), JSON.stringify(evidence, null, 2), "utf-8");
  return path.join(evidenceDir, filename);
}

module.exports = { collectEvidence, saveEvidence };
