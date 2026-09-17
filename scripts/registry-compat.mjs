import { readFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const require = createRequire(import.meta.url);
const { fetchWithTimeout, readCappedResponse, MAX_RESPONSE_BYTES } = require("../src/core/http");
const REGISTRY_TIMEOUT_MS = 5000;

export function publishedMetadata(metadata, tag = "latest") {
  if (!metadata || typeof metadata !== "object") return metadata;
  const version = metadata["dist-tags"]?.[tag];
  return version ? { ...metadata, version, dist: metadata.versions?.[version]?.dist } : metadata;
}

export function validateRegistryMetadata(metadata, expected = packageJson, { requireLatest = true } = {}) {
  const errors = [];
  if (!metadata || typeof metadata !== "object") return ["registry metadata is not an object"];
  if (metadata.name !== expected.name) errors.push(`registry package name mismatch: ${metadata.name || "missing"}`);
  if (!metadata.version) errors.push("registry version is missing");
  if (requireLatest && metadata.version && metadata.version !== expected.version) errors.push(`registry version ${metadata.version} does not match ${expected.version}`);
  if (!metadata.dist?.tarball || !metadata.dist?.integrity) errors.push("registry dist tarball/integrity metadata is incomplete");
  return errors;
}

export function inspectRegistryMetadata(metadata, expected = packageJson) {
  const latest = metadata?.["dist-tags"]?.latest || null;
  const published = metadata?.versions?.[expected.version];
  const exact = published ? { ...metadata, version: expected.version, dist: published.dist } : null;
  return {
    package: expected.name,
    localVersion: expected.version,
    latest,
    latestMatches: latest === expected.version,
    exactVersion: published ? expected.version : null,
    exactPublished: Boolean(published),
    exactErrors: validateRegistryMetadata(exact, expected, { requireLatest: false }),
    dist: published?.dist || null,
  };
}

export async function fetchRegistryMetadata(url, { timeoutMs = REGISTRY_TIMEOUT_MS, maxBytes = MAX_RESPONSE_BYTES } = {}) {
  let response;
  try {
    response = await fetchWithTimeout(url, { method: "GET", headers: { accept: "application/json" } }, timeoutMs);
  } catch (error) {
    if (error?.name === "AuthError" || error?.name === "AbortError" || /timed out/i.test(error?.message || "")) throw new Error("registry request timed out");
    throw new Error(`registry request failed: ${error?.message || "unknown error"}`);
  }
  if (response.status < 200 || response.status >= 300) throw new Error(`registry returned HTTP ${response.status}`);
  let body;
  try {
    body = await readCappedResponse(response, maxBytes);
  } catch (error) {
    if (/timed out|abort/i.test(error?.message || "") || error?.name === "AuthError") throw new Error("registry request timed out");
    throw error;
  }
  try { return JSON.parse(body); } catch { throw new Error("registry returned invalid JSON"); }
}

export { REGISTRY_TIMEOUT_MS };

if (process.argv[1] && process.argv[1].endsWith("registry-compat.mjs")) {
  if (process.env.MINITOK_ALLOW_LIVE_REGISTRY !== "1") {
    console.error("live registry access is disabled; set MINITOK_ALLOW_LIVE_REGISTRY=1 for an explicit read-only check");
    process.exitCode = 2;
  } else {
    try {
      const metadata = await fetchRegistryMetadata(`https://registry.npmjs.org/${encodeURIComponent(packageJson.name)}`);
      const report = inspectRegistryMetadata(metadata, packageJson);
      const errors = [...report.exactErrors];
      if (!report.exactPublished) errors.push(`registry does not publish exact local version ${packageJson.version}`);
      if (process.env.MINITOK_REGISTRY_REQUIRE_LATEST === "1" && !report.latestMatches) errors.push(`registry latest ${report.latest || "unknown"} does not match ${packageJson.version}`);
      if (errors.length) throw new Error(errors.join("\n"));
      console.log(JSON.stringify({ status: "valid", verificationStatus: "read-only", ...report }));
    } catch (error) { console.error(`registry compatibility failed: ${error.message}`); process.exitCode = 1; }
  }
}
