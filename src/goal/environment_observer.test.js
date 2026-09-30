"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { observeEnvironment, isObservationStale, preflightEnvironment } = require("./environment_observer");
const { createTool, discoverTools, preflightTool, isStale } = require("./tool_registry");

function workspace() { return fs.mkdtempSync(path.join(os.tmpdir(), "minitok-environment-")); }
function cleanup(root) { fs.rmSync(root, { recursive: true, force: true }); }

test("observes repository structure, package scripts, commands, and credential presence only", () => {
  const root = workspace(); try { fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "probe", scripts: { test: "node --test" } })); fs.writeFileSync(path.join(root, "src.js"), "safe"); const value = observeEnvironment({ workspaceRoot: root, commands: ["npm", "missing"], commandAvailable: command => command === "npm", credential_presence: { API_KEY: true, PASSWORD: false }, branch: "main", dirty: true, protected_paths: ["package.json"], allowed_paths: ["src"], now: "2026-09-20T00:00:00.000Z" }); assert.ok(value.repository.files.includes("src.js")); assert.deepEqual(value.package.scripts, ["test"]); assert.deepEqual(value.commands, { npm: true, missing: false }); assert.deepEqual(value.credential_presence, { API_KEY: true, PASSWORD: false }); assert.doesNotMatch(JSON.stringify(value), /secret|token|password=/i); assert.equal(value.repository.dirty, true); } finally { cleanup(root); }
});

test("discovers tools and requires explicit external capability", () => {
  const tools = discoverTools([{ name: "local-check", kind: "command", required_capabilities: ["verify"], external: false, adapter_injected: true }, { name: "remote-api", kind: "api", required_capabilities: ["external_call"], external: true, adapter_injected: true }], { observed_at: new Date().toISOString() }); assert.equal(tools[0].status, "available"); assert.equal(tools[1].status, "approval_required"); assert.equal(preflightTool(tools[0], { capabilities: ["verify"] }).allowed, true); assert.equal(preflightTool(tools[1], { capabilities: ["external_call"], external_capability: false }).allowed, false); assert.equal(preflightTool(tools[1], { capabilities: ["external_call"], external_capability: true }).allowed, true);
});

test("detects stale observations and stale tools by TTL", () => { const old = "2020-01-01T00:00:00.000Z"; const value = observeEnvironment({ workspaceRoot: process.cwd(), now: old, ttl_ms: 10 }); assert.equal(isObservationStale(value, Date.now()), true); const tool = createTool({ name: "old", kind: "command", observed_at: old, ttl_ms: 10 }); assert.equal(isStale(tool, Date.now()), true); assert.equal(preflightEnvironment(value, {}, { now: Date.now() }).ready, false); });

test("preflight reports unavailable commands and missing tools", () => { const value = observeEnvironment({ workspaceRoot: process.cwd(), commands: ["missing"], commandAvailable: () => false, tool_definitions: [{ name: "local", kind: "service", required_capabilities: ["read"], adapter_injected: true }] }); const result = preflightEnvironment(value, { commands: ["missing", "node"], tools: ["unknown"] }, { capabilities: ["read"] }); assert.equal(result.ready, false); assert.ok(result.reasons.some(item => /command_unavailable/.test(item))); assert.ok(result.reasons.some(item => /tool_missing/.test(item))); });

test("keeps tool registry source/runtime parity", () => { for (const name of ["environment_observer.js", "tool_registry.js"]) { const source = fs.readFileSync(path.join(__dirname, name), "utf8").replace(/\r\n/g, "\n"); const runtime = fs.readFileSync(path.join(__dirname, "..", "..", "extension", "runtime", "src", "goal", name), "utf8").replace(/\r\n/g, "\n"); assert.equal(source, runtime); } });
