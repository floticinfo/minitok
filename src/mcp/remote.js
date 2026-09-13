"use strict";

const { fetchWithTimeout } = require("../core/http");
const { loadCustomerToken } = require("../auth/customer-token");
const { OAuthFlow } = require("../auth/oauth");
const { TokenStore } = require("../auth/token-store");
const TRUSTED_MCP_AUTH_HOSTS = new Set(["api.minitok.dev"]);
const REMOTE_MCP_TOOLS = Object.freeze(new Set(["minitok_status", "minitok_compact"]));

const MCP_PROTOCOL_VERSION = "2024-11-05";
const REMOTE_PATH = "/mcp";
const REMOTE_READ_ONLY_TOOLS = REMOTE_MCP_TOOLS;
const LOCAL_ONLY_TOOLS = Object.freeze(new Set([
  "minitok_run",
  "minitok_run_cancel",
  "minitok_approve_run",
  "minitok_reject_run",
  "minitok_collect_evidence",
  "minitok_observe",
  "minitok_knowledge_record",
]));

function validateRemoteUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw Object.assign(new Error("Remote MCP URL must be a valid HTTPS URL"), { code: "INVALID_REMOTE_URL" }); }
  if (url.protocol !== "https:") throw Object.assign(new Error("Remote MCP URL must use HTTPS"), { code: "INVALID_REMOTE_URL" });
  if (url.username || url.password) throw Object.assign(new Error("Remote MCP URL must not contain credentials"), { code: "INVALID_REMOTE_URL" });
  url.pathname = url.pathname.replace(/\/$/, "") || REMOTE_PATH;
  if (url.pathname !== REMOTE_PATH) throw Object.assign(new Error("Remote MCP URL must target /mcp"), { code: "INVALID_REMOTE_URL" });
  url.search = "";
  url.hash = "";
  return url.toString();
}

function classifyRemoteError(error) {
  if (error?.classification) return error.classification;
  if (error?.code === "INVALID_REMOTE_URL") return "configuration";
  if (error?.status >= 500) return "server";
  if (error?.status >= 400) {
    if (error.status === 429) return "rate_limit";
    return error.status === 401 || error.status === 403 ? "auth" : "protocol";
  }
  return "network";
}

function remoteError(message, classification, details = {}) {
  return Object.assign(new Error(message), { code: "REMOTE_MCP_ERROR", classification, ...details });
}

class RemoteMcpClient {
  constructor(options = {}) {
    this.url = validateRemoteUrl(options.url);
    this.token = options.token || loadCustomerToken(options.tokenFile);
    this.accountOptions = options.accountOptions || {};
    this.allowOAuth = options.allowOAuth !== false;
    this.clientId = options.clientId || "minitok-cli";
    this.tokenStore = options.tokenStore || new TokenStore(options.tokensDir);
    this.resourceKey = `mcp-${new URL(this.url).host}`;
    this._cachedTokenExpired = false;
    if (!this.token) {
      const stored = this.tokenStore.load(this.resourceKey);
      // TokenStore.isValid() existed but was never consulted here, and the 401
      // handler below only re-authorized when no token was present at all, so an
      // expired cached token blocked OAuth refresh permanently.
      this._cachedTokenExpired = Boolean(stored?.access_token) && !this.tokenStore.isValid(this.resourceKey);
      if (stored?.access_token && !this._cachedTokenExpired) this.token = stored.access_token;
    }
    this.timeoutMs = options.timeoutMs || 10000;
    this.sessionId = null;
    this.nextId = 1;
  }

  async request(method, params = {}, retried = false) {
    const id = this.nextId++;
    const headers = { Accept: "application/json", ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}) };
    if (this.sessionId) headers["Mcp-Session-Id"] = this.sessionId;
    let response;
    try {
      response = await fetchWithTimeout(this.url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) }, this.timeoutMs);
    } catch (error) {
      throw remoteError("Remote MCP network request failed", "network", { cause: error });
    }
    const session = response.headers.get("mcp-session-id");
    if (session) this.sessionId = session;
    let body;
    try { body = await response.json(); } catch { throw remoteError("Remote MCP returned invalid JSON", response.status >= 500 ? "server" : "protocol", { status: response.status }); }
    if (response.status >= 500) {
      const errorType = body?.error?.data?.type;
      const classification = ["RATE_LIMITED", "RATE_LIMIT_DEGRADED"].includes(errorType) ? "rate_limit" : "server";
      throw remoteError("Remote MCP server failure", classification, { status: response.status, body, errorType: errorType || null });
    }
    if (response.status >= 400) {
      const errorType = body?.error?.data?.type;
      const challenge = response.headers.get("www-authenticate") || "";
      const metadataMatch = challenge.match(/resource_metadata="([^"]+)"/);
      if (response.status === 401 && this.allowOAuth && !retried && metadataMatch && (!this.token || this._cachedTokenExpired)) {
        // Discard the unusable credential first: `retried` bounds the loop, and
        // without this the client kept presenting the same expired token.
        try { this.tokenStore.remove(this.resourceKey); } catch {}
        this._cachedTokenExpired = false;
        await this.authorizeFromMetadata(metadataMatch[1]);
        return this.request(method, params, true);
      }
      const classification = ["SESSION_REQUIRED", "SESSION_BINDING_MISMATCH"].includes(errorType) ? errorType : ["RATE_LIMITED", "RATE_LIMIT_DEGRADED"].includes(errorType) || response.status === 429 ? "rate_limit" : response.status === 401 || response.status === 403 ? "auth" : "protocol";
      throw remoteError(response.status === 401 || response.status === 403 ? "Remote MCP authentication or entitlement failed" : response.status === 429 ? "Remote MCP rate limit exceeded" : "Remote MCP HTTP protocol failure", classification, { status: response.status, body, errorType: errorType || null });
    }
    const result = Array.isArray(body) ? body.find(item => item?.id === id) : body;
    if (result?.error) throw remoteError(result.error.message || "Remote MCP protocol error", ["SESSION_REQUIRED", "SESSION_BINDING_MISMATCH"].includes(result.error.data?.type) ? result.error.data.type : ["RATE_LIMITED", "RATE_LIMIT_DEGRADED"].includes(result.error.data?.type) ? "rate_limit" : result.error.data?.type === "ENTITLEMENT_REQUIRED" ? "auth" : "protocol", { status: response.status, rpcError: result.error });
    if (!result || result.id !== id) throw remoteError("Remote MCP response did not match request", "protocol", { status: response.status });
    return result.result;
  }

  async authorizeFromMetadata(metadataUrl) {
    let metadata;
    try {
      const response = await fetchWithTimeout(metadataUrl, { headers: { Accept: "application/json" } }, this.timeoutMs);
      metadata = await response.json();
      if (!response.ok || !metadata?.authorization_servers?.[0]) throw new Error("Protected-resource metadata is invalid");
      const serverUrl = new URL(metadata.authorization_servers[0]);
      const resourceUrl = new URL(this.url);
      if (serverUrl.protocol !== "https:" || (serverUrl.hostname !== resourceUrl.hostname && !TRUSTED_MCP_AUTH_HOSTS.has(serverUrl.hostname))) throw remoteError("Remote MCP authorization server is not trusted", "auth", { code: "REMOTE_OAUTH_UNTRUSTED_AUTHORITY" });
      const serverMetadataUrl = serverUrl.pathname.includes('/.well-known/') ? serverUrl.toString() : `${serverUrl.toString().replace(/\/$/, "")}/.well-known/oauth-authorization-server`;
      const serverResponse = await fetchWithTimeout(serverMetadataUrl, { headers: { Accept: "application/json" } }, this.timeoutMs);
      const serverMetadata = await serverResponse.json();
      if (!serverResponse.ok || !serverMetadata.authorization_endpoint || !serverMetadata.token_endpoint) throw new Error("Authorization-server metadata is invalid");
      const token = await new OAuthFlow({ openBrowser: this.accountOptions.openBrowser, port: this.accountOptions.port }).authorize("mcp", { authorize_url: serverMetadata.authorization_endpoint, token_url: serverMetadata.token_endpoint, client_id: this.clientId, scope: metadata.scopes_supported?.[0] || "read" });
      this.token = token.access_token;
      this.tokenStore.save(this.resourceKey, { resource: this.url, ...token, expires_at: token.expires_at || new Date(Date.now() + 2592000000).toISOString() });
      return this.token;
    } catch (error) {
      if (error?.code === "REMOTE_MCP_ERROR" || error?.code === "REMOTE_OAUTH_UNTRUSTED_AUTHORITY") throw error;
      throw remoteError("Remote MCP OAuth discovery failed", "auth", { code: "REMOTE_OAUTH_DISCOVERY_FAILED", cause: error });
    }
  }

  async handshake() {
    const initialize = await this.request("initialize", { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "minitok-remote-client", version: "1" } });
    const listed = await this.request("tools/list");
    const tools = Array.isArray(listed?.tools) ? listed.tools : [];
    return { protocolVersion: initialize?.protocolVersion, sessionId: this.sessionId, tools: tools.filter(tool => REMOTE_READ_ONLY_TOOLS.has(tool.name)) };
  }

  async listTools() { return ((await this.request("tools/list"))?.tools || []).filter(tool => REMOTE_READ_ONLY_TOOLS.has(tool.name)); }

  async callTool(name, argumentsValue = {}) {
    if (LOCAL_ONLY_TOOLS.has(name) || !REMOTE_READ_ONLY_TOOLS.has(name)) throw remoteError(`Remote MCP tool is not supported: ${name}`, "configuration", { code: "REMOTE_TOOL_UNSUPPORTED" });
    return this.request("tools/call", { name, arguments: argumentsValue });
  }
}

async function remoteHealth(options) {
  const client = new RemoteMcpClient(options);
  return client.handshake();
}

function canFallbackToLocal(error) { return ["network", "server"].includes(classifyRemoteError(error)); }

async function executeRemoteWithLocalFallback({ remote, local, allowFallback = false }) {
  if (typeof remote !== "function" || typeof local !== "function") throw remoteError("Remote and local MCP operations are required", "configuration", { code: "REMOTE_OPERATION_CONFIGURATION" });
  try {
    return { source: "remote", result: await remote() };
  } catch (error) {
    if (!allowFallback || !canFallbackToLocal(error)) throw error;
    return { source: "local", result: await local() };
  }
}

module.exports = { RemoteMcpClient, remoteHealth, validateRemoteUrl, classifyRemoteError, canFallbackToLocal, executeRemoteWithLocalFallback, REMOTE_READ_ONLY_TOOLS, LOCAL_ONLY_TOOLS, REMOTE_PATH };
