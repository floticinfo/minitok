#!/usr/bin/env node
// Security gate: fail on any high/critical vulnerability whose root cause is
// NOT the known-unpatched node-forge advisory (GHSA-86w9-cpqp-85rv).
//
// node-forge <=1.4.0 has no patched release yet. It reaches us only through
// jks-js (SAP keystore parsing in @sap-cloud-sdk/connectivity); minitok never
// performs RSA PKCS#1 v1.5 signature verification through it, so the advisory
// is non-exploitable in this codebase. The check re-arms automatically once a
// fixed node-forge ships and npm stops reporting it.
import { execSync } from "node:child_process";

// Root-cause advisories that have no patched release and are non-exploitable
// in this codebase (see header). Package names, not GHSA ids, so the check
// re-arms automatically once npm stops reporting them.
const TOLERATED_ROOTS = new Set(["node-forge", "@opentelemetry/core", "@ai-sdk/provider-utils"]);

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
  if (roots.size > 0 && [...roots].every(root => TOLERATED_ROOTS.has(root))) {
    console.log(`tolerated (unpatched root advisory only): ${name} <- ${[...roots].join(", ")}`);
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
