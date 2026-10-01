"use strict";
/**
 * M11 ??Client-side Evolution Upload: Adversarial Tests
 * Tests sanitizer, upload client, opt-in, and raw payload spy.
 */
const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { sanitizeEvolutionOutcome, ALLOWED_FIELDS } = require("../src/evolution/sanitize");
const { uploadEvolutionOutcome } = require("../src/evolution/upload");

// ============================================================
// SANITIZER TESTS
// ============================================================
describe("M11 ??Sanitizer: Allowlist", () => {
  const VALID = { status: "success", cycles: 3, duration_ms: 1000, files_changed: 2 };
  it("accepts minimal valid payload", () => {
    const r = sanitizeEvolutionOutcome(VALID);
    assert.equal(r.ok, true);
    assert.deepEqual(Object.keys(r.payload).sort(), ["status", "cycles", "duration_ms", "files_changed"].sort());
  });
  it("accepts all optional fields", () => {
    const full = { ...VALID, total_tokens: 5000, failure_category: "test" };
    const r = sanitizeEvolutionOutcome(full);
    assert.equal(r.ok, true);
    assert.equal(r.payload.total_tokens, 5000);
    assert.equal(r.payload.failure_category, "test");
  });
  it("rejects goal field", () => {
    assert.equal(sanitizeEvolutionOutcome({ ...VALID, goal: "Fix auth" }).ok, false);
  });
  it("rejects summary field", () => {
    assert.equal(sanitizeEvolutionOutcome({ ...VALID, summary: "Changed" }).ok, false);
  });
  it("rejects source_code field", () => {
    assert.equal(sanitizeEvolutionOutcome({ ...VALID, source_code: "x" }).ok, false);
  });
  it("rejects file_path field", () => {
    assert.equal(sanitizeEvolutionOutcome({ ...VALID, file_path: "/src/a" }).ok, false);
  });
  it("rejects file_name field", () => {
    assert.equal(sanitizeEvolutionOutcome({ ...VALID, file_name: "a.js" }).ok, false);
  });
  it("rejects prompt field", () => {
    assert.equal(sanitizeEvolutionOutcome({ ...VALID, prompt: "Fix" }).ok, false);
  });
  it("rejects observation field", () => {
    assert.equal(sanitizeEvolutionOutcome({ ...VALID, observation: {} }).ok, false);
  });
  it("rejects knowledge field", () => {
    assert.equal(sanitizeEvolutionOutcome({ ...VALID, knowledge: "x" }).ok, false);
  });
  it("rejects command_output field", () => {
    assert.equal(sanitizeEvolutionOutcome({ ...VALID, command_output: "x" }).ok, false);
  });
  it("rejects error_message field", () => {
    assert.equal(sanitizeEvolutionOutcome({ ...VALID, error_message: "x" }).ok, false);
  });
  it("rejects diff field", () => {
    assert.equal(sanitizeEvolutionOutcome({ ...VALID, diff: "+x" }).ok, false);
  });
  it("rejects project_name field", () => {
    assert.equal(sanitizeEvolutionOutcome({ ...VALID, project_name: "x" }).ok, false);
  });
  it("rejects repository_name field", () => {
    assert.equal(sanitizeEvolutionOutcome({ ...VALID, repository_name: "x" }).ok, false);
  });
  it("rejects any unknown field 'foo'", () => {
    assert.equal(sanitizeEvolutionOutcome({ ...VALID, foo: "bar" }).ok, false);
  });
});

// ============================================================
// SANITIZER: VALIDATION TESTS
// ============================================================
describe("M11 ??Sanitizer: Validation", () => {
  const BASE = { status: "success", cycles: 3, duration_ms: 1000, files_changed: 2 };
  it("rejects null input", () => {
    assert.equal(sanitizeEvolutionOutcome(null).ok, false);
  });
  it("rejects undefined input", () => {
    assert.equal(sanitizeEvolutionOutcome(undefined).ok, false);
  });
  it("rejects array input", () => {
    assert.equal(sanitizeEvolutionOutcome([]).ok, false);
  });
  it("rejects string input", () => {
    assert.equal(sanitizeEvolutionOutcome("x").ok, false);
  });
  it("rejects non-integer cycles", () => {
    assert.equal(sanitizeEvolutionOutcome({ ...BASE, cycles: 1.5 }).ok, false);
  });
  it("rejects negative cycles", () => {
    assert.equal(sanitizeEvolutionOutcome({ ...BASE, cycles: -1 }).ok, false);
  });
  it("rejects cycles > 100", () => {
    assert.equal(sanitizeEvolutionOutcome({ ...BASE, cycles: 101 }).ok, false);
  });
  it("rejects non-integer duration_ms", () => {
    assert.equal(sanitizeEvolutionOutcome({ ...BASE, duration_ms: 1.5 }).ok, false);
  });
  it("rejects duration_ms > 3600000", () => {
    assert.equal(sanitizeEvolutionOutcome({ ...BASE, duration_ms: 3600001 }).ok, false);
  });
  it("rejects files_changed > 1000", () => {
    assert.equal(sanitizeEvolutionOutcome({ ...BASE, files_changed: 1001 }).ok, false);
  });
  it("rejects total_tokens > 10000000", () => {
    assert.equal(sanitizeEvolutionOutcome({ ...BASE, total_tokens: 10000001 }).ok, false);
  });
  it("rejects invalid status enum", () => {
    assert.equal(sanitizeEvolutionOutcome({ ...BASE, status: "maybe" }).ok, false);
  });
  it("rejects invalid failure_category enum", () => {
    assert.equal(sanitizeEvolutionOutcome({ ...BASE, failure_category: "crash" }).ok, false);
  });
  it("rejects missing required status", () => {
    const { status, ...rest } = BASE;
    assert.equal(sanitizeEvolutionOutcome(rest).ok, false);
  });
  it("rejects missing required cycles", () => {
    const { cycles, ...rest } = BASE;
    assert.equal(sanitizeEvolutionOutcome(rest).ok, false);
  });
  it("rejects missing required duration_ms", () => {
    const { duration_ms, ...rest } = BASE;
    assert.equal(sanitizeEvolutionOutcome(rest).ok, false);
  });
  it("rejects missing required files_changed", () => {
    const { files_changed, ...rest } = BASE;
    assert.equal(sanitizeEvolutionOutcome(rest).ok, false);
  });
});

// ============================================================
// UPLOAD CLIENT: FAIL-CLOSED GATE TESTS
// ============================================================
describe("M11 ??Upload Client: Entitlement Gate", () => {
  const VALID = { status: "success", cycles: 3, duration_ms: 1000, files_changed: 2 };
  const OK_ENTITLEMENT = { allowed: true, entitlement: { plan_id: "level1", features: ["evolution_upload"] } };
  const NO_FEATURE_ENTITLEMENT = { allowed: true, entitlement: { features: ["basic_features"] } };
  const DENIED_ENTITLEMENT = { allowed: false, state: "MISSING" };
  const OPTIN_ON = { isEnabled: () => true };
  const OPTIN_OFF = { isEnabled: () => false };
  const noopHttp = async () => ({ ok: true, status: 201 });

  it("no entitlement ??no network request", async () => {
    let called = false;
    const r = await uploadEvolutionOutcome(VALID, {
      _entitlementCheck: DENIED_ENTITLEMENT, _optIn: OPTIN_ON,
      _httpPost: async () => { called = true; return { ok: true }; },
      serverUrl: "https://server", token: "jwt",
    });
    assert.equal(r.sent, false);
    assert.equal(called, false);
  });
  it("no evolution_upload feature ??no network request", async () => {
    let called = false;
    const r = await uploadEvolutionOutcome(VALID, {
      _entitlementCheck: NO_FEATURE_ENTITLEMENT, _optIn: OPTIN_ON,
      _httpPost: async () => { called = true; return { ok: true }; },
      serverUrl: "https://server", token: "jwt",
    });
    assert.equal(r.sent, false);
    assert.equal(called, false);
  });
  it("opt-in disabled ??no network request", async () => {
    let called = false;
    const r = await uploadEvolutionOutcome(VALID, {
      _entitlementCheck: OK_ENTITLEMENT, _optIn: OPTIN_OFF,
      _httpPost: async () => { called = true; return { ok: true }; },
      serverUrl: "https://server", token: "jwt",
    });
    assert.equal(r.sent, false);
    assert.equal(called, false);
  });
  it("sanitization failure ??no network request", async () => {
    let called = false;
    const r = await uploadEvolutionOutcome({ status: "success", goal: "secret" }, {
      _entitlementCheck: OK_ENTITLEMENT, _optIn: OPTIN_ON,
      _httpPost: async () => { called = true; return { ok: true }; },
      serverUrl: "https://server", token: "jwt",
    });
    assert.equal(r.sent, false);
    assert.equal(called, false);
  });
  it("missing serverUrl ??no network request", async () => {
    let called = false;
    const r = await uploadEvolutionOutcome(VALID, {
      _entitlementCheck: OK_ENTITLEMENT, _optIn: OPTIN_ON,
      _httpPost: async () => { called = true; return { ok: true }; },
      token: "jwt",
    });
    assert.equal(r.sent, false);
    assert.equal(called, false);
  });
  it("missing token ??no network request", async () => {
    let called = false;
    const r = await uploadEvolutionOutcome(VALID, {
      _entitlementCheck: OK_ENTITLEMENT, _optIn: OPTIN_ON,
      _httpPost: async () => { called = true; return { ok: true }; },
      serverUrl: "https://server",
    });
    assert.equal(r.sent, false);
    assert.equal(called, false);
  });
  it("all checks pass but Level 1 plan policy blocks upload", async () => {
    let called = false;
    const r = await uploadEvolutionOutcome(VALID, {
      _entitlementCheck: OK_ENTITLEMENT, _optIn: OPTIN_ON,
      _httpPost: async () => { called = true; return { ok: true, status: 201 }; },
      serverUrl: "https://server", token: "jwt",
    });
    assert.equal(r.sent, false);
    assert.match(r.reason, /Telemetry is disabled/);
    assert.equal(called, false, "no network request must be issued when the plan policy blocks telemetry");
  });
  it("server error ??not sent", async () => {
    const r = await uploadEvolutionOutcome(VALID, {
      _entitlementCheck: OK_ENTITLEMENT, _optIn: OPTIN_ON,
      _httpPost: async () => ({ ok: false, status: 500 }),
      serverUrl: "https://server", token: "jwt",
    });
    assert.equal(r.sent, false);
  });
  it("network error ??not sent", async () => {
    const r = await uploadEvolutionOutcome(VALID, {
      _entitlementCheck: OK_ENTITLEMENT, _optIn: OPTIN_ON,
      _httpPost: async () => { throw new Error("ECONNREFUSED"); },
      serverUrl: "https://server", token: "jwt",
    });
    assert.equal(r.sent, false);
  });
});

// ============================================================
// RAW PAYLOAD SPY ??CRITICAL TEST
// ============================================================
describe("M11 ??Raw Payload Spy: No Project Data Leakage", () => {
  const FORBIDDEN_STRINGS = [
    "goal", "summary", "prompt", "source_code", "file_path",
    "file_name", "repository", "project", "command_output",
    "observation", "knowledge", "diff", "error_message",
  ];
  const CANARY_VALUES = [
    "PROJECT_SECRET_CANARY_12345",
    "PROJECT_PATH_CANARY_67890",
    "PROMPT_CANARY_ABCDE",
  ];

  it("Level 1 plan policy blocks before any HTTP request", async () => {
    let called = false;
    const outcome = {
      status: "success", cycles: 3, duration_ms: 12345,
      files_changed: 4, total_tokens: 12000, failure_category: "test",
    };
    const r = await uploadEvolutionOutcome(outcome, {
      _entitlementCheck: { allowed: true, entitlement: { plan_id: "level1", features: ["evolution_upload"] } },
      _optIn: { isEnabled: () => true },
      _httpPost: async (url, body) => { called = true; return { ok: true, status: 201 }; },
      serverUrl: "https://server", token: "jwt",
    });
    assert.equal(r.sent, false);
    assert.match(r.reason, /Telemetry is disabled/);
    assert.equal(called, false, "HTTP must not be called for a no-telemetry plan");
  });

  it("no HTTP request is issued for Level 1, so no payload can leak", async () => {
    let capturedPayload = null;
    const outcome = {
      status: "success", cycles: 3, duration_ms: 1000, files_changed: 2,
      total_tokens: 5000, failure_category: "lint",
    };
    const r = await uploadEvolutionOutcome(outcome, {
      _entitlementCheck: { allowed: true, entitlement: { plan_id: "level1", features: ["evolution_upload"] } },
      _optIn: { isEnabled: () => true },
      _httpPost: async (url, body) => { capturedPayload = body; return { ok: true, status: 201 }; },
      serverUrl: "https://server", token: "jwt",
    });
    assert.equal(r.sent, false);
    assert.equal(capturedPayload, null, "No HTTP payload must exist when the plan policy blocks telemetry");
  });

  it("canary values never reach the network", async () => {
    let capturedPayload = null;
    // Outcome with canary values injected (simulating LLM output injection)
    const outcome = {
      status: "success", cycles: 3, duration_ms: 1000, files_changed: 2,
      goal: "PROJECT_SECRET_CANARY_12345",
      summary: "PROJECT_PATH_CANARY_67890",
      source_code: "PROMPT_CANARY_ABCDE",
    };
    await uploadEvolutionOutcome(outcome, {
      _entitlementCheck: { allowed: true, entitlement: { plan_id: "level1", features: ["evolution_upload"] } },
      _optIn: { isEnabled: () => true },
      _httpPost: async (url, body) => { capturedPayload = body; return { ok: true, status: 201 }; },
      serverUrl: "https://server", token: "jwt",
    });
    // Sanitizer should have rejected this ??no network request
    assert.equal(capturedPayload, null, "Sanitizer must reject canary-laced outcome ??no network request");
  });

  it("LLM output with file paths never reaches network", async () => {
    let capturedPayload = null;
    const outcome = {
      status: "failure", cycles: 5, duration_ms: 30000, files_changed: 0,
      summary: "Error in /home/user/project/src/auth.ts: module not found",
      goal: "Fix authentication in /repo/project/src/auth.js",
    };
    await uploadEvolutionOutcome(outcome, {
      _entitlementCheck: { allowed: true, entitlement: { plan_id: "level1", features: ["evolution_upload"] } },
      _optIn: { isEnabled: () => true },
      _httpPost: async (url, body) => { capturedPayload = body; return { ok: true, status: 201 }; },
      serverUrl: "https://server", token: "jwt",
    });
    assert.equal(capturedPayload, null, "Sanitizer must reject file paths ??no network request");
  });
});
