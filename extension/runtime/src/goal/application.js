"use strict";

const http = require("http");
const { redactValue, redactText } = require("./evidence");
const APPLICATION_CAPABILITIES = Object.freeze(["local_http", "process_health", "browser_assertion", "api_assertion", "database_read_only", "deployment"]);
const DEFAULT_ACTIONS = new Set(["assert_text", "assert_status", "assert_json"]);
const LOCAL_HTTP_METHODS = Object.freeze(["GET", "HEAD"]);
const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 120000;
const LOCAL_HTTP_HOSTS = new Set(["localhost", "127.0.0.1"]);
function allowedUrl(url, allowlist = []) {
  let target;
  try { target = new URL(url); } catch { return false; }
  return allowlist.some(item => {
    try {
      const allowed = new URL(item);
      return allowed.protocol === target.protocol && allowed.hostname === target.hostname && (!allowed.port || allowed.port === target.port);
    } catch { return false; }
  });
}
function capabilityAllowed(kind, options) { return options.capabilities instanceof Set && options.capabilities.has(kind); }
function approvalAllowed(kind, options) { return !options.approvals || options.approvals instanceof Set && options.approvals.has(kind); }
function unknown(reason, extra = {}) { return { status: "unknown", reason, evidence: redactValue({ executed: false, status: "unknown", reason, ...extra }) }; }
function permissionRequired(reason, extra = {}) { return { status: "permission_required", reason, evidence: redactValue({ executed: false, status: "permission_required", reason, ...extra }) }; }
function unavailable(reason, extra = {}) { return { status: "unavailable", reason, evidence: redactValue({ executed: true, status: "unavailable", reason, ...extra }) }; }
function timeout(reason, extra = {}) { return { status: "timeout", reason, evidence: redactValue({ executed: true, status: "timeout", reason, ...extra }) }; }
function failed(reason, evidence = {}) { return { status: "failed", reason, evidence: redactValue({ executed: true, status: "failed", reason, ...evidence }) }; }
function passed(evidence = {}) { return { status: "passed", reason: "Application assertions passed", evidence: redactValue({ executed: true, status: "passed", ...evidence }) }; }
function blocked(reason, extra = {}) { return { status: "blocked", reason, evidence: redactValue({ executed: false, status: "blocked", reason, ...extra }) }; }
function escalated(reason, extra = {}) { return { status: "escalated", reason, evidence: redactValue({ executed: true, status: "escalated", reason, ...extra }) }; }
function assertJsonPath(value, dottedPath) {
  if (typeof dottedPath !== "string" || !dottedPath || dottedPath.split(".").some(part => !/^[A-Za-z0-9_-]+$/.test(part) || ["__proto__", "constructor", "prototype"].includes(part))) return { valid: false, safe: false, reason: "Unsafe JSON assertion path" };
  let current = value;
  for (const part of dottedPath.split(".")) {
    if (!current || typeof current !== "object" || !Object.prototype.hasOwnProperty.call(current, part)) return { valid: false, safe: true, reason: "JSON assertion path was not found" };
    current = current[part];
  }
  return { valid: true, safe: true, value: current };
}
function localHttpUrl(value) {
  try {
    const target = new URL(value);
    return target.protocol === "http:" && LOCAL_HTTP_HOSTS.has(target.hostname.toLowerCase()) && !target.username && !target.password;
  } catch { return false; }
}
function requestError(message, code, timedOut = false) {
  const error = /** @type {{ code?: string, timed_out?: boolean, message: string }} */ (new Error(message));
  error.code = code;
  if (timedOut) error.timed_out = true;
  return error;
}
function requestErrorStatus(error) {
  const details = /** @type {{ code?: string, timed_out?: boolean }} */ (error || {});
  if (details.timed_out === true || details.code === "ETIMEDOUT" || details.code === "ESOCKETTIMEDOUT") return "timeout";
  if (["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EHOSTUNREACH", "EAI_AGAIN"].includes(details.code)) return "unavailable";
  if (["EACCES", "EPERM"].includes(details.code)) return "permission_required";
  return "unknown";
}
function createLocalHttpRequest(request = {}, options = {}) {
  const target = new URL(request.url);
  const method = String(request.method || "GET").toUpperCase();
  const allowedMethods = options.allowedMethods || LOCAL_HTTP_METHODS;
  const maxResponseBytes = Number.isSafeInteger(request.max_response_bytes) && request.max_response_bytes > 0 ? request.max_response_bytes : options.maxResponseBytes || DEFAULT_MAX_RESPONSE_BYTES;
  const timeoutMs = Number.isSafeInteger(request.timeout_ms) && request.timeout_ms > 0 ? request.timeout_ms : options.timeoutMs || DEFAULT_TIMEOUT_MS;
  if (!localHttpUrl(request.url)) throw requestError("Only localhost HTTP URLs are allowed", "EACCES");
  if (!allowedMethods.includes(method)) throw requestError(`HTTP method is not allowlisted: ${method}`, "EACCES");
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const req = http.request({ protocol: target.protocol, hostname: target.hostname, port: target.port || 80, path: `${target.pathname}${target.search}`, method, headers: request.headers || {} }, response => {
      const declared = Number(response.headers["content-length"]);
      if (Number.isFinite(declared) && declared > maxResponseBytes) { response.destroy(); reject(requestError("HTTP response body too large", "RESPONSE_TOO_LARGE")); return; }
      const chunks = []; let total = 0;
      response.on("data", chunk => { total += chunk.length; if (total > maxResponseBytes) { response.destroy(); reject(requestError("HTTP response body too large", "RESPONSE_TOO_LARGE")); return; } chunks.push(chunk); });
      response.on("end", () => { const body = Buffer.concat(chunks).toString("utf8"); let json = null; try { json = JSON.parse(body); } catch {} resolve({ status: response.statusCode, headers: response.headers, body, json, duration_ms: Date.now() - started }); });
      response.on("error", reject);
    });
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(requestError("Local HTTP request timed out", "ETIMEDOUT", true)); });
    req.on("error", reject); req.end(request.body || undefined);
  });
}
async function evaluateApplicationCheck(config, options = {}) {
  const kind = config?.kind;
  if (!APPLICATION_CAPABILITIES.includes(kind) || !capabilityAllowed(kind, options)) return permissionRequired("Application capability is not granted");
  if (!approvalAllowed(kind, options)) return permissionRequired("Application approval is required");
  const timeoutMs = Number.isSafeInteger(config.timeout_ms) && config.timeout_ms > 0 ? config.timeout_ms : options.timeoutMs || DEFAULT_TIMEOUT_MS;
  try {
    if (kind === "local_http" || kind === "api_assertion") {
      if (!localHttpUrl(config.url) || !allowedUrl(config.url, options.allowedUrls || ["http://127.0.0.1", "http://localhost"])) return permissionRequired("URL is not in the allowed local URL set");
      const request = { url: config.url, method: config.method || "GET", timeout_ms: timeoutMs, max_response_bytes: config.max_response_bytes, headers: config.headers };
      const response = typeof options.httpRequest === "function" ? await options.httpRequest(request) : await createLocalHttpRequest(request, options);
      if (response?.timed_out) return timeout("Application HTTP probe timed out", { response: { timed_out: true } });
      if (!response || typeof response.status !== "number") return unavailable("HTTP probe returned no response");
      if (config.expect_status !== undefined && response.status !== config.expect_status) return failed(`Expected HTTP ${config.expect_status}, received ${response.status}`, { response });
      if (config.expect_body_contains !== undefined && (typeof response.body !== "string" || !response.body.includes(config.expect_body_contains))) return failed("HTTP body assertion failed", { response });
      for (const assertion of config.assertions || []) { const value = assertJsonPath(response.json, assertion.path); if (!value.valid) return value.safe === false ? permissionRequired(value.reason, { response }) : failed(value.reason, { response }); if (Object.prototype.hasOwnProperty.call(assertion, "equals") && value.value !== assertion.equals) return failed("API JSON assertion failed", { response }); }
      return passed({ response: { status: response.status, headers: response.headers || {}, body: redactText(response.body || "") }, code_state: response.code_state || options.codeState || null, application_state: response.application_state || options.applicationState || "observed" });
    }
    if (kind === "process_health") {
      if (typeof options.processHealth !== "function") return unknown("Process health check was not executed");
      const result = await options.processHealth({ process: config.process, timeout_ms: timeoutMs });
      if (result?.timed_out) return unknown("Process health check timed out", { response: result });
      if (result?.alive !== true && config.expect_alive !== false) return failed("Expected process to be alive", { response: result });
      return passed({ response: redactValue(result), application_state: result?.alive ? "running" : "stopped" });
    }

    if (kind === "browser_assertion") {
      if (!allowedUrl(config.url, options.allowedUrls || []) || !options.allowedAccounts?.includes(config.account) || !Array.isArray(config.actions) || config.actions.some(action => !DEFAULT_ACTIONS.has(action.type) || !(options.allowedActions || []).includes(action.type))) return blocked("Browser URL, account, or action is not allowlisted");
      if (!options.browser || typeof options.browser.open !== "function") return unknown("Browser assertion was not executed");
      const page = await options.browser.open({ url: config.url, account: config.account, timeout_ms: timeoutMs, read_only: true });
      if (page?.timed_out) return timeout("Browser assertion timed out", { response: page });
      for (const action of config.actions) {
        if (action.type === "assert_text" && !String(page.text || "").includes(action.value)) return failed("Browser text assertion failed", { response: page });
        if (action.type === "assert_status" && page.status !== action.value) return failed("Browser status assertion failed", { response: page });
      }
      const cleanup = typeof options.browser.cleanup === "function" ? await options.browser.cleanup({ url: config.url, account: config.account }) : page.cleanup;
      if (!cleanup || cleanup.executed !== true) return unknown("Browser cleanup evidence is required", { response: redactValue(page), cleanup: redactValue(cleanup) });
      return passed({ response: redactValue(page), application_state: "observed", cleanup: redactValue(cleanup) });
    }
    if (kind === "database_read_only") {
      if (config.write === true || config.mutation === true) return blocked("Database adapter permits read-only assertions only");
      if (typeof options.databaseReader !== "function") return unknown("Database read-only assertion was not executed");
      const result = await options.databaseReader({ query_id: config.query_id, timeout_ms: timeoutMs, read_only: true });
      if (result?.timed_out) return timeout("Database assertion timed out", { response: result });
      if (result?.available === false) return unavailable("Database is unavailable", { response: result });
      for (const [key, expected] of Object.entries(config.expected || {})) if (result?.[key] !== expected) return failed(`Database assertion failed for ${key}`, { response: result });
      if (!result?.cleanup || result.cleanup.executed !== true) return unknown("Database cleanup evidence is required", { response: redactValue(result) });
      return passed({ response: redactValue(result), application_state: "observed", cleanup: redactValue(result.cleanup) });
    }
    if (kind === "deployment") {
      if (config.environment !== "staging" || config.production === true) return blocked("Production deployment is forbidden; staging is required");
      if (config.approval !== true || !approvalAllowed("deployment", options)) return permissionRequired("Staging deployment approval is required");
      if (typeof options.deployer !== "function" || typeof options.healthCheck !== "function" || typeof options.rollback !== "function") return unknown("Deployment, health check, and rollback adapters are required");
      if (!config.rollback_strategy || !config.health_check) return unknown("Deployment requires rollback strategy and health check configuration");
      let deployment;
      try {
        deployment = await options.deployer({ environment: "staging", timeout_ms: timeoutMs, read_only: false });
        if (!deployment || deployment.success !== true) return failed("Staging deployment failed", { deployment: redactValue(deployment) });
        const health = await options.healthCheck({ environment: "staging", timeout_ms: timeoutMs });
        if (health?.timed_out) {
          const rollbackResult = await options.rollback({ environment: "staging", strategy: config.rollback_strategy, timeout_ms: timeoutMs });
          if (rollbackResult?.success !== true) return escalated("Staging health check timed out and rollback failed", { deployment: redactValue(deployment), health: redactValue(health), rollback: redactValue(rollbackResult) });
          return timeout("Staging health check timed out; rollback completed", { deployment: redactValue(deployment), health: redactValue(health), rollback: redactValue(rollbackResult) });
        }
        if (health?.healthy !== true) {
          const rollbackResult = await options.rollback({ environment: "staging", strategy: config.rollback_strategy, timeout_ms: timeoutMs });
          if (rollbackResult?.success !== true) return escalated("Staging health check failed and rollback failed", { deployment: redactValue(deployment), health: redactValue(health), rollback: redactValue(rollbackResult) });
          return failed("Staging health check failed; rollback completed", { deployment: redactValue(deployment), health: redactValue(health), rollback: redactValue(rollbackResult) });
        }
        const cleanup = typeof options.cleanup === "function" ? await options.cleanup({ environment: "staging", deployment: redactValue(deployment) }) : null;
        if (!cleanup || cleanup.executed !== true) return unknown("Deployment cleanup evidence is required", { deployment: redactValue(deployment), health: redactValue(health), cleanup: redactValue(cleanup) });
        return passed({ deployment: redactValue(deployment), health: redactValue(health), rollback_strategy: config.rollback_strategy, cleanup: redactValue(cleanup), application_state: "staging-healthy" });
      } catch (error) {
        return unknown(`Deployment adapter error: ${error.message}`, { deployment: redactValue(deployment) });
      }
    }
  } catch (error) {
    const status = requestErrorStatus(error);
    if (status === "timeout") return timeout(`Application adapter timed out: ${error.message}`);
    if (status === "unavailable") return unavailable(`Application is unavailable: ${error.message}`);
    if (status === "permission_required") return permissionRequired(`Application permission is required: ${error.message}`);
    return unknown(`Application adapter error: ${error.message}`);
  }
  return unknown("Application adapter did not execute");
}
function isDeploymentEnabled(config = {}) { return Boolean(config.kind === "deployment" && config.environment === "staging" && config.rollback_strategy && config.health_check && config.approval === true && config.production !== true); }
module.exports = { APPLICATION_CAPABILITIES, DEFAULT_ACTIONS, LOCAL_HTTP_METHODS, DEFAULT_MAX_RESPONSE_BYTES, allowedUrl, localHttpUrl, createLocalHttpRequest, evaluateApplicationCheck, isDeploymentEnabled, assertJsonPath };
