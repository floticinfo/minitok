"use strict";

const { performance } = require("node:perf_hooks");
const { redactValue, redactText } = require("../goal/evidence");
const { createProvider, CustomProvider } = require("./provider");

const LIVE_EVIDENCE_SCHEMA_VERSION = 1;
const LIVE_MODE = "supervised_live";
const CAMELSTREAM_PROVIDER = "camelstream";
const CAMELSTREAM_BASE_URL = "https://stream.camelai.com/v1";
const CAMELSTREAM_MODEL = "auto";
const CAMELSTREAM_CREDENTIAL_HANDLE = "CAMEL_API_KEY";
const LIVE_CLAIM_BOUNDARY = "Supervised live provider smoke evidence only; no production-readiness, quality, availability, or product-superiority claim.";
const DEFAULT_CANARY_BUDGET = Object.freeze({ max_requests: 1, max_tokens: 1024, timeout_ms: 30000 });

function plain(value) { return Boolean(value && typeof value === "object" && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)); }
function positive(value, fallback) { return Number.isSafeInteger(value) && value > 0 ? value : fallback; }
function validateCamelstreamConfig(config = {}) {
  if (!plain(config)) throw new TypeError("Camelstream configuration must be an object");
  if (config.api_key !== undefined) throw new Error("Camelstream accepts credential handles only; use api_key_env: CAMEL_API_KEY");
  if (config.base_url !== undefined && config.base_url !== CAMELSTREAM_BASE_URL) throw new Error(`Camelstream base_url must be ${CAMELSTREAM_BASE_URL}`);
  if (config.api_key_env !== undefined && config.api_key_env !== CAMELSTREAM_CREDENTIAL_HANDLE) throw new Error(`Camelstream api_key_env must be ${CAMELSTREAM_CREDENTIAL_HANDLE}`);
  const models = Array.isArray(config.models) ? config.models.map(item => typeof item === "string" ? item : item?.id).filter(Boolean) : [CAMELSTREAM_MODEL];
  if (!models.includes(CAMELSTREAM_MODEL)) throw new Error(`Camelstream model allowlist must include ${CAMELSTREAM_MODEL}`);
  return { ...config, base_url: CAMELSTREAM_BASE_URL, api_key_env: CAMELSTREAM_CREDENTIAL_HANDLE, models: [{ id: CAMELSTREAM_MODEL, context_window: 260000, ...(Array.isArray(config.models) ? config.models.find(item => (typeof item === "string" ? item : item?.id) === CAMELSTREAM_MODEL) : {}) }], _name: CAMELSTREAM_PROVIDER, response_api: "responses" };
}
function liveGate(options = {}) {
  if (options.mode !== LIVE_MODE) return { allowed: false, code: "LIVE_MODE_REQUIRED", reason: `mode must be ${LIVE_MODE}` };
  if (options.confirmation !== true) return { allowed: false, code: "LIVE_CONFIRMATION_REQUIRED", reason: "explicit live confirmation is required" };
  if (options.network_enabled !== true) return { allowed: false, code: "LIVE_NETWORK_DISABLED", reason: "live network access is disabled" };
  if (options.live_endpoint_opt_in !== true) return { allowed: false, code: "LIVE_ENDPOINT_OPT_IN_REQUIRED", reason: "explicit endpoint opt-in is required" };
  if (process.env.CAMEL_API_KEY === undefined || !String(process.env.CAMEL_API_KEY).trim()) return { allowed: false, code: "CAMELSTREAM_CREDENTIAL_MISSING", reason: "CAMEL_API_KEY credential handle is not configured" };
  return { allowed: true };
}
function budget(options = {}) { return { max_requests: Number.isSafeInteger(options.max_requests) && options.max_requests >= 0 ? options.max_requests : DEFAULT_CANARY_BUDGET.max_requests, max_tokens: positive(options.max_tokens, DEFAULT_CANARY_BUDGET.max_tokens), timeout_ms: positive(options.timeout_ms, DEFAULT_CANARY_BUDGET.timeout_ms) }; }
function evidence(input = {}) { const tokenUsage = { input: Number(input.token_usage?.input) || 0, output: Number(input.token_usage?.output) || 0, total: Number(input.token_usage?.total) || 0 }; const canaryBudget = input.canary_budget ? { max_requests: Number(input.canary_budget.max_requests) || 0, max_tokens: Number(input.canary_budget.max_tokens) || 0, timeout_ms: Number(input.canary_budget.timeout_ms) || 0 } : null; const record = redactValue({ schema_version: LIVE_EVIDENCE_SCHEMA_VERSION, artifact_type: "supervised_live_provider_smoke", measurement_status: "supervised_live", provider: CAMELSTREAM_PROVIDER, endpoint: { protocol: "https:", hostname: "stream.camelai.com", pathname: "/v1" }, model: input.model || CAMELSTREAM_MODEL, credential_handle: CAMELSTREAM_CREDENTIAL_HANDLE, status: input.status || "unknown", request_count: input.request_count || 0, latency_ms: Number.isFinite(input.latency_ms) ? input.latency_ms : null, token_usage: tokenUsage, error: input.error ? redactText(String(input.error)).slice(0, 240) : null, canary_budget: canaryBudget, publishable_claim: false, claim_boundary: LIVE_CLAIM_BOUNDARY, live_contacted: input.live_contacted === true }); record.token_usage = tokenUsage; record.canary_budget = canaryBudget; record.credential_handle = CAMELSTREAM_CREDENTIAL_HANDLE; return record; }
function responseText(result) { if (typeof result?.text === "string") return result.text; return ""; }
async function discoverCamelstreamLive(options = {}) {
  const gate = liveGate(options);
  if (!gate.allowed) return evidence({ status: "blocked", error: gate.reason, canary_budget: budget(options), live_contacted: false });
  const canary = budget(options);
  if (canary.max_requests < 1) return evidence({ status: "blocked", error: "canary request budget must allow one request", canary_budget: canary, live_contacted: false });
  const started = performance.now();
  try {
    const provider = new CustomProvider({ ...validateCamelstreamConfig(options.provider_config || {}), _name: CAMELSTREAM_PROVIDER });
    const models = await CustomProvider.fetchModels(provider.baseUrl, undefined, { type: "api_key", key: "${CAMEL_API_KEY}", scheme: "Bearer" }, CAMELSTREAM_PROVIDER);
    return evidence({ status: models.some(item => item?.id === CAMELSTREAM_MODEL) ? "passed" : "unknown", request_count: 1, latency_ms: performance.now() - started, canary_budget: canary, live_contacted: true });
  } catch (error) { return evidence({ status: "error", request_count: 1, latency_ms: performance.now() - started, error: error.message, canary_budget: canary, live_contacted: true }); }
}
async function runCamelstreamLiveSmoke(options = {}) {
  const gate = liveGate(options);
  if (!gate.allowed) return evidence({ status: "blocked", error: gate.reason, canary_budget: budget(options), live_contacted: false });
  const canary = budget(options);
  if (canary.max_requests < 1) return evidence({ status: "blocked", error: "canary request budget must allow one request", canary_budget: canary, live_contacted: false });
  const started = performance.now();
  const provider = createProvider(CAMELSTREAM_PROVIDER, validateCamelstreamConfig(options.provider_config || {}));
  try {
    const result = await provider.complete([{ role: "user", content: options.prompt || "Reply with the single word READY." }], { model: CAMELSTREAM_MODEL, max_tokens: canary.max_tokens, timeout_ms: canary.timeout_ms });
    const text = responseText(result);
    return evidence({ status: text ? "passed" : "unknown", model: result.model || CAMELSTREAM_MODEL, request_count: 1, latency_ms: performance.now() - started, token_usage: { ...(result.tokens || {}), total: (Number(result.tokens?.input) || 0) + (Number(result.tokens?.output) || 0) }, canary_budget: canary, live_contacted: true });
  } catch (error) {
    return evidence({ status: "error", request_count: 1, latency_ms: performance.now() - started, error: error.message, canary_budget: canary, live_contacted: true });
  }
}
module.exports = { LIVE_EVIDENCE_SCHEMA_VERSION, LIVE_MODE, CAMELSTREAM_PROVIDER, CAMELSTREAM_BASE_URL, CAMELSTREAM_MODEL, CAMELSTREAM_CREDENTIAL_HANDLE, LIVE_CLAIM_BOUNDARY, DEFAULT_CANARY_BUDGET, validateCamelstreamConfig, liveGate, budget, evidence, discoverCamelstreamLive, runCamelstreamLiveSmoke };
