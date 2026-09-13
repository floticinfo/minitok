"use strict";

/**
 * OAuth 2.0 Flow with PKCE support.
 * Handles browser-based authorization for the Anthropic OAuth login flow.
 * OpenAI and Google use API keys, and any other endpoint is reached through a
 * custom provider, so those flows are not part of the shipped provider list.
 */

const http = require("http");
const crypto = require("crypto");
const { URL } = require("url");
const { AuthError } = require("../core/errors");
const { fetchWithTimeout, readCappedResponse } = require("../core/http");

/** @type {Record<string, object>} */
const OAUTH_CONFIGS = {
  anthropic: {
    name: "Anthropic",
    authorize_url: "https://console.anthropic.com/oauth/authorize",
    token_url: "https://console.anthropic.com/oauth/token",
    scope: "user:inference",
    client_id: process.env.ANTHROPIC_CLIENT_ID || "",
    client_secret: process.env.ANTHROPIC_CLIENT_SECRET || "",
  },
};

const DEFAULT_PORT = 9876;
const CALLBACK_PATH = "/oauth/callback";
const TOKEN_LIFETIME_MS = 3600 * 1000;
const TOKEN_TIMEOUT_MS = 15000;
const MAX_TOKEN_RESPONSE_BYTES = 1024 * 1024;

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
}

async function readResponseJson(res) {
  let text;
  try { text = await readCappedResponse(res, MAX_TOKEN_RESPONSE_BYTES); } catch (error) {
    if (error.message === "HTTP response body too large") throw new AuthError("Token response is too large");
    throw error;
  }
  try { return JSON.parse(text); } catch { throw new AuthError("Token response was not valid JSON"); }
}

class OAuthFlow {
  /**
   * @param {object} [opts]
   * @param {number} [opts.port] - Local callback server port
   * @param {boolean} [opts.openBrowser] - Auto-open browser (default true)
   */
  constructor(opts = {}) {
    this._port = opts.port || DEFAULT_PORT;
    // Only auto-launch a browser in an interactive terminal. In CI, a service, or
    // an SSH session without a display the launch either fails silently or starts
    // a browser nobody can see, while the flow still blocks until the callback
    // times out. The URL is always printed, so a remote user can open it by hand.
    this._openBrowser = opts.openBrowser === true ? true : opts.openBrowser === false ? false : Boolean(process.stdin.isTTY && process.stdout.isTTY);
  }

  /**
   * Run full OAuth 2.0 authorization code flow with PKCE.
   * @param {string} provider - OAuth provider key (anthropic)
   * @param {object} [authConfig] - Override auth config (client_id, tenant_id, etc.)
   * @returns {Promise<object>} Token data with access_token, refresh_token, expires_at
   */
  async authorize(provider, authConfig = {}) {
    const config = provider === "mcp" ? this._getMcpConfig(authConfig) : this._getConfig(provider, authConfig);
    const { codeVerifier, codeChallenge } = this._generatePKCE();
    const state = crypto.randomBytes(16).toString("hex");

    const authUrl = this._buildAuthUrl(config, codeChallenge, state);
    if (this._openBrowser) this._openBrowserUrl(authUrl);
    else console.log("\nNo interactive terminal detected; open the authorization URL below on any device.\n");

    console.log("\n\ud83d\udd10 Opening browser for " + config.name + " authorization...");
    console.log("   If the browser didn't open, visit:\n   " + authUrl + "\n");

    const { code, returnedState } = await this._startCallbackServer(
      this._port,
      state
    );

    if (returnedState !== state) {
      throw new AuthError("OAuth state mismatch \u2014 possible CSRF attack");
    }

    return this._exchangeCode(config, code, codeVerifier);
  }

  /**
   * Refresh an existing OAuth token.
   * @param {string} provider
   * @param {string} refreshToken
   * @param {object} [authConfig]
   * @returns {Promise<object>}
   */
  async refreshToken(provider, refreshToken, authConfig = {}) {
    const config = provider === "mcp" ? this._getMcpConfig(authConfig) : this._getConfig(provider, authConfig);
    const params = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: config.client_id,
      client_secret: config.client_secret,
    });

    const res = await fetchWithTimeout(config.token_url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: params.toString(),
    }, TOKEN_TIMEOUT_MS);

    if (!res.ok) {
      throw new AuthError("Token refresh failed (" + res.status + ")");
    }

    const data = await readResponseJson(res);
    if (!data || typeof data !== "object" || typeof data.access_token !== "string" || !data.access_token) throw new AuthError("Token response missing access_token");
    return {
      access_token: data.access_token,
      refresh_token: data.refresh_token || refreshToken,
      expires_at: data.expires_in
        ? new Date(Date.now() + data.expires_in * 1000).toISOString()
        : new Date(Date.now() + TOKEN_LIFETIME_MS).toISOString(),
      token_type: data.token_type || "Bearer",
    };
  }

  /**
   * Get provider config, merging overrides.
   * @param {object} overrides
   * @returns {object}
   */
  _getMcpConfig(overrides = {}) {
    const config = { name: "minitok MCP", client_id: "minitok-cli", client_secret: "", scope: "read", ...overrides };
    if (!config.authorize_url || !config.token_url || !config.client_id) throw new AuthError("Incomplete MCP OAuth metadata");
    return config;
  }

  _getConfig(provider, overrides = {}) {
    const base = OAUTH_CONFIGS[provider];
    if (!base) {
      throw new AuthError("Unknown OAuth provider: " + provider);
    }
    const config = { ...base, ...overrides };
    if (!config.client_id) {
      throw new AuthError(
        "No client_id for " + config.name + ". Set env or auth config."
      );
    }
    return config;
  }

  /**
   * Generate PKCE code verifier and S256 challenge.
   * @returns {{ codeVerifier: string, codeChallenge: string }}
   */
  _generatePKCE() {
    const codeVerifier = crypto.randomBytes(32).toString("base64url");
    const codeChallenge = crypto
      .createHash("sha256")
      .update(codeVerifier)
      .digest("base64url");
    return { codeVerifier, codeChallenge };
  }

  /**
   * Build the full authorization URL.
   * @param {object} config
   * @param {string} codeChallenge
   * @param {string} state
   * @returns {string}
   */
  _buildAuthUrl(config, codeChallenge, state) {
    const url = new URL(config.authorize_url);
    url.searchParams.set("client_id", config.client_id);
    url.searchParams.set("scope", config.scope);
    url.searchParams.set(
      "redirect_uri",
      "http://localhost:" + this._port + CALLBACK_PATH
    );
    url.searchParams.set("response_type", "code");
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    return url.toString();
  }

  /**
   * Attempt to open URL in default browser.
   * @param {string} url
   */
  _openBrowserUrl(url) {
    const { spawn } = require("child_process");
    const command = process.platform === "win32" ? "rundll32.exe" : process.platform === "darwin" ? "open" : "xdg-open";
    const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
    try {
      const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
      child.unref();
    } catch {}
  }

  /**
   * Start local HTTP server to receive the OAuth callback.
   * @param {number} port
   * @param {string} expectedState
   * @returns {Promise<{ code: string, returnedState: string }>}
   */
  _startCallbackServer(port, expectedState) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        server.close();
        reject(new AuthError("OAuth callback timed out (5 minutes)"));
      }, 5 * 60 * 1000);

      const server = http.createServer((req, res) => {
        const url = new URL(req.url, "http://localhost:" + port);

        if (url.pathname !== CALLBACK_PATH) {
          res.writeHead(404);
          res.end("Not found");
          return;
        }

        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        const error = url.searchParams.get("error");

        if (error) {
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end("<h2>Authorization failed</h2><p>" + escapeHtml(error) + "</p>");
          clearTimeout(timeout);
          server.close();
          reject(new AuthError("OAuth error: " + error));
          return;
        }

        if (state !== expectedState) {
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end("<h2>Authorization failed</h2>");
          clearTimeout(timeout);
          server.close();
          reject(new AuthError("OAuth state mismatch — possible CSRF attack"));
          return;
        }

        if (!code) {
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end("<h2>Missing authorization code</h2>");
          clearTimeout(timeout);
          server.close();
          reject(new AuthError("No authorization code received"));
          return;
        }

        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(
          "<h2>Authorization successful!</h2>" +
            "<p>You can close this tab and return to the terminal.</p>"
        );
        clearTimeout(timeout);
        server.close();
        resolve({ code, returnedState: state || "" });
      });

      server.listen(port, "127.0.0.1", () => {
        console.log(
          "   Listening on http://localhost:" + port + " for callback..."
        );
      });

      server.on("error", (err) => {
        clearTimeout(timeout);
        reject(new AuthError("Callback server error: " + err.message));
      });
    });
  }

  /**
   * Exchange authorization code for tokens.
   * @param {object} config
   * @param {string} code
   * @param {string} codeVerifier
   * @returns {Promise<object>}
   */
  async _exchangeCode(config, code, codeVerifier) {
    const params = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: "http://localhost:" + this._port + CALLBACK_PATH,
      client_id: config.client_id,
      client_secret: config.client_secret,
      code_verifier: codeVerifier,
    });

    const res = await fetchWithTimeout(config.token_url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: params.toString(),
    }, TOKEN_TIMEOUT_MS);

    if (!res.ok) {
      throw new AuthError("Token exchange failed (" + res.status + ")");
    }

    const data = await readResponseJson(res);
    if (!data || typeof data !== "object" || typeof data.access_token !== "string" || !data.access_token) {
      throw new AuthError("Token response missing access_token");
    }

    return {
      access_token: data.access_token,
      refresh_token: data.refresh_token || null,
      expires_at: data.expires_in
        ? new Date(Date.now() + data.expires_in * 1000).toISOString()
        : new Date(Date.now() + TOKEN_LIFETIME_MS).toISOString(),
      token_type: data.token_type || "Bearer",
    };
  }
}

module.exports = { OAuthFlow, OAUTH_CONFIGS };
