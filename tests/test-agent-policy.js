"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

let policy;
test.before(async () => { policy = await import("../src/agent/policy.mjs"); });

test("agent mode is a strict on/off gate", () => {
  assert.equal(policy.resolveMode("ON"), "on");
  assert.equal(policy.resolveMode("off"), "off");
  assert.throws(() => policy.resolveMode("enabled"), /Expected "on" or "off"/);
  assert.throws(() => policy.assertModeEnabled("off"), /minitok is OFF/);
  assert.doesNotThrow(() => policy.assertModeEnabled("on"));
});

test("agent exposes only minitok tools and requires an absolute repo", () => {
  assert.deepEqual(policy.filterMinitokTools([
    { name: "minitok_status" }, { name: "editor" }, { name: "bash" }, { name: "minitok_run" },
  ]).map(tool => tool.name), ["minitok_status", "minitok_run"]);
  assert.equal(policy.normalizeRunInput({ task: "test", repo: "C:\\\\repo", auto_accept: true }).auto_accept, false);
  assert.equal(policy.normalizeRunInput({ task: "test", repo: "/repo", auto_accept: true }, process.cwd(), { allowAutoAccept: true }).auto_accept, true);
  assert.throws(() => policy.normalizeRunInput({ task: "test", repo: "relative" }), /absolute/);
});
