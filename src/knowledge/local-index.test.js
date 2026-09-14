"use strict";
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { LocalKnowledgeIndex } = require("./local-index");
const { exportKnowledgeFile } = require("./export");
const { allocateContextBudget } = require("./context");

describe("local project knowledge", () => {
  it("filters secrets and retrieves relevant chunks", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "minitok-local-"));
    try { fs.mkdirSync(path.join(root, "src")); fs.writeFileSync(path.join(root, "src", "answer.js"), "export function answer() { return true; }\n"); fs.writeFileSync(path.join(root, ".env"), "API_KEY=secret\n"); const index = new LocalKnowledgeIndex(root); assert.equal(index.build(["src/answer.js", ".env"]).files, 1); assert.equal(index.query("answer", { limit: 1 })[0].file, "src/answer.js"); } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  it("allocates a bounded context budget", () => { const result = allocateContextBudget({ task: "t".repeat(100), retrieved: "r".repeat(100) }, 80); assert.ok(result.total_chars <= 80); });
  it("rejects secret-like content before export", () => { assert.equal(exportKnowledgeFile("src/config.js", "api_key=secret").allowed, false); });
});
