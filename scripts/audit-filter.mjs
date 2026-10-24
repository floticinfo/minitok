#!/usr/bin/env node
// Security gate: fail on any high/critical vulnerability whose root cause is
// not explicitly documented as an accepted, non-exploitable dependency risk.
//
// This script is intentionally fail-closed: adding a package to the documented
// risk list does not make the release pass. The list is used only to explain the
// remaining root cause and to require a separate, time-bounded acceptance record.
// The check re-arms automatically once a fixed dependency ships and npm stops
// reporting the advisory.
import { execSync } from "node:child_process";

// Root-cause advisory packages are listed for classification only. They are
// never automatically tolerated; package names rather than GHSA ids mean the
// check re-arms automatically once npm stops reporting them.
const DOCUMENTED_RISK_ROOTS = new Set(["node-forge", "zod", "@opentelemetry/core", "@ai-sdk/provider-utils"]);

function auditReport() {
  try {
    // Run npm through the shell: npm is always on PATH in both our dev and CI
    // environments, and this avoids cmd-shim spawn quirks on Windows.
    return JSON.parse(execSync("npm audit --json", { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 32 * 1024 * 1024 }));
  } catch (error) {
    if (error.stdout) return JSON.parse(error.stdout);
    throw error;
  }
}

const report = auditReport();
const vulnerabilities = report.vulnerabilities || {};

function rootAdvisories(name, seen = new Set()) {
  if (seen.has(name)) return [];
  seen.add(name);
  const entry = vulnerabilities[name];
  if (!entry) return [];
  const roots = [];
  for (const via of entry.via || []) {
    if (typeof via === "string") roots.push(...rootAdvisories(via, seen));
    else if (via?.name) roots.push(via.name);
  }
  return roots;
}

const offenders = [];
for (const [name, entry] of Object.entries(vulnerabilities)) {
  if (!["high", "critical"].includes(entry.severity)) continue;
  const roots = new Set(rootAdvisories(name));
  if (roots.size > 0 && [...roots].every(root => DOCUMENTED_RISK_ROOTS.has(root))) {
    console.error(`risk acceptance required (not automatically tolerated): ${name} <- ${[...roots].join(", ")}`);
    offenders.push(`${name} (documented risk roots require time-bounded acceptance: ${[...roots].join(", ")})`);
    continue;
  }
  offenders.push(`${name} (roots: ${[...roots].join(", ") || "unknown"})`);
}

if (offenders.length) {
  console.error("High/critical vulnerabilities outside the tolerated advisory roots:");
  for (const name of offenders) console.error(`  - ${name}`);
  process.exit(1);
}
console.log("No high/critical vulnerabilities outside the tolerated advisory roots.");
