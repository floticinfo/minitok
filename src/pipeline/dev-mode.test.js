"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { execSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { checkEntitlement, GateState } = require("../entitlement/gate");

function execGit(cwd, args) {
  execSync("git " + args, { cwd, stdio: "pipe" });
}

function tmpGitRepo() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "minitok-devmode-"));
  execGit(d, "init");
  execGit(d, "config user.email t@t.com");
  execGit(d, "config user.name T");
  fs.writeFileSync(path.join(d, "a.txt"), "a");
  execGit(d, "add -A");
  execGit(d, "commit -m init");
  return d;
}

describe("development mode gate bypass", () => {
  it("legacy skipEntitlementCheck fails closed", async () => {
    const { runPipeline } = require("./loop");
    await assert.rejects(() => runPipeline("t", { skipEntitlementCheck: true }), /skipEntitlementCheck is not supported/);
  });

  it("minitok_dev_mode does not bypass the entitlement gate", async () => {
    const previous = process.env.minitok_dev_mode;
    process.env.minitok_dev_mode = "1";
    try {
      const { runPipeline } = require("./loop");
      const d = tmpGitRepo();
      const emptyEntitlementDir = fs.mkdtempSync(path.join(os.tmpdir(), "minitok-ent-"));
      try {
        await assert.rejects(
          () => runPipeline("t", { repoRoot: d, entitlementDir: emptyEntitlementDir }),
          /Entitlement MISSING/
        );
      } finally {
        fs.rmSync(d, { recursive: true, force: true });
        fs.rmSync(emptyEntitlementDir, { recursive: true, force: true });
      }
    } finally {
      if (previous === undefined) delete process.env.minitok_dev_mode;
      else process.env.minitok_dev_mode = previous;
    }
  });
});

describe("entitlement gate fail-closed states", () => {
  it("fails closed for unknown key ids with a non-allow state", () => {
    const r = checkEntitlement({
      _loadArtifact: () => ({ key_id: "cv82-self", payload: { entitlement_id: "e1", installation_id: "i1", plan_id: "level1", features: [], max_devices: 1, issued_at: new Date().toISOString(), expires_at: new Date(Date.now() + 86400000).toISOString(), key_id: "cv82-self" }, signature: "AA" }),
      _loadGateState: () => ({ latest_observed_at: 0, last_validated_at: null }),
    });
    assert.equal(r.allowed, false);
    assert.ok([GateState.INVALID_SIGNATURE, GateState.MALFORMED].includes(r.state), `state=${r.state}`);
  });
});
