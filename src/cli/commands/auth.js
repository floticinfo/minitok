"use strict";

const { TokenStore } = require("../../auth/token-store");
const { OAuthFlow, OAUTH_CONFIGS } = require("../../auth/oauth");
const { ALIAS_MAP, normalizeProvider } = require("../../auth/aliases");
const { saveCustomerToken, saveCustomerSession, loadCustomerSession, removeCustomerToken, revokeCustomerSession } = require("../../auth/customer-token");
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
  const token = result.body?.token || result.body?.access_token || result.body?.accessToken;
  if (!result.ok || !token) { console.error(`[error] Customer login failed: ${result.body?.error || "request failed"}`); return 1; }
  if (result.body?.refresh_token || result.body?.refreshToken) { removeCustomerToken(); saveCustomerSession(result.body); }
  else saveCustomerToken(token);
  console.log("[ok] Customer login successful. Token stored securely.");
  return 0;
}

function customerAuthRequest(endpoint, body, server) { return postJson(resolveServerUrl({ cliServer: server }) + endpoint, body, 30000); }

async function cmdAuthLogin(provider) {
  if (!provider) { console.error("Usage: minitok auth login <provider>"); console.error("  Providers: anthropic, openai, google — aliases claude, gpt, gemini are accepted (any other endpoint: configure a custom provider)"); return 1; }
  // Stored under the canonical name: the resolver normalises aliases before it
  // reads, so keying by the raw argument made `auth login gpt` unreachable.
  const name = normalizeProvider(provider);
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
  for (const t of tokens) {
    const status = t.valid ? "valid" : "expired";
    const refresh = t.has_refresh ? " (has refresh token)" : "";
    const expiry = t.expires_at ? "  expires: " + t.expires_at : "";
    // A credential saved before aliases were normalised is keyed by the alias
    // (gpt.json) and still resolves through the token store's fallback, but the
    // canonical name is what the CLI and the resolver use from now on.
    const legacy = ALIAS_MAP[t.provider] ? `  [alias of ${ALIAS_MAP[t.provider]} — re-run: minitok auth login ${ALIAS_MAP[t.provider]}]` : "";
    console.log("  " + t.provider.padEnd(16) + status + refresh + expiry + legacy);
  }
  console.log("\nRun: minitok auth login <provider>  to add/update credentials");
  return 0;
}

async function cmdAuthLogout(provider) {
  if (!provider) { console.error("Usage: minitok auth logout <provider>"); return 1; }
  const name = normalizeProvider(provider); tokenStore.remove(name); afterCredentialChange(); console.log("Logged out from " + name + "."); return 0;
}

async function customerLogout(server) {
  const session = loadCustomerSession();
  let remoteRevoked = false;
  if (session?.refresh_token) {
    try {
      const result = await postJson(resolveServerUrl({ cliServer: server }) + "/v1/auth/logout", { refresh_token: session.refresh_token }, 10000);
      remoteRevoked = result.status === 204 || result.ok === true;
    } catch {}
  }
  removeCustomerToken();
  // Leave an explicit local tombstone so an Extension or CLI process cannot
  // resurrect the previous SecretStorage/shared session after local logout.
  revokeCustomerSession();
  if (remoteRevoked) console.log("Remote customer session revoked; local credentials removed.");
  else console.log("Remote logout unavailable; local credentials removed. Sign in again to revoke the server session.");
  return remoteRevoked;
}

function addCustomerLogin(command, description) {
  const login = command.command("customer-login").description(description).argument("[email]", "Customer email").option("--email-env <name>", "Read customer email from an environment variable").option("--password-env <name>", "Read customer password from an environment variable").option("--server <url>", "minitok server URL");
  login.action(async (email, options) => { const resolvedEmail = email || (options.emailEnv && process.env[options.emailEnv]); if (!options.passwordEnv && !process.stdin.isTTY) { console.error("Customer password is required via --password-env in non-interactive mode."); process.exit(1); } const value = options.passwordEnv ? process.env[options.passwordEnv] : await prompt("Customer password: "); process.exit(await cmdAuthCustomerLogin(options.server, resolvedEmail, value)); });
  command.command("customer-logout").description("Revoke the server session and remove local customer credentials").option("--server <url>", "minitok server URL").action(async options => { await customerLogout(options.server); });
}

function register(program) {
  const authCmd = program.command("auth").description("Manage provider and customer authentication");
  authCmd.command("login").description("Log in to an LLM provider (OAuth or API key)").argument("<provider>", "Provider name (anthropic, openai, google; aliases claude, gpt, gemini accepted)").action(async provider => { process.exit(await cmdAuthLogin(provider)); });
  addCustomerLogin(authCmd, "Log in to the minitok customer account for billing commands");
  authCmd.command("status").description("Show stored credentials and their validity").action(async () => { process.exit(await cmdAuthStatus()); });
  authCmd.command("logout").description("Remove stored credentials for a provider").argument("<provider>", "Provider name").action(async provider => { process.exit(await cmdAuthLogout(provider)); });
}

module.exports = { cmdAuthLogin, cmdAuthCustomerLogin, cmdAuthStatus, cmdAuthLogout, register };
