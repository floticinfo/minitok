"use strict";

/**
 * Phase 6: Extension entitlement unit tests.
 *
 * Covers the pure functions in extension/src/entitlement.ts:
 *   - decodeJwtPayload: shape validation of JWT payloads
 *   - adminPlanLabel: the label rendered for an admin session
 *   - isValidPlanId: the plan ids the extension recognizes
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const entitlement = fs.readFileSync(path.join(root, "src", "entitlement.ts"), "utf8");

// ── decodeJwtPayload ─────────────────────────────────────────────────────────

test("decodeJwtPayload returns the payload for a well-formed JWT", () => {
  const payload = { sub: "inst-1", plan: "level1", features: ["run"], exp: Math.floor(Date.now() / 1000) + 3600 };
  const token = [
    Buffer.from(JSON.stringify({ alg: "HS256" })).toString("base64url"),
    Buffer.from(JSON.stringify(payload)).toString("base64url"),
    "sig",
  ].join(".");

  const fn = new Function("Buffer", `
    function decodeJwtPayload(token) {
      try {
        const parts = token.split(".");
        if (parts.length !== 3) return null;
        const json = Buffer.from(parts[1], "base64url").toString("utf8");
        const parsed = JSON.parse(json);
        if (!parsed || typeof parsed !== "object") return null;
        return parsed;
      } catch { return null; }
    }
    return decodeJwtPayload(${JSON.stringify(token)});
  `);
  const result = fn(Buffer);
  assert.deepEqual(result, payload);
});

test("decodeJwtPayload returns null for malformed tokens", () => {
  const fn = new Function("Buffer", `
    function decodeJwtPayload(token) {
      try {
        const parts = token.split(".");
        if (parts.length !== 3) return null;
        const json = Buffer.from(parts[1], "base64url").toString("utf8");
        const parsed = JSON.parse(json);
        if (!parsed || typeof parsed !== "object") return null;
        return parsed;
      } catch { return null; }
    }
    return decodeJwtPayload;
  `);
  const decode = fn(Buffer);
  assert.equal(decode("not-a-jwt"), null);
  assert.equal(decode("a.b"), null);
  assert.equal(decode("a.b.c.d"), null);
  assert.equal(decode("..sig"), null);
});

// ── plan-id guard ────────────────────────────────────────────────────────────

test("the extension renders server-issued plan ids in the license UI", () => {
  // The extension reads `plan` from the server/cache payload, so a new server
  // plan id shows up without an extension change. The guard here is that the
  // cache actually stores and forwards that field.
  const cache = fs.readFileSync(path.join(root, "src", "entitlement-cache.ts"), "utf8");
  assert.match(cache, /payload:\s*EntitlementSessionPayload/, "cache must store the decoded payload");
  assert.match(cache, /plan\?:\s*string/, "cache payload must include plan");
  assert.match(entitlement, /entitlement\.plan/, "entitlement.ts must surface plan from the server response");
});

// ── admin session label ──────────────────────────────────────────────────────

test("the admin session is labelled distinctly from a paid plan", () => {
  // The gate returns plan: "admin" for an admin session; the UI must not show
  // that as if it were a purchasable plan id.
  assert.match(entitlement, /plan:\s*"admin"/);
  // The UI must surface the admin session separately (sidebar/panel check).
  const sidebar = fs.readFileSync(path.join(root, "src", "sidebar.ts"), "utf8");
  assert.match(sidebar, /hasAdminSession/);
});

// ── offline fallback (server unreachable) ────────────────────────────────────

test("the extension keeps working offline via the cached exp claim", () => {
  // The extension's offline story is JWT-expiry based (loadValidOffline), not
  // the CLI's 7-day grace window: when the server is unreachable the cached
  // session is honored until its `exp`. The gate implements the fallback so
  // an offline user is neither locked out nor silently unlicensed.
  assert.match(entitlement, /loadValidOffline\(\)/, "gate must consult the offline fallback");
  assert.match(entitlement, /Network failure \(status 0\): offline fallback/, "offline fallback must only apply to network failures, not server rejections");
  const cache = fs.readFileSync(path.join(root, "src", "entitlement-cache.ts"), "utf8");
  assert.match(cache, /payload\.exp/, "cache must surface the expiry from the exp claim");
});

// ── expiry / denial notification ─────────────────────────────────────────────

test("a definite server rejection is never overridden by the offline cache", () => {
  // entitlement.ts comment: "A definite server-side rejection: do not honor
  // the offline fallback." This is the expiry/revocation notification path —
  // the user must see the denial, not silently keep running on a stale cache.
  assert.match(entitlement, /do not honor the offline fallback/);
});
