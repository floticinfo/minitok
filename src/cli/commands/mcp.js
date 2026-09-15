"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { runtimeTokenPath, ensureRuntimeToken } = require("../../mcp/runtime-token");
const { resolveServerUrl } = require("./server-config");

const LOCK_STALE_MS = 30000;

/**
 * Per-platform locations of the supported MCP host applications.
 *
 * The previous implementation hardcoded `%APPDATA%` and fell back to
 * `<home>/AppData/Roaming`, so on macOS and Linux `minitok mcp connect` created
 * a fabricated `~/AppData/Roaming/...` tree, reported "Connected", and never
 * touched the editor's real configuration.
 */
function hostRoots() {
  const home = os.homedir();
  if (process.platform === "win32") {
    const app = process.env.APPDATA || path.join(home, "AppData", "Roaming");
    return { vscodeUser: path.join(app, "Code", "User"), claude: path.join(app, "Claude"), home, configHome: path.join(home, ".config") };
  }
  if (process.platform === "darwin") {
    const support = path.join(home, "Library", "Application Support");
    return { vscodeUser: path.join(support, "Code", "User"), claude: path.join(support, "Claude"), home, configHome: path.join(home, ".config") };
  }
  const configHome = process.env.XDG_CONFIG_HOME || path.join(home, ".config");
  return { vscodeUser: path.join(configHome, "Code", "User"), claude: path.join(configHome, "Claude"), home, configHome };
}

/** Every configuration file a host is known to read, preferred location first. */
function hostCandidates() {
  const roots = hostRoots();
  return {
    // Current Cline IDE and CLI locations, followed by the legacy VS Code path.
    cline: [
      path.join(roots.home, ".cline", "data", "settings", "cline_mcp_settings.json"),
      path.join(roots.home, ".cline", "mcp.json"),
      path.join(roots.vscodeUser, "globalStorage", "saoudrizwan.claude-dev", "settings", "cline_mcp_settings.json"),
    ],
    claude: [path.join(roots.claude, "claude_desktop_config.json")],
    cursor: [path.join(roots.home, ".cursor", "mcp.json"), path.join(roots.vscodeUser, "globalStorage", "mcp.json")],
  };
}

function configs() {
  const candidates = hostCandidates();
  return Object.fromEntries(Object.entries(candidates).map(([name, list]) => [name, list.find(file => fs.existsSync(file)) || list[0]]));
}

/** Resolve a host, failing closed when the host is not installed on this machine. */
function resolveHost(name, override) {
  if (override) {
    const file = path.resolve(override);
    return { name, file, candidates: [file], installed: true };
  }
  const list = hostCandidates()[name];
  if (!list) throw new Error(`Unsupported MCP host: ${name}`);
  const existing = list.find(file => fs.existsSync(file));
  if (existing) return { name, file: existing, candidates: list, installed: true };
  // A host whose directory exists but has no config yet is a first run.
  const firstRun = list.find(file => fs.existsSync(path.dirname(file)));
  if (firstRun) return { name, file: firstRun, candidates: list, installed: true };
  throw Object.assign(
    new Error(`No ${name} configuration found. Checked: ${list.join(", ")}. Start ${name} once so it creates its configuration, or pass --host-file <path>.`),
    { code: "MCP_HOST_NOT_FOUND" }
  );
}

function configuredScopes(file) {
  try {
    const data = readConfig(file);
    const container = serverContainer(data);
    const entry = container.value?.minitok;
    const raw = entry && typeof entry === "object" ? entry.env?.MINITOK_MCP_SCOPES : undefined;
    const explicit = typeof raw === "string" && raw.trim().length > 0;
    const scopes = explicit ? [...new Set(raw.split(",").map(scope => scope.trim()).filter(Boolean))] : ["read"];
    const allowed = ["read", "write", "auto_accept", "verify_exec"];
    return { scopes, scopes_explicit: explicit, scopes_source: explicit ? "explicit" : "default", invalid_scopes: scopes.filter(scope => !allowed.includes(scope)) };
  } catch (error) {
    return { scopes: [], invalid_scopes: [], scope_error: error.message };
  }
}

function detect() {
  const candidates = hostCandidates();
  return Object.entries(candidates).map(([name, list]) => {
    const file = list.find(candidate => fs.existsSync(candidate)) || list[0];
    const row = { name, file, detected: fs.existsSync(file), candidates: list };
    return row.detected ? { ...row, ...configuredScopes(file) } : row;
  });
}

function readConfig(file) {
  if (!fs.existsSync(file)) return {};
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    const failure = new Error(`MCP config is invalid; update aborted: ${error.message}`);
    failure.cause = error;
    throw failure;
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("MCP config must be a JSON object; update aborted");
  return data;
}
function serverContainer(data) {
  if (Object.prototype.hasOwnProperty.call(data, "mcpServers")) return { key: "mcpServers", value: data.mcpServers };
  if (Object.prototype.hasOwnProperty.call(data, "servers")) return { key: "servers", value: data.servers };
  return { key: "mcpServers", value: {} };
}

function validateServers(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("MCP server configuration must be an object; update aborted");
  return value;
}

function syncFile(fd) {
  try {
    fs.fsyncSync(fd);
  } catch (error) {
    if (!["EINVAL", "ENOTSUP", "EBADF"].includes(error.code)) throw error;
  }
}

function syncDir(dir) {
  try {
    const fd = fs.openSync(dir, "r");
    try { syncFile(fd); } finally { fs.closeSync(fd); }
  } catch (error) {
    if (!["EINVAL", "ENOTSUP", "EPERM", "EISDIR"].includes(error.code)) throw error;
  }
}
function readLock(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!Number.isInteger(value.pid) || value.pid <= 0 || typeof value.nonce !== "string" || !/^[a-f0-9]{32}$/.test(value.nonce)) return null;
    return value;
  } catch { return null; }
}

function processIsRunning(pid) {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function lockIsStale(lock, lockPath) {
  if (lock && processIsRunning(lock.pid)) return false;
  if (lock) return true;
  try { return Date.now() - fs.statSync(lockPath).mtimeMs > LOCK_STALE_MS; } catch { return true; }
}

function createLock(lock) {
  const nonce = crypto.randomBytes(16).toString("hex");
  const owner = { pid: process.pid, nonce, startedAt: new Date().toISOString() };
  const fd = fs.openSync(lock, "wx", 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(owner)}\n`, { encoding: "utf8" });
    syncFile(fd);
  } catch (error) {
    try { fs.closeSync(fd); } catch {}
    try { fs.unlinkSync(lock); } catch {}
    throw error;
  }
  fs.closeSync(fd);
  try { fs.chmodSync(lock, 0o600); } catch {}
  syncDir(path.dirname(lock));
  return owner;
}

function lockMatches(left, right) {
  return left?.pid === right?.pid && left?.nonce === right?.nonce;
}

function busyLock(error) {
  return new Error("MCP config is busy", { cause: error });
}
function reclaimLock(lock, existing) {
  const candidate = `${lock}.reclaim.${process.pid}.${crypto.randomBytes(16).toString("hex")}`;
  try { fs.renameSync(lock, candidate); } catch (error) { if (error.code === "ENOENT") return false; throw busyLock(error); }
  const claimed = readLock(candidate);
  if (!lockMatches(claimed, existing)) { try { fs.unlinkSync(candidate); } catch {} throw busyLock(new Error("MCP config lock changed")); }
  try { fs.unlinkSync(candidate); } catch (error) { if (error.code !== "ENOENT") throw error; }
  syncDir(path.dirname(lock));
  return true;
}
function releaseLock(lock, owner) {
  if (!owner) return;
  const current = readLock(lock);
  if (!lockMatches(current, owner)) return;
  const candidate = `${lock}.release.${process.pid}.${owner.nonce}`;
  try { fs.renameSync(lock, candidate); } catch (error) { if (error.code === "ENOENT") return; throw error; }
  if (lockMatches(readLock(candidate), owner)) { fs.unlinkSync(candidate); syncDir(path.dirname(lock)); }
  else { try { fs.unlinkSync(candidate); } catch (error) { if (error.code !== "ENOENT") throw error; } }
}
function writeConfig(file, data, options = {}) {
  const dir = path.dirname(file); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lock = `${file}.lock`; let owner; let temp; let backupTemp; let previous; let replaced = false; const backup = `${file}.bak`;
  try {
    try { owner = createLock(lock); } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const existing = readLock(lock);
      if (existing && existing.pid === process.pid) { try { fs.unlinkSync(lock); syncDir(dir); } catch (removeError) { if (removeError.code !== "ENOENT") throw busyLock(removeError); } } else if (existing && !lockIsStale(existing, lock)) throw busyLock(error);
      if (existing && existing.pid !== process.pid && !reclaimLock(lock, existing)) throw busyLock(error);
      if (!existing) {
        let stale = false;
        try { stale = Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS; } catch (statError) { if (statError.code !== "ENOENT") throw busyLock(statError); }
        if (!stale) throw busyLock(error);
        try { fs.unlinkSync(lock); syncDir(dir); } catch (removeError) { if (removeError.code !== "ENOENT") throw busyLock(removeError); }
      }
      try { owner = createLock(lock); } catch (retryError) { throw busyLock(retryError); }
    }
    previous = fs.existsSync(file) ? fs.readFileSync(file) : null;
    const content = `${JSON.stringify(data, null, 2)}\n`;
    temp = `${file}.tmp.${process.pid}.${owner.nonce}`;
    const fd = fs.openSync(temp, "wx", 0o600);
    try { fs.writeFileSync(fd, content, { encoding: "utf8" }); syncFile(fd); } finally { fs.closeSync(fd); }
    try { fs.chmodSync(temp, 0o600); } catch {}
    if (previous && options.backup !== false) {
      backupTemp = `${backup}.tmp.${process.pid}.${owner.nonce}`;
      const backupFd = fs.openSync(backupTemp, "wx", 0o600);
      try { fs.writeFileSync(backupFd, previous); syncFile(backupFd); } finally { fs.closeSync(backupFd); }
      try { fs.chmodSync(backupTemp, 0o600); } catch {}
      fs.renameSync(backupTemp, backup); backupTemp = undefined;
    }
    fs.renameSync(temp, file); temp = undefined; replaced = true;
    try { fs.chmodSync(file, 0o600); } catch {}
    syncDir(dir);
    if (options.rollback === true) {
      const current = fs.existsSync(file) ? fs.readFileSync(file) : null;
      if (Buffer.from(current || []).equals(Buffer.from(content))) {
        if (previous) {
          const rollbackTemp = `${file}.rollback.${process.pid}.${owner.nonce}`;
          fs.writeFileSync(rollbackTemp, previous, { mode: 0o600, flag: "wx" });
          const rollbackFd = fs.openSync(rollbackTemp, "r+"); try { syncFile(rollbackFd); } finally { fs.closeSync(rollbackFd); }
          fs.renameSync(rollbackTemp, file); try { fs.chmodSync(file, 0o600); } catch {} syncDir(dir);
        }
      }
    }
    // The crash-recovery copy lives only for the duration of the replacement, so
    // the flag that disables it is about that window. --keep-backup opts into
    // keeping the copy as a restore point.
    if (options.keepBackup !== true && fs.existsSync(backup)) { try { fs.unlinkSync(backup); syncDir(dir); } catch {} }
  } catch (error) {
    if (temp) { try { fs.unlinkSync(temp); } catch {} }
    if (backupTemp) { try { fs.unlinkSync(backupTemp); } catch {} }
    if (replaced) {
      const current = fs.existsSync(file) ? fs.readFileSync(file) : null;
      const content = `${JSON.stringify(data, null, 2)}\n`;
      if (Buffer.from(current || []).equals(Buffer.from(content))) {
        if (previous) {
          const rollbackTemp = `${file}.rollback.${process.pid}.${owner.nonce}`;
          try { fs.writeFileSync(rollbackTemp, previous, { mode: 0o600, flag: "wx" }); fs.renameSync(rollbackTemp, file); try { fs.chmodSync(file, 0o600); } catch {} syncDir(dir); } catch {}
        } else { try { fs.unlinkSync(file); } catch {} }
      }
    }
    try { if (fs.existsSync(backup)) fs.unlinkSync(backup); } catch {}
    throw error;
  } finally { try { releaseLock(lock, owner); } catch {} }
}
function configuredServerUrl(file) {
  try {
    const data = readConfig(file);
    const entry = serverContainer(data).value?.minitok;
    const value = entry && typeof entry === "object" ? entry.env?.minitok_server_url : undefined;
    return typeof value === "string" && value.trim() ? value : undefined;
  } catch {
    return undefined;
  }
}
function planChange(file, action, options = {}) {
  const data = readConfig(file);
  const container = serverContainer(data);
  const servers = validateServers(container.value);
  const before = JSON.stringify(data);

  if (action === "connect") {
    const tokenFile = options.tokenFile || runtimeTokenPath();
    const existingEntry = container.value?.minitok;
    const existingServer = existingEntry && typeof existingEntry === "object" ? existingEntry.env?.minitok_server_url : undefined;
    const serverUrl = options.serverUrl || (typeof existingServer === "string" && existingServer.trim() ? existingServer : resolveServerUrl());
    const env = { MINITOK_MCP_AUTH_TOKEN_FILE: tokenFile, minitok_server_url: serverUrl };
    // The grant has to travel in the MCP server's environment: the transport
    // reads it at startup, and options.permissions is only reachable in-process.
    // Reconnects without --scopes are non-destructive: retain the existing grant.
    if (options.scopes !== undefined && options.scopes !== null) env.MINITOK_MCP_SCOPES = options.scopes;
    else {
      const existing = container.value?.minitok;
      const previous = existing && typeof existing === "object" ? existing.env?.MINITOK_MCP_SCOPES : undefined;
      if (typeof previous === "string" && previous.trim()) env.MINITOK_MCP_SCOPES = previous;
    }
    servers.minitok = {
      command: process.execPath,
      args: [path.resolve(__dirname, "../../runtime/stdio-entry.js")],
      env,
      disabled: false,
      autoApprove: [],
    };
  } else {
    delete servers.minitok;
  }

  data[container.key] = servers;
  return { file, data, changed: before !== JSON.stringify(data), schema: container.key, backup: `${file}.bak` };
}
/**
 * Token files still referenced by any other host configuration.
 *
 * `minitok mcp disconnect` used to remove the server entry and nothing else, so
 * the runtime token stayed valid for the application it had just been removed
 * from (and for the whole TTL). Revoking the shared record is only correct once
 * no remaining host points at it — otherwise disconnecting one editor would sign
 * out the others.
 */
function configuredTokenFiles(exceptFile) {
  const files = new Set();
  for (const file of Object.values(configs())) {
    if (file === exceptFile) continue;
    let data;
    try { data = readConfig(file); } catch { continue; }
    const servers = serverContainer(data).value;
    const entry = servers && typeof servers === "object" && !Array.isArray(servers) ? servers.minitok : null;
    const tokenFile = entry && typeof entry === "object" ? entry.env?.MINITOK_MCP_AUTH_TOKEN_FILE : null;
    if (typeof tokenFile === "string" && tokenFile) files.add(tokenFile);
  }
  return files;
}
async function remoteStatus(url, token, options = {}) {
  const { remoteHealth } = require("../../mcp/remote");
  return remoteHealth({ url, token, allowOAuth: options.allowOAuth !== false, accountOptions: options });
}
function register(program) {
  const mcp = program.command("mcp");

  mcp.command("serve")
    .description("Run the authenticated MCP stdio server for package and marketplace clients")
    .action(() => {
      const { RuntimeStdio } = require("../../runtime/stdio");
      new RuntimeStdio().start();
    });

  mcp.command("status")
    .option("--server <url>", "minitok server URL")
    .option("--json")
    .action(opts => {
      /** @type {Array<{ name: string, file: string, detected: boolean, candidates?: string[], scopes?: string[], scopes_explicit?: boolean, scopes_source?: string, invalid_scopes?: string[], scope_error?: string, reason?: string | null, action?: string | null }>} */
      const rows = detect();
      rows.unshift({ name: "server", file: resolveServerUrl({ cliServer: opts.server }), detected: true });
      // The token row explains a class of silent failure: an MCP host is configured
      // with a token file that readRuntimeToken refuses (outside ~/.minitok/mcp/, or
      // an expired/revoked record), so every call fails with AUTH_REQUIRED while the
      // host configuration looks correct.
      const { runtimeTokenDiagnostics } = require("../../mcp/runtime-token");
      const tokenFile = process.env.MINITOK_MCP_AUTH_TOKEN_FILE || runtimeTokenPath();
      const token = runtimeTokenDiagnostics(tokenFile);
      rows.push({ name: "token", file: token.file || tokenFile, detected: token.ok === true, reason: token.reason || null, action: token.action || null });
      if (opts.json) { console.log(JSON.stringify(rows)); return; }
      for (const row of rows) {
        if (row.name === "token") {
          console.log(`token: ${row.detected ? "usable" : "NOT usable"} (${row.file})`);
          if (!row.detected) { console.log(`  ${row.reason}`); if (row.action) console.log(`  ${row.action}`); }
          continue;
        }
        console.log(`${row.name}: ${row.detected ? "detected" : "not found"} (${row.file})`);
        if (row.detected && row.scopes) {
          console.log(`  scopes: ${row.scopes.join(",") || "none"} (${row.scopes_source || "default"})`);
          if (row.invalid_scopes?.length) console.log(`  invalid scopes: ${row.invalid_scopes.join(",")}`);
          if (row.scope_error) console.log(`  scope error: ${row.scope_error}`);
        }
      }
    });

  mcp.command("remote-health <url>")
    .option("--token <jwt>", "Customer JWT")
    .option("--no-oauth", "disable browser OAuth")
    .option("--json", "output JSON")
    .action(async (url, opts) => {
      const result = await remoteStatus(url, opts.token, opts);
      console.log(opts.json ? JSON.stringify(result) : `Remote MCP online: ${result.tools.length} read-only tools`);
    });

  for (const action of ["connect", "disconnect"]) {
    mcp.command(`${action} <host>`)
      .option("--dry-run", "preview without writing")
      .option("--force", "write despite an unchanged configuration")
      .option("--no-backup", "skip the crash-recovery copy taken during the write")
      .option("--keep-backup", "keep <config>.bak after a successful write as a restore point")
      .option("--host-file <path>", "write this host configuration file instead of the detected one")
      .option("--rollback", "restore the previous configuration on failure")
      .option("--scopes <scopes>", "local MCP scopes to grant (read,write,auto_accept,verify_exec)")
      .option("--server <url>", "minitok server URL")
      .action(async (host, opts) => {
        const target = resolveHost(host, opts.hostFile);
        const file = target.file;
        if (action === "disconnect" && !fs.existsSync(file)) {
          console.log(`Already disconnected ${host} (${file} does not exist)`);
          return;
        }

        // Validate before touching any config so an unknown scope fails fast,
        // rather than throwing inside the MCP server the user just configured.
        const scopes = action === "connect" && opts.scopes
          ? require("../../runtime/stdio").parseLocalMcpScopes(opts.scopes).join(",")
          : null;

        let tokenFile;
        const effectiveServerUrl = opts.server ? resolveServerUrl({ cliServer: opts.server }) : configuredServerUrl(file) || resolveServerUrl();
        if (action === "connect" && !(opts.dryRun || opts.preview)) {
          const { authorizeEntitlement } = require("../../entitlement/policy");
          const entitlement = await authorizeEntitlement({ serverUrl: effectiveServerUrl });
          if (!entitlement.allowed) throw new Error(entitlement.message || "An active paid entitlement is required");
          tokenFile = ensureRuntimeToken({});
        }

        const plan = planChange(file, action, { tokenFile: tokenFile?.path || runtimeTokenPath(), scopes, serverUrl: opts.server ? effectiveServerUrl : undefined });
        if (!plan.changed && !opts.force) {
          console.log(`${action === "connect" ? "Already connected" : "Already disconnected"} ${host}`);
          return;
        }
        if (opts.dryRun || opts.preview) {
          console.log(JSON.stringify({ action, host, file, schema: plan.schema, changed: plan.changed, backup: opts.backup !== false ? plan.backup : null, keepBackup: opts.keepBackup === true, scopes: action === "connect" ? scopes : null }));
          return;
        }
        const backupRequested = opts.backup !== false;
        const hadPreviousConfig = fs.existsSync(file);
        writeConfig(file, plan.data, { backup: backupRequested, keepBackup: opts.keepBackup === true, rollback: opts.rollback === true });
        if (action === "disconnect") {
          // Only the last host holding the record revokes it: the token file is
          // shared, so disconnecting one editor must not sign out the others.
          const { revokeRuntimeToken } = require("../../mcp/runtime-token");
          const tokenFile = process.env.MINITOK_MCP_AUTH_TOKEN_FILE || runtimeTokenPath();
          if (!configuredTokenFiles(file).has(tokenFile) && revokeRuntimeToken(tokenFile)) {
            console.log(`MCP auth token revoked (${tokenFile}). Run "minitok mcp token" before connecting a host again.`);
          }
        }
        console.log(`${action === "connect" ? "Connected" : "Disconnected"} minitok ${action === "connect" ? "to" : "from"} ${host} (${file})`);
        if (hadPreviousConfig && backupRequested && opts.keepBackup === true && fs.existsSync(plan.backup)) console.log(`Backup: ${plan.backup}`);
        else if (hadPreviousConfig && backupRequested) console.log("Backup: not retained (use --keep-backup to keep the restore point).");
        else console.log(`Backup: none (${hadPreviousConfig ? "disabled by --no-backup" : "new configuration"}).`);
      });
  }

  // The runtime token is short lived (15 minutes) and used to be rotated only by
  // `mcp connect`, so a configured MCP client lost access 15 minutes after setup
  // with no way to refresh. This command makes rotation an explicit, idempotent
  // step that the editor can call before a handshake.
  mcp.command("token")
    .description("Ensure the local MCP runtime token is valid, rotating it when missing or expired")
    .option("--server <url>", "minitok server URL")
    .action(async opts => {
      const { authorizeEntitlement } = require("../../entitlement/policy");
      const entitlement = await authorizeEntitlement({ serverUrl: resolveServerUrl({ cliServer: opts.server }) });
      if (!entitlement.allowed) throw new Error(entitlement.message || "An active paid entitlement is required");
      const { ensureRuntimeToken } = require("../../mcp/runtime-token");
      const record = ensureRuntimeToken({});
      // Never print the token itself: it is a bearer credential. Report the
      // rotation so the caller can authenticate from the token file.
      console.log(JSON.stringify({ status: "ok", path: record.path, expires_at: new Date(record.expires_at).toISOString() }));
    });
}
module.exports = { register, detect, configuredScopes, readConfig, writeConfig, configs, serverContainer, configuredServerUrl, planChange, readLock, processIsRunning, hostCandidates, resolveHost, configuredTokenFiles };
