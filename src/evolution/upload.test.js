"use strict";
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { uploadEvolutionOutcome } = require("./upload");

const VO = { status: "success", cycles: 3, duration_ms: 1000, files_changed: 2 };

function makeOpts(overrides = {}) {
  return {
    _entitlementCheck: { allowed: true, entitlement: { plan_id: "level1", features: ["evolution_upload"] } },
    _optIn: { isEnabled: () => true },
    serverUrl: "https://srv.ex", token: "jwt",
    ...overrides,
  };
}

describe("Upload - gate chain (A-N)", () => {
  it("A: Level 1 without upload feature → no upload", async () => {
    const r = await uploadEvolutionOutcome(VO, makeOpts({
      _entitlementCheck: { allowed: true, entitlement: { plan_id: "level1", features: ["basic_features"] } },
    }));
    assert.equal(r.sent, false);
    assert.match(r.reason, /evolution_upload/);
  });

  it("B: Level 1 opt-in=false → no upload", async () => {
    const r = await uploadEvolutionOutcome(VO, makeOpts({
      _optIn: { isEnabled: () => false },
    }));
    assert.equal(r.sent, false);
    assert.match(r.reason, /Telemetry is disabled|consent|opted-in|not authorized/);
  });

  it("C: Level 1 opt-in=true → policy blocks (no telemetry for Level 1)", async () => {
    let called = false;
    const mock = (u, b) => { called = true; return Promise.resolve({ ok: true, status: 201 }); };
    const r = await uploadEvolutionOutcome(VO, makeOpts({ _httpPost: mock }));
    assert.equal(r.sent, false);
    assert.match(r.reason, /Telemetry is disabled/);
    assert.equal(called, false, "no network request must be issued when the plan policy blocks telemetry");
  });

  it("D: Invalid signature → no upload", async () => {
    const r = await uploadEvolutionOutcome(VO, makeOpts({
      _entitlementCheck: { allowed: false, state: "INVALID_SIGNATURE" },
    }));
    assert.equal(r.sent, false);
  });

  it("E: No evolution_upload feature → no upload", async () => {
    const r = await uploadEvolutionOutcome(VO, makeOpts({
      _entitlementCheck: { allowed: true, entitlement: { features: ["basic"] } },
    }));
    assert.equal(r.sent, false);
  });

  it("F: Goal injection → sanitizer rejects", async () => {
    const r = await uploadEvolutionOutcome({ ...VO, goal: "secret" }, makeOpts());
    assert.equal(r.sent, false);
  });

  it("G: Summary injection → sanitizer rejects", async () => {
    const r = await uploadEvolutionOutcome({ ...VO, summary: "info" }, makeOpts());
    assert.equal(r.sent, false);
  });

  it("H: source_code injection → sanitizer rejects", async () => {
    const r = await uploadEvolutionOutcome({ ...VO, source_code: "x" }, makeOpts());
    assert.equal(r.sent, false);
  });

  it("I: Unknown field → sanitizer rejects", async () => {
    const r = await uploadEvolutionOutcome({ ...VO, foo: "bar" }, makeOpts());
    assert.equal(r.sent, false);
  });

  it("J: Invalid numeric range → sanitizer rejects", async () => {
    const r = await uploadEvolutionOutcome({ status: "success", cycles: 999999999, duration_ms: 100, files_changed: 1 }, makeOpts());
    assert.equal(r.sent, false);
  });

  it("K: Expired entitlement → no upload", async () => {
    const r = await uploadEvolutionOutcome(VO, makeOpts({
      _entitlementCheck: { allowed: false, state: "EXPIRED" },
    }));
    assert.equal(r.sent, false);
  });

  it("L: Invalid signature → no upload", async () => {
    const r = await uploadEvolutionOutcome(VO, makeOpts({
      _entitlementCheck: { allowed: false, state: "INVALID_SIGNATURE" },
    }));
    assert.equal(r.sent, false);
  });

  it("M: Server unreachable → policy blocks before any network attempt", async () => {
    let called = false;
    const mock = () => { called = true; return Promise.reject(new Error("ECONNREFUSED")); };
    const r = await uploadEvolutionOutcome(VO, makeOpts({ _httpPost: mock }));
    assert.equal(r.sent, false);
    assert.match(r.reason, /Telemetry is disabled/);
    assert.equal(called, false);
  });

  it("N: Malicious LLM output → sanitizer blocks", async () => {
    const bad = { ...VO, goal: "Fix auth", summary: "Modified auth.js", source_code: "const k='x'", file_path: "/src/auth.js", prompt: "Look at auth" };
    const r = await uploadEvolutionOutcome(bad, makeOpts());
    assert.equal(r.sent, false);
  });

  it("No server URL → no upload", async () => {
    const r = await uploadEvolutionOutcome(VO, makeOpts({ serverUrl: undefined }));
    assert.equal(r.sent, false);
  });

  it("No token → no upload", async () => {
    const r = await uploadEvolutionOutcome(VO, makeOpts({ token: undefined }));
    assert.equal(r.sent, false);
  });

  it("Server 403 → not sent (policy blocks before network)", async () => {
    let called = false;
    const mock = () => { called = true; return Promise.resolve({ ok: false, status: 403 }); };
    const r = await uploadEvolutionOutcome(VO, makeOpts({ _httpPost: mock }));
    assert.equal(r.sent, false);
    assert.equal(called, false);
  });

  it("Canary: Level 1 policy blocks upload before any HTTP body is constructed", async () => {
    let called = false;
    const mock = (u, b) => { called = true; return Promise.resolve({ ok: true, status: 201 }); };
    const r = await uploadEvolutionOutcome(VO, makeOpts({ _httpPost: mock }));
    assert.equal(r.sent, false);
    assert.match(r.reason, /Telemetry is disabled/);
    assert.equal(called, false, "no HTTP request must be issued for a no-telemetry plan");
  });
});
