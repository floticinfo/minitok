"use strict";

const { TokenStore } = require("../../auth/token-store");
const { OAuthFlow, OAUTH_CONFIGS } = require("../../auth/oauth");
const { saveCustomerToken } = require("../../auth/customer-token");
const { resetVerifyCache } = require("../../llm/provider");
const { resolveServerUrl } = require("./server-config");
const readline = require("readline");
const { postJson } = require("../../core/http");

const tokenStore = new TokenStore();

/**
 * Drop the cached provider-verification verdict.
 *
 * `verifyCredentials` caches per credential, but an embedded host (the MCP
 * runtime or any long-lived process) can still hold a verdict resolved before
 * this credential change, so invalidate explicitly after a login or logout.
 */
function afterCredentialChange() {
  resetVerifyCache();
}

function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  return new Promise(resolve => { rl.question(question, answer => { rl.close(); resolve(answer.trim()); }); });
}

async function cmdAuthCustomerLogin(server, email, password) {
  if (!email || !password) { console.error("Usage: minitok auth customer-login <email>"); return 1; }
  const result = await customerAuthRequest("/v1/auth/login", { email, password }, server);
  if (!result.ok || !result.body?.token) { console.error(`[error] Customer login failed: ${result.body?.error || "request failed"}`); return 1; }
  saveCustomerToken(result.body.token);
  console.log("[ok] Customer login successful. Token stored securely.");
  return 0;
}

function customerAuthRequest(endpoint, body, server) { return postJson(resolveServerUrl({ cliServer: server }) + endpoint, body, 30000); }

async function cmdAuthLogin(provider) {
  if (!provider) { console.error("Usage: minitok auth login <provider>"); console.error("  Providers: anthropic, openai, google (any other endpoint: configure a custom provider)"); return 1; }
  const name = provider.toLowerCase();
  if (OAUTH_CONFIGS[name]) {
    const oauthConfig = OAUTH_CONFIGS[name];
    if (!oauthConfig.client_id) { console.log("\nOAuth not available: " + oauthConfig.name + " client_id not configured."); console.log("   You can:"); console.log("   1. Set the client ID via environment variable:"); const envVar = name.toUpperCase().replace("-", "_") + "_CLIENT_ID"; console.log("      export " + envVar + "=your_client_id"); console.log("   2. Use API key authentication instead:"); console.log("      minitok auth login " + name + " (API key mode)"); console.log("\nAPI Key fallback:"); return await cmdApiKeyLogin(name); }
    try { const oauth = new OAuthFlow(); const tokens = await oauth.authorize(name); tokenStore.save(name, tokens); afterCredentialChange(); console.log("\nLogged in to " + name + " successfully."); return 0; } catch (e) { console.error("\nOAuth login failed: " + e.message); console.error("\nFalling back to API key authentication..."); return await cmdApiKeyLogin(name); }
  }
  return await cmdApiKeyLogin(name);
}

async function cmdApiKeyLogin(name) {
  const key = await prompt("Enter API key for " + name + ": ");
  if (!key) { console.error("No key entered. Aborting."); return 1; }
  tokenStore.save(name, { access_token: key, token_type: "api_key" });
  afterCredentialChange();
  console.log("\nAPI key saved for " + name + ".");
  return 0;
}

async function cmdAuthStatus() {
  const tokens = tokenStore.list();
  if (tokens.length === 0) { console.log("No stored credentials."); console.log("\nRun: minitok auth login <provider>"); return 0; }
  console.log("Stored credentials:\n");
  for (const t of tokens) { const status = t.valid ? "valid" : "expired"; const refresh = t.has_refresh ? " (has refresh token)" : ""; const expiry = t.expires_at ? "  expires: " + t.expires_at : ""; console.log("  " + t.provider.padEnd(16) + status + refresh + expiry); }
  console.log("\nRun: minitok auth login <provider>  to add/update credentials");
  return 0;
}

async function cmdAuthLogout(provider) {
  if (!provider) { console.error("Usage: minitok auth logout <provider>"); return 1; }
  const name = provider.toLowerCase(); tokenStore.remove(name); afterCredentialChange(); console.log("Logged out from " + name + "."); return 0;
}

function addCustomerLogin(command, description) {
  const login = command.command("customer-login").description(description).argument("[email]", "Customer email").option("--email-env <name>", "Read customer email from an environment variable").option("--password-env <name>", "Read customer password from an environment variable").option("--server <url>", "minitok server URL");
  login.action(async (email, options) => { const resolvedEmail = email || (options.emailEnv && process.env[options.emailEnv]); const value = options.passwordEnv ? process.env[options.passwordEnv] : await prompt("Customer password: "); process.exit(await cmdAuthCustomerLogin(options.server, resolvedEmail, value)); });
}

function register(program) {
  const authCmd = program.command("auth").description("Manage provider and customer authentication");
  authCmd.command("login").description("Log in to an LLM provider (OAuth or API key)").argument("<provider>", "Provider name (anthropic, openai, google)").action(async provider => { process.exit(await cmdAuthLogin(provider)); });
  addCustomerLogin(authCmd, "Log in to the minitok customer account for billing commands");
  authCmd.command("status").description("Show stored credentials and their validity").action(async () => { process.exit(await cmdAuthStatus()); });
  authCmd.command("logout").description("Remove stored credentials for a provider").argument("<provider>", "Provider name").action(async provider => { process.exit(await cmdAuthLogout(provider)); });
}

module.exports = { cmdAuthLogin, cmdAuthCustomerLogin, cmdAuthStatus, cmdAuthLogout, register };
