"use strict";

const FETCH_TIMEOUT_MS = 300000; // Allow slow reasoning providers up to five minutes
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024; // 2 MB max response body

const dns = require("dns").promises;
const net = require("net");
const crypto = require("crypto");
const { authManager } = require("../auth");
const { normalizeProvider } = require("../auth/aliases");
const { Agent } = require("undici");
const { getProxyDispatcher, shouldBypassProxy } = require("../core/http");
const { CAMELSTREAM_PROVIDER, camelstreamPreset } = require("./camelstream");

function providerError(name, status, detail = "") {
  return new Error(`${name} API request failed (${status})${detail ? `: ${detail}` : ""}`);
}

/**
 * Extract the API's own error message from an already-buffered response.
 *
 * The status code alone cannot distinguish an invalid model name, a quota
 * problem or an oversized request, which left every failure undiagnosable.
 */
async function providerErrorDetail(res) {
  try {
    const text = await res.text();
    if (!text) return "";
    try {
      const parsed = JSON.parse(text);
      const message = parsed?.error?.message || parsed?.error || parsed?.message || parsed?.detail;
      if (typeof message === "string" && message.trim()) return message.trim().slice(0, 200);
    } catch { /* not JSON — fall through to the raw body */ }
    return text.replace(/\s+/g, " ").trim().slice(0, 200);
  } catch { return ""; }
}

function validateProviderEndpoint(raw, label = "Provider endpoint", options = {}) {
  let parsed;
  try { parsed = new URL(raw); } catch { throw new Error(`${label} must be a valid URL`); }
  if (!["https:", "http:"].includes(parsed.protocol)) throw new Error(`${label} must use HTTP or HTTPS`);
  const localHost = ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname);
  const allowLocalHttp = options.allowInsecureLocalEndpoint === true || options.allowInsecureLocalEndpoint === undefined;
  if (parsed.protocol === "http:" && !localHost) throw new Error(`${label} HTTP endpoints are limited to localhost`);
  if (parsed.protocol === "http:" && options.strictHttps === true && !allowLocalHttp) throw new Error(`${label} requires HTTPS; explicitly enable allow_insecure_local_endpoint for localhost development`);
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (parsed.protocol === "https:" && (isBlockedAddress(hostname) || hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || hostname === "metadata" || hostname === "metadata.google.internal" || hostname === "metadata.google.internal.")) throw new Error(`${label} host is blocked`);
  if (parsed.username || parsed.password) throw new Error(`${label} must not contain credentials`);
  if (parsed.search || parsed.hash) throw new Error(`${label} must not contain a query or fragment`);
  return parsed.origin + parsed.pathname.replace(/\/+$/, "");
}

function ipv4Number(address) {
  return address.split(".").reduce((value, octet) => (value * 256) + Number(octet), 0);
}

function ipv6Number(address) {
  let value = address.toLowerCase().replace(/^\[|\]$/g, "");
  if (value.includes(".")) {
    const lastColon = value.lastIndexOf(":");
    const ipv4 = value.slice(lastColon + 1);
    if (!net.isIPv4(ipv4)) return null;
    const number = ipv4Number(ipv4);
    value = `${value.slice(0, lastColon)}:${(number >>> 16).toString(16)}:${(number & 0xffff).toString(16)}`;
  }
  const halves = value.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const expanded = halves.length === 2 ? [...left, ...Array(8 - left.length - right.length).fill("0"), ...right] : left;
  if (expanded.length !== 8 || expanded.some(part => !/^[0-9a-f]{1,4}$/.test(part))) return null;
  return expanded.reduce((value, part) => (value << 16n) | BigInt(`0x${part}`), 0n);
}

function inIpv6Range(value, prefix, bits) {
  const mask = ((1n << BigInt(bits)) - 1n) << BigInt(128 - bits);
  return (value & mask) === (prefix & mask);
}

function isBlockedAddress(address) {
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized.startsWith("::ffff:") && net.isIPv4(normalized.slice(7))) return isBlockedAddress(normalized.slice(7));
  if (net.isIPv4(normalized)) {
    const value = ipv4Number(normalized);
    const first = value >>> 24;
    return first === 0 || first === 10 || first === 127 || first >= 224 ||
      (value >= 0x64400000 && value <= 0x647fffff) ||
      (value >= 0xa9fe0000 && value <= 0xa9feffff) ||
      (value >= 0xac100000 && value <= 0xac1fffff) ||
      (value >= 0xc0000000 && value <= 0xc00000ff) ||
      (value >= 0xc0000200 && value <= 0xc00002ff) ||
      (value >= 0xc0001000 && value <= 0xc00010ff) ||
      (value >= 0xc0a80000 && value <= 0xc0a8ffff) ||
      (value >= 0xc6120000 && value <= 0xc613ffff) ||
      (value >= 0xc6336400 && value <= 0xc63364ff) ||
      (value >= 0xcb007100 && value <= 0xcb0071ff) ||
      value >= 0xf0000000;
  }
  if (!net.isIPv6(normalized)) return false;
  const value = ipv6Number(normalized);
  if (value === null) return false;
  if ((value >> 32n) === 0xffffn) {
    const mapped = Number(value & 0xffffffffn);
    return isBlockedAddress(`${mapped >>> 24}.${(mapped >>> 16) & 255}.${(mapped >>> 8) & 255}.${mapped & 255}`);
  }
  return value === 0n || value === 1n ||
    inIpv6Range(value, 0xfc000000000000000000000000000000n, 7) ||
    inIpv6Range(value, 0xfe800000000000000000000000000000n, 10) ||
    inIpv6Range(value, 0xff000000000000000000000000000000n, 8) ||
    inIpv6Range(value, 0x20010000000000000000000000000000n, 32) ||
    inIpv6Range(value, 0x20010db8000000000000000000000000n, 32) ||
    inIpv6Range(value, 0x20010010000000000000000000000000n, 28) ||
    inIpv6Range(value, 0x20010002000000000000000000000000n, 48);
}

async function resolvePublicEndpoint(raw, label = "Provider endpoint") {
  const parsed = new URL(raw);
  if (parsed.protocol !== "https:") return { dispatcher: undefined, url: raw, headers: {} };
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
  let addresses;
  try {
    addresses = net.isIP(hostname) ? [hostname] : (await dns.lookup(hostname, { all: true })).map(result => result.address);
  } catch {
    throw new Error(`${label} DNS resolution failed`);
  }
  if (!addresses.length || addresses.some(isBlockedAddress)) throw new Error(`${label} resolves to a blocked internal address`);
  const address = addresses[0];
  if (shouldBypassProxy(raw)) {
    const dispatcher = new Agent({ connect: { lookup: (_hostname, options, callback) => {
      const family = options?.family;
      const candidate = addresses.find(value => !family || net.isIP(value) === family);
      if (candidate) callback(null, candidate, net.isIP(candidate));
      else callback(new Error("Custom provider endpoint has no address for requested address family"), "", 0);
    } } });
    return { dispatcher, url: raw, headers: {} };
  }
  const proxy = require("../core/http").getProxyDispatcher(raw);
  if (!proxy) return { dispatcher: undefined, url: raw, headers: {} };
  const pinned = new URL(raw);
  pinned.hostname = address.includes(":") ? `[${address}]` : address;
  return { dispatcher: require("undici").ProxyAgent ? new (require("undici").ProxyAgent)({ uri: process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy, requestTls: { servername: hostname } }) : proxy, url: pinned.toString(), headers: { Host: parsed.host } };
}

const resolvePublicCustomEndpoint = (raw) => resolvePublicEndpoint(raw, "Custom provider endpoint");

const validateCustomEndpoint = (raw, options = {}) => {
  const endpoint = validateProviderEndpoint(raw, "Custom provider endpoint", { ...options, strictHttps: true });
  if (new URL(endpoint).protocol === "https:") {
    const hostname = new URL(endpoint).hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (isBlockedAddress(hostname) || hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || hostname === "metadata.google.internal" || hostname === "metadata" || hostname === "metadata.google.internal.") throw new Error("Custom provider endpoint host is blocked");
  }
  return endpoint;
};

async function readCappedResponse(res) {
  if (!res.body || typeof res.body.getReader !== "function") return res;
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        try { await reader.cancel(); } catch {}
        throw new Error(`Response too large: ${total} bytes (max ${MAX_RESPONSE_BYTES})`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    try { reader.releaseLock(); } catch {}
  }
  return new Response(Buffer.concat(chunks), {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  });
}

const RETRY_DEFAULTS = { maxRetries: 5, backoffMs: 250, maxBackoffMs: 1250 };
let _retryPolicy = { ...RETRY_DEFAULTS };

/**
 * Configure the shared HTTP retry policy (wired from minitok.yml
 * execution.max_retries / retry_backoff_sec / retry_max_sec).
 */
function configureRetries(policy = {}) {
  const clamp = (value, min, max, fallback) => (Number.isFinite(Number(value)) ? Math.min(Math.max(Number(value), min), max) : fallback);
  _retryPolicy = {
    maxRetries: clamp(policy.maxRetries, 0, 10, RETRY_DEFAULTS.maxRetries),
    backoffMs: clamp(policy.backoffMs, 250, 120000, RETRY_DEFAULTS.backoffMs),
    maxBackoffMs: clamp(policy.maxBackoffMs, 250, 1800000, RETRY_DEFAULTS.maxBackoffMs),
  };
}

function _isRetryableStatus(status) {
  return status === 429 || status >= 500;
}

function _retryAfterMs(res) {
  const header = res.headers.get("retry-after");
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && String(seconds) === header.trim()) return Math.max(0, seconds * 1000);
  const at = new Date(header).getTime();
  return Number.isNaN(at) ? null : Math.max(0, at - Date.now());
}

/** Header names that carry a provider credential (never sent twice). */
const CREDENTIAL_HEADER_NAMES = new Set(["authorization", "x-api-key", "x-goog-api-key", "api-key"]);

class LLMProvider {
  constructor(name, config = {}) {
    this.name = name;
    this.config = config;
    this._authManager = authManager;
  }
  /** @returns {Promise<object>} */
  async complete(messages, options = {}) {
    throw new Error(`${this.name}.complete() not implemented`);
  }
  /** @returns {Promise<boolean>} */
  async isAvailable() { return false; }
  /** Resolve auth headers using the auth module. */
  async _resolveAuth() {
    return this._authManager.resolve(this.name, this.config);
  }
  /**
   * Build request headers from the resolved auth block.
   *
   * AuthManager resolves the configured header name and scheme (api_key with a
   * custom header, `raw`, an OAuth bearer token, ...). The built-in providers
   * used to ignore `auth.headers` completely and always send their own
   * x-api-key/Authorization header, so an `auth:` block could not change how the
   * credential is presented (an OAuth token was sent as `x-api-key`).
   * `_probeProvider()` already merged the resolved headers; `complete()` now
   * behaves the same way.
   */
  _requestHeaders(auth, apiKey, defaults = {}) {
    // Only an explicit `auth:` block is authoritative for header layout. The
    // legacy api_key path returns a generic x-api-key header for every provider,
    // which must not replace e.g. OpenAI's Authorization header.
    const explicitAuth = this.config && typeof this.config.auth === "object" && this.config.auth ? this.config.auth : null;
    const configured = explicitAuth && auth && typeof auth.headers === "object" && auth.headers ? auth.headers : {};
    const configuredNames = new Set(Object.keys(configured).map(name => name.toLowerCase()));
    // A credential must be sent once: when the auth block already carries the
    // token, the provider's own credential header is dropped.
    const carriesCredential = Boolean(apiKey) && Object.values(configured).some(value => typeof value === "string" && value.includes(apiKey));
    const headers = { "Content-Type": "application/json", ...configured };
    for (const [name, value] of Object.entries(defaults)) {
      const lower = name.toLowerCase();
      if (configuredNames.has(lower)) continue;
      if (carriesCredential && CREDENTIAL_HEADER_NAMES.has(lower)) continue;
      headers[name] = value;
    }
    return headers;
  }
}

/**
 * Fetch with timeout, response size limit, and retries for transport errors
 * and transient HTTP statuses (429/5xx), honoring Retry-After when present.
 */
async function fetchWithTimeout(url, opts = {}, timeoutMs = FETCH_TIMEOUT_MS, retryOverride = {}) {
  // The per-request deadline may travel inside the request options: roles carry
  // their own timeout_sec, and a shorter role budget must bound the HTTP call
  // instead of the fixed five minute default.
  const requestedTimeout = Number.isFinite(Number(opts.timeout_ms)) && Number(opts.timeout_ms) > 0 ? Number(opts.timeout_ms) : timeoutMs;
  const policy = { ..._retryPolicy, ...retryOverride };
  const externalSignal = retryOverride.signal || opts.signal;
  const deadline = Date.now() + requestedTimeout;
  const attempts = (/** @type {any} */ (opts)).retry_network_errors === false ? 1 : Math.max(1, policy.maxRetries + 1);
  const requestOpts = { ...opts };
  delete /** @type {any} */ (requestOpts).retry_network_errors;
  delete /** @type {any} */ (requestOpts).timeout_ms;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("Provider request deadline exceeded");
    const controller = new AbortController();
    const abortExternal = () => controller.abort(externalSignal.reason);
    if (externalSignal?.aborted) throw Object.assign(new Error("Provider request cancelled"), { code: "RUN_CANCELLED" });
    externalSignal?.addEventListener("abort", abortExternal, { once: true });
    const timer = setTimeout(() => controller.abort(), remaining);
    try {
      const dispatcher = /** @type {any} */ (requestOpts).dispatcher || getProxyDispatcher(url);
      const res = await fetch(url, { ...requestOpts, ...(dispatcher ? { dispatcher } : {}), signal: controller.signal });
      const contentLength = parseInt(res.headers.get("content-length") || "0", 10);
      if (contentLength > MAX_RESPONSE_BYTES) throw new Error(`Response too large: ${contentLength} bytes (max ${MAX_RESPONSE_BYTES})`);
      const cappedRes = await readCappedResponse(res);
      if (_isRetryableStatus(res.status) && attempt < attempts) {
        const serverDelay = _retryAfterMs(res);
        const backoffDelay = Math.min(policy.backoffMs * Math.pow(2, attempt - 1), policy.maxBackoffMs);
        // Retry-After is advisory; never let a provider response suspend a
        // paid run beyond the configured retry ceiling.
        const delayMs = Math.min(serverDelay ?? backoffDelay, policy.maxBackoffMs, Math.max(0, deadline - Date.now()));
        try { await cappedRes.arrayBuffer(); } catch {}
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }
      return cappedRes;
    } catch (error) {
      lastError = error;
      const networkFailure = error?.name === "TypeError" || error?.name === "AbortError" || /ECONNRESET|ECONNREFUSED|UND_ERR|fetch failed|aborted/i.test(error?.message || "");
      if (!networkFailure || attempt === attempts) throw error;
      const delay = Math.min(250 * attempt, Math.max(0, deadline - Date.now()));
      await new Promise(resolve => setTimeout(resolve, delay));
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener("abort", abortExternal);
    }
  }
  throw lastError;
}

/**
 * Fallback provider — retries a failed completion on alternative models of
 * the same provider (wired from roles.<role>.fallback_model).
 */
class FallbackProvider extends LLMProvider {
  constructor(primary, fallbackModels = []) {
    super(primary.name, primary.config);
    this.primary = primary;
    this.fallbackModels = fallbackModels.filter(Boolean);
  }
  /** @returns {Promise<boolean>} */
  async isAvailable() {
    try { return await this.primary.isAvailable(); } catch { return false; }
  }
  async complete(messages, options = {}) {
    try {
      return await this.primary.complete(messages, options);
    } catch (error) {
      const attempted = new Set([options.model, this.primary.config.model].filter(Boolean));
      for (const model of this.fallbackModels) {
        if (attempted.has(model)) continue;
        attempted.add(model);
        try {
          return await this.primary.complete(messages, { ...options, model });
        } catch {}
      }
      throw error;
    }
  }
}

/**
 * Estimate USD cost for a usage object using optional per-provider pricing
 * ({ input_per_mtok, output_per_mtok } from minitok.yml providers config).
 */
function _estimateCost(tokens, pricing) {
  if (!tokens || !pricing) return { input: 0, output: 0, total: 0 };
  const input = ((tokens.input || 0) / 1e6) * (Number(pricing.input_per_mtok) || 0);
  const output = ((tokens.output || 0) / 1e6) * (Number(pricing.output_per_mtok) || 0);
  const total = input + output;
  return { input, output, total };
}

class AnthropicProvider extends LLMProvider {
  constructor(config = {}) {
    super("anthropic", config);
    this.apiKey = config.api_key || process.env.ANTHROPIC_API_KEY || "";
    this.baseUrl = validateProviderEndpoint(config.endpoint || "https://api.anthropic.com", "Anthropic endpoint");
  }
  async isAvailable() {
    try {
      const { token } = await this._resolveAuth();
      return Boolean(token || this.apiKey);
    } catch { return Boolean(this.apiKey); }
  }
  async complete(messages, options = {}) {
    const auth = await this._resolveAuth();
    const apiKey = this.apiKey || auth.token || "";
    if (!apiKey) throw new Error("Anthropic: no credentials (set api_key or auth block)");
    const model = options.model || this.config.model || "claude-sonnet-5";
    const systemMsg = messages.find((m) => m.role === "system");
    const nonSystem = messages.filter((m) => m.role !== "system");
    const body = {
      model, max_tokens: options.max_tokens || 4096,
      messages: nonSystem.map((m) => ({ role: m.role, content: m.content })),
    };
    if (systemMsg) body.system = systemMsg.content;

    // Thinking support
    const thinking = options.thinking || this.config.thinking;
    const effort = options.effort || this.config.effort;
    if (thinking === "adaptive" || thinking === "enabled") {
      if (thinking === "adaptive" || /^(claude-(fable|opus|sonnet)-5|claude-opus-4-[78]|claude-sonnet-4-6|claude-sonnet-5)/.test(model)) {
        body.thinking = { type: "adaptive" };
        if (effort) body.output_config = { effort };
      } else {
        const budget = options.thinking_budget || this.config.thinking_budget || 10000;
        body.thinking = { type: "enabled", budget_tokens: budget };
      }
      if (body.max_tokens < 16000) body.max_tokens = 16000;
    }

    const endpointTransport = await resolvePublicEndpoint(this.baseUrl, "Anthropic endpoint");
    const headers = this._requestHeaders(auth, apiKey, { "x-api-key": apiKey, "anthropic-version": "2023-06-01" });
    const res = await fetchWithTimeout(`${endpointTransport.url}/v1/messages`, { method: "POST", headers, body: JSON.stringify(body), signal: options.signal, timeout_ms: options.timeout_ms, ...(endpointTransport.dispatcher ? { dispatcher: endpointTransport.dispatcher } : {}) });
    if (!res.ok) throw providerError("Anthropic", res.status, await providerErrorDetail(res));
    const data = await res.json();
    const textBlocks = (data.content || []).filter(b => b.type === "text");
    const text = textBlocks.map((b) => b.text).join("") || "";
    // The provider's own stop reason is the only place the real cause of an
    // unusable response lives. Without it a refusal (or a turn that produced only
    // tool calls) surfaced downstream as "No JSON in response", and a body cut off
    // by max_tokens was indistinguishable from a model that ignored the format.
    const finishReason = data.stop_reason || null;
    if (!text && finishReason) throw providerError("Anthropic", 200, `the model returned no text (stop_reason: ${finishReason})`);
    return { text, model: data.model, usage: data.usage || {}, tokens: _countTokens(data.usage), finish_reason: finishReason, truncated: finishReason === "max_tokens" };
  }
}

class OpenAIProvider extends LLMProvider {
  constructor(config = {}) {
    super("openai", config);
    this.apiKey = config.api_key || process.env.OPENAI_API_KEY || "";
    this.baseUrl = validateProviderEndpoint(config.endpoint || "https://api.openai.com", "OpenAI endpoint");
  }
  async isAvailable() {
    try { const { token } = await this._resolveAuth(); return Boolean(token || this.apiKey); }
    catch { return Boolean(this.apiKey); }
  }
  async complete(messages, options = {}) {
    const auth = await this._resolveAuth();
    const apiKey = this.apiKey || auth.token || "";
    if (!apiKey) throw new Error("OpenAI: no credentials (set api_key or auth block)");
    const model = options.model || this.config.model || "gpt-5.6-terra";
    // Reasoning models (o-series, and the GPT-5 family on the official API)
    // reject `max_tokens` with "Unsupported parameter: max_tokens is not
    // supported with this model. Use max_completion_tokens instead", and they
    // only accept the default temperature. The previous body always sent
    // max_tokens, so every o-series request failed before the request was made
    // useful. Compatible gateways commonly implement max_tokens only, so the new
    // parameter is restricted to the official endpoint.
    const reasoningModel = /^(?:o\d|gpt-5)/.test(model);
    const officialEndpoint = (() => { try { return /(^|\.)api\.openai\.com$/i.test(new URL(this.baseUrl).hostname); } catch { return false; } })();
    const useCompletionTokens = reasoningModel && officialEndpoint;
    const body = { model, messages };
    body[useCompletionTokens ? "max_completion_tokens" : "max_tokens"] = options.max_tokens || 4096;
    if (!reasoningModel) body.temperature = options.temperature ?? 0.7;
    else if (options.temperature !== undefined) body.temperature = options.temperature;

    // Reasoning effort support (o1, o3, o4-mini)
    const reasoningEffort = options.reasoning_effort || this.config.reasoning_effort;
    if (reasoningEffort && reasoningModel) body.reasoning_effort = reasoningEffort;

    const endpointTransport = await resolvePublicEndpoint(this.baseUrl, "OpenAI endpoint");
    const res = await fetchWithTimeout(`${endpointTransport.url}/v1/chat/completions`, {
      method: "POST",
      headers: this._requestHeaders(auth, apiKey, { Authorization: "Bearer " + apiKey }),
      body: JSON.stringify(body),
      signal: options.signal, timeout_ms: options.timeout_ms,
      ...(endpointTransport.dispatcher ? { dispatcher: endpointTransport.dispatcher } : {}),
    });
    if (!res.ok) throw providerError("OpenAI", res.status, await providerErrorDetail(res));
    const data = await res.json();
    const choice = data.choices?.[0];
    // `length` means the reply was cut off by the output token budget. Reasoning
    // models bill their reasoning tokens against the same budget, so a truncated
    // answer is common and used to be reported as malformed JSON.
    const finishReason = choice?.finish_reason || null;
    const text = choice?.message?.content || "";
    if (!text && finishReason) throw providerError("OpenAI", 200, `the model returned no text (finish_reason: ${finishReason})`);
    return { text, model: data.model, usage: data.usage || {}, tokens: _countTokens(data.usage), finish_reason: finishReason, truncated: finishReason === "length" };
  }
}

class GoogleProvider extends LLMProvider {
  constructor(config = {}) {
    super("google", config);
    this.apiKey = config.api_key || process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY || "";
    this.baseUrl = validateProviderEndpoint(config.endpoint || "https://generativelanguage.googleapis.com", "Google endpoint");
  }
  async isAvailable() {
    try { const { token } = await this._resolveAuth(); return Boolean(token || this.apiKey); }
    catch { return Boolean(this.apiKey); }
  }
  async complete(messages, options = {}) {
    const auth = await this._resolveAuth();
    const apiKey = this.apiKey || auth.token || "";
    if (!apiKey) throw new Error("Google: no credentials (set api_key or auth block)");
    const model = options.model || this.config.model || "gemini-3.7-flash";
    const systemMsg = messages.find((m) => m.role === "system");
    const nonSystem = messages.filter((m) => m.role !== "system");
    const contents = nonSystem.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] }));
    const body = { contents };
    if (systemMsg) body.systemInstruction = { parts: [{ text: systemMsg.content }] };

    // Thinking support (Gemini 2.5 Pro / Flash)
    const thinking = options.thinking || this.config.thinking;
    if (thinking && thinking !== "none") {
      body.generationConfig = body.generationConfig || {};
      if (thinking === "dynamic") {
        body.generationConfig.thinkingConfig = { includeThoughts: true };
      } else if (thinking === "budget" || (typeof thinking === "object" && thinking.budget_tokens)) {
        const budget = typeof thinking === "object" ? thinking.budget_tokens : (this.config.thinking_budget || 10000);
        body.generationConfig.thinkingConfig = { includeThoughts: true, thinkingBudget: budget };
      }
    }

    const endpointTransport = await resolvePublicEndpoint(this.baseUrl, "Google endpoint");
    const res = await fetchWithTimeout(`${endpointTransport.url}/v1beta/models/${model}:generateContent`, {
      method: "POST",
      headers: this._requestHeaders(auth, apiKey, { "x-goog-api-key": apiKey }),
      body: JSON.stringify(body),
      signal: options.signal, timeout_ms: options.timeout_ms,
      ...(endpointTransport.dispatcher ? { dispatcher: endpointTransport.dispatcher } : {}),
    });
    if (!res.ok) throw providerError("Google", res.status, await providerErrorDetail(res));
    const data = await res.json();
    // A request that Gemini refuses is answered with no candidates at all and a
    // prompt-level blockReason. Returning an empty string turned a safety block
    // into "No JSON in response" and hid the actual reason from the operator.
    const blockReason = data.promptFeedback?.blockReason || null;
    if (blockReason) throw providerError("Google", 200, `the request was blocked (blockReason: ${blockReason})`);
    const candidate = data.candidates?.[0];
    const finishReason = candidate?.finishReason || null;
    // Filter out thought parts from candidates
    const parts = candidate?.content?.parts || [];
    const textParts = parts.filter(p => !p.thought);
    const text = textParts.map((p) => p.text).join("") || "";
    if (!text && finishReason) throw providerError("Google", 200, `the model returned no text (finishReason: ${finishReason})`);
    return { text, model, usage: data.usageMetadata || {}, tokens: _countTokens(data.usageMetadata), finish_reason: finishReason, truncated: finishReason === "MAX_TOKENS" };
  }
}

/**
 * Extract token counts from any provider's usage metadata.
 * Returns { input: number, output: number } with accurate counts from the API.
 */
function _countTokens(u) {
  if (!u) return { input: 0, output: 0 };
  // Anthropic: input_tokens, output_tokens
  if (u.input_tokens !== undefined || u.output_tokens !== undefined) {
    return { input: u.input_tokens || 0, output: u.output_tokens || 0 };
  }
  // OpenAI: prompt_tokens, completion_tokens
  if (u.prompt_tokens !== undefined || u.completion_tokens !== undefined) {
    return { input: u.prompt_tokens || 0, output: u.completion_tokens || 0 };
  }
  // Google: promptTokenCount, candidatesTokenCount
  if (u.promptTokenCount !== undefined || u.candidatesTokenCount !== undefined) {
    return { input: u.promptTokenCount || 0, output: u.candidatesTokenCount || 0 };
  }
  return { input: 0, output: 0 };
}

/**
 * Custom provider — generic OpenAI-compatible endpoint.
 * Used for Ollama, vLLM, LiteLLM, Bedrock proxies, enterprise LLMs, etc.
 */
class CustomProvider extends LLMProvider {
  constructor(config = {}) {
    const isCamelstream = config._name === CAMELSTREAM_PROVIDER;
    if (isCamelstream && config.api_key !== undefined) throw new Error("Camelstream accepts credential handles only; use CAMEL_API_KEY");
    const effective = isCamelstream ? camelstreamPreset(config) : config;
    super(effective._name || "custom", effective);
    this.apiKey = effective.api_key || "";
    this.baseUrl = effective.base_url ? validateCustomEndpoint(effective.base_url, { allowInsecureLocalEndpoint: effective.allow_insecure_local_endpoint === true || effective._name && effective._name !== "custom" }) : "";
    this.models = effective.models || [];
    this.responseApi = effective.response_api || "chat_completions";
  }
  // A custom provider is reachable as soon as a base_url is configured: local
  // servers (e.g. Ollama) legitimately need no credentials, and complete()
  // sends an unauthenticated request in that case. Requiring an auth block here
  // would hide self-hosted providers — see tests/test-providers-tiers.js
  // "isAvailable with base_url" and "detects custom provider".
  async isAvailable() { return this.name === CAMELSTREAM_PROVIDER ? Boolean(this.apiKey || process.env.CAMEL_API_KEY) : Boolean(this.baseUrl); }
  async complete(messages, options = {}) {
    if (!this.baseUrl) throw new Error(`${this.name}: base_url not configured`);
    const endpointTransport = await resolvePublicCustomEndpoint(this.baseUrl);
    const auth = await this._resolveAuth();
    const apiKey = this.apiKey || auth.token || "";
    const model = validateProviderModel(this.name, options.model || this.config.model || (this.models[0]?.id) || "default", this.config);
    const isResponses = this.responseApi === "responses";
    const body = isResponses ? { model, input: messages.map(m => ({ role: m.role, content: [{ type: "input_text", text: m.content }] })), max_output_tokens: options.max_tokens || 4096 } : { model, messages: messages.map(m => ({ role: m.role, content: m.content })), max_tokens: options.max_tokens || 4096 };
    const headers = { "Content-Type": "application/json", ...(auth.headers || {}) };
    if (apiKey && !this.config.auth && headers["x-api-key"]) {
      delete headers["x-api-key"];
    }
    if (apiKey && !headers.Authorization && !headers["x-api-key"]) {
      const scheme = this.config.auth?.scheme || "Bearer";
      const header = this.config.auth?.header || "Authorization";
      headers[header] = scheme === "raw" ? apiKey : `${scheme} ${apiKey}`;
    }
    const apiPath = isResponses ? "/responses" : "/chat/completions";
    const requestHeaders = { ...headers, ...endpointTransport.headers };
    const res = await fetchWithTimeout(`${endpointTransport.url}${apiPath}`, { method: "POST", headers: requestHeaders, body: JSON.stringify(body), signal: options.signal, timeout_ms: options.timeout_ms, ...(endpointTransport.dispatcher ? { dispatcher: endpointTransport.dispatcher } : {}) });
    if (!res.ok) throw providerError(this.name, res.status, await providerErrorDetail(res));
    const data = await res.json();
    if (isResponses) {
      const text = data.output_text || data.output?.flatMap(item => item.content || []).find(item => item.type === "output_text")?.text || "";
      if (!text) throw providerError(this.name, 200, "the model returned no output text");
      return { text, model: data.model || model, usage: data.usage || {}, tokens: _countTokens(data.usage), finish_reason: data.status || null, truncated: data.status === "incomplete" };
    }
    const choice = data.choices?.[0];
    const finishReason = choice?.finish_reason || null;
    const text = choice?.message?.content || "";
    if (!text && finishReason) throw providerError(this.name, 200, `the model returned no text (finish_reason: ${finishReason})`);
    return { text, model: data.model || model, usage: data.usage || {}, tokens: _countTokens(data.usage), finish_reason: finishReason, truncated: finishReason === "length" };
  }
  static async fetchModels(baseUrl, apiKey, auth = {}, providerName = "custom") {
    if (!baseUrl) return [];
    try {
      const endpoint = validateCustomEndpoint(baseUrl);
      const endpointTransport = await resolvePublicCustomEndpoint(endpoint);
      const resolvedAuth = await authManager.resolve(providerName, { api_key: apiKey, ...(Object.keys(auth).length > 0 ? { auth } : {}) });
      const headers = { ...(resolvedAuth.headers || {}) };
      const token = resolvedAuth.token || apiKey;
      if (token && !Object.keys(headers).some(header => header.toLowerCase() === "authorization" || header.toLowerCase() === "x-api-key")) {
        const scheme = auth.scheme || "Bearer";
        const header = auth.header || "Authorization";
        headers[header] = scheme === "raw" ? token : `${scheme} ${token}`;
      }
      const requestHeaders = { ...headers, ...endpointTransport.headers };
      const modelsPath = endpoint.endsWith("/v1") ? "/models" : "/v1/models";
      const res = await fetchWithTimeout(`${endpointTransport.url}${modelsPath}`, { headers: requestHeaders, ...(endpointTransport.dispatcher ? { dispatcher: endpointTransport.dispatcher } : {}) }, 10000);
      if (!res.ok) return [];
      const data = await res.json();
      return (data.data || []).map(m => ({ id: m.id, display: m.id, context_window: m.context_length || null, max_output: null }));
    } catch { return []; }
  }
}

function validateProviderModel(providerName, model, config = {}) {
  if (typeof model !== "string" || !model.trim()) throw new Error(`${providerName}: model must be a non-empty string`);
  const configured = Array.isArray(config.models) ? config.models.map(item => typeof item === "string" ? item : item?.id).filter(Boolean) : [];
  if (configured.length && !configured.includes(model)) throw new Error(`${providerName}: model is not in the configured model policy`);
  return model;
}

function createProvider(name, config = {}) {
  const n = name.toLowerCase();
  if (n === CAMELSTREAM_PROVIDER) return new CustomProvider(camelstreamPreset({ ...config, _name: CAMELSTREAM_PROVIDER }));
  // Tier 1: Direct providers
  switch (n) {
    case "anthropic": case "claude": return new AnthropicProvider(config);
    case "openai": case "gpt": return new OpenAIProvider(config);
    case "google": case "gemini": return new GoogleProvider(config);
  }
  // Tier 2/3: Custom provider (has base_url or models array)
  if (config.base_url || config.endpoint || config.models) {
    return new CustomProvider({ ...config, base_url: config.base_url || config.endpoint, _name: n });
  }
  throw new Error(`Unknown LLM provider: ${name}. Set base_url for custom providers.`);
}

/**
 * Providers whose credentials are present in the environment or configuration.
 * @param {object} config resolved minitok configuration
 * @returns {Promise<string[]>} provider names that can be used
 */
async function detectAvailableProviders(config) {
  const providers = config?.providers || {};
  const providerConfig = canonical => providers[canonical] || Object.entries(providers).find(([name]) => normalizeProvider(name) === canonical)?.[1] || {};
  const checks = new Map([
    ["anthropic", new AnthropicProvider(providerConfig("anthropic"))],
    ["openai", new OpenAIProvider(providerConfig("openai"))],
    ["google", new GoogleProvider(providerConfig("google"))],
  ]);
  for (const [rawName, cfg] of Object.entries(providers)) {
    const name = normalizeProvider(rawName);
    if (!cfg.base_url || checks.has(name)) continue;
    try { checks.set(name, new CustomProvider({ ...cfg, _name: name })); } catch {}
  }
  // isAvailable() only inspects configuration (no network), so a plain loop is
  // both sufficient and easier to type than a Promise.all of pairs.
  const available = [];
  for (const [name, provider] of checks) {
    let ok;
    try { ok = Boolean(await provider.isAvailable()); } catch { ok = false; }
    if (ok) available.push(name);
  }
  return available;
}

// ──────────────────────────────────────────────────────────────────────────
// Live credential verification (B1/B2): configuration presence (isAvailable)
// cannot detect an expired/revoked key. verifyCredentials() performs a cheap
// GET against the provider's models endpoint (8s cap, single attempt) so
// doctor --verify and the run preflight can surface 401/403 before a run
// burns cycles. Results are TTL-cached: successes 120s, failures 15s.
// ──────────────────────────────────────────────────────────────────────────
const VERIFY_OK_TTL_MS = 120 * 1000;
const VERIFY_FAIL_TTL_MS = 15 * 1000;
const PROBE_TIMEOUT_MS = 8000;
const verifyCache = new Map();

function resetVerifyCache() { verifyCache.clear(); }

async function _probeProvider(provider) {
  const auth = await provider._resolveAuth().catch(() => ({ headers: {}, token: null }));
  const headers = { ...(auth.headers || {}) };
  const token = auth.token || "";
  const apiKey = provider.apiKey || token || "";

  let url;
  switch (provider.name) {
    case "anthropic":
      if (!apiKey) return { status: "absent", detail: "ANTHROPIC_API_KEY not set" };
      headers["x-api-key"] = headers["x-api-key"] || apiKey;
      headers["anthropic-version"] = "2023-06-01";
      url = "https://api.anthropic.com/v1/models";
      break;
    case "openai":
      if (!apiKey) return { status: "absent", detail: "OPENAI_API_KEY not set" };
      headers["authorization"] = headers["authorization"] || "Bearer " + apiKey;
      url = "https://api.openai.com/v1/models";
      break;
    case "google":
      if (!apiKey) return { status: "absent", detail: "GOOGLE_API_KEY / GEMINI_API_KEY not set" };
      headers["x-goog-api-key"] = headers["x-goog-api-key"] || apiKey;
      url = "https://generativelanguage.googleapis.com/v1beta/models";
      break;
    default: {
      if (!provider.baseUrl) return { status: "absent", detail: "custom provider without base_url" };
      if (provider.config?.auth?.type === "none") return { status: "skipped", detail: "auth type none (local)" };
      if (!apiKey && !Object.keys(headers).length) return { status: "absent", detail: "custom provider without credentials" };
      if (!Object.keys(headers).some(h => /authorization|x-api-key|token/i.test(h)) && token) headers["authorization"] = "Bearer " + token;
      url = provider.baseUrl.replace(/\/+$/, "") + "/v1/models";
    }
  }

  try {
    const res = await fetchWithTimeout(url, { method: "GET", headers, retry_network_errors: false }, PROBE_TIMEOUT_MS);
    if (res.ok) return { status: "ok", detail: "HTTP " + res.status };
    if (res.status === 401 || res.status === 403) return { status: "invalid", detail: "HTTP " + res.status + " - key rejected" };
    return { status: "error", detail: "HTTP " + res.status };
  } catch (error) {
    return { status: "network_error", detail: String(error?.message || error).slice(0, 200) };
  }
}

/**
 * Fingerprint the credential a probe would actually use.
 *
 * The verification cache was keyed by provider name and endpoint only, so a
 * credential the user had just replaced kept the previous verdict: a 401
 * rejection survived the fix (and an OK survived a revoked key) until the TTL
 * expired, with no way to invalidate it (`resetVerifyCache` had no caller).
 * Hashing the resolved credential keeps the cache useful without serving an
 * answer that belongs to a different key.
 */
async function credentialFingerprint(provider) {
  let auth;
  try { auth = await provider._resolveAuth(); } catch { auth = {}; }
  const headers = auth?.headers || {};
  const material = [
    auth?.token || "",
    headers.authorization || headers.Authorization || "",
    headers["x-api-key"] || "",
    headers["x-goog-api-key"] || "",
    provider.apiKey || "",
  ].join("\u0000");
  return crypto.createHash("sha256").update(material).digest("hex").slice(0, 16);
}

/**
 * Live-check a provider's credentials.
 * @returns {Promise<{status: string, detail: string}>}
 *   ok | invalid (401/403) | absent | network_error | error | skipped
 */
async function verifyCredentials(providerName, providerConfig = {}) {
  const now = Date.now();
  let provider = null;
  let fingerprint = "unresolved";
  try {
    provider = createProvider(providerName, providerConfig);
    fingerprint = await credentialFingerprint(provider);
  } catch { /* an unusable configuration is reported below */ }
  const key = [String(providerName).toLowerCase(), providerConfig?.base_url || providerConfig?.endpoint || "", fingerprint].join("\u0000");
  const hit = verifyCache.get(key);
  if (hit && now - hit.at < (hit.status === "ok" ? VERIFY_OK_TTL_MS : VERIFY_FAIL_TTL_MS)) return hit;
  let result;
  try {
    if (!provider) throw new Error(`Unknown provider: ${providerName}`);
    result = await _probeProvider(provider);
  } catch (error) {
    result = { status: "error", detail: String(error?.message || error).slice(0, 200) };
  }
  result.at = now;
  verifyCache.set(key, result);
  return result;
}

module.exports = { LLMProvider, FallbackProvider, AnthropicProvider, OpenAIProvider, GoogleProvider, CustomProvider, createProvider, detectAvailableProviders, verifyCredentials, resetVerifyCache, fetchWithTimeout, configureRetries, validateProviderModel, _countTokens, _estimateCost };

