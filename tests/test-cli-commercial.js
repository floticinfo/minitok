"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const pkg = require("../package.json");
const extensionPkg = require("../extension/package.json");
const ids = ["legal-owner-approval", "privacy-owner-approval", "support-commitments", "npm-publication-authorization", "marketplace-publisher-authorization", "registry-publication-verification", "production-operations"];
function approvalFor(id, status = "APPROVED") {
  const approval = { status, owner: "operator", decision: status === "APPROVED" ? "approved" : "not-approved", evidenceRef: { type: "external", reference: "operator-record" }, approvedAt: "2026-09-06T00:00:00Z" };
  if (id === "support-commitments") approval.support = { contactOwner: "support", sla: "business-hours", escalationOwner: "lead" };
  if (id === "npm-publication-authorization") approval.npmPublication = { package: pkg.name, version: pkg.version, registry: "https://registry.npmjs.org/" };
  if (id === "marketplace-publisher-authorization") approval.marketplacePublication = { publisher: "flotic", extension: "minitok-extension", version: extensionPkg.version };
  if (id === "production-operations") approval.productionOperations = { deploymentOwner: "deploy", databaseOwner: "database", rollbackOwner: "ops", monitoringOwner: "monitoring", signerOwner: "signer" };
  return approval;
}
function approvalManifest(status = "APPROVED") { return { schemaVersion: 2, release: { package: pkg.name, version: pkg.version, artifacts: { cli: { version: pkg.version, sha256: "a".repeat(64) }, vsix: { version: extensionPkg.version, sha256: "b".repeat(64) } } }, approvals: Object.fromEntries(ids.map(id => [id, approvalFor(id, status)])) }; }
test("verified installers exist and record integrity state", () => { for (const file of ["install-verified.sh", "install-verified.cmd"]) { const target = path.join(__dirname, "..", "scripts", file); assert.ok(fs.existsSync(target)); assert.match(fs.readFileSync(target, "utf8"), /previous|rollback/i); } });
test("terminal probe is platform-aware", () => { assert.equal(require("../src/cli/terminal-probe").runTerminalProbe().output.trim(), "minitok-pty"); });
test("commercial readiness keeps missing approvals blocked or unverified", async () => { const { evaluateCommercialReadiness } = await import("../scripts/commercial-readiness.mjs"); const documents = { "EULA.md": "> TODO: Legal owner must approve", "POLICY.md": "Legal review is required before publication. TODO: Operator must confirm", "README.md": "npm tarball includes runtime" }; const results = evaluateCommercialReadiness(file => documents[file] || "", { state: "MISSING", errors: ["not supplied"] }); assert.deepEqual(results.map(result => result.status), ["BLOCKED", "BLOCKED", "UNVERIFIED", "UNVERIFIED", "UNVERIFIED", "UNVERIFIED", "UNVERIFIED"]); });
test("commercial readiness rejects malformed approval manifests", async () => { const { readApprovalManifest } = await import("../scripts/commercial-readiness.mjs"); const result = readApprovalManifest(path.join(__dirname, "fixtures", "missing-approval-manifest.json")); assert.equal(result.state, "MALFORMED"); assert.ok(result.errors.length > 0); });
test("valid-shaped but unapproved approvals do not pass", async () => { const { evaluateCommercialReadiness } = await import("../scripts/commercial-readiness.mjs"); const results = evaluateCommercialReadiness(() => "", { state: "VALID", manifest: approvalManifest("NOT_APPROVED") }); assert.equal(results.some(result => result.status === "PASS"), false); });
test("complete approval manifest can pass commercial items", async () => { const { evaluateCommercialReadiness } = await import("../scripts/commercial-readiness.mjs"); assert.ok(evaluateCommercialReadiness(() => "", { state: "VALID", manifest: approvalManifest() }).every(result => result.status === "PASS")); });
test("approval validation rejects identity, timestamp, evidence, and ownership defects", async () => { const { validateApprovalManifest } = await import("../scripts/commercial-readiness.mjs"); const manifest = approvalManifest(); manifest.release = { package: "wrong", version: "0.0.0" }; for (const approval of Object.values(manifest.approvals)) { approval.evidenceRef = { type: "local", path: "missing" }; approval.approvedAt = "2999-01-01T00:00:00Z"; } delete manifest.approvals["support-commitments"].support; delete manifest.approvals["production-operations"].productionOperations; const errors = validateApprovalManifest(manifest); assert.ok(errors.some(error => error.includes("package/version"))); assert.ok(errors.some(error => error.includes("approvedAt"))); assert.ok(errors.some(error => error.includes("evidenceRef"))); assert.ok(errors.some(error => error.includes("support"))); assert.ok(errors.some(error => error.includes("productionOperations"))); });
test("approval validation accepts valid-shaped external evidence", async () => { const { validateApprovalManifest } = await import("../scripts/commercial-readiness.mjs"); assert.deepEqual(validateApprovalManifest(approvalManifest("NOT_APPROVED")), []); });
test("approval validation rejects template placeholders and stale artifact versions", async () => { const { validateApprovalManifest } = await import("../scripts/commercial-readiness.mjs"); const manifest = approvalManifest("PENDING"); manifest.approvals[ids[0]].owner = "REPLACE_WITH_OWNER"; manifest.release.artifacts.cli.version = "1.3.2"; const errors = validateApprovalManifest(manifest); assert.ok(errors.some(error => error.includes("placeholder"))); assert.ok(errors.some(error => error.includes("release.artifacts"))); });
test("approval validation tracks the current Extension VSIX version", async () => { const { validateApprovalManifest } = await import("../scripts/commercial-readiness.mjs"); assert.deepEqual(validateApprovalManifest(approvalManifest()), [], "an approval manifest declaring the current VSIX is accepted"); const stale = approvalManifest(); stale.release.artifacts.vsix.version = "0.0.1"; assert.ok(validateApprovalManifest(stale).some(error => error.includes("release.artifacts.vsix")), "a stale VSIX version is rejected"); });
test("the approval manifest example is fail-closed until the owners record decisions", async () => {
  const { validateApprovalManifest } = await import("../scripts/commercial-readiness.mjs");
  const example = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "scripts", "approval-manifest.example.json"), "utf8"));
  assert.ok(validateApprovalManifest(example).includes("manifest contains unresolved placeholder values"), "the unfilled example must never validate");
  // Fill it the way _howTo documents: replace the unresolved values, point the
  // versions at the current packages, and record the owner decisions.
  const filled = JSON.parse(JSON.stringify(example).replace(/PENDING|TODO|TBD|REPLACE_ME/g, "recorded").replace(/<[^>]+>/g, "the path"));
  filled.release.version = pkg.version;
  filled.release.artifacts.cli.version = pkg.version;
  filled.release.artifacts.cli.sha256 = "a".repeat(64);
  filled.release.artifacts.vsix.version = extensionPkg.version;
  filled.release.artifacts.vsix.sha256 = "b".repeat(64);
  filled.approvals["npm-publication-authorization"].npmPublication.version = pkg.version;
  filled.approvals["marketplace-publisher-authorization"].marketplacePublication.version = extensionPkg.version;
  for (const approval of Object.values(filled.approvals)) { approval.status = "APPROVED"; approval.approvedAt = "2026-09-06T00:00:00Z"; }
  assert.deepEqual(validateApprovalManifest(filled), [], "a copy filled in as documented validates");
});

test("the preparation helper refuses a stale release manifest before preparing approvals", async () => {
  const { spawnSync } = require("node:child_process");
  const dir = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "minitok-approval-prep-"));
  const out = path.join(dir, "approvals.json");
  try {
    const result = spawnSync(process.execPath, [path.join(__dirname, "..", "scripts", "approval-manifest-prepare.mjs"), "--out", out], { encoding: "utf8" });
    const releaseManifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "release-manifest.json"), "utf8"));
    if (releaseManifest.release.version !== pkg.version) {
      assert.equal(result.status, 1);
      assert.match(result.stderr, /release-manifest\.json describes/);
      assert.equal(fs.existsSync(out), false);
    } else {
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /notAnApproval/);
      const { validateApprovalManifest } = await import("../scripts/commercial-readiness.mjs");
      const prepared = JSON.parse(fs.readFileSync(out, "utf8"));
      assert.equal(prepared.release.version, pkg.version, "the CLI version is filled in");
      assert.equal(prepared.release.artifacts.cli.version, pkg.version);
      assert.equal(prepared.release.artifacts.cli.sha256, releaseManifest.release.artifact.sha256, "the recorded tarball hash is filled in");
      assert.ok([extensionPkg.version, "PENDING"].includes(prepared.release.artifacts.vsix.version), "the Extension version is filled in or explicitly unresolved");
      assert.ok(validateApprovalManifest(prepared).includes("manifest contains unresolved placeholder values"), "unfinished decisions must be rejected");
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


test("release verification includes unresolved commercial readiness", () => { const source = fs.readFileSync(path.join(__dirname, "..", "scripts", "release-verify.mjs"), "utf8"); assert.match(source, /evaluateCommercialReadiness/); assert.match(source, /BLOCKED|UNVERIFIED/); });
