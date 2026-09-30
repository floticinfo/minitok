"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { evaluateApplicationCheck, APPLICATION_CAPABILITIES, allowedUrl, isDeploymentEnabled, localHttpUrl } = require("./application");
const { startServer } = require("../../tests/fixtures/local-http-app/server");

function baseOptions(extra = {}) {
  return { capabilities: new Set(APPLICATION_CAPABILITIES), approvals: new Set(APPLICATION_CAPABILITIES), ...extra };
}

test("local HTTP probe uses an allowed localhost URL and asserts status/body", async () => {
  const result = await evaluateApplicationCheck({ kind: "local_http", url: "http://127.0.0.1:3000/health", method: "GET", expect_status: 200, expect_body_contains: "ok", timeout_ms: 1000 }, baseOptions({ httpRequest: async request => ({ status: 200, body: "ok", headers: {}, duration_ms: 2, request }) }));
  assert.equal(result.status, "passed");
  assert.equal(result.evidence.executed, true);
  assert.equal(result.evidence.response.status, 200);
});

test("local HTTP probe rejects non-allowlisted or external URLs", async () => {
  assert.equal(allowedUrl("https://example.com", ["http://127.0.0.1:3000"]), false);
  const result = await evaluateApplicationCheck({ kind: "local_http", url: "https://example.com", expect_status: 200 }, baseOptions());
  assert.equal(result.status, "permission_required");
  assert.match(result.reason, /URL|local|allow/i);
});

test("HTTP timeout and missing health check are not success", async () => {
  const timeout = await evaluateApplicationCheck({ kind: "local_http", url: "http://127.0.0.1:3000/health", expect_status: 200 }, baseOptions({ httpRequest: async () => ({ timed_out: true, duration_ms: 10 }) }));
  assert.equal(timeout.status, "timeout");
  const missing = await evaluateApplicationCheck({ kind: "local_http", url: "http://127.0.0.1:1/health", expect_status: 200 }, baseOptions());
  assert.equal(missing.status, "unavailable");
});

test("process health check distinguishes process alive from health assertion", async () => {
  const healthy = await evaluateApplicationCheck({ kind: "process_health", process: "app", expect_alive: true }, baseOptions({ processHealth: async () => ({ alive: true, pid: 123, duration_ms: 1 }) }));
  assert.equal(healthy.status, "passed");
  const dead = await evaluateApplicationCheck({ kind: "process_health", process: "app", expect_alive: true }, baseOptions({ processHealth: async () => ({ alive: false, duration_ms: 1 }) }));
  assert.equal(dead.status, "failed");
});

test("API response assertion supports status and bounded JSON path values", async () => {
  const result = await evaluateApplicationCheck({ kind: "api_assertion", url: "http://127.0.0.1:3000/api", method: "GET", expect_status: 200, assertions: [{ path: "data.status", equals: "ready" }] }, baseOptions({ httpRequest: async () => ({ status: 200, json: { data: { status: "ready" } }, body: "{\"data\":{\"status\":\"ready\"}}", duration_ms: 1 }) }));
  assert.equal(result.status, "passed");
  const invalidPath = await evaluateApplicationCheck({ kind: "api_assertion", url: "http://127.0.0.1:3000/api", assertions: [{ path: "data.__proto__.x", equals: true }] }, baseOptions({ httpRequest: async () => ({ status: 200, json: {} }) }));
  assert.equal(invalidPath.status, "permission_required");
});

test("browser assertion is mock-driver only and enforces account/action allowlists", async () => {
  const passed = await evaluateApplicationCheck({ kind: "browser_assertion", url: "http://127.0.0.1:3000", account: "test-user", actions: [{ type: "assert_text", value: "Dashboard" }] }, baseOptions({ browser: { open: async () => ({ screenshot: "data", text: "Dashboard" }), cleanup: async () => ({ executed: true }) }, allowedUrls: ["http://127.0.0.1:3000"], allowedAccounts: ["test-user"], allowedActions: ["assert_text"] }));
  assert.equal(passed.status, "passed");
  const missing = await evaluateApplicationCheck({ kind: "browser_assertion", url: "http://127.0.0.1:3000", account: "test-user", actions: [] }, baseOptions({ allowedUrls: ["http://127.0.0.1:3000"], allowedAccounts: ["test-user"] }));
  assert.equal(missing.status, "unknown");
});

test("database read-only assertion requires injected reader and approval", async () => {
  const passed = await evaluateApplicationCheck({ kind: "database_read_only", query_id: "health", expected: { status: "ready" } }, baseOptions({ databaseReader: async () => ({ status: "ready", duration_ms: 1, cleanup: { executed: true } }) }));
  assert.equal(passed.status, "passed");
  const denied = await evaluateApplicationCheck({ kind: "database_read_only", query_id: "health", expected: { status: "ready" } }, baseOptions({ approvals: new Set(), databaseReader: async () => ({ status: "ready" }) }));
  assert.equal(denied.status, "permission_required");
});

test("deployment is disabled by default", () => {
  assert.equal(isDeploymentEnabled({ kind: "deployment" }), false);
});

test("application evidence redacts secrets and separates code/application state", async () => {
  const result = await evaluateApplicationCheck({ kind: "local_http", url: "http://127.0.0.1:3000/health", expect_status: 200 }, baseOptions({ httpRequest: async () => ({ status: 200, body: "token=secret", code_state: "changed", application_state: "running" }) }));
  assert.equal(result.status, "passed");
  assert.equal(result.evidence.response.body.includes("secret"), false);
  assert.equal(result.evidence.code_state, "changed");
  assert.equal(result.evidence.application_state, "running");
});

test("observes the deterministic local application fixture with status, body, JSON, and separated state", async () => {
  const app = await startServer();
  try {
    const options = baseOptions({ codeState: "changed", applicationState: "running" });
    const health = await evaluateApplicationCheck({ kind: "local_http", url: `${app.baseUrl}/health`, method: "GET", expect_status: 200, expect_body_contains: "ok" }, options);
    assert.equal(health.status, "passed");
    assert.equal(health.evidence.code_state, "changed");
    assert.equal(health.evidence.application_state, "running");
    const api = await evaluateApplicationCheck({ kind: "api_assertion", url: `${app.baseUrl}/api`, expect_status: 200, assertions: [{ path: "data.status", equals: "ready" }] }, options);
    assert.equal(api.status, "passed");
    const failure = await evaluateApplicationCheck({ kind: "local_http", url: `${app.baseUrl}/failure`, expect_status: 200 }, options);
    assert.equal(failure.status, "failed");
    const bodyFailure = await evaluateApplicationCheck({ kind: "local_http", url: `${app.baseUrl}/health`, expect_status: 200, expect_body_contains: "missing" }, options);
    assert.equal(bodyFailure.status, "failed");
  } finally { await app.close(); }
});

test("enforces local HTTP method and response-size limits", async () => {
  const app = await startServer();
  try {
    const method = await evaluateApplicationCheck({ kind: "local_http", url: `${app.baseUrl}/health`, method: "POST" }, baseOptions());
    assert.equal(method.status, "permission_required");
    const large = await evaluateApplicationCheck({ kind: "local_http", url: `${app.baseUrl}/large`, max_response_bytes: 1024 }, baseOptions());
    assert.equal(large.status, "unknown");
  } finally { await app.close(); }
});

test("distinguishes timeout, unavailable, and running-process health failure", async () => {
  const app = await startServer();
  const base = app.baseUrl;
  await app.close();
  const unavailable = await evaluateApplicationCheck({ kind: "local_http", url: `${base}/health`, timeout_ms: 100 }, baseOptions());
  assert.equal(unavailable.status, "unavailable");
  const slowApp = await startServer();
  try {
    const timeout = await evaluateApplicationCheck({ kind: "local_http", url: `${slowApp.baseUrl}/slow`, timeout_ms: 10 }, baseOptions());
    assert.equal(timeout.status, "timeout");
    const process = await evaluateApplicationCheck({ kind: "process_health", process: "fixture", expect_alive: true }, baseOptions({ processHealth: async () => ({ alive: true, pid: 123 }) }));
    assert.equal(process.status, "passed");
    const processHealthyButAppFailed = await evaluateApplicationCheck({ kind: "local_http", url: `${slowApp.baseUrl}/failure`, expect_status: 200 }, baseOptions({ applicationState: "running" }));
    assert.equal(processHealthyButAppFailed.status, "failed");
  } finally { await slowApp.close(); }
});

test("redacts local application secrets and rejects external URLs", async () => {
  const app = await startServer();
  try {
    const secret = await evaluateApplicationCheck({ kind: "local_http", url: `${app.baseUrl}/secret`, expect_status: 200 }, baseOptions());
    assert.equal(secret.status, "passed");
    assert.equal(JSON.stringify(secret.evidence).includes("fixture-secret"), false);
    assert.equal(JSON.stringify(secret.evidence).includes("fixture-bearer"), false);
    assert.equal(localHttpUrl("https://example.com"), false);
    const external = await evaluateApplicationCheck({ kind: "api_assertion", url: "https://example.com/api", expect_status: 200 }, baseOptions());
    assert.equal(external.status, "permission_required");
  } finally { await app.close(); }
});

test("permission and timeout states are not valid completion evidence", async () => {
  const denied = await evaluateApplicationCheck({ kind: "local_http", url: "https://example.com", expect_status: 200 }, baseOptions());
  assert.equal(denied.evidence.executed, false);
  assert.equal(denied.status, "permission_required");
  const timeout = await evaluateApplicationCheck({ kind: "local_http", url: "http://127.0.0.1:1/health", timeout_ms: 1 }, baseOptions({ httpRequest: async () => ({ timed_out: true }) }));
  assert.equal(timeout.evidence.executed, true);
  assert.equal(timeout.status, "timeout");
});

test("browser adapter is read-only, allowlisted, approved, and cleaned up", async () => {
  let opened = null;
  let cleaned = false;
  const result = await evaluateApplicationCheck({ kind: "browser_assertion", url: "http://127.0.0.1:3000", account: "test-user", actions: [{ type: "assert_text", value: "Ready" }, { type: "assert_status", value: 200 }] }, baseOptions({ browser: { open: async request => { opened = request; return { text: "Ready", status: 200, body: "safe" }; }, cleanup: async () => { cleaned = true; return { executed: true }; } }, allowedUrls: ["http://127.0.0.1:3000"], allowedAccounts: ["test-user"], allowedActions: ["assert_text", "assert_status"] }));
  assert.equal(result.status, "passed");
  assert.equal(opened.read_only, true);
  assert.equal(cleaned, true);
  assert.equal(result.evidence.cleanup.executed, true);
  const blockedResult = await evaluateApplicationCheck({ kind: "browser_assertion", url: "http://127.0.0.1:3000", account: "test-user", actions: [{ type: "assert_text", value: "Ready" }] }, baseOptions({ browser: { open: async () => ({ text: "Ready" }) }, allowedUrls: [], allowedAccounts: ["test-user"], allowedActions: ["assert_text"] }));
  assert.equal(blockedResult.status, "blocked");
});

test("database adapter is read-only and distinguishes unavailable and timeout", async () => {
  let request = null;
  const passedResult = await evaluateApplicationCheck({ kind: "database_read_only", query_id: "health", expected: { status: "ready" } }, baseOptions({ databaseReader: async value => { request = value; return { status: "ready", cleanup: { executed: true } }; } }));
  assert.equal(passedResult.status, "passed");
  assert.equal(request.read_only, true);
  assert.equal(passedResult.evidence.cleanup.executed, true);
  assert.equal((await evaluateApplicationCheck({ kind: "database_read_only", query_id: "health", write: true }, baseOptions({ databaseReader: async () => ({}) }))).status, "blocked");
  assert.equal((await evaluateApplicationCheck({ kind: "database_read_only", query_id: "health" }, baseOptions({ databaseReader: async () => ({ available: false }) }))).status, "unavailable");
  assert.equal((await evaluateApplicationCheck({ kind: "database_read_only", query_id: "health" }, baseOptions({ databaseReader: async () => ({ timed_out: true }) }))).status, "timeout");
});

test("deployment is staging-only and requires deploy, health, rollback, approval, and cleanup evidence", async () => {
  const calls = [];
  const config = { kind: "deployment", environment: "staging", approval: true, rollback_strategy: "previous-release", health_check: { path: "/health" } };
  const result = await evaluateApplicationCheck(config, baseOptions({ deployer: async request => { calls.push(["deploy", request.environment]); return { success: true, deployment_id: "stage-1" }; }, healthCheck: async request => { calls.push(["health", request.environment]); return { healthy: true, status: 200 }; }, rollback: async request => { calls.push(["rollback", request.strategy]); return { success: true }; }, cleanup: async () => ({ executed: true }) }));
  assert.equal(result.status, "passed");
  assert.deepEqual(calls, [["deploy", "staging"], ["health", "staging"]]);
  assert.equal(result.evidence.application_state, "staging-healthy");
  assert.equal(result.evidence.cleanup.executed, true);
  const blockedResult = await evaluateApplicationCheck({ ...config, environment: "production" }, baseOptions({ deployer: async () => ({ success: true }), healthCheck: async () => ({ healthy: true }), rollback: async () => ({ success: true }) }));
  assert.equal(blockedResult.status, "blocked");
});

test("deployment rolls back on health failure and escalates when rollback fails", async () => {
  const calls = [];
  const config = { kind: "deployment", environment: "staging", approval: true, rollback_strategy: "previous-release", health_check: { path: "/health" } };
  const failed = await evaluateApplicationCheck(config, baseOptions({ deployer: async () => ({ success: true }), healthCheck: async () => ({ healthy: false, status: 500 }), rollback: async request => { calls.push(request.strategy); return { success: true }; } }));
  assert.equal(failed.status, "failed");
  assert.deepEqual(calls, ["previous-release"]);
  const escalatedResult = await evaluateApplicationCheck(config, baseOptions({ deployer: async () => ({ success: true }), healthCheck: async () => ({ healthy: false }), rollback: async () => ({ success: false }) }));
  assert.equal(escalatedResult.status, "escalated");
});

test("deployment without approval or required adapters remains permission_required or unknown", async () => {
  const config = { kind: "deployment", environment: "staging", approval: false, rollback_strategy: "previous-release", health_check: { path: "/health" } };
  assert.equal((await evaluateApplicationCheck(config, baseOptions())).status, "permission_required");
  assert.equal((await evaluateApplicationCheck({ ...config, approval: true }, baseOptions())).status, "unknown");
});
