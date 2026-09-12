"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { runtimeTokenPath, ensureRuntimeToken } = require("../../mcp/runtime-token");

const LOCK_STALE_MS = 30000;

function configs() { const app = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"); return { cline: path.join(app, "Code", "User", "globalStorage", "saoudrizwan.claude-dev", "settings", "cline_mcp_settings.json"), claude: path.join(app, "Claude", "claude_desktop_config.json"), cursor: path.join(app, "Cursor", "User", "globalStorage", "mcp.json") }; }
function detect() { return Object.entries(configs()).map(([name, file]) => ({ name, file, detected: fs.existsSync(file) })); }
function readConfig(file) { if (!fs.existsSync(file)) return {}; let data; try { data = JSON.parse(fs.readFileSync(file, "utf8")); } catch (error) { const failure = new Error(`MCP config is invalid; update aborted: ${error.message}`); failure.cause = error; throw failure; } if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("MCP config must be a JSON object; update aborted"); return data; }
function serverContainer(data) { if (Object.prototype.hasOwnProperty.call(data, "mcpServers")) return { key: "mcpServers", value: data.mcpServers }; if (Object.prototype.hasOwnProperty.call(data, "servers")) return { key: "servers", value: data.servers }; return { key: "mcpServers", value: {} }; }
function validateServers(value) { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("MCP server configuration must be an object; update aborted"); return value; }
function syncFile(fd) { try { fs.fsyncSync(fd); } catch (error) { if (!( ["EINVAL", "ENOTSUP", "EBADF"].includes(error.code))) throw error; } }
function syncDir(dir) { try { const fd = fs.openSync(dir, "r"); try { syncFile(fd); } finally { fs.closeSync(fd); } } catch (error) { if (!( ["EINVAL", "ENOTSUP", "EPERM", "EISDIR"].includes(error.code))) throw error; } }
function readLock(file) { try { const value = JSON.parse(fs.readFileSync(file, "utf8")); if (!Number.isInteger(value.pid) || value.pid <= 0 || typeof value.nonce !== "string" || !/^[a-f0-9]{32}$/.test(value.nonce)) return null; return value; } catch { return null; } }
function processIsRunning(pid) { if (pid === process.pid) return true; try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; } }
function lockIsStale(lock, lockPath) { if (lock && processIsRunning(lock.pid)) return false; if (lock) return true; try { return Date.now() - fs.statSync(lockPath).mtimeMs > LOCK_STALE_MS; } catch { return true; } }
function createLock(lock) { const nonce = crypto.randomBytes(16).toString("hex"); const owner = { pid: process.pid, nonce, startedAt: new Date().toISOString() }; const fd = fs.openSync(lock, "wx", 0o600); try { fs.writeFileSync(fd, `${JSON.stringify(owner)}\n`, { encoding: "utf8" }); syncFile(fd); } catch (error) { try { fs.closeSync(fd); } catch {} try { fs.unlinkSync(lock); } catch {} throw error; } fs.closeSync(fd); try { fs.chmodSync(lock, 0o600); } catch {} syncDir(path.dirname(lock)); return owner; }
function lockMatches(left, right) { return left?.pid === right?.pid && left?.nonce === right?.nonce; }
function busyLock(error) { return new Error("MCP config is busy", { cause: error }); }
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
    if (fs.existsSync(backup)) { try { fs.unlinkSync(backup); syncDir(dir); } catch {} }
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
function planChange(file, action, options = {}) { const data = readConfig(file); const container = serverContainer(data); const servers = validateServers(container.value); const before = JSON.stringify(data); if (action === "connect") { const tokenFile = options.tokenFile || runtimeTokenPath(); const env = { MINITOK_MCP_AUTH_TOKEN_FILE: tokenFile }; if (options.scopes) env.MINITOK_MCP_SCOPES = options.scopes; servers.minitok = { command: process.execPath, args: [path.resolve(__dirname, "../../runtime/stdio-entry.js")], env, disabled: false }; } else delete servers.minitok; data[container.key] = servers; return { file, data, changed: before !== JSON.stringify(data), schema: container.key, backup: `${file}.bak` }; }
async function remoteStatus(url, token, options = {}) { const { remoteHealth } = require("../../mcp/remote"); return remoteHealth({ url, token, allowOAuth: options.allowOAuth !== false, accountOptions: options }); }
function register(program) { const mcp = program.command("mcp"); mcp.command("status").option("--json").action(opts => { const rows = detect(); if (opts.json) console.log(JSON.stringify(rows)); else rows.forEach(row => console.log(`${row.name}: ${row.detected ? "detected" : "not found"}`)); }); mcp.command("remote-health <url>").option("--token <jwt>", "Customer JWT").option("--no-oauth", "disable browser OAuth").option("--json", "output JSON").action(async (url, opts) => { const result = await remoteStatus(url, opts.token, opts); console.log(opts.json ? JSON.stringify(result) : `Remote MCP online: ${result.tools.length} read-only tools`); }); for (const action of ["connect", "disconnect"]) { mcp.command(`${action} <host>`).option("--dry-run", "preview without writing").option("--force", "write despite an unchanged configuration").option("--no-backup", "disable backup").option("--rollback", "restore backup on failure").option("--scopes <scopes>", "local MCP scopes to grant (read,write,auto_accept)").action(async (host, opts) => { const file = configs()[host]; if (!file) throw new Error(`Unsupported MCP host: ${host}`); if (action === "disconnect" && !fs.existsSync(file)) return; const scopes = action === "connect" && opts.scopes ? require("../../runtime/stdio").parseLocalMcpScopes(opts.scopes).join(",") : null; let tokenFile; if (action === "connect" && !(opts.dryRun || opts.preview)) { const { authorizeEntitlement } = require("../../entitlement/policy"); const entitlement = await authorizeEntitlement(); if (!entitlement.allowed) throw new Error(entitlement.message || "An active paid entitlement is required"); tokenFile = ensureRuntimeToken({}); } const plan = planChange(file, action, { tokenFile: tokenFile?.path || runtimeTokenPath(), scopes }); if (!plan.changed && !opts.force) { console.log(`${action === "connect" ? "Already connected" : "Already disconnected"} ${host}`); return; } if (opts.dryRun || opts.preview) { console.log(JSON.stringify({ action, host, file, schema: plan.schema, changed: plan.changed, backup: opts.backup !== false ? plan.backup : null, scopes: action === "connect" ? scopes : null })); return; } writeConfig(file, plan.data, { backup: opts.backup !== false, rollback: opts.rollback === true }); console.log(`${action === "connect" ? "Connected" : "Disconnected"} minitok ${action === "connect" ? "to" : "from"} ${host}`); }); } }
module.exports = { register, detect, readConfig, writeConfig, configs, serverContainer, planChange, readLock, processIsRunning };
