"use strict";

const jwt = require("jsonwebtoken");

/**
 * JWT verification middleware.
 *
 * Expects `Authorization: Bearer <token>`. On success the decoded payload is
 * attached to `req.entitlement` so downstream handlers can read the
 * installation id, plan, and expiry without re-verifying.
 *
 * The secret comes from the environment in production; the development
 * fallback is exported so tests and the token issuer stay in sync.
 */
const DEV_SECRET = "minitok-entitlement-dev-secret";
const JWT_SECRET = process.env.MINITOK_JWT_SECRET || DEV_SECRET;
const TOKEN_TTL_SECONDS = 60 * 60 * 24; // 24h access token

function requireAuth(req, res, next) {
  const header = req.get("Authorization") || "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) {
    return res.status(401).json({ error: "Authorization: Bearer <token> header is required." });
  }
  try {
    const payload = jwt.verify(match[1], JWT_SECRET);
    req.entitlement = payload;
    return next();
  } catch (error) {
    const expired = error && error.name === "TokenExpiredError";
    return res.status(401).json({
      error: expired ? "The session token has expired. Refresh or reactivate." : "The session token is invalid.",
      code: expired ? "token_expired" : "token_invalid",
    });
  }
}

module.exports = { requireAuth, JWT_SECRET, TOKEN_TTL_SECONDS };
