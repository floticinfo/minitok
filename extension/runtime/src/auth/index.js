"use strict";

/**
 * Unified Auth Module — resolves credentials for any provider.
 *
 * Supported auth types:
 *   - api_key:   Simple API key from config or environment
 *   - oauth:     Browser-based OAuth 2.0 (GitHub, Anthropic, Azure AD)
 *   - iam:       NOT SUPPORTED — rejected with a workaround pointer (SigV4
 *                cannot be computed without the request URL/body hash)
 *   - service_account: Google Cloud service account (ADC)
 *   - none:      No authentication needed (Ollama, local models)
 */

const { AuthError } = require("../core/errors");
const { TokenStore } = require("./token-store");
const { OAuthFlow } = require("./oauth");
const { ServiceAccountResolver } = require("./service-account");

const ALIAS_MAP = {
  claude: "anthropic",
  gpt: "openai",
  gemini: "google",
};

class AuthManager {
  constructor() {
    this._tokenStore = new TokenStore();
    this._oauth = new OAuthFlow();
    this._sa = new ServiceAccountResolver();
    this._iam = { resolve: async (_auth) => ({ headers: {}, token: null }) };
  }

  get tokenStore() { return this._tokenStore; }

  /**
   * Resolve credentials for a provider.
   * Returns { headers: {}, token: string | null }
   *
   * @param {string} providerName - Provider name (anthropic, openai, google, etc.)
   * @param {object} providerConfig - Full provider config from minitok.yml
   */
  async resolve(providerName, providerConfig) {
    const normalized = ALIAS_MAP[providerName.toLowerCase()] || providerName.toLowerCase();
    const auth = providerConfig.auth;

    // No auth block → legacy api_key fallback
    if (!auth) {
      return this._resolveLegacyApiKey(normalized, providerConfig);
    }

    switch (auth.type) {
      case "api_key":
        return this._resolveApiKey(auth, providerConfig);
      case "oauth":
        return this._resolveOAuth(normalized, auth);
      case "iam":
        // AWS SigV4 signing requires the request URL and body hash, which the
        // auth resolver never sees — a Credential-only header cannot
        // authenticate. Fail loudly instead of shipping a broken signer.
        throw new AuthError(
          "AWS IAM auth (SigV4) is not supported yet. " +
          "Access Bedrock-compatible endpoints via an OpenAI-compatible proxy " +
          "(base_url + api_key) instead."
        );
      case "service_account":
        return this._resolveServiceAccount(normalized, auth);
      case "none":
        return { headers: {}, token: null };
      default:
        throw new AuthError(`Unknown auth type: ${auth.type}`);
    }
  }

  /**
   * Check if a provider is available (has valid credentials).
   */
  async isAvailable(providerName, providerConfig) {
    try {
      const result = await this.resolve(providerName, providerConfig);
      return Boolean(result.token || Object.keys(result.headers).length > 0);
    } catch {
      return false;
    }
  }

  // ─── Legacy: api_key from config.api_key, config.api_key_env, or env ───
  _resolveLegacyApiKey(name, config) {
    // A provider may name the environment variable that holds its key. minitok.yml
    // and README documented `api_key_env` without the code ever reading it, so a
    // custom provider had no way to point at its vendor key.
    const namedEnv = typeof config.api_key_env === "string" && config.api_key_env.trim() ? config.api_key_env.trim() : "";
    // Only the supported providers have a conventional environment variable. Any
    // other endpoint is a custom provider and names its credential explicitly
    // (api_key, or api_key_env), so this map stays short instead of guessing an
    // environment variable for every vendor that exists.
    const envMap = {
      anthropic: "ANTHROPIC_API_KEY",
      openai: "OPENAI_API_KEY",
      google: "GOOGLE_API_KEY",
      gemini: "GEMINI_API_KEY",
    };
    const key = config.api_key || (namedEnv ? process.env[namedEnv] : "") || process.env[envMap[name]] || "";
    if (!key) return { headers: {}, token: null };
    return { headers: { "x-api-key": key }, token: key };
  }

  // ─── Auth type: api_key ───
  _resolveApiKey(auth, config) {
    let key = auth.key || "";
    // Resolve ${ENV_VAR} references in key value
    if (typeof key === "string" && key.startsWith("${") && key.endsWith("}")) {
      const envName = key.slice(2, -1);
      key = process.env[envName] || "";
    }
    if (!key) return { headers: {}, token: null };
    const scheme = auth.scheme || "x-api-key";
    const header = auth.header || (scheme === "Bearer" ? "Authorization" : "x-api-key");
    return { headers: { [header]: scheme === "raw" || scheme === "x-api-key" ? key : `${scheme} ${key}` }, token: key };
  }

  // ─── Auth type: oauth ───
  async _resolveOAuth(name, auth) {
    // Check stored token first
    if (this._tokenStore.isValid(name)) {
      const stored = this._tokenStore.load(name);
      return { headers: { Authorization: `Bearer ${stored.access_token}` }, token: stored.access_token };
    }

    // Try refresh token if available
    const stored = this._tokenStore.load(name);
    if (stored && stored.refresh_token) {
      try {
        const refreshed = await this._oauth.refreshToken(name, stored.refresh_token, auth);
        this._tokenStore.save(name, refreshed);
        return { headers: { Authorization: `Bearer ${refreshed.access_token}` }, token: refreshed.access_token };
      } catch {
        // Refresh failed, need full re-auth
      }
    }

    // Full OAuth flow
    const tokens = await this._oauth.authorize(name, auth);
    this._tokenStore.save(name, tokens);
    return { headers: { Authorization: `Bearer ${tokens.access_token}` }, token: tokens.access_token };
  }

  // ─── Auth type: iam ───
  async _resolveIAM(name, auth) {
    const creds = await this._iam.resolve(auth);
    return { headers: creds.headers, token: creds.token || null };
  }

  // ─── Auth type: service_account ───
  async _resolveServiceAccount(name, auth) {
    const creds = await this._sa.resolve(auth);
    return { headers: creds.headers, token: creds.token || null };
  }
}

// Singleton
const authManager = new AuthManager();

module.exports = { AuthManager, authManager, ALIAS_MAP };

