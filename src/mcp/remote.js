"use strict";

const { fetchWithTimeout } = require("../core/http");
const { loadCustomerToken } = require("../auth/customer-token");
const { OAuthFlow } = require("../auth/oauth");
const { TokenStore } = require("../auth/token-store");
const { capabilityPermissions, safeRecord, FULL_TEST_PROFILE } = require("../entitlement/capability");
const { postJson } = require("../core/http");
const TRUSTED_MCP_AUTH_HOSTS = new Set(["api.minitok.dev"]);
const PRIVATE_HOSTNAMES = new Set(["localhost", "localhost.localdomain", "ip6-localhost", "ip6-loopback"]);
function isPrivateOrLoopbackHost(hostname) {
  const host = String(hostname || "").replace(/^\[|\]$/g, "").toLowerCase();
  if (PRIVATE_HOSTNAMES.has(host) || host === "::1" || host === "0.0.0.0" || host === "::") return true;
  const parts = host.split(".").map(Number);
  if (parts.length !== 4 || parts.some(value => !Number.isInteger(value) || value < 0 || value > 255)) return false;
  const n = parts[0] * 0x1000000 + parts[1] * 0x10000 + parts[2] * 0x100 + parts[3];
  return (parts[0] === 10) || (parts[0] === 127) || (parts[0] === 169 && parts[1] === 254) || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) || (parts[0] === 192 && parts[1] === 168) || n === 0;
}
function validateMetadataUrl(value, resourceUrl) {
  let url;
  try { url = new URL(value); } catch { throw remoteError("OAuth metadata URL is invalid", "auth", { code: "REMOTE_OAUTH_UNTRUSTED_METADATA" }); }
  if (url.protocol !== "https:" || url.username || url.password || isPrivateOrLoopbackHost(url.hostname)) throw remoteError("OAuth metadata URL is not a trusted HTTPS endpoint", "auth", { code: "REMOTE_OAUTH_UNTRUSTED_METADATA" });
  if (url.hostname !== resourceUrl.hostname && !TRUSTED_MCP_AUTH_HOSTS.has(url.hostname)) throw remoteError("OAuth metadata URL is not trusted", "auth", { code: "REMOTE_OAUTH_UNTRUSTED_METADATA" });
  return url.toString();
}
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

/**
 * Classify a remote MCP failure for recovery routing. The server's structured
 * JSON-RPC error type (`error.data.type`, surfaced here as `errorType`) wins
 * over the bare HTTP status: an email-verification denial and a payment
 * entitlement denial both arrive as HTTP 403, so status-only classification
 * flattened them into a single "auth" bucket and could not produce the right
 * recovery guidance (verify the email address vs buy a subscription).
 */
function classifyRemoteError(error) {
  if (error?.classification) return error.classification;
  const errorType = error?.errorType || error?.rpcError?.data?.type || error?.body?.error?.data?.type || null;
  if (errorType === "EMAIL_VERIFICATION_REQUIRED") return "email_verification";
  if (errorType === "ENTITLEMENT_REQUIRED") return "entitlement";
  if (["SESSION_REQUIRED", "SESSION_BINDING_MISMATCH"].includes(errorType)) return errorType;
  if (["RATE_LIMITED", "RATE_LIMIT_DEGRADED"].includes(errorType) || error?.status === 429) return "rate_limit";
  if (error?.code === "INVALID_REMOTE_URL") return "configuration";
  if (error?.status >= 500) return "server";
  if (error?.status >= 400) {
    return error.status === 401 || error.status === 403 ? "auth" : "protocol";
  }
  return "network";
}

/** Actionable recovery guidance keyed by the classified failure. */
function recoveryHintForError(error) {
  switch (classifyRemoteError(error)) {
    case "email_verification":
      return "Your minitok account email address is not verified yet. Open the verification link in your inbox (see https://minitok.dev/verify-email to request a new one), then retry.";
    case "entitlement":
      return "No active paid subscription is attached to this account. Start or restore one at https://minitok.dev/pricing, then retry.";
    case "SESSION_REQUIRED":
    case "SESSION_BINDING_MISMATCH":
      return "The remote MCP session is no longer valid. Reconnect to start a new session.";
    case "rate_limit":
      return "The remote MCP service rate-limited the request. Wait a moment, then retry.";
    case "auth":
      return "Remote MCP authentication failed. Re-run `minitok mcp connect` to refresh the credential.";
    case "network":
      return "The remote MCP service could not be reached. Check connectivity, then retry.";
    case "server":
      return "The remote MCP service failed. Retry later.";
    default:
      return null;
  }
}

function remoteError(message, classification, details = {}) {
  // Carry the server's structured JSON-RPC error type and message forward so
  // UX layers can distinguish EMAIL_VERIFICATION_REQUIRED from
  // ENTITLEMENT_REQUIRED (both HTTP 403) instead of collapsing them into one
  // generic auth failure. Build all properties in a single Object.assign so
  // the returned error's type surface stays consistent for the typechecker.
  const structuredType = details.errorType || details.rpcError?.data?.type || details.body?.error?.data?.type || null;
  const serverMessage = details.rpcError?.message || details.body?.error?.message || null;
  return Object.assign(new Error(message), {
    code: "REMOTE_MCP_ERROR",
    classification,
    ...(structuredType ? { errorType: structuredType } : {}),
    ...(typeof serverMessage === "string" && serverMessage ? { serverMessage } : {}),
    ...details,
  });
}


/**
 * Fetch OAuth metadata with a stable diagnostic that identifies which discovery
 * document failed. The endpoint URL is safe to report (credentials are rejected
 * by validateMetadataUrl), while the response body is deliberately not retained.
 */
async function fetchOAuthMetadata(url, stage, timeoutMs) {
  let response;
  try {
    response = await fetchWithTimeout(url, { headers: { Accept: "application/json" }, redirect: "error" }, timeoutMs);
  } catch (error) {
    throw remoteError(`Remote MCP OAuth ${stage} metadata request failed`, "auth", {
      code: "REMOTE_OAUTH_METADATA_REQUEST_FAILED",
      metadata_stage: stage,
      metadata_url: url,
      cause: error,
    });
  }
  let metadata;
  try {
    metadata = await response.json();
  } catch (error) {
    throw remoteError(`Remote MCP OAuth ${stage} metadata returned invalid JSON`, "auth", {
      code: "REMOTE_OAUTH_METADATA_INVALID_JSON",
      metadata_stage: stage,
      metadata_url: url,
      status: response.status,
      cause: error,
    });
  }
  if (!response.ok) {
    throw remoteError(`Remote MCP OAuth ${stage} metadata endpoint returned HTTP ${response.status}`, "auth", {
      code: response.status === 404 ? `REMOTE_OAUTH_${stage.toUpperCase()}_METADATA_NOT_FOUND` : "REMOTE_OAUTH_METADATA_HTTP_ERROR",
      metadata_stage: stage,
      metadata_url: url,
      status: response.status,
    });
  }
  return metadata;
}

/** Extract RFC 6750 resource_metadata from common WWW-Authenticate forms. */
function extractResourceMetadata(challenge) {
  const value = String(challenge || "");
  const match = value.match(/resource_metadata\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s,]+))/i);
  if (!match) return null;
  return (match[1] ?? match[2] ?? match[3]).replace(/\\(["'])/g, "$1");
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
      const metadataUrl = extractResourceMetadata(challenge);
      if (response.status === 401 && this.allowOAuth && !retried && metadataUrl && errorType !== "ENTITLEMENT_REQUIRED" && errorType !== "EMAIL_VERIFICATION_REQUIRED") {
        // Discard the unusable credential first: `retried` bounds the loop, and
        // without this the client kept presenting the same expired token.
        try { this.tokenStore.remove(this.resourceKey); } catch {}
        this._cachedTokenExpired = false;
        await this.authorizeFromMetadata(metadataUrl);
        return this.request(method, params, true);
      }
      const classification = errorType === "EMAIL_VERIFICATION_REQUIRED" ? "email_verification" : errorType === "ENTITLEMENT_REQUIRED" ? "entitlement" : ["SESSION_REQUIRED", "SESSION_BINDING_MISMATCH"].includes(errorType) ? errorType : ["RATE_LIMITED", "RATE_LIMIT_DEGRADED"].includes(errorType) || response.status === 429 ? "rate_limit" : response.status === 401 || response.status === 403 ? "auth" : "protocol";
      throw remoteError(response.status === 401 || response.status === 403 ? "Remote MCP authentication or entitlement failed" : response.status === 429 ? "Remote MCP rate limit exceeded" : "Remote MCP HTTP protocol failure", classification, { status: response.status, body, errorType: errorType || null });
    }
    const result = Array.isArray(body) ? body.find(item => item?.id === id) : body;
    if (result?.error) throw remoteError(result.error.message || "Remote MCP protocol error", result.error.data?.type === "EMAIL_VERIFICATION_REQUIRED" ? "email_verification" : result.error.data?.type === "ENTITLEMENT_REQUIRED" ? "entitlement" : ["SESSION_REQUIRED", "SESSION_BINDING_MISMATCH"].includes(result.error.data?.type) ? result.error.data.type : ["RATE_LIMITED", "RATE_LIMIT_DEGRADED"].includes(result.error.data?.type) ? "rate_limit" : "protocol", { status: response.status, rpcError: result.error });
    if (!result || result.id !== id) throw remoteError("Remote MCP response did not match request", "protocol", { status: response.status });
    return result.result;
  }

  async authorizeFromMetadata(metadataUrl) {
    let metadata;
    try {
      const resourceUrl = new URL(this.url);
      const trustedMetadataUrl = validateMetadataUrl(metadataUrl, resourceUrl);
      metadata = await fetchOAuthMetadata(trustedMetadataUrl, "protected_resource", this.timeoutMs);
      if (!metadata?.authorization_servers?.[0]) throw remoteError("Remote MCP protected-resource metadata is missing authorization_servers", "auth", { code: "REMOTE_OAUTH_PROTECTED_RESOURCE_METADATA_INVALID", metadata_stage: "protected_resource", metadata_url: trustedMetadataUrl });
      const serverUrl = new URL(metadata.authorization_servers[0]);
      if (serverUrl.protocol !== "https:" || serverUrl.username || serverUrl.password || isPrivateOrLoopbackHost(serverUrl.hostname) || (serverUrl.hostname !== resourceUrl.hostname && !TRUSTED_MCP_AUTH_HOSTS.has(serverUrl.hostname))) throw remoteError("Remote MCP authorization server is not trusted", "auth", { code: "REMOTE_OAUTH_UNTRUSTED_AUTHORITY" });
      const serverMetadataUrl = validateMetadataUrl(serverUrl.pathname.includes("/.well-known/") ? serverUrl.toString() : `${serverUrl.toString().replace(/\/$/, "")}/.well-known/oauth-authorization-server`, resourceUrl);
      const serverMetadata = await fetchOAuthMetadata(serverMetadataUrl, "authorization_server", this.timeoutMs);
      if (!serverMetadata.authorization_endpoint || !serverMetadata.token_endpoint) throw remoteError("Remote MCP authorization-server metadata is missing authorization_endpoint or token_endpoint", "auth", { code: "REMOTE_OAUTH_AUTHORIZATION_SERVER_METADATA_INVALID", metadata_stage: "authorization_server", metadata_url: serverMetadataUrl });
      const authorizationEndpoint = validateMetadataUrl(serverMetadata.authorization_endpoint, resourceUrl);
      const tokenEndpoint = validateMetadataUrl(serverMetadata.token_endpoint, resourceUrl);
      const token = await new OAuthFlow({ openBrowser: this.accountOptions.openBrowser, port: this.accountOptions.port }).authorize("mcp", { authorize_url: authorizationEndpoint, token_url: tokenEndpoint, client_id: this.clientId, scope: metadata.scopes_supported?.[0] || "read" });
      this.token = token.access_token;
      this.tokenStore.save(this.resourceKey, { resource: this.url, ...token, expires_at: token.expires_at || new Date(Date.now() + 2592000000).toISOString() });
      return this.token;
    } catch (error) {
      // Preserve actionable discovery diagnostics (especially HTTP 404) at the
      // top level. Callers should not have to inspect a nested cause to learn
      // which metadata document is missing.
      if (error?.code === "REMOTE_MCP_ERROR" || String(error?.code || "").startsWith("REMOTE_OAUTH_")) throw error;
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

module.exports = { RemoteMcpClient, remoteHealth, validateRemoteUrl, validateMetadataUrl, classifyRemoteError, recoveryHintForError, canFallbackToLocal, executeRemoteWithLocalFallback, extractResourceMetadata, remoteCapabilityPreflight, validateRemoteCapability, REMOTE_READ_ONLY_TOOLS, LOCAL_ONLY_TOOLS, REMOTE_PATH };

