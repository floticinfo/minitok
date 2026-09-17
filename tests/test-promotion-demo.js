"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createDemo } = require("../src/promotion/demo");

test("demo fixture creates a disposable repository without credentials or network", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "minitok-demo-test-"));
  try {
    const plan = createDemo(path.join(directory, "repo"));
    assert.equal(plan.status, "fixture_created");
    assert.equal(plan.networkRequests, false);
    assert.equal(plan.providerCredentialsRequired, true);
    assert.equal(plan.repositoryChanges, false);
    assert.ok(fs.existsSync(path.join(plan.repository, "README.md")));
    assert.ok(fs.existsSync(path.join(plan.repository, "health.js")));
    assert.match(plan.commands[2], /--dry-run/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
