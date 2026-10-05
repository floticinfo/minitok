"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { cmdDoctor } = require("../src/cli/commands/doctor");

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, "g");

async function capture(fn) {
  const out = [];
  const savedLog = console.log;
  const savedErr = console.error;
  console.log = m => out.push(m);
  console.error = m => out.push(m);
  try {
    const code = await fn();
    return { code, text: out.join("\n") };
  } finally {
    console.log = savedLog;
    console.error = savedErr;
  }
}

test("doctor --json emits a single valid JSON document and no human text", async () => {
  const { code, text } = await capture(() => cmdDoctor({ json: true }));
  assert.ok(code === 0 || code === 1, "doctor must return a numeric exit code");
  const parsed = JSON.parse(text);
  assert.equal(typeof parsed.version, "string");
  assert.equal(typeof parsed.ok, "boolean");
  assert.ok(Array.isArray(parsed.checks), "checks must be an array");
  assert.ok(parsed.checks.length > 0, "checks must not be empty");
  for (const c of parsed.checks) {
    assert.equal(typeof c.name, "string");
    assert.equal(typeof c.ok, "boolean");
    assert.equal(typeof c.detail, "string");
  }
  assert.ok(!text.includes("Environment Check"), "JSON mode must not print the human banner");
  assert.ok(!ANSI.test(text), "JSON mode must not contain ANSI colour sequences");
});

test("doctor human output prints markers and never emits a JSON document", async () => {
  const { code, text } = await capture(() => cmdDoctor({}));
  assert.ok(code === 0 || code === 1);
  assert.ok(text.includes("Environment Check"), "human mode prints the banner");
  assert.ok(text.includes("[ok]") || text.includes("[error]"), "human mode prints status markers");
  assert.throws(() => JSON.parse(text), "human mode must not be parseable as JSON");
});

test("doctor --json ok flag mirrors the aggregate of its checks", async () => {
  const { text } = await capture(() => cmdDoctor({ json: true }));
  const parsed = JSON.parse(text);
  const aggregate = parsed.checks.every(c => c.ok);
  assert.equal(parsed.ok, aggregate, "top-level ok must equal every(checks.ok)");
});
