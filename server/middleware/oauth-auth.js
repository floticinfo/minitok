/**
 * OAuth Token Verification — local JWT verification for OAuth access tokens.
 *
 * The OAuth server (minitok-server-deploy) issues JWT access tokens signed with
 * a shared secret. This module verifies those tokens locally without calling
 * the auth server's introspection endpoint.
 *
 * Security invariants:
 *  - Verify signature, issuer, audience, and expiration locally
 *  - Fail closed: any verification error rejects the request, never grants
 *  - Never log or key caches by the raw token; use a sha256 digest
 */

const { createHash } = require("node:crypto");
const { verify: jwtVerify } = require("../services/jwt");

function hashSecret(value) { return createHash('sha256').update(value).digest('hex'); }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CUSTOMER_TOKEN_RESERVED_CLAIMS = new Set(['installation_id', 'token_type', 'device_code', 'refresh_token', 'provider_token']);

function classifyCustomerTokenClaims(claims, { requireCanonicalBinding = true } = {}) {
  if (!claims || typeof claims !== 'object' || Array.isArray(claims)) return { valid: false, reason: 'Malformed customer claims' };
  if (requireCanonicalBinding && (typeof claims.iss !== 'string' || claims.iss !== 'minitok-server')) return { valid: false, reason: 'Customer token required' };
  if (requireCanonicalBinding && (typeof claims.aud !== 'string' || claims.aud !== 'minitok:customer')) return { valid: false, reason: 'Customer token required' };
  if (typeof claims.sub !== 'string' || !UUID_RE.test(claims.sub)) return { valid: false, reason: 'Token missing valid customer identity' };
  if ([...CUSTOMER_TOKEN_RESERVED_CLAIMS].some((claim) => Object.prototype.hasOwnProperty.call(claims, claim))) return { valid: false, reason: 'Customer token required' };
  if (claims.exp !== undefined && (typeof claims.exp !== 'number' || !Number.isFinite(claims.exp))) return { valid: false, reason: 'Malformed customer claims' };
  if (claims.iat !== undefined && (typeof claims.iat !== 'number' || !Number.isFinite(claims.iat))) return { valid: false, reason: 'Malformed customer claims' };
  return { valid: true, customerId: claims.sub };
}

// OAuth JWT verification configuration
const OAUTH_JWT_SECRET = process.env.OAUTH_JWT_SECRET || process.env.MINITOK_JWT_SECRET || "minitok-oauth-dev-secret";
const OAUTH_ISSUER = process.env.OAUTH_JWT_ISSUER || "minitok-server";
const OAUTH_AUDIENCE = process.env.OAUTH_JWT_AUDIENCE || "minitok:customer";

/**
 * Verify an OAuth access token locally.
 *
 * @param {string} token - OAuth access token (JWT format)
 * @returns {{ valid: boolean, customerId?: string, error?: string }}
 */
function verifyOAuthToken(token) {
  if (!token || typeof token !== 'string') {
    return { valid: false, error: 'Token must be a non-empty string' };
  }

  // Verify JWT signature, issuer, audience, and expiration
  const result = jwtVerify(token, OAUTH_JWT_SECRET, {
    issuer: OAUTH_ISSUER,
    audience: OAUTH_AUDIENCE,
  });

  if (!result.valid) {
    return { valid: false, error: result.error || 'Invalid OAuth token' };
  }

  // Classify and validate customer claims
  const classified = classifyCustomerTokenClaims(result.payload, { requireCanonicalBinding: true });
  if (!classified.valid) {
    return { valid: false, error: classified.reason };
  }

  return { valid: true, customerId: classified.customerId };
}

module.exports = { verifyOAuthToken, classifyCustomerTokenClaims, hashSecret };