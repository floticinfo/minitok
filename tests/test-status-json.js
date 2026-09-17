"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function isolatedHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "minitok-status-json-"));
  const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  return { home, restore() {
    if (previous.HOME === undefined) delete process.env.HOME; else process.env.HOME = previous.HOME;
    if (previous.USERPROFILE === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = previous.USERPROFILE;
    fs.rmSync(home, { recursive: true, force: true });
  } };
}

test("human status returns a recovery diagnostic for a corrupt workspace registry", async () => {
  const isolated = isolatedHome();
  const originalError = console.error;
  const lines = [];
  console.error = value => lines.push(String(value));
  try {
    fs.mkdirSync(path.join(isolated.home, ".minitok"), { recursive: true });
    fs.writeFileSync(path.join(isolated.home, ".minitok", "workspaces.json"), "{not-json");
    const { cmdStatus } = require("../src/cli/commands/status");
    assert.equal(await cmdStatus({ workspaceManagerHome: path.join(isolated.home, ".minitok") }), 1);
    assert.match(lines.join("\n"), /Recovery:.*workspaces\.json/);
  } finally {
    console.error = originalError;
    isolated.restore();
  }
});

test("status --json returns structured diagnostics for a corrupt workspace registry", async () => {
  const isolated = isolatedHome();
  try {
    fs.mkdirSync(path.join(isolated.home, ".minitok"), { recursive: true });
    fs.writeFileSync(path.join(isolated.home, ".minitok", "workspaces.json"), "{not-json");
    const { cmdStatus } = require("../src/cli/commands/status");
    const payload = await cmdStatus({ json: true, workspaceManagerHome: path.join(isolated.home, ".minitok") });
    assert.equal(payload.workspace, null);
    assert.match(payload.workspace_error, /Workspace registry is invalid/);
    assert.equal(Array.isArray(payload.providers), true);
    assert.equal(typeof payload.entitlement, "object");
  } finally {
    isolated.restore();
  }
});
