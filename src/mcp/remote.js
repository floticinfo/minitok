"use strict";

const { fetchWithTimeout } = require("../core/http");
const { loadCustomerToken } = require("../auth/customer-token");
const { OAuthFlow } = require("../auth/oauth");
const { TokenStore } = require("../auth/token-store");
const { capabilityPermissions, safeRecord, FULL_TEST_PROFILE } = require("../entitlement/capability");
const { postJson } = require("../core/http");
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

function remoteCapabilityPreflight(options = {}, toolName = null) {
  const capabilityFile = options.capabilityFile || process.env.MINITOK_CAPABILITY_FILE;
  const configured = Boolean(capabilityFile || options.capabilityToken || options.capabilityRecord);
  const capability = options.capabilityRecord ? { record: options.capabilityRecord } : capabilityPermissions({ filePath: capabilityFile });
  if (!configured) return { configured: false, policy_decision: "legacy_auth" };
  const record = capability.record;
  const valid = Boolean(record && safeRecord(record) && record.profile === FULL_TEST_PROFILE && Array.isArray(record.capabilities) && (!options.installationId || record.installation_id === options.installationId));
  const granted = valid ? [...new Set(record.capabilities)] : [];
  const requested = toolName ? [toolName === "minitok_status" || toolName === "minitok_compact" ? "read" : "remote_tool_call"] : ["read"];
  const denied = valid && granted.includes("read") ? [] : requested;
  const result = { configured: true, token_valid: valid, profile: record?.profile || null, installation_id: record?.installation_id || null, expires_at: record?.expires_at || null, granted_capabilities: granted, denied_capabilities: denied, approval_required_capabilities: [], always_blocked_capabilities: [], blocked_external_operations: ["credential_use", "external_call", "publish", "deploy"], policy_decision: denied.length ? "denied" : "allowed" };
  if (!valid) result.reason = "Remote capability record is missing, expired, revoked, or not server-validated";
  return result;
}

async function validateRemoteCapability(options = {}) {
  if (typeof options.validateCapability === "function") return options.validateCapability();
  if (!options.capabilityToken || !options.capabilityServerUrl) return null;
  const serverUrl = String(options.capabilityServerUrl).replace(/\/$/, "");
  const response = await (options.postJson || postJson)(`${serverUrl}/v1/capability/validate`, { token: options.capabilityToken, installation_id: options.installationId, subscription_id: options.subscriptionId });
  return response?.ok && response.body?.valid === true ? response.body : null;
}

class RemoteMcpClient {
  constructor(options = {}) {
    this.url = validateRemoteUrl(options.url);
    this.token = options.token || loadCustomerToken(options.tokenFile);
    this.accountOptions = options.accountOptions || {};
    this.allowOAuth = options.allowOAuth !== false;
    this._capabilityOptions = { ...options };
    this.capabilityPreflight = remoteCapabilityPreflight(options);
    this.clientId = options.clientId || "minitok-cli";
    this.tokenStore = options.tokenStore || new TokenStore(options.tokensDir);
    this.resourceKey = `mcp-${new URL(this.url).host}`;
    if (!this.token) {
      const stored = this.tokenStore.load(this.resourceKey);
      // TokenStore.isValid() existed but was never consulted here, and the 401
      // handler below only re-authorized when no token was present at all, so an
      // expired cached token blocked OAuth refresh permanently.
      if (stored?.access_token && !this.tokenStore.isValid(this.resourceKey)) {
        // Eagerly remove the unusable token so the 401 handler doesn't need to
        // do it redundantly and the store stays clean for future requests.
        try { this.tokenStore.remove(this.resourceKey); } catch {}
      } else if (stored?.access_token) {
        this.token = stored.access_token;
      }
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
      if (response.status === 401 && this.allowOAuth && !retried && metadataMatch && errorType !== "ENTITLEMENT_REQUIRED") {
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
    /** @type {{ capabilityToken?: string; capabilityServerUrl?: string; installationId?: string; subscriptionId?: string; validateCapability?: () => Promise<any> }} */
    const capabilityOptions = this._capabilityOptions;
    if (capabilityOptions.capabilityToken) {
      const validated = await validateRemoteCapability(capabilityOptions);
      if (!validated) throw remoteError("Remote capability validation failed", "auth", { code: "REMOTE_CAPABILITY_REQUIRED", capability_preflight: this.capabilityPreflight });
      const claims = validated.claims || {};
      const validatedRecord = { token: capabilityOptions.capabilityToken, profile: validated.profile, installation_id: claims.installation_id, capabilities: claims.capabilities, validated_at: new Date().toISOString(), expires_at: new Date(Number(claims.exp) * 1000).toISOString() };
      this.capabilityPreflight = remoteCapabilityPreflight({ ...capabilityOptions, capabilityRecord: validatedRecord }, "minitok_status");
      if (!this.capabilityPreflight.token_valid) throw remoteError("Remote capability validation failed", "auth", { code: "REMOTE_CAPABILITY_REQUIRED", capability_preflight: this.capabilityPreflight });
    } else if (this.capabilityPreflight.configured && !this.capabilityPreflight.token_valid) {
      throw remoteError("Remote capability validation failed", "auth", { code: "REMOTE_CAPABILITY_REQUIRED", capability_preflight: this.capabilityPreflight });
    }
    const initialize = await this.request("initialize", { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "minitok-remote-client", version: "1" } });
    const listed = await this.request("tools/list");
    const tools = Array.isArray(listed?.tools) ? listed.tools : [];
    return { protocolVersion: initialize?.protocolVersion, sessionId: this.sessionId, tools: tools.filter(tool => REMOTE_READ_ONLY_TOOLS.has(tool.name)), capability_preflight: this.capabilityPreflight };
  }

  async listTools() { if (this.capabilityPreflight.configured && !this.capabilityPreflight.token_valid) throw remoteError("Remote capability validation failed", "auth", { code: "REMOTE_CAPABILITY_REQUIRED", capability_preflight: this.capabilityPreflight }); return ((await this.request("tools/list"))?.tools || []).filter(tool => REMOTE_READ_ONLY_TOOLS.has(tool.name)); }

  async callTool(name, argumentsValue = {}) {
    if (LOCAL_ONLY_TOOLS.has(name) || !REMOTE_READ_ONLY_TOOLS.has(name)) throw remoteError(`Remote MCP tool is not supported: ${name}`, "configuration", { code: "REMOTE_TOOL_UNSUPPORTED" });
    const preflight = remoteCapabilityPreflight(this._capabilityOptions, name);
    if (preflight.configured && preflight.policy_decision !== "allowed") throw remoteError("Remote capability preflight denied the tool", "auth", { code: "REMOTE_CAPABILITY_DENIED", capability_preflight: preflight });
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

module.exports = { RemoteMcpClient, remoteHealth, validateRemoteUrl, classifyRemoteError, canFallbackToLocal, executeRemoteWithLocalFallback, remoteCapabilityPreflight, validateRemoteCapability, REMOTE_READ_ONLY_TOOLS, LOCAL_ONLY_TOOLS, REMOTE_PATH };
