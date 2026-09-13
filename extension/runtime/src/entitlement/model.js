"use strict";

/**
 * Entitlement Model — schema validation and canonical serialization.
 *
 * The entitlement is the signed authorization artifact that governs
 * minitok's runtime access. This module defines the schema and provides
 * deterministic canonicalization for signature verification.
 *
 * Signed payload structure (new format with installation binding):
 * {
 *   entitlement_id,   // UUID
 *   installation_id,  // UUID — PHASE 13 installation binding
 *   plan_id,          // string
 *   features,         // string[]
 *   max_devices,      // positive integer
 *   issued_at,        // ISO 8601 UTC
 *   expires_at,       // ISO 8601 UTC
 *   key_id            // string
 * }
 *
 * LEGACY ARTIFACTS:
 * Entitlements without installation_id remain parseable and are flagged as
 * LEGACY for migration diagnostics, but they are not runtime-authorized.
 * Installation binding is required for runtime authorization.
 */

const VALID_PLAN_IDS = ["open", "select", "private"];

/**
 * Check whether a value is a valid ISO 8601 instant.
 *
 * The previous implementation required `d.toISOString() === v`, which also
 * demanded milliseconds: an issuer that signed `2026-01-01T00:00:00Z` (a valid
 * ISO instant) would have turned every customer's entitlement into MALFORMED.
 * Accept the canonical forms while still rejecting anything unparseable.
 */
function isValidTimestamp(v) {
  if (typeof v !== "string") return false;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.test(v)) return false;
  return !isNaN(new Date(v).getTime());
}

/**
 * Check whether a value is a valid UUID v4.
 * @param {*} v
 * @returns {boolean}
 */
function isValidUUID(v) {
  return typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
}

/**
 * Validate a single entitlement payload (the signed portion).
 * Returns { valid: true, payload } or { valid: false, reason }.
 *
 * @param {*} payload
 * @returns {{ valid: boolean, payload?: object, reason?: string, legacy?: boolean }}
 */
function validatePayload(payload) {
  if (payload === null || payload === undefined || typeof payload !== "object" || Array.isArray(payload)) {
    return { valid: false, reason: "Payload must be a non-null object" };
  }

  const required = ["entitlement_id", "plan_id", "features", "max_devices", "issued_at", "expires_at", "key_id"];
  // PHASE 13: installation_id is now part of the signed payload.
  // Legacy artifacts remain parseable for migration diagnostics but are not runtime-authorized.
  const hasInstallationId = "installation_id" in payload;

  for (const field of required) {
    if (!(field in payload)) {
      return { valid: false, reason: `Missing required field: ${field}` };
    }
  }

  // Check for unexpected fields
  const allowed = new Set([...required, "installation_id"]);
  for (const key of Object.keys(payload)) {
    if (!allowed.has(key)) {
      return { valid: false, reason: `Unexpected field: ${key}` };
    }
  }

  if (!isValidUUID(payload.entitlement_id)) {
    return { valid: false, reason: "Invalid entitlement_id format" };
  }

  if (typeof payload.plan_id !== "string" || !VALID_PLAN_IDS.includes(payload.plan_id)) {
    return { valid: false, reason: `Invalid plan_id: ${JSON.stringify(payload.plan_id)}` };
  }

  if (!Array.isArray(payload.features) || !payload.features.every(f => typeof f === "string")) {
    return { valid: false, reason: "features must be an array of strings" };
  }

  if (typeof payload.max_devices !== "number" || !Number.isInteger(payload.max_devices) || payload.max_devices < 1) {
    return { valid: false, reason: "max_devices must be a positive integer" };
  }

  if (!isValidTimestamp(payload.issued_at)) {
    return { valid: false, reason: "Invalid issued_at timestamp" };
  }

  if (!isValidTimestamp(payload.expires_at)) {
    return { valid: false, reason: "Invalid expires_at timestamp" };
  }

  const issued = new Date(payload.issued_at).getTime();
  const expires = new Date(payload.expires_at).getTime();
  if (expires <= issued) {
    return { valid: false, reason: "expires_at must be after issued_at" };
  }

  if (typeof payload.key_id !== "string" || payload.key_id.length === 0) {
    return { valid: false, reason: "key_id must be a non-empty string" };
  }

  // PHASE 13: Validate installation_id if present (new format)
  if (hasInstallationId) {
    if (!isValidUUID(payload.installation_id)) {
      return { valid: false, reason: "Invalid installation_id format" };
    }
  }

  return { valid: true, payload, legacy: !hasInstallationId };
}

/**
 * Validate a complete entitlement artifact (payload + signature + key_id at top level).
 *
 * @param {*} artifact
 * @returns {{ valid: boolean, payload?: object, signature?: string, key_id?: string, reason?: string, legacy?: boolean }}
 */
function validateArtifact(artifact) {
  if (artifact === null || artifact === undefined || typeof artifact !== "object" || Array.isArray(artifact)) {
    return { valid: false, reason: "Artifact must be a non-null object" };
  }

  if (!("payload" in artifact) || !("signature" in artifact) || !("key_id" in artifact)) {
    return { valid: false, reason: "Artifact must have payload, signature, and key_id" };
  }

  // Top-level key_id must match payload key_id
  if (typeof artifact.key_id !== "string" || artifact.key_id.length === 0) {
    return { valid: false, reason: "key_id must be a non-empty string" };
  }

  if (artifact.key_id !== artifact.payload.key_id) {
    return { valid: false, reason: "key_id mismatch between artifact and payload" };
  }

  if (typeof artifact.signature !== "string" || artifact.signature.length === 0) {
    return { valid: false, reason: "signature must be a non-empty string" };
  }

  const payloadResult = validatePayload(artifact.payload);
  if (!payloadResult.valid) {
    return { valid: false, reason: payloadResult.reason };
  }

  return { valid: true, payload: artifact.payload, signature: artifact.signature, key_id: artifact.key_id, legacy: payloadResult.legacy === true };
}

/**
 * Produce a deterministic canonical JSON representation of the payload.
 * Keys are sorted lexicographically. No whitespace. No trailing commas.
 *
 * This ensures that the same semantic payload always produces the same
 * byte sequence for signature verification.
 *
 * @param {object} payload
 * @returns {string}
 */
function canonicalize(payload) {
  const sorted = {};
  for (const key of Object.keys(payload).sort()) {
    sorted[key] = payload[key];
  }
  return JSON.stringify(sorted);
}

module.exports = {
  validatePayload,
  validateArtifact,
  canonicalize,
  isValidTimestamp,
  isValidUUID,
  VALID_PLAN_IDS,
};
