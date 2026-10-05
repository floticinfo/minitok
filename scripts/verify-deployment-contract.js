#!/usr/bin/env node
"use strict";

/**
 * verify-deployment-contract.js
 *
 * Verifies that the OAuth server (minitok-server-deploy) and the entitlement
 * server (this repo's server/) agree on the JWT signing contract, and that the
 * entitlement server correctly verifies tokens the OAuth server would issue.
 *
 * Usage:
 *   node scripts/verify-deployment-contract.js
 *
 * Reads OAUTH_JWT_SECRET (or MINITOK_JWT_SECRET) from the environment. If unset,
 * uses the development fallback (minitok-oauth-dev-secret) and prints a warning.
 *
 * Exits 0 on success, 1 on failure.
 */

const { sign, verify } = require("../server/services/jwt");
const { verifyOAuthToken, classifyCustomerTokenClaims } = require("../server/middleware/oauth-auth");

const OAUTH_JWT_SECRET = process.env.OAUTH_JWT_SECRET || process.env.MINITOK_JWT_SECRET || "minitok-oauth-dev-secret";
const OAUTH_ISSUER = process.env.OAUTH_JWT_ISSUER || "minitok-server";
const OAUTH_AUDIENCE = process.env.OAUTH_JWT_AUDIENCE || "minitok:customer";

const TEST_CUSTOMER_ID = "a1b2c3d4-e5f6-4890-a1b2-c3d4e5f6a7b8";

let failures = 0;
function check(name, condition, detail) {
  if (condition) {
    console.log(`  PASS ${name}`);
  } else {
    console.error(`  FAIL ${name}`);
    if (detail) console.error(`    ${detail}`);
    failures++;
  }
}

function section(title) {
  console.log(`\n-- ${title} --`);
}

section("Secret configuration");
check(
  "Secret is set",
  OAUTH_JWT_SECRET && OAUTH_JWT_SECRET !== "minitok-oauth-dev-secret",
  OAUTH_JWT_SECRET === "minitok-oauth-dev-secret"
    ? "Using development fallback. Set OAUTH_JWT_SECRET in production."
    : "No secret configured."
);

section("Issuer/Audience contract");
check("Issuer is 'minitok-server'", OAUTH_ISSUER === "minitok-server");
check("Audience is 'minitok:customer'", OAUTH_AUDIENCE === "minitok:customer");

section("Token roundtrip");
const now = Math.floor(Date.now() / 1000);
const token = sign(
  { sub: TEST_CUSTOMER_ID, iss: OAUTH_ISSUER, aud: OAUTH_AUDIENCE, iat: now, exp: now + 3600 },
  OAUTH_JWT_SECRET
);
check("Token is a non-empty string", typeof token === "string" && token.length > 0);

const verified = verify(token, OAUTH_JWT_SECRET, { issuer: OAUTH_ISSUER, audience: OAUTH_AUDIENCE });
check("Token verifies with shared secret", verified.valid === true, verified.error);
check("Subject preserved", verified.payload && verified.payload.sub === TEST_CUSTOMER_ID);

section("Entitlement server acceptance");
const oauthResult = verifyOAuthToken(token);
check("verifyOAuthToken accepts valid token", oauthResult.valid === true, oauthResult.error);
check("Customer ID extracted from sub", oauthResult.customerId === TEST_CUSTOMER_ID);


section("Forgery resistance");
// Wrong secret
const forgedWrongSecret = sign(
  { sub: TEST_CUSTOMER_ID, iss: OAUTH_ISSUER, aud: OAUTH_AUDIENCE, iat: now, exp: now + 3600 },
  "wrong-secret-12345"
);
check("Token signed with wrong secret is rejected", verifyOAuthToken(forgedWrongSecret).valid === false);

// Wrong issuer
const forgedWrongIss = sign(
  { sub: TEST_CUSTOMER_ID, iss: "evil-issuer", aud: OAUTH_AUDIENCE, iat: now, exp: now + 3600 },
  OAUTH_JWT_SECRET
);
check("Token with wrong issuer is rejected", verifyOAuthToken(forgedWrongIss).valid === false);

// Wrong audience
const forgedWrongAud = sign(
  { sub: TEST_CUSTOMER_ID, iss: OAUTH_ISSUER, aud: "minitok:installation", iat: now, exp: now + 3600 },
  OAUTH_JWT_SECRET
);
check("Token with wrong audience is rejected", verifyOAuthToken(forgedWrongAud).valid === false);

// Payload tampering (swap sub after signing)
const parts = token.split(".");
const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
payload.sub = "b2c3d4e5-f6a7-4901-b2c3-d4e5f6a7b8c9";
parts[1] = Buffer.from(JSON.stringify(payload)).toString("base64url");
check("Payload tampering is rejected", verifyOAuthToken(parts.join(".")).valid === false);

// Expired token
const expiredToken = sign(
  { sub: TEST_CUSTOMER_ID, iss: OAUTH_ISSUER, aud: OAUTH_AUDIENCE, iat: now - 7200, exp: now - 3600 },
  OAUTH_JWT_SECRET
);
check("Expired token is rejected", verifyOAuthToken(expiredToken).valid === false);

// Reserved claims rejected (installation token shape)
const installationToken = sign(
  { sub: TEST_CUSTOMER_ID, iss: OAUTH_ISSUER, aud: "minitok:installation", installation_id: "inst-123", iat: now, exp: now + 3600 },
  OAUTH_JWT_SECRET
);
check("Installation token is rejected", verifyOAuthToken(installationToken).valid === false);

section("Claim classification");
check(
  "Missing sub is rejected",
  classifyCustomerTokenClaims({ iss: OAUTH_ISSUER, aud: OAUTH_AUDIENCE }, { requireCanonicalBinding: true }).valid === false
);
check(
  "Non-UUID sub is rejected",
  classifyCustomerTokenClaims({ iss: OAUTH_ISSUER, aud: OAUTH_AUDIENCE, sub: "not-a-uuid" }, { requireCanonicalBinding: true }).valid === false
);

console.log(`\n${"=".repeat(50)}`);
if (failures === 0) {
  console.log("OK All deployment contract checks passed.");
  if (OAUTH_JWT_SECRET === "minitok-oauth-dev-secret") {
    console.log("\nWARNING: Using development secret. Set OAUTH_JWT_SECRET in production.");
  }
  process.exit(0);
} else {
  console.error(`FAIL ${failures} check(s) failed.`);
  process.exit(1);
}
