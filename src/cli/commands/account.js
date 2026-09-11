"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { setOwnerOnlyPermissions } = require("../../utils/file-permissions");
const { postJson } = require("../../core/http");
const { resolveServerUrl } = require("./server-config");
const { normalizeCustomerSession } = require("../../auth/customer-session");

const ACCOUNT_FILE = path.join(os.homedir(), ".minitok", "account", "session.json");

function saveAccountSession(session, filePath = ACCOUNT_FILE) {
  const normalized = normalizeCustomerSession(session);
  if (!normalized) throw new TypeError("Account session is incomplete");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.tmp.${process.pid}.${crypto.randomBytes(4).toString("hex")}`;
  fs.writeFileSync(temp, JSON.stringify({ ...normalized, saved_at: new Date().toISOString() }), { mode: 0o600, flag: "wx" });
  setOwnerOnlyPermissions(temp);
  fs.renameSync(temp, filePath);
  setOwnerOnlyPermissions(filePath);
}
/** @returns {({ customer_id?: unknown, access_token: string, refresh_token: string, token_type: unknown, expires_in?: number, expires_at?: string, expired?: boolean } | null)} */
function loadAccountSession(filePath = ACCOUNT_FILE) {
  try {
    const session = normalizeCustomerSession(JSON.parse(fs.readFileSync(filePath, "utf8")));
    if (!session) return null;
    if (session.expires_at && Date.now() >= new Date(session.expires_at).getTime() - 60000) return { ...session, expired: true };
    return session;
  } catch { return null; }
}
async function refreshAccountSession(options = {}) {
  const session = loadAccountSession(options.file);
  if (!session?.refresh_token) return null;
  const result = await postJson(`${resolveServerUrl({ cliServer: options.server })}/v1/auth/token/refresh`, { refresh_token: session.refresh_token }, 30000);
  if (!result.ok || !result.body?.access_token || !result.body?.refresh_token) return null;
  saveAccountSession(result.body, options.file);
  return result.body;
}
async function ensureAccountSession(options = {}) {
  const session = loadAccountSession(options.file);
  if (session && !session.expired) return session;
  return refreshAccountSession(options);
}
function removeAccountSession(filePath = ACCOUNT_FILE) { try { fs.unlinkSync(filePath); } catch {} }
function openBrowser(url) {
  const { spawn } = require("node:child_process");
  if (process.platform === "win32") spawn("rundll32.exe", ["url.dll,FileProtocolHandler", url], { detached: true, stdio: "ignore" }).unref();
  else if (process.platform === "darwin") spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
  else spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
}
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function accountLogin(options = {}) {
  const server = resolveServerUrl({ cliServer: options.server });
  let start;
  try { start = await postJson(`${server}/v1/auth/device/authorize`, { client_id: "minitok-cli" }, options.timeoutMs || 30000); } catch (error) { console.error(`[error] Account login failed: ${error.message}`); return 1; }
   const deviceCode = start.body?.device_code || start.body?.deviceCode;
   if (!start.ok || !deviceCode) { console.error("[error] Unable to start account login."); return 1; }
   const url = start.body.verification_uri_complete || start.body.verificationUriComplete || start.body.verification_uri || start.body.verificationUri;
   console.error(`Open this URL to authorize minitok:\n${url}`);
   if (options.openBrowser !== false) { try { openBrowser(url); } catch {} }
   const deadline = Date.now() + (options.timeoutMs || 10 * 60 * 1000);
   const interval = Math.max(1000, Number(start.body.interval || 5) * 1000);

  while (Date.now() < deadline) {
    if (process.stdin.isTTY && process.stdin.readableEnded) { console.error("[error] Login cancelled."); return 1; }
    let result;
      try { result = await postJson(`${server}/v1/auth/device/token`, { device_code: deviceCode }, Math.min(30000, deadline - Date.now())); } catch (error) { console.error(`[error] Account login failed: ${error.message}`); return 1; }
    if (result.ok && result.body?.access_token && result.body?.refresh_token) {
      saveAccountSession(result.body);
      console.error("[ok] Account login successful. Credentials stored securely.");
      return 0;
    }
    if (result.body?.error === "authorization_pending") { await sleep(interval); continue; }
    console.error(`[error] Account login failed: ${result.body?.error || "authorization expired"}`);
    return 1;
  }
  console.error("[error] Account login timed out.");
  return 1;
}
async function accountLogout(options = {}) {
  const session = loadAccountSession(options.file);
  if (session?.refresh_token) { try { await postJson(`${resolveServerUrl({ cliServer: options.server })}/v1/auth/logout`, { refresh_token: session.refresh_token }, 10000); } catch {} }
  removeAccountSession(options.file);
  console.log("Logged out of the minitok account.");
  return 0;
}
async function accountSwitch(options = {}) { return accountLogin(options); }

function registerAccount(program) {
  const account = program.command("account").description("Manage the minitok customer account");
  account.command("login").description("Alias for auth customer-login; browser device authorization").option("--server <url>").option("--no-open-browser").option("--timeout <ms>", "Polling timeout", value => Number(value), 600000).action(async options => process.exit(await accountLogin({ ...options, timeoutMs: options.timeout, openBrowser: options.openBrowser })));
  account.command("logout").description("Revoke and remove account credentials").option("--server <url>").action(async options => process.exit(await accountLogout(options)));
  account.command("switch").description("Authorize a different minitok account").option("--server <url>").option("--no-open-browser").option("--timeout <ms>", "Polling timeout", value => Number(value), 600000).action(async options => process.exit(await accountSwitch({ ...options, timeoutMs: options.timeout, openBrowser: options.openBrowser })));
}

module.exports = { ACCOUNT_FILE, saveAccountSession, loadAccountSession, removeAccountSession, refreshAccountSession, ensureAccountSession, accountLogin, accountLogout, accountSwitch, registerAccount };
