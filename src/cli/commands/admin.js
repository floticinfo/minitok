"use strict";

const { spawn } = require("node:child_process");
const { resolveServerUrl } = require("./server-config");
const { fetchWithTimeout } = require("../../core/http");

const ADMIN_CONSOLE_URL = "https://minitok.dev/admin";

function openBrowser(url) {
  if (process.platform === "win32") spawn("rundll32.exe", ["url.dll,FileProtocolHandler", url], { detached: true, stdio: "ignore" }).unref();
  else if (process.platform === "darwin") spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
  else spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
}

function adminConsoleUrl() {
  return ADMIN_CONSOLE_URL;
}

async function adminStatus(options = {}) {
  const server = resolveServerUrl({ cliServer: options.server });
  const headers = { Accept: "application/json" };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  const url = `${server}/v1/admin/me`;
  try {
    const response = await fetchWithTimeout(url, { method: "GET", headers }, 15000);
    const body = await response.json().catch(() => ({}));
    if (response.status === 401) {
      console.log(JSON.stringify({ authenticated: false, server, reason: options.token ? "admin_token_rejected" : "browser_session_not_available_to_cli" }));
      return 1;
    }
    if (!response.ok) {
      console.log(JSON.stringify({ authenticated: false, server, status: response.status, error: body.error || "admin status request failed" }));
      return 1;
    }
    console.log(JSON.stringify({ authenticated: true, server, admin_id: body.admin_id || null }));
    return 0;
  } catch (error) {
    console.log(JSON.stringify({ authenticated: false, server, error: error.message }));
    return 1;
  }
}

function register(program) {
  const admin = program.command("admin").description("Open and inspect the minitok administrator console");
  admin.command("open").description("Open the administrator console; authentication stays in the browser").option("--no-open-browser").action(options => {
    const url = adminConsoleUrl();
    console.log(url);
    if (options.openBrowser !== false) openBrowser(url);
  });
  admin.command("status").description("Check administrator API status without reading browser cookies").option("--server <url>").option("--token-env <name>", "Read an explicitly supplied administrator bearer token from an environment variable").option("--json", "output JSON").action(async options => {
    const token = options.tokenEnv ? process.env[options.tokenEnv] : undefined;
    const code = await adminStatus({ ...options, token });
    process.exitCode = code;
  });
}

module.exports = { ADMIN_CONSOLE_URL, adminConsoleUrl, adminStatus, register };
