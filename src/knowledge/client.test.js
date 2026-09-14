"use strict";
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { KnowledgeConsent } = require("../evolution/consent");
const { getIndexCapabilities, withdrawKnowledgeConsent, createTrainingJob } = require("./client");

describe("knowledge client safety contracts", () => {
  it("withdraws local consent before sending confirmed server withdrawal", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "minitok-client-consent-"));
    try {
      const consent = new KnowledgeConsent(path.join(dir, "consent.json")); consent.enable("project_knowledge");
      const original = global.fetch; let request;
      global.fetch = async (_url, options) => { request = JSON.parse(options.body); return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } }); };
      try { await withdrawKnowledgeConsent("https://localhost", "project_knowledge", { consent, token: "token" }); } finally { global.fetch = original; }
      assert.equal(consent.isEnabled("project_knowledge"), false); assert.equal(request.confirmation, true); assert.equal(request.purpose, "project_knowledge");
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  it("does not allow arbitrary training purposes", async () => { const consent = { isEnabled: scope => scope === "tenant_training" }; await assert.rejects(() => createTrainingJob("https://localhost", "repo", "global_training", { consent, token: "token" }), /Only tenant_training/); });
  it("uses GET for index capabilities", async () => { const original = global.fetch; let method; global.fetch = async (_url, options) => { method = options.method; return new Response(JSON.stringify({ capabilities: [] }), { status: 200, headers: { "content-type": "application/json" } }); }; try { await getIndexCapabilities("https://localhost", { token: "token" }); } finally { global.fetch = original; } assert.equal(method, "GET"); });
});
