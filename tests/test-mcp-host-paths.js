"use strict";

/**
 * `minitok mcp connect` used to compute `%APPDATA%`-based paths on every
 * platform and to fall back to `<home>/AppData/Roaming`, so on macOS and Linux it
 * created a fabricated directory tree, printed "Connected", and never touched the
 * editor's real configuration. These tests pin the platform layout and the
 * fail-closed behaviour.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const mcp = require(path.join(__dirname, "..", "src", "cli", "commands", "mcp.js"));

function withPlatform(platform, run) {
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  try { return run(); } finally { if (original) Object.defineProperty(process, "platform", original); }
}

function withHome(home, run) {
  const previous = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME, APPDATA: process.env.APPDATA, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
  process.env.USERPROFILE = home;
  process.env.HOME = home;
  delete process.env.APPDATA;
  delete process.env.XDG_CONFIG_HOME;
  try { return run(); } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("host paths follow the platform instead of assuming %APPDATA%", () => {
  const darwin = withPlatform("darwin", () => mcp.hostCandidates());
  assert.match(darwin.claude[0], /Library[\\/]Application Support[\\/]Claude[\\/]claude_desktop_config\.json$/);
  assert.doesNotMatch(darwin.cline[0], /AppData/);

  const linux = withPlatform("linux", () => mcp.hostCandidates());
  assert.match(linux.cline[0], /[\\/]\.config[\\/]Code[\\/]User[\\/]globalStorage[\\/]saoudrizwan\.claude-dev[\\/]settings[\\/]cline_mcp_settings\.json$/);
  assert.equal(linux.cursor[0].endsWith(path.join(".cursor", "mcp.json")), true);
  assert.equal(linux.cursor.length, 2, "the previous globalStorage location stays as a fallback");
});

test("XDG_CONFIG_HOME is honoured on Linux", () => {
  const previous = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = path.join(os.tmpdir(), "xdg-home");
  try {
    const candidates = withPlatform("linux", () => mcp.hostCandidates());
    assert.match(candidates.cline[0], /xdg-home[\\/]Code[\\/]User/);
  } finally {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous;
  }
});

test("an uninstalled host fails closed with the checked locations", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "minitok-mcp-home-"));
  try {
    withHome(home, () => {
      let error;
      try { mcp.resolveHost("claude"); } catch (caught) { error = caught; }
      assert.ok(error, "an uninstalled host must throw instead of fabricating a path");
      assert.equal(error.code, "MCP_HOST_NOT_FOUND");
      assert.match(error.message, /No claude configuration found/);
      assert.match(error.message, /--host-file/, "the error must name the escape hatch");
      assert.equal(fs.existsSync(path.join(home, "AppData")), false, "no directory tree may be fabricated");
    });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("a host that already created its directory is treated as installed", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "minitok-mcp-home-"));
  try {
    fs.mkdirSync(path.join(home, ".cursor"), { recursive: true });
    withHome(home, () => {
      const target = mcp.resolveHost("cursor");
      assert.equal(target.file, path.join(home, ".cursor", "mcp.json"));
      assert.equal(target.installed, true);
    });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("an explicit --host-file overrides detection and keeps the backup opt-in", () => {
  const override = path.join(os.tmpdir(), "minitok-mcp-override", "custom.json");
  const target = mcp.resolveHost("cline", override);
  assert.equal(target.file, path.resolve(override));
  assert.deepEqual(target.candidates, [path.resolve(override)]);
});

test("--keep-backup retains the restore point only when asked", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "minitok-mcp-backup-"));
  const file = path.join(root, "mcp.json");
  try {
    fs.writeFileSync(file, `${JSON.stringify({ mcpServers: {} })}\n`);
    mcp.writeConfig(file, { mcpServers: { minitok: { command: "minitok" } } });
    assert.equal(fs.existsSync(`${file}.bak`), false, "the default stays a write-window copy");

    const before = fs.readFileSync(file);
    fs.writeFileSync(file, `${JSON.stringify({ mcpServers: {} })}\n`);
    mcp.writeConfig(file, { mcpServers: { minitok: { command: "minitok" } } }, { keepBackup: true });
    assert.equal(fs.existsSync(`${file}.bak`), true, "--keep-backup leaves a restore point");
    assert.deepEqual(JSON.parse(fs.readFileSync(`${file}.bak`, "utf8")), { mcpServers: {} });
    assert.ok(before.length > 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
