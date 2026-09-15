"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const script = fs.readFileSync(path.join(root, "scripts", "release-artifact-check.mjs"), "utf8");
const packer = fs.readFileSync(path.join(root, "scripts", "package-extension.mjs"), "utf8");
const reporter = fs.readFileSync(path.join(root, "scripts", "artifact-report.mjs"), "utf8");
const manifest = fs.readFileSync(path.join(root, "scripts", "release-manifest.mjs"), "utf8");
const registry = fs.readFileSync(path.join(root, "scripts", "registry-compat.mjs"), "utf8");
const installer = fs.readFileSync(path.join(root, "scripts", "install-verified.cmd"), "utf8");
const marketplace = fs.readFileSync(path.join(root, "scripts", "marketplace-compat.mjs"), "utf8");

test("current release manifests use the canonical CLI version", () => {
  const cli = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const runtime = JSON.parse(fs.readFileSync(path.join(root, "extension", "runtime", "package.json"), "utf8"));
  const role = fs.readFileSync(path.join(root, "MINITOK_ARTIFACT_ROLE.txt"), "utf8");
  assert.equal(runtime.version, cli.version);
  assert.match(role, new RegExp(`VERSION: ${cli.version.replaceAll(".", "\\.")}`));
});

test("release artifact checks define one authoritative extension output", () => {
  assert.match(packer, /outputRoot = path\.join\(extensionRoot, "artifacts"\)/);
  assert.match(packer, /minitok-extension-\$\{packageJson\.version\}\.vsix/);
  assert.match(packer, /rmSync/);
  assert.match(script, /stale VSIX artifacts/);
});

test("release diagnostics distinguish dirty candidates", () => {
  assert.match(script, /DIRTY CANDIDATE \(not releasable source\)/);
  assert.match(script, /CLEAN SOURCE \(artifact checks still required\)/);
  assert.match(script, /sha256/);
});

test("artifact checks enforce npm and extension manifest identity", () => {
  assert.match(script, /@flotic\/minitok/);
  assert.match(script, /minitok-extension/);
  assert.match(script, /extensionJson\.version/);
  assert.match(script, /runtimeJson\.version !== packageJson\.version/);
  assert.match(script, /extensionJson\.minitok\?\.cliPackage !== packageJson\.name/);
  assert.match(script, /readVsixManifest/);
  assert.match(script, /vsixManifest\.runtime\.version/);
  assert.match(reporter, /manifestMatches/);
  assert.match(reporter, /embeddedRuntime\.version/);
});

test("stage 2 reports deterministic artifact states and package evidence", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  assert.equal(manifest.scripts["artifact:report"], "node scripts/artifact-report.mjs report");
  assert.match(reporter, /status: "generated"/);
  assert.match(reporter, /"missing"/);
  assert.match(reporter, /staleStatus: "stale"/);
  assert.match(reporter, /inspectExtensionArtifacts/);
  assert.match(reporter, /unpackedSize/);
  assert.match(reporter, /notificationStatus: 202/);
  assert.match(reporter, /stdio-entry\.js/);
  assert.match(reporter, /POST \/mcp/);
  assert.match(packer, /stale/);
  assert.match(script, /stale VSIX artifacts/);
  assert.match(script, /authoritative/);
});

test("marketplace compatibility check excludes development payloads", () => {
  assert.match(marketplace, /vsce/);
  assert.match(marketplace, /node_modules/);
  assert.match(marketplace, /\.test/);
  assert.match(marketplace, /required/);
});

test("release safeguards are fail-closed and integrity based", () => {
  assert.match(manifest, /source worktree is dirty/);
  assert.match(manifest, /HEAD is untagged/);
  assert.match(manifest, /sha512/);
  assert.match(registry, /MINITOK_ALLOW_LIVE_REGISTRY/);
  assert.match(registry, /validateRegistryMetadata/);
  assert.match(installer, /verify-package\.mjs/);
  assert.match(installer, /npm pack/);
});

test("artifact checks keep the canonical VSIX and remove stale candidates", () => {
  assert.doesNotMatch(script, /rmSync/);
  assert.match(packer, /rmSync/);
  assert.doesNotMatch(packer, /undici\/lib\/mock/);
});

test("artifact reports verify embedded runtime and CLI compatibility metadata", () => {
  assert.match(reporter, /extensionManifest\.minitok\?\.cliPackage === cliJson\.name/);
  assert.match(reporter, /extensionManifest\.minitok\?\.cliVersion === cliJson\.version/);
  assert.match(reporter, /runtimeManifest\.name === runtimeJson\.name/);
  assert.match(reporter, /runtimeManifest\.version === runtimeJson\.version/);
});

test("cross-artifact report separates provenance from external states", () => {
  assert.match(reporter, /inspectSourceState/);
  assert.match(reporter, /worktree: status \? "DIRTY" : "CLEAN"/);
  assert.match(reporter, /publication: "UNVERIFIED"/);
  assert.match(reporter, /production: "UNVERIFIED"/);
  assert.match(reporter, /approval: "NOT_GRANTED"/);
  assert.match(reporter, /tarballHash/);
  assert.match(reporter, /authoritativeEvidence/);
  assert.match(reporter, /stdio-entry\.js/);
});
