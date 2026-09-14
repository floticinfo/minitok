"use strict";

/**
 * GUI slash commands that shell out must point at the real CLI entry point.
 *
 * `:mcp <action> <host>` and `:oauth` resolved `../bin/minitok.js` from
 * `src/cli/`, which is `src/bin/minitok.js` — a path that does not exist — so
 * both commands died with MODULE_NOT_FOUND, and `:oauth` additionally invoked
 * `auth login` without its required provider argument. `:models` and
 * `:provider-test` used the correct `../../bin/minitok.js`.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const childProcess = require("node:child_process");

const repoRoot = path.resolve(__dirname, "..");
const cliBin = path.resolve(repoRoot, "bin/minitok.js");
const guiCommandsPath = path.resolve(repoRoot, "src/cli/gui-commands.js");
const guiCommandsSource = fs.readFileSync(guiCommandsPath, "utf8");
const { handleCommand } = require(guiCommandsPath);

/** Run `fn` with every child process replaced by a recorder. */
function withSpawnStub(fn) {
  const calls = [];
  const original = { spawnSync: childProcess.spawnSync, execFileSync: childProcess.execFileSync };
  childProcess.spawnSync = (command, args, options) => {
    calls.push({ command, args, options });
    return { status: 0, stdout: "stub-output", stderr: "" };
  };
  childProcess.execFileSync = (command, args, options) => {
    calls.push({ command, args, options });
    return "stub-output";
  };
  const output = [];
  const originalLog = console.log;
  console.log = (...values) => { output.push(values.map(String).join(" ")); };
  try {
    return { handled: fn(), calls, output: output.join("\n") };
  } finally {
    childProcess.spawnSync = original.spawnSync;
    childProcess.execFileSync = original.execFileSync;
    console.log = originalLog;
  }
}

test("every path that gui-commands.js spawns resolves to a file that exists", () => {
  const targets = [...guiCommandsSource.matchAll(/path\.resolve\(__dirname,\s*"([^"]+)"\)/g)].map(match => match[1]);
  assert.ok(targets.length >= 4, `expected the CLI and helper targets, saw ${targets.length}`);
  for (const target of targets) {
    const resolved = path.resolve(path.dirname(guiCommandsPath), target);
    assert.equal(fs.existsSync(resolved), true, `${target} resolves to the missing path ${resolved}`);
  }
});

test("gui-commands.js reaches the repository bin directory, not src/bin", () => {
  const targets = [...guiCommandsSource.matchAll(/path\.resolve\(__dirname,\s*"([^"]+)"\)/g)].map(match => match[1]);
  const cliTargets = targets.filter(target => target.endsWith("bin/minitok.js"));
  assert.ok(cliTargets.length >= 4, "every CLI invocation should point at a bin/minitok.js target");
  for (const target of cliTargets) assert.equal(target, "../../bin/minitok.js", `${target} is not the repository bin`);
});

test(":mcp <action> <host> runs the real CLI with the action and host", () => {
  // `connect` is a real `minitok mcp` subcommand; the action is forwarded
  // verbatim so the CLI stays the single owner of the action list.
  const { handled, calls } = withSpawnStub(() => handleCommand(":mcp connect https://mcp.example.test/sse", { repo: repoRoot }));
  assert.equal(handled, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, process.execPath);
  assert.equal(calls[0].args[0], cliBin);
  assert.deepEqual(calls[0].args.slice(1), ["mcp", "connect", "https://mcp.example.test/sse"]);
  assert.equal(fs.existsSync(calls[0].args[0]), true);
  assert.equal(calls[0].options.cwd, repoRoot);
});

test(":mcp <action> without a host still runs the real CLI", () => {
  // `status` is a real `minitok mcp` subcommand that takes no host argument.
  const { handled, calls } = withSpawnStub(() => handleCommand(":mcp status", { repo: repoRoot }));
  assert.equal(handled, true);
  assert.deepEqual(calls[0].args.slice(1), ["mcp", "status"]);
});

test(":mcp alone stays in-process", () => {
  const { handled, calls, output } = withSpawnStub(() => handleCommand(":mcp", { repo: repoRoot }));
  assert.equal(handled, true);
  assert.deepEqual(calls, [], "detection must not spawn the CLI");
  assert.match(output, /detected/);
  // The detection report is not the pass-through form, so the operator is told
  // how to reach the CLI actions without duplicating the action list here.
  assert.match(output, /:mcp <action> <host>/);
  assert.match(output, /minitok mcp --help/);
});

test(":mcp forwards an unknown action so the CLI reports it", () => {
  // The action list belongs to the CLI; filtering here would duplicate it and
  // drift. The CLI's own error is surfaced instead.
  const { handled, calls, output } = withSpawnStub(() => handleCommand(":mcp detect", { repo: repoRoot }));
  assert.equal(handled, true);
  assert.deepEqual(calls[0].args.slice(1), ["mcp", "detect"]);
  assert.match(output, /exit=0/, "the CLI's exit status must be reported");
});

test(":oauth passes the configured provider to auth login", () => {
  const { OAUTH_CONFIGS } = require("../src/auth/oauth");
  const configured = Object.keys(OAUTH_CONFIGS);
  assert.ok(configured.length > 0, "at least one OAuth provider must be registered");
  const { handled, calls } = withSpawnStub(() => handleCommand(":oauth", { repo: repoRoot }));
  assert.equal(handled, true);
  // Only the CLI invocation is counted: the success path also checks that a
  // credential landed in the store, and on Windows that read probes the OS
  // keychain through a helper process.
  const cliCalls = calls.filter(call => Array.isArray(call.args) && call.args[0] === cliBin);
  assert.equal(cliCalls.length, 1);
  assert.equal(calls[0].command, process.execPath);
  // `auth login` declares <provider> as a required argument, so the flow used
  // to abort with a commander error before it could ever start.
  assert.deepEqual(cliCalls[0].args.slice(1), ["auth", "login", configured[0]]);
});

test(":oauth <provider> forwards an explicitly requested provider", () => {
  const configured = Object.keys(require("../src/auth/oauth").OAUTH_CONFIGS)[0];
  const { handled, calls } = withSpawnStub(() => handleCommand(`:oauth ${configured.toUpperCase()}`, { repo: repoRoot }));
  assert.equal(handled, true);
  assert.deepEqual(calls[0].args.slice(1), ["auth", "login", configured]);
});

test(":oauth rejects an unsupported provider without spawning", () => {
  const { handled, calls, output } = withSpawnStub(() => handleCommand(":oauth deepseek", { repo: repoRoot }));
  assert.equal(handled, true);
  assert.deepEqual(calls, [], "an unsupported provider must not start a login");
  assert.match(output, /deepseek/);
  assert.match(output, /anthropic/, "the supported providers must be listed");
});

test(":oauth reports a failure without claiming success", () => {
  const originalSpawn = childProcess.spawnSync;
  const originalLog = console.log;
  let failure = "";
  childProcess.spawnSync = () => ({ status: 1, stdout: "", stderr: "auth failed" });
  console.log = (...values) => { failure += `${values.map(String).join(" ")}\n`; };
  try {
    assert.equal(handleCommand(":oauth anthropic", { repo: repoRoot }), true);
  } finally {
    childProcess.spawnSync = originalSpawn;
    console.log = originalLog;
  }
  assert.match(failure, /failed/i);
});

test(":oauth names the provider when it succeeds", () => {
  const { output } = withSpawnStub(() => handleCommand(":oauth anthropic", { repo: repoRoot }));
  assert.match(output, /anthropic/);
});

test(":oauth accepts an alias for an OAuth-capable provider", () => {
  // `claude` normalises to `anthropic`, which is the registered OAuth provider.
  const configured = Object.keys(require("../src/auth/oauth").OAUTH_CONFIGS)[0];
  const alias = { anthropic: "claude", openai: "gpt", google: "gemini" }[configured];
  if (!alias) return;
  const { handled, calls } = withSpawnStub(() => handleCommand(`:oauth ${alias}`, { repo: repoRoot }));
  assert.equal(handled, true);
  assert.deepEqual(calls[0].args.slice(1), ["auth", "login", configured]);
});

test(":oauth rejects an alias whose canonical provider has no OAuth flow", () => {
  // `gpt` normalises to openai; without an OAuth config it must not spawn.
  const configured = Object.keys(require("../src/auth/oauth").OAUTH_CONFIGS);
  if (configured.includes("openai")) return;
  const { handled, calls, output } = withSpawnStub(() => handleCommand(":oauth gpt", { repo: repoRoot }));
  assert.equal(handled, true);
  assert.deepEqual(calls, []);
  assert.match(output, /gpt/);
});

test(":help advertises the OAuth and provider-test commands", () => {
  const guiSource = fs.readFileSync(path.resolve(repoRoot, "src/cli/commands/gui.js"), "utf8");
  assert.match(guiSource, /:oauth \[provider\]/);
  assert.match(guiSource, /:provider-test <provider>/);
  assert.match(guiSource, /:mcp/);
});
