/**
 * Minimal JWT Service — HMAC-SHA256
 *
 * No external dependencies. Uses Node.js native crypto.
 * Produces standard JWTs: header.payload.signature
 */

const { createHmac } = require("node:crypto");

const ALG = "HS256";
const HEADER = Object.freeze({ alg: ALG, typ: "JWT" });

/**
 * Base64url encode a buffer or string.
 * @param {Buffer|string} data
 * @returns {string}
 */
function base64urlEncode(data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf-8");
  return buf.toString("base64url");
}

/**
 * Base64url decode a string to a Buffer.
 * @param {string} str
 * @returns {Buffer}
 */
function base64urlDecode(str) {
  return Buffer.from(str, "base64url");
}

/**
 * Constant-time comparison of two buffers.
 * @param {Buffer} a
 * @param {Buffer} b
 * @returns {boolean}
 */
function cryptoConstantTimeCompare(a, b) {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a[i] ^ b[i];
  }
  return result === 0;
}

/**
 * Sign a payload and produce a JWT string.
 *
 * @param {object} payload - Claims to include in the token
 * @param {string} secret - HMAC-SHA256 signing secret
 * @param {object} [options] - Additional options
 * @param {number} [options.expiresInSeconds] - Token lifetime in seconds
 * @param {number} [options.expiryDays] - Token lifetime in days (alternative to expiresInSeconds)
 * @returns {string} Compact JWT string
 */
function sign(payload, secret, options = {}) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("payload must be a non-null object");
  }
  if (typeof secret !== "string" || secret.length === 0) {
    throw new Error("secret must be a non-empty string");
  }

  const now = Math.floor(Date.now() / 1000);
  const claims = { ...payload };

  // Set iat if not provided
  if (claims.iat === undefined) {
    claims.iat = now;
  }

  // Set exp based on options
  if (claims.exp === undefined) {
    if (options.expiresInSeconds !== undefined) {
      claims.exp = claims.iat + options.expiresInSeconds;
    } else if (options.expiryDays !== undefined) {
      claims.exp = claims.iat + options.expiryDays * 86400;
    }
  }

  const headerB64 = base64urlEncode(JSON.stringify(HEADER));
  const payloadB64 = base64urlEncode(JSON.stringify(claims));
  const signingInput = `${headerB64}.${payloadB64}`;

  const signature = createHmac("sha256", secret)
    .update(signingInput)
    .digest();

  const sigB64 = base64urlEncode(signature);
  return `${signingInput}.${sigB64}`;
}

/**
 * Verify a JWT token and return the decoded payload.
 *
 * @param {string} token - Compact JWT string
 * @param {string} secret - HMAC-SHA256 signing secret
 * @param {object} [options]
 * @param {string} [options.issuer] - If set, token must carry a matching `iss` claim
 * @param {string} [options.audience] - If set, token must carry a matching `aud` claim
 * @returns {{ valid: boolean, payload?: object, error?: string }}
 */
function verify(token, secret, options = {}) {
  if (typeof token !== "string" || token.length === 0) {
    return { valid: false, error: "Token must be a non-empty string" };
  }
  if (typeof secret !== "string" || secret.length === 0) {
    return { valid: false, error: "Secret must be a non-empty string" };
  }

  const parts = token.split(".");
  if (parts.length !== 3) {
    return { valid: false, error: "Invalid token format: expected 3 parts" };
  }

  const [headerB64, payloadB64, sigB64] = parts;

  // Verify header
  let header;
  try {
    header = JSON.parse(base64urlDecode(headerB64).toString("utf-8"));
  } catch {
    return { valid: false, error: "Invalid header encoding" };
  }
  // Reject algorithm confusion attacks (e.g., "none", "HS256" vs "hs256")
  if (typeof header.alg !== "string" || header.alg !== ALG) {
    return { valid: false, error: "Unsupported algorithm" };
  }
  // Reject unexpected header fields
  const allowedHeaderKeys = new Set(["alg", "typ"]);
  for (const k of Object.keys(header)) {
    if (!allowedHeaderKeys.has(k)) {
      return { valid: false, error: "Unexpected header field" };
    }
  }

  // Verify signature
  const signingInput = `${headerB64}.${payloadB64}`;
  const expectedSig = createHmac("sha256", secret)
    .update(signingInput)
    .digest();
  const receivedSig = base64urlDecode(sigB64);

  if (expectedSig.length !== receivedSig.length ||
      !cryptoConstantTimeCompare(expectedSig, receivedSig)) {
    return { valid: false, error: "Invalid signature" };
  }

  // Decode payload
  let payload;
  try {
    payload = JSON.parse(base64urlDecode(payloadB64).toString("utf-8"));
  } catch {
    return { valid: false, error: "Invalid payload encoding" };
  }

  // Check expiration
  if (payload.exp !== undefined) {
    const now = Math.floor(Date.now() / 1000);
    if (now >= payload.exp) {
      return { valid: false, error: "Token expired", payload };
    }
  }

  // Check issuer
  if (options.issuer !== undefined) {
    if (payload.iss !== options.issuer) {
      return { valid: false, error: "Invalid issuer", payload };
    }
  }

  // Check audience
  if (options.audience !== undefined) {
    if (payload.aud !== options.audience) {
      return { valid: false, error: "Invalid audience", payload };
    }
  }

  return { valid: true, payload };
}

module.exports = { sign, verify };