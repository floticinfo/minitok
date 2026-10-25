"use strict";

/**
 * The VS Code extension must talk to the routes the server actually serves.
 *
 * [2026-10-22 F1단계] The extension's HTTP client called the retired Phase 1
 * entitlement routes. The server answers every one of them with
 * `404 Route ... not found`, so the sidebar could not activate, validate or
 * revoke an entitlement, and the "no plan" it showed was indistinguishable
 * from a broken call.
 *
 * The canonical contract is the /v1 API. The extension reads the account view
 * from `/v1/account` and drives activation through the CLI, which owns the
 * installation identity and calls `/v1/activate`. These tests pin that, and
 * assert that no extension source names a retired route.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const entitlement = fs.readFileSync(path.join(root, "src", "entitlement.ts"), "utf8");
const sidebar = fs.readFileSync(path.join(root, "src", "sidebar.ts"), "utf8");

// ── the canonical contract ──────────────────────────────────────────────────

test("the extension reads the account view from the canonical route", () => {
  assert.match(entitlement, /\/v1\/account/, "the account view must come from /v1/account");
  assert.match(entitlement, /Authorization: `Bearer \$\{token\}`/, "the account view is customer-authenticated");
});

test("no extension source names a retired entitlement route", () => {
  const walk = (dir) => {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!["node_modules", "dist", ".git"].includes(entry.name)) out.push(...walk(full));
      } else if (/\.(ts|js|html)$/.test(entry.name)) {
        out.push(full);
      }
    }
    return out;
  };
  for (const file of walk(path.join(root, "src"))) {
    const content = fs.readFileSync(file, "utf8");
    assert.ok(
      !content.includes("/api/entitlement"),
      `${path.relative(root, file)} must not name a retired entitlement route`,
    );
  }
});

test("the extension activates through the CLI, which owns the installation identity", () => {
  // A plan permits exactly one installation. An activation that minted its own
  // installation id would occupy a second device slot and fail with 409, so the
  // extension must not activate over HTTP on its own.
  assert.match(entitlement, /spawnSpec\(cliPath\(\), \["activate", "--key-env", ACTIVATION_KEY_ENV\]\)/);
  assert.match(sidebar, /await activateEntitlement\(trimmed\)/);
  assert.doesNotMatch(sidebar, /bindLicenseToAccount/);
});

test("the extension issues no entitlement request of its own", () => {
  // The only server route the extension calls is the account view. Activation,
  // validation and revocation all belong to the CLI, which owns the signed
  // artifact and the installation record.
  const calls = [...entitlement.matchAll(/fetch\(`\$\{[^}]+\}(\/[^`]*)`/g)].map((m) => m[1]);
  assert.deepEqual(calls, ["/v1/account"]);
});

// ── the entitlement decision ────────────────────────────────────────────────

test("the entitlement decision comes from the CLI's canonical status check", () => {
  assert.match(entitlement, /spawnSpec\(cliPath\(\), \["status", "--json"\]\)/);
  assert.match(entitlement, /entitlement\.allowed === true/);
});

test("a server outage is not reported as a missing plan", () => {
  // The CLI gate denies on its own; the account view then separates "this
  // account has no plan" from "the server is unreachable", so an outage is not
  // reported as a missing plan and a missing plan is not reported as an outage.
  assert.match(entitlement, /account\.status >= 500/);
  assert.match(entitlement, /Entitlement server error:/);
});

test("the account view can grant access the local artifact has not caught up with", () => {
  assert.match(entitlement, /if \(account\.ok && account\.active\)/);
});

test("the server's own paid flag decides, not a re-derived one", () => {
  // `paid` folds the subscription status and the billing period together on
  // the server. Re-deriving it in the client would repeat that rule in a
  // second place, and the two would drift.
  assert.match(entitlement, /s\?\.paid === true/);
  assert.match(entitlement, /paid\?\.plan_id \|\| activeEntitlement\?\.plan_id/);
});

test("an account without a plan is denied with an actionable message", () => {
  assert.match(entitlement, /An active paid minitok plan is required\./);
});

// ── admin session ───────────────────────────────────────────────────────────

test("the admin session is labelled distinctly from a paid plan", () => {
  assert.match(entitlement, /plan:\s*"admin"/);
  assert.match(sidebar, /hasAdminSession/);
});
