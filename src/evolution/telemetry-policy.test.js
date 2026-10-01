"use strict";

const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { PLAN_POLICIES, getTelemetryPolicy, canUploadTelemetry } = require("./telemetry-policy");

describe("commercial plan telemetry policy", () => {
  it("defines Level 1 as no telemetry", () => {
    assert.deepEqual(PLAN_POLICIES.level1, { mode: "none", retention_days: 0, requires_consent: false });
    assert.equal(canUploadTelemetry({ entitlement: { plan_id: "level1" } }, true).allowed, false);
    assert.equal(canUploadTelemetry({ entitlement: { plan_id: "level1" } }, false).allowed, false);
  });
  it("denies telemetry for trialing subscriptions", () => {
    assert.equal(canUploadTelemetry({ entitlement: { plan_id: "trial" }, subscription: { status: "trialing" } }, true).allowed, false);
  });
  it("fails closed for unknown plans", () => {
    assert.equal(getTelemetryPolicy("unknown").mode, "none");
    assert.equal(canUploadTelemetry({ entitlement: { plan_id: "unknown" } }, true).allowed, false);
  });
});
