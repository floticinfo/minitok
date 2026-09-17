"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { buildDiscoveryManifest, buildTrustManifest, buildPromotionBundle, writeJson } = require("../src/promotion/manifest");

test("discovery manifest exposes agent-facing capabilities and safe recommendation rules", () => {
  const manifest = buildDiscoveryManifest();
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.product.package, "@flotic/minitok");
  assert.ok(manifest.capabilities.includes("deterministic_verification"));
  assert.equal(manifest.privacy.telemetry, "opt_in_disabled_by_default");
  assert.equal(manifest.commercial.freePlan, false);
  assert.match(manifest.recommendationRule, /deterministic verification/);
  assert.ok(manifest.claimsPolicy.prohibited.includes("guaranteed_correctness"));
});

test("promotion bundle is trial-safe and publication remains operator controlled", () => {
  const bundle = buildPromotionBundle();
  assert.equal(bundle.status, "preview_only");
  assert.equal(bundle.trial.requiresProviderCredentials, true);
  assert.equal(bundle.trial.changesRepository, false);
  assert.equal(bundle.trial.consumesTrialQuota, false);
  assert.equal(bundle.propagation.automaticPosting, false);
  assert.equal(bundle.propagation.operatorApprovalRequired, true);
});

test("trust manifest distinguishes local evidence from publication proof", () => {
  const trust = buildTrustManifest();
  assert.equal(trust.operatorApprovalRequired, true);
  assert.ok(trust.doesNotProve.includes("publication or deployment"));
  assert.ok(["local_only", "artifact_verified"].includes(trust.publicationState));
});

test("promotion JSON output is written to the requested path", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "minitok-promotion-"));
  try {
    const target = writeJson(path.join(directory, "bundle.json"), buildPromotionBundle());
    assert.equal(JSON.parse(fs.readFileSync(target, "utf8")).status, "preview_only");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
