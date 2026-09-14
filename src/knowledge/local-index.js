"use strict";

const path = require("path");
const { collectKnowledgeFiles } = require("./export");

function tokenize(value) { return new Set(String(value).toLowerCase().split(/[^a-z0-9_$.-]+/).filter(token => token.length > 1)); }
function chunk(content, maxChars = 4000) { const value = String(content); const chunks = []; for (let i = 0; i < value.length; i += maxChars) chunks.push(value.slice(i, i + maxChars)); return chunks; }

class LocalKnowledgeIndex {
  constructor(repoRoot, options = {}) { this.repoRoot = path.resolve(repoRoot); this.maxChars = options.maxChars || 4000; this.documents = []; }
  build(files) {
    this.documents = [];
    for (const item of collectKnowledgeFiles(this.repoRoot, files)) {
      if (!item.allowed) continue;
      for (const [index, text] of chunk(item.content, this.maxChars).entries()) this.documents.push({ id: `${item.content_hash}:${index}`, file: item.file, text, terms: tokenize(text), content_hash: item.content_hash });
    }
    return { documents: this.documents.length, files: new Set(this.documents.map(item => item.file)).size };
  }
  query(query, options = {}) {
    const wanted = tokenize(query); const limit = Math.max(1, Math.min(Number(options.limit) || 5, 50));
    return this.documents.map(document => ({ document, score: [...wanted].reduce((score, term) => score + (document.terms.has(term) ? 1 : 0), 0) })).filter(item => item.score > 0).sort((a, b) => b.score - a.score || a.document.file.localeCompare(b.document.file)).slice(0, limit).map(item => ({ file: item.document.file, text: item.document.text, score: item.score, content_hash: item.document.content_hash }));
  }
  context(query, options = {}) { return this.query(query, options).map(item => `## ${item.file}\n${item.text}`).join("\n\n"); }
}
module.exports = { LocalKnowledgeIndex, tokenize, chunk };
