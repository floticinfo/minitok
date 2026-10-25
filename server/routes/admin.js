"use strict";

const express = require("express");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const store = require("../models/entitlement");
const { JWT_SECRET } = require("../middleware/auth");
const { rateLimit } = require("../middleware/rate-limit");

const router = express.Router();

/**
 * Admin API for the homepage device manager.
 *
 * The page authenticates with the customer's activation key. The admin token
 * is a short-lived JWT bound to that key (`scope: "admin"`), so the bearer
 * credential in browser storage never is the raw license key.
 */
const ADMIN_TOKEN_TTL_SECONDS = 60 * 30; // 30 minutes

function signAdminToken(key) {
  return jwt.sign(
    { scope: "admin", key },
    JWT_SECRET,
    { expiresIn: ADMIN_TOKEN_TTL_SECONDS, issuer: "minitok-entitlement", jwtid: crypto.randomUUID() }
  );
}

function requireAdmin(req, res, next) {
  const header = req.get("Authorization") || "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) {
    return res.status(401).json({ error: "Authorization: Bearer <token> header is required." });
  }
  try {
    const payload = jwt.verify(match[1], JWT_SECRET);
    if (payload.scope !== "admin" || typeof payload.key !== "string") {
      return res.status(403).json({ error: "Admin scope is required." });
    }
    req.admin = payload;
    return next();
  } catch (error) {
    const expired = error && error.name === "TokenExpiredError";
    return res.status(401).json({
      error: expired ? "The admin session has expired. Sign in again." : "The admin session is invalid.",
      code: expired ? "token_expired" : "token_invalid",
    });
  }
}

/** Public JSON shape for one device/installation record. */
function adminBody(record) {
  return {
    id: record.installationId,
    plan: record.planId,
    features: record.features,
    max_devices: record.maxDevices,
    active: store.isActive(record),
    device_name: record.deviceName,
    activated_at: record.activatedAt,
    expires_at: record.expiresAt,
    revoked_at: record.revokedAt,
    last_seen_at: record.lastSeenAt,
  };
}

// POST /api/admin/session — exchange a license key for a short admin session.
router.post("/session", rateLimit, (req, res) => {
  const key = req.body && req.body.key;
  const check = store.validateKey(key);
  if (!check.valid) {
    return res.status(401).json({ error: check.reason });
  }
  const record = store.findByKey(check.key);
  if (!record) {
    return res.status(404).json({ error: "This key has not been activated on any device yet." });
  }
  if (record.revokedAt) {
    return res.status(403).json({ error: "This activation key has been revoked." });
  }
  return res.status(200).json({
    token: signAdminToken(check.key),
    token_type: "Bearer",
    expires_in: ADMIN_TOKEN_TTL_SECONDS,
  });
});

// GET /api/admin/entitlements — devices bound to the signed-in key.
router.get("/entitlements", requireAdmin, (req, res) => {
  const record = store.findByKey(req.admin.key);
  if (!record) return res.status(404).json({ error: "No entitlement found for this key." });
  return res.status(200).json({ devices: [adminBody(record)] });
});

// DELETE /api/admin/entitlements/:id — release a device (revoke the key binding).
router.delete("/entitlements/:id", requireAdmin, (req, res) => {
  const record = store.findByInstallationId(req.params.id);
  if (!record || record.key !== req.admin.key) {
    return res.status(404).json({ error: "No device found for this key." });
  }
  if (record.revokedAt) {
    return res.status(409).json({ error: "This device has already been released.", device: adminBody(record) });
  }
  const revoked = store.revoke(record.key);
  return res.status(200).json({ revoked: true, device: adminBody(revoked) });
});

module.exports = router;