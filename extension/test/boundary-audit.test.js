"use strict";

// Boundary audit for the four switchboards that have to agree:
//
//   1. webview  -> extension : commands the HTML sends vs the commands handle() accepts
//   2. extension -> CLI      : subcommands the extension spawns vs the CLI's real commands
//   3. extension -> webview  : message types the host posts vs the types the HTML handles
//   4. auth gates            : every "is anybody signed in?" site vs admin-session awareness
//
// A mismatch in any of these fails silently at runtime: the webview shows nothing,
// a command reports "Unsupported command", or a signed-in user is told to sign in.
// These tests read the sources as text and cross-reference them, which is the only
// way to catch the whole class at once instead of one symptom at a time.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const SRC = path.join(__dirname, "..", "src");
const REPO = path.join(__dirname, "..", "..");
const read = (p) => fs.readFileSync(p, "utf8");
const matchAll = (source, re) => [...source.matchAll(re)];

const WEBVIEWS = {
  sidebar: read(path.join(SRC, "sidebar.html")),
  panel: read(path.join(SRC, "panel.html")),
};
const HOSTS = {
  sidebar: read(path.join(SRC, "sidebar.ts")),
  panel: read(path.join(SRC, "panel.ts")),
};

/** Commands a host accepts: `command === "x"` plus every member of an allow-list
 *  assigned through `new Set([...])`. */
function handledCommands(source) {
  const out = new Set(matchAll(source, /command\s*===\s*["']([a-z-]+)["']/g).map((m) => m[1]));
  for (const m of matchAll(source, /(?:const|let)\s+\w+\s*=\s*new Set\(\[([^\]]*)\]\)/g)) {
    for (const inner of matchAll(m[1], /["']([a-z-]+)["']/g)) out.add(inner[1]);
  }
  return out;
}

/** Commands a webview sends. Two senders are dynamic and must be spelled out:
 *  `command:mode` (the Run/Dry-run buttons) and `command:adminRoute?'a':'b'`. */
function sentCommands(source) {
  const out = new Set(matchAll(source, /postMessage\(\{\s*command:\s*["']([a-z-]+)["']/g).map((m) => m[1]));
  for (const m of matchAll(source, /command:\s*adminRoute\s*\?\s*'([a-z-]+)'\s*:\s*'([a-z-]+)'/g)) {
    out.add(m[1]);
    out.add(m[2]);
  }
  if (/command:\s*mode\b/.test(source)) {
    out.add("run");
    out.add("dry-run");
  }
  return out;
}

// ---------- 1. webview -> extension ----------

test("every command the sidebar sends is handled by sidebar.ts", () => {
  const handled = handledCommands(HOSTS.sidebar);
  const orphans = [...sentCommands(WEBVIEWS.sidebar)].filter((c) => !handled.has(c));
  assert.deepEqual(orphans, [], "commands sent by the webview but unhandled are silently ignored");
});

test("every command the panel sends is handled by panel.ts", () => {
  const handled = handledCommands(HOSTS.panel);
  const orphans = [...sentCommands(WEBVIEWS.panel)].filter((c) => !handled.has(c));
  assert.deepEqual(orphans, [], "commands sent by the webview but unhandled are silently ignored");
});

// ---------- 2. extension -> CLI ----------

/** Ground truth: ask the CLI itself rather than parsing its source. */
function cliCommands() {
  const bin = path.join(REPO, "bin", "minitok.js");
  const help = (extra) => {
    try {
      return execFileSync(process.execPath, [bin, ...extra, "--help"], { encoding: "utf8", timeout: 30000 });
    } catch (error) {
      return String(error.stdout || "");
    }
  };
  const parse = (text, prefix) => {
    const out = [];
    let inList = false;
    for (const line of text.split(/\r?\n/)) {
      if (/^Commands:/.test(line)) { inList = true; continue; }
      if (!inList) continue;
      if (!line.trim()) continue;
      if (/^Options:|^Usage:/.test(line)) break;
      const m = /^ {2}([a-z][a-z|-]*)(?:\s|$)/.exec(line);
      if (m) out.push(prefix ? `${prefix} ${m[1].split("|")[0]}` : m[1].split("|")[0]);
    }
    return out;
  };
  const commands = new Set();
  for (const top of parse(help([]), "")) {
    commands.add(top);
    for (const sub of parse(help([top]), top)) commands.add(sub);
  }
  return commands;
}

/** Subcommands the extension actually spawns. Only array literals that reach a
 *  spawn call count; allow-lists such as `new Set(["run","dry-run"])` are command
 *  names for the webview, not CLI arguments. There is deliberately no indirect
 *  form (a `[kind, ...]` variable) to enumerate: every spawn names its
 *  subcommand as a literal, so the patterns below see all of them. */
function spawnedSubcommands() {
  const out = new Set();
  for (const file of ["sidebar.ts", "panel.ts", "extension.ts", "entitlement.ts", "mcp.ts"]) {
    const source = read(path.join(SRC, file));
    for (const m of matchAll(source, /(?:spawnSpec|execFile)\([^,]*cliPath\(\)[^,]*,\s*\[\s*"([a-z][a-z-]*)"(?:\s*,\s*"([a-z][a-z-]*)")?/g)) {
      out.add(m[2] ? `${m[1]} ${m[2]}` : m[1]);
    }
    for (const m of matchAll(source, /const args\s*=\s*\[\s*"([a-z][a-z-]*)"(?:\s*,\s*"([a-z][a-z-]*)")?/g)) {
      out.add(m[2] ? `${m[1]} ${m[2]}` : m[1]);
    }
    for (const m of matchAll(source, /\[\s*\[\s*"([a-z][a-z-]*)"(?:\s*,\s*"([a-z][a-z-]*)")?\s*\]/g)) {
      out.add(m[2] ? `${m[1]} ${m[2]}` : m[1]);
    }
    }
  return out;
}

test("every CLI subcommand the extension spawns exists in the CLI", () => {
  const available = cliCommands();
  const missing = [...spawnedSubcommands()].filter((c) => !available.has(c));
  assert.deepEqual(missing, [], "spawning a nonexistent subcommand fails with a commander usage error");
});

test("the bundled runtime mirror stays in step with the repo CLI", () => {
  const bundled = JSON.parse(read(path.join(__dirname, "..", "runtime", "package.json"))).version;
  const repo = JSON.parse(read(path.join(REPO, "package.json"))).version;
  assert.equal(bundled, repo, "a drifted runtime mirror ships CLI code the extension was not built against");
});

// ---------- 3. extension -> webview ----------

/** Message types the webview handles, collected from every construct it uses:
 *  `type === "x"`, `case "x":`, `["x"]` lookups, and bare strings inside the
 *  message listener. */
function webviewHandledTypes() {
  const out = new Set();
  for (const name of Object.keys(WEBVIEWS)) {
    const html = WEBVIEWS[name];
    for (const m of matchAll(html, /(?:type|\.type)\s*===?\s*["']([a-z-]+)["']/g)) out.add(m[1]);
    for (const m of matchAll(html, /case\s+["']([a-z-]+)["']\s*:/g)) out.add(m[1]);
    for (const m of matchAll(html, /\[\s*["']([a-z-]+)["']\s*\]\s*[({]/g)) out.add(m[1]);
    const listener = /addEventListener\(\s*["']message["'][\s\S]{0,6000}/.exec(html);
    if (listener) for (const t of matchAll(listener[0], /["']([a-z-]+)["']/g)) out.add(t[1]);
  }
  return out;
}

// No known unhandled types: any posted type without a webview handler fails the
// test so a new orphan cannot hide behind a sealed exception.
const KNOWN_UNHANDLED_TYPES = [];

test("every message type the host posts is handled by the webview", () => {
  const handled = webviewHandledTypes();
  const posted = new Set();
  for (const file of ["sidebar.ts", "panel.ts"]) {
    for (const m of matchAll(read(path.join(SRC, file)), /postMessage\(\{\s*type:\s*["']([a-z-]+)["']/g)) posted.add(m[1]);
  }
  const orphans = [...posted].filter((t) => !handled.has(t)).filter((t) => !KNOWN_UNHANDLED_TYPES.includes(t));
  assert.deepEqual(orphans, [], "a posted type with no handler updates nothing, and the UI looks frozen");
});

// ---------- 4. auth gates ----------

/** The auth-status handler body, from the handler to the next top-level member. */
function authStatusBody(file) {
  const source = read(path.join(SRC, file));
  const m = /(?:command\s*===\s*["']auth-status["']|private async authStatus\(\)|public async refreshAuth\(\))/.exec(source);
  if (!m) return "";
  const rest = source.slice(m.index);
  const next = /\n {2}(?:private|public|protected|async)\s/.exec(rest.slice(10));
  return next ? rest.slice(0, 10 + next.index) : rest.slice(0, 2500);
}

// Admin and customer sessions live under separate SecretStorage keys, so every
// "is anybody signed in?" check has to consult both. Asking only about the
// customer session reports a signed-in admin as signed out.
for (const file of ["sidebar.ts", "panel.ts"]) {
  test(`${file} auth-status recognises the admin session`, () => {
    assert.match(authStatusBody(file), /hasAdminSession\(this\.context\)/);
  });

  test(`${file} sign-out clears the admin session as well`, () => {
    // A surviving admin session would re-authenticate the next gated command.
    assert.match(read(path.join(SRC, file)), /await logoutAdmin\(this\.context\)/);
  });
}

test("the entitlement gate short-circuits for an admin session", () => {
  const source = read(path.join(SRC, "entitlement.ts"));
  assert.match(source, /async function isAdminSessionActive/);
  assert.match(source, /if \(await isAdminSessionActive\(\)\) return \{ checked: true, allowed: true, plan: "admin"/);
});

// ---------- 5. cross-process entitlement boundary ----------

// The extension's entitlement bypass lives in the extension host, but the work
// itself runs in a spawned CLI child (sidebar.ts spawns
// `run <task> --repo <cwd> --evidence-path <path>`). The CLI therefore performs
// its own entitlement check, and it can only see files on disk.
//
// The admin session is stored in VS Code SecretStorage
// (`minitok.secret.adminSession`), which the CLI cannot read, and PREAUTHORIZED
// is a process-local Symbol that cannot cross a process boundary. So a valid
// admin is admitted by the webview and rejected by the CLI.
//
// This test pins the boundary and fails the moment anyone wires it up, which is
// the signal to replace it with a real end-to-end assertion.
test("cross-process entitlement boundary is a known gap, not an oversight", () => {
  const cliFiles = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules") continue;
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith(".js")) cliFiles.push(p);
    }
  })(path.join(REPO, "src"));

  const adminAware = cliFiles.filter((f) => /MINITOK_ADMIN|adminSession|admin_token|adminToken|\/v1\/admin/.test(read(f)));
  assert.deepEqual(
    adminAware.map((f) => path.relative(REPO, f)),
    [],
    "the CLI can now see an admin session — replace this test with one that proves "
      + "`minitok run` actually proceeds for an admin, because the gap it documents is closed"
  );

  // The spawn site proves the child is expected to authorize itself.
  const sidebar = read(path.join(SRC, "sidebar.ts"));
  assert.match(
    sidebar,
    /const args = \["run", message\.task, "--repo", cwd!, "--evidence-path", evidenceSetting\]/,
    "if the run invocation changed, re-check what the child is told about authorization"
  );
});