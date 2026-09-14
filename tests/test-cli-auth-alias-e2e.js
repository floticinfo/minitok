"use strict";

/**
 * End-to-end guard for the alias credential path, run against the real CLI in
 * an isolated home.
 *
 * This is the only test that exercises the writer and the reader through
 * separate processes, which is exactly where the bug lived: `auth login gpt`
 * wrote the credential under the raw argument while every consumer normalised
 * the name to `openai` before reading it, so the login silently never worked
 * and `auth logout gpt` cleared a key nothing used.
 *
 * `gpt`/`openai` is deliberate — it is the one alias whose canonical provider
 * has no OAuth configuration, so `auth login` falls straight through to the API
 * key prompt instead of blocking on a browser callback server.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const childProcess = require("node:child_process");

const repoRoot = path.resolve(__dirname, "..");
const cliEntry = path.join(repoRoot, "bin", "minitok.js");

/** Create a throwaway home so the developer's real ~/.minitok stays untouched. */
function makeIsolatedHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "minitok-alias-e2e-"));
}

function runCli(home, args, input) {
  const result = childProcess.spawnSync(process.execPath, [cliEntry, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    input,
    timeout: 60000,
    env: { ...process.env, HOME: home, USERPROFILE: home },
  });
  return {
    status: result.status,
    output: `${result.stdout || ""}${result.stderr || ""}`,
  };
}

function tokenFiles(home) {
  const dir = path.join(home, ".minitok", "tokens");
  return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
}

test("auth login with an alias writes the canonical credential the reader looks up", () => {
  const home = makeIsolatedHome();
  try {
    const login = runCli(home, ["auth", "login", "gpt"], "sk-alias-e2e-key\n");
    assert.equal(login.status, 0, login.output);
    assert.match(login.output, /openai/, "the operator should see the canonical provider name");

    const files = tokenFiles(home);
    assert.ok(files.includes("openai.json"), `expected openai.json, saw ${files.join(", ") || "(none)"}`);
    assert.equal(files.includes("gpt.json"), false, "the raw alias must not become the storage key");

    const status = runCli(home, ["auth", "status"]);
    assert.equal(status.status, 0, status.output);
    // The credential must be visible through the same normalisation the
    // providers use, otherwise it is stored but unreachable.
    assert.match(status.output, /openai/);
    assert.match(status.output, /valid/);
    assert.doesNotMatch(status.output, /alias of/, "a freshly written credential is canonical, not legacy");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("auth logout with an alias removes the canonical credential", () => {
  const home = makeIsolatedHome();
  try {
    assert.equal(runCli(home, ["auth", "login", "gpt"], "sk-alias-e2e-key\n").status, 0);
    const logout = runCli(home, ["auth", "logout", "gpt"]);
    assert.equal(logout.status, 0, logout.output);
    assert.deepEqual(tokenFiles(home), [], "logout must not leave the credential behind");

    const status = runCli(home, ["auth", "status"]);
    assert.match(status.output, /No stored credentials/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("a credential stored under the pre-alias key is still usable and flagged", () => {
  const home = makeIsolatedHome();
  try {
    const dir = path.join(home, ".minitok", "tokens");
    fs.mkdirSync(dir, { recursive: true });
    // Exactly what `auth login gpt` used to write before the fix.
    fs.writeFileSync(path.join(dir, "gpt.json"), JSON.stringify({
      provider: "gpt",
      access_token: "sk-legacy-key",
      token_type: "api_key",
      saved_at: new Date().toISOString(),
    }));

    const status = runCli(home, ["auth", "status"]);
    assert.equal(status.status, 0, status.output);
    assert.match(status.output, /gpt/, "the stale key has to be reported");
    assert.match(status.output, /alias of openai/, "the operator must be told the key is legacy");
    assert.match(status.output, /auth login openai/, "the fix has to be spelled out");

    // Logging out of the canonical name must clear the legacy copy too.
    assert.equal(runCli(home, ["auth", "logout", "openai"]).status, 0);
    assert.deepEqual(tokenFiles(home), []);
    assert.match(runCli(home, ["auth", "status"]).output, /No stored credentials/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
