"use strict";

const fs = require("fs");
const path = require("path");
const readline = require("readline");

function selectionPath(repoRoot) {
  return path.join(path.resolve(repoRoot), ".minitok", "selection.json");
}

function normalizeSelection(repoRoot, value) {
  const workspaceRoot = path.resolve(value?.workspace_root || value?.workspace || repoRoot);
  const provider = typeof value?.provider === "string" ? value.provider.trim().toLowerCase() : "";
  if (!workspaceRoot || !provider) return null;
  return {
    schema_version: 1,
    workspace_root: workspaceRoot,
    provider,
    selected_at: typeof value?.selected_at === "string" ? value.selected_at : new Date().toISOString(),
  };
}

function loadSelection(repoRoot) {
  try {
    const value = JSON.parse(fs.readFileSync(selectionPath(repoRoot), "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    return normalizeSelection(repoRoot, value);
  } catch { return null; }
}

function saveSelection(repoRoot, value) {
  const selection = normalizeSelection(repoRoot, value);
  if (!selection) throw new Error("A selection requires workspace_root and provider");
  const target = selectionPath(repoRoot);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.tmp.${process.pid}`;
  fs.writeFileSync(temp, `${JSON.stringify(selection, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, target);
  return target;
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  return new Promise(resolve => rl.question(question, answer => { rl.close(); resolve(answer.trim()); }));
}

async function chooseCandidate(kind, candidates) {
  if (candidates.length === 1) return candidates[0];
  if (!process.stdin.isTTY || !process.stderr.isTTY) return null;
  process.stderr.write(`\nMultiple ${kind} candidates were found. Select one:\n`);
  candidates.forEach((candidate, index) => {
    const label = candidate.repository_root || candidate.provider || candidate.name;
    const source = candidate.source ? ` [${candidate.source}]` : "";
    process.stderr.write(`  ${index + 1}) ${label}${source}\n`);
  });
  const answer = await ask(`Choice (1-${candidates.length}, or cancel): `);
  const index = Number(answer) - 1;
  return Number.isInteger(index) && candidates[index] ? candidates[index] : null;
}

module.exports = { selectionPath, normalizeSelection, loadSelection, saveSelection, chooseCandidate };
