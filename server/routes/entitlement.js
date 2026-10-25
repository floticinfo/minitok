"use strict";

const express = require("express");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const store = require("../models/entitlement");
const { requireAuth, JWT_SECRET, TOKEN_TTL_SECONDS } = require("../middleware/auth");
const { rateLimit } = require("../middleware/rate-limit");
const { verifyOAuthToken } = require("../middleware/oauth-auth");

const router = express.Router();

function signToken(record) {
  return jwt.sign(
    {
      sub: record.installationId,
      plan: record.planId,
      features: record.features,
    },
    JWT_SECRET,
    {
      expiresIn: TOKEN_TTL_SECONDS,
      issuer: "minitok-entitlement",
      // Unique token id per issuance: without it, two tokens minted in the same
      // second are byte-identical (iat/exp have second granularity), which makes
      // refresh indistinguishable from a replay.
      jwtid: crypto.randomUUID(),
    }
  );
}

function statusBody(record) {
  return {
    active: store.isActive(record),
    plan: record.planId,
    features: record.features,
    installation_id: record.installationId,
    activated_at: record.activatedAt,
    expires_at: record.expiresAt,
    revoked_at: record.revokedAt,
  };
}

// POST /api/entitlement/activate — validate a license key, issue a JWT.
router.post("/activate", rateLimit, (req, res) => {
  const key = req.body && req.body.key;
  const check = store.validateKey(key);
  if (!check.valid) {
    return res.status(401).json({ error: check.reason });
  }

  // Re-activation with the same key reuses the installation id so a client
  // that lost its token does not burn a second device slot.
  let record = store.findByKey(check.key);
  if (record && record.revokedAt) {
    return res.status(403).json({ error: "This activation key has been revoked." });
  }
  if (!record) {
    record = store.create({ key: check.key, installationId: crypto.randomUUID(), planId: check.planId });
  }

  return res.status(200).json({
    token: signToken(record),
    token_type: "Bearer",
    expires_in: TOKEN_TTL_SECONDS,
    entitlement: statusBody(record),
  });
});

// GET /api/entitlement/me — resolve entitlement from an auth-server JWT.
//
// The OAuth access_token is a JWT signed by the auth server. This server
// verifies the token locally using the shared secret, then looks up the
// entitlement bound to that customer. This lets the Extension check
// entitlement after OAuth login without requiring a separate license key.
router.get("/me", rateLimit, (req, res) => {
  const header = req.get("Authorization") || "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) {
    return res.status(401).json({ error: "Authorization: Bearer <auth-token> header is required." });
  }
  
  const result = verifyOAuthToken(match[1]);
  
  if (!result.valid) {
    return res.status(401).json({ active: false, error: result.error || "Invalid OAuth token" });
  }
  
  const record = store.findByCustomerId(result.customerId);
  if (!record) {
    return res.status(404).json({ active: false, error: "No entitlement found for this account." });
  }
  return res.status(200).json(statusBody(record));
});

// POST /api/entitlement/bind — link a license key to an auth-server customer.
//
// Activation is license-key based and carries no OAuth identity, so this is the
// one path that fills record.customerId and makes GET /me resolvable. The key
// authorizes the binding; the auth token is verified locally to obtain the
// customer_id rather than trusting a client-supplied value.
router.post("/bind", rateLimit, (req, res) => {
  const key = req.body && req.body.key;
  const authToken = req.body && (req.body.auth_token || req.body.authToken);
  const check = store.validateKey(key);
  if (!check.valid) {
    return res.status(401).json({ error: check.reason });
  }
  const record = store.findByKey(check.key);
  if (!record) {
    return res.status(404).json({ error: "Activate this key before binding it to an account." });
  }
  if (record.revokedAt) {
    return res.status(403).json({ error: "This activation key has been revoked." });
  }
  if (typeof authToken !== "string" || !authToken.trim()) {
    return res.status(400).json({ error: "An auth_token is required." });
  }
  
  const result = verifyOAuthToken(authToken);
  
  if (!result.valid) {
    return res.status(401).json({ error: result.error || "The auth token is not valid." });
  }
  
  const updated = store.bindCustomerId(check.key, result.customerId);
  return res.status(200).json({ bound: true, customer_id: result.customerId, entitlement: statusBody(updated) });
});

// GET /api/entitlement/status — verify the bearer token, return state.
router.get("/status", requireAuth, (req, res) => {
  const record = store.findByInstallationId(req.entitlement.sub);
  if (!record) {
    return res.status(404).json({ active: false, error: "No entitlement found for this token." });
  }
  return res.status(200).json(statusBody(record));
});

// POST /api/entitlement/refresh — exchange a valid (or freshly expired) token for a new one.
router.post("/refresh", (req, res) => {
  const header = req.get("Authorization") || "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) {
    return res.status(401).json({ error: "Authorization: Bearer <token> header is required." });
  }
  let payload;
  try {
    payload = jwt.verify(match[1], JWT_SECRET);
  } catch (error) {
    // Allow a grace window for expired tokens so a client that was offline can
    // refresh without re-entering the key. Tampered tokens are still rejected.
    if (error && error.name === "TokenExpiredError") {
      payload = jwt.decode(match[1]);
    } else {
      return res.status(401).json({ error: "The session token is invalid.", code: "token_invalid" });
    }
  }

  const record = payload && store.findByInstallationId(payload.sub);
  if (!record) {
    return res.status(404).json({ error: "No entitlement found for this token." });
  }
  if (!store.isActive(record)) {
    return res.status(403).json({ error: "This entitlement is no longer active." });
  }

  return res.status(200).json({
    token: signToken(record),
    token_type: "Bearer",
    expires_in: TOKEN_TTL_SECONDS,
    entitlement: statusBody(record),
  });
});

// DELETE /api/entitlement — revoke the entitlement bound to the token.
router.delete("/", requireAuth, (req, res) => {
  const record = store.findByInstallationId(req.entitlement.sub);
  if (!record) {
    return res.status(404).json({ error: "No entitlement found for this token." });
  }
  const revoked = store.revoke(record.key);
  return res.status(200).json({ revoked: true, entitlement: statusBody(revoked) });
});

module.exports = router;
