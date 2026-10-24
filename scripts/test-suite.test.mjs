import test from "node:test";
import assert from "node:assert/strict";
import { classify, isTestFile, discoverTests, DEFAULT_TIMEOUT_MS, DEFAULT_TEST_TIMEOUT_MS } from "./test-suite.mjs";

test("test discovery accepts intended test shapes and rejects generated files", () => {
  assert.equal(isTestFile("tests/test-example.js"), true);
  assert.equal(isTestFile("tests/e2e/goal-agent/harness.test.js"), true);
  assert.equal(isTestFile("src/core/example.test.js"), true);
  assert.equal(isTestFile("scripts/test-suite.test.mjs"), true);
  assert.equal(isTestFile("extension/dist/test/example.test.js"), false);
  assert.equal(isTestFile("node_modules/pkg/test.js"), false);
});

test("test classification keeps explicit operational groups stable", () => {
  assert.equal(classify("tests/e2e/goal-agent/harness.test.js"), "e2e");
  assert.equal(classify("tests/test-mcp-tool-transport.js"), "mcp");
  assert.equal(classify("tests/test-capability-token.js"), "security");
  assert.equal(classify("tests/test-workspace.js"), "workspace");
  assert.equal(classify("tests/test-release-artifacts.js"), "release");
  assert.equal(classify("tests/test-provider-live.js"), "live");
});

test("test discovery includes the runner regression test and excludes dist", async () => {
  const files = await discoverTests();
  assert.ok(files.includes("scripts/test-suite.test.mjs"));
  assert.equal(files.some(file => file.startsWith("extension/dist/")), false);
});

test("runner exposes bounded defaults", () => {
  assert.equal(DEFAULT_TIMEOUT_MS, 300000);
  assert.equal(DEFAULT_TEST_TIMEOUT_MS, 120000);
});
