"use strict";
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { KnowledgeConsent, KNOWLEDGE_CONSENT_SCOPES } = require("./consent");

describe("knowledge consent scopes", () => {
  it("defaults every scope to off and persists independently", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "minitok-consent-"));
    try { const consent = new KnowledgeConsent(path.join(dir, "consent.json")); assert.deepEqual(consent.status(), Object.fromEntries(KNOWLEDGE_CONSENT_SCOPES.map(scope => [scope, false]))); consent.enable("project_knowledge"); consent.enable("retrieval"); assert.equal(consent.isEnabled("project_knowledge"), true); assert.equal(consent.isEnabled("tenant_training"), false); consent.disable("project_knowledge"); assert.equal(consent.isEnabled("project_knowledge"), false); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  it("rejects unknown scopes", () => { assert.throws(() => new KnowledgeConsent(path.join(os.tmpdir(), "consent-test.json")).enable("global"), /Unknown consent scope/); });
});
