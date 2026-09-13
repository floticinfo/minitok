"use strict";

/**
 * Timestamp acceptance for the signed entitlement payload.
 *
 * The previous check required `new Date(value).toISOString() === value`, which
 * also demanded milliseconds. An issuer that signed a valid ISO instant such as
 * `2026-01-01T00:00:00Z` would have turned every customer's entitlement into
 * MALFORMED, so the accepted shapes need explicit coverage.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const { isValidTimestamp, validatePayload, canonicalize } = require("./model");

test("accepts canonical ISO instants with or without milliseconds", () => {
  for (const value of ["2026-01-01T00:00:00Z", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.5Z", "2026-01-01T00:00:00.123Z", "2026-01-01T01:00:00+01:00"]) {
    assert.equal(isValidTimestamp(value), true, value);
  }
});

test("rejects unusable timestamps", () => {
  for (const value of ["", "not-a-date", "2026-13-01T00:00:00Z", "2026-01-01", "2026-01-01T00:00:00", "2026-01-01T00:00:00ZZ", 123, null, undefined, {}]) {
    assert.equal(isValidTimestamp(value), false, JSON.stringify(value));
  }
});

test("a payload signed without milliseconds remains valid and verifiable", () => {
  const payload = {
    entitlement_id: "3f1b0c9e-6f1a-4a1f-8f0e-2b3c4d5e6f70",
    plan_id: "select",
    features: ["evolution_upload"],
    max_devices: 1,
    issued_at: "2026-01-01T00:00:00Z",
    expires_at: "2027-01-01T00:00:00Z",
    key_id: "k1",
  };
  const result = validatePayload(payload);
  assert.equal(result.valid, true, result.reason);
  // Canonicalization uses the signed strings verbatim, so widening the accepted
  // formats cannot change what is verified against the signature.
  assert.equal(canonicalize(payload), JSON.stringify(Object.fromEntries(Object.entries(payload).sort())));
});
