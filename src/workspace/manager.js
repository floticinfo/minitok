"use strict";

/**
 * Workspace manager — compatible with Python version's workspaces.json.
 * Storage: ~/.minitok/workspaces.json
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { WorkspaceError } = require("../core/errors");
const { setOwnerOnlyPermissions } = require("../utils/file-permissions");

const minitokHome = path.join(os.homedir(), ".minitok");
const WORKSPACES_FILE = "workspaces.json";
const LOCK_STALE_MS = 30000;

const INDICATORS = {
  python: ["pyproject.toml", "setup.py", "setup.cfg", "requirements.txt"],
  node: ["package.json"],
  rust: ["Cargo.toml"],
  go: ["go.mod"],
  java: ["pom.xml", "build.gradle"],
  flutter: ["pubspec.yaml"],
};

function detectProjectType(repoRoot) {
  for (const [type, files] of Object.entries(INDICATORS)) {
    for (const f of files) {
      if (fs.existsSync(path.join(repoRoot, f))) return type;
    }
  }
  return "generic";
}

function isUnder(child, parent) {
  const c = path.resolve(child);
  const p = path.resolve(parent);
  return c === p || c.startsWith(p + path.sep);
}

class WorkspaceManager {
  constructor(minitokHomePath) {
    this._home = minitokHomePath || minitokHome;
    this._file = path.join(this._home, WORKSPACES_FILE);
    this._registry = this._load();
    this._removedNames = new Set();
  }

  _load() {
    try {
      const data = JSON.parse(fs.readFileSync(this._file, "utf-8"));
      if (!data || typeof data !== "object" || Array.isArray(data) || !data.workspaces || typeof data.workspaces !== "object" || Array.isArray(data.workspaces) || (data.current !== null && typeof data.current !== "string")) throw new Error("invalid registry");
      for (const [name, ws] of Object.entries(data.workspaces)) {
        if (!ws || ws.name !== name || typeof ws.repository_root !== "string" || typeof ws.workspace_directory !== "string") throw new Error("invalid workspace entry");
      }
      return data;
    } catch (error) {
      if (error.code === "ENOENT") return { workspaces: {}, current: null };
      throw new WorkspaceError("Workspace registry is invalid");
    }
  }

  _save(registry = this._registry) {
    fs.mkdirSync(this._home, { recursive: true });
    const lockPath = this._file + ".lock";
    let lockFd;
    const token = crypto.randomBytes(8).toString("hex");
    for (let attempt = 0; attempt < 100; attempt++) {
      try { lockFd = fs.openSync(lockPath, "wx", 0o600); fs.writeFileSync(lockFd, JSON.stringify({ pid: process.pid, host: os.hostname(), token, createdAt: Date.now() })); break; } catch (error) {
        if (error.code !== "EEXIST") throw error;
        // Fail closed while the owner may still be alive. The old test defaulted
        // to `stale = true`, so an empty or half-written lock file (the writer is
        // between create and write) was deleted and two processes wrote the
        // registry at once. An unreadable file is now only reclaimed by age, and a
        // lock from another host only by age as well: liveness can be judged for
        // this host's PIDs alone.
        let stale = false;
        let lock = null;
        try { lock = JSON.parse(fs.readFileSync(lockPath, "utf8")); } catch {}
        if (lock && typeof lock === "object" && !Array.isArray(lock)) {
          const sameHost = !lock.host || lock.host === os.hostname();
          const pidKnown = Number.isInteger(lock.pid) && lock.pid > 0;
          let alive = false;
          if (sameHost && pidKnown) { try { process.kill(lock.pid, 0); alive = true; } catch {} }
          if (typeof lock.createdAt === "number" && Date.now() - lock.createdAt > LOCK_STALE_MS) stale = true;
          else if (sameHost && pidKnown && !alive) stale = true;
        } else {
          try { stale = Date.now() - fs.statSync(lockPath).mtimeMs > LOCK_STALE_MS; } catch { stale = true; }
        }
        if (stale) { try { fs.unlinkSync(lockPath); } catch {} } else Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      }
    }
    if (lockFd === undefined) throw new WorkspaceError("Workspace registry is busy");
    try {
      const current = this._load();
      const merged = { ...current, workspaces: { ...current.workspaces, ...registry.workspaces }, current: registry.current };
      for (const name of this._removedNames) delete merged.workspaces[name];
      this._removedNames.clear();
      const tmp = `${this._file}.tmp.${process.pid}.${crypto.randomBytes(6).toString("hex")}`;
      try {
        fs.writeFileSync(tmp, JSON.stringify(merged, null, 2), { encoding: "utf-8", flag: "wx", mode: 0o600 });
        setOwnerOnlyPermissions(tmp); fs.renameSync(tmp, this._file); setOwnerOnlyPermissions(this._file);
      } finally { try { fs.unlinkSync(tmp); } catch {} }
      this._registry = merged;
    } finally {
      try { fs.closeSync(lockFd); } catch {}
      try { const lock = JSON.parse(fs.readFileSync(lockPath, "utf8")); if (lock.token === token) fs.unlinkSync(lockPath); } catch {}
    }
  }

  add(name, repoRoot) {
    if (this._registry.workspaces[name]) {
      throw new WorkspaceError(`Workspace '${name}' already exists`);
    }
    if (!fs.existsSync(repoRoot) || !fs.statSync(repoRoot).isDirectory()) {
      throw new WorkspaceError(`Path does not exist or is not a directory: ${repoRoot}`);
    }
    const projectType = detectProjectType(repoRoot);
    const wsDir = path.join(repoRoot, ".minitok");
    const ws = {
      name,
      repository_root: path.resolve(repoRoot),
      workspace_directory: wsDir,
      project_type: projectType,
      last_used: null,
      created_at: new Date().toISOString(),
    };
    this._registry.workspaces[name] = ws;
    this._save();
    return ws;
  }

  listAll() {
    return this._registry.workspaces;
  }

  get(name) {
    if (!this._registry.workspaces[name]) {
      throw new WorkspaceError(`Workspace '${name}' not found`);
    }
    return this._registry.workspaces[name];
  }

  use(name) {
    const ws = this.get(name);
    ws.repository_root = fs.realpathSync(ws.repository_root);
    if (!fs.statSync(ws.repository_root).isDirectory()) throw new WorkspaceError("Workspace repository is not a directory");
    ws.workspace_directory = path.join(ws.repository_root, ".minitok");
    ws.last_used = new Date().toISOString();
    this._registry.current = name;
    this._save();
    return ws;
  }

  remove(name) {
    if (!this._registry.workspaces[name]) {
      throw new WorkspaceError(`Workspace '${name}' not found`);
    }
    delete this._registry.workspaces[name];
    this._removedNames.add(name);
    if (this._registry.current === name) {
      this._registry.current = null;
    }
    this._save();
  }

  currentWorkspace() {
    if (!this._registry.current) return null;
    return this._registry.workspaces[this._registry.current] || null;
  }

  resolve(explicitName, cwd) {
    // Priority 1: explicit name
    if (explicitName) return this.get(explicitName);

    // Priority 2: CWD matching
    const resolved = path.resolve(cwd || process.cwd());
    const matches = [];
    for (const ws of Object.values(this._registry.workspaces)) {
      let resolvedCwd, resolvedRoot;
      try {
        resolvedCwd = fs.realpathSync(resolved);
        resolvedRoot = fs.realpathSync(ws.repository_root);
      } catch {
        continue;
      }
      if (isUnder(resolvedCwd, resolvedRoot)) {
        matches.push(ws);
      }
    }
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      const names = matches.map((w) => w.name).join(", ");
      throw new WorkspaceError(
        `Ambiguous CWD matches multiple workspaces: ${names}. Use 'minitok workspace use <name>'.`
      );
    }

    // Priority 3: current workspace
    const cur = this.currentWorkspace();
    if (cur) return cur;

    // Priority 4: single workspace
    const all = Object.values(this._registry.workspaces);
    if (all.length === 1) return all[0];

    // Priority 5: nothing
    throw new WorkspaceError(
      "No workspace could be resolved.\n\nRun:\n\n    minitok workspace add .\n"
    );
  }

  get currentName() {
    return this._registry.current;
  }

  get repositoryRoot() {
    const ws = this.currentWorkspace();
    return ws ? ws.repository_root : null;
  }
}

module.exports = { WorkspaceManager, minitokHome, detectProjectType };
