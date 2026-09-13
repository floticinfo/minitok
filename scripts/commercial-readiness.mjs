import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestEnvironmentVariable = "MINITOK_COMMERCIAL_APPROVAL_MANIFEST";
const packageData = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
// The Extension marketplace version is independent of the CLI version, so the
// expected VSIX version comes from the Extension package itself. This used to
// fall back to a hardcoded "0.1.4" because the root package.json has no
// extensionVersion, which rejected any approval manifest that declared the real
// current VSIX (0.2.6) as stale — the approval flow could never pass.
const extensionPackageData = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(root, "extension", "package.json"), "utf8")); } catch { return {}; }
})();
const requiredApprovalFields = ["status", "owner", "decision", "evidenceRef", "approvedAt"];
const placeholderPattern = /(?:PENDING|TODO|TBD|CHANGE_ME|REPLACE_ME|PLACEHOLDER|UNVERIFIED|NOT_GRANTED|<[^>]+>)/i;
const requirements = [
  { id: "legal-owner-approval", status: "BLOCKED", files: ["EULA.md"], markers: [/TODO: Legal owner must approve/i] },
  { id: "privacy-owner-approval", status: "BLOCKED", files: ["POLICY.md"], markers: [/Legal review is required before publication/i, /TODO: Legal owner must approve/i] },
  { id: "support-commitments", status: "UNVERIFIED", files: ["EULA.md", "README.md"], markers: [/Support is provided according to the plan or purchase terms/i, /support commitments?/i], structured: "support", fields: ["contactOwner", "sla", "escalationOwner"] },
  { id: "npm-publication-authorization", status: "UNVERIFIED", files: ["README.md"], markers: [/npm tarball includes/i, /Package:/i], structured: "npmPublication" },
  { id: "marketplace-publisher-authorization", status: "UNVERIFIED", files: ["README.md"], markers: [/Package:/i], structured: "marketplacePublication" },
  { id: "registry-publication-verification", status: "UNVERIFIED", files: ["README.md"], markers: [/npm tarball includes/i, /Package:/i] },
  { id: "production-operations", status: "UNVERIFIED", files: ["POLICY.md", "README.md"], markers: [/TODO: Operator must confirm/i, /production.*not verified/i], structured: "productionOperations", fields: ["deploymentOwner", "databaseOwner", "rollbackOwner", "monitoringOwner", "signerOwner"] },
];

export function detectApprovalMarkers(text, markers) {
  return markers.filter(marker => marker.test(text)).map(marker => marker.source);
}

function validTimestamp(value, now) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp <= now;
}

function containsPlaceholder(value) {
  return typeof value === "string" && placeholderPattern.test(value);
}

function validateEvidenceRef(value, baseDir) {
  if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.type !== "string") return false;
  if (value.type === "external") return typeof value.reference === "string" && value.reference.trim().length > 0 && !containsPlaceholder(value.reference);
  if (value.type !== "local" || typeof value.path !== "string" || !value.path.trim() || containsPlaceholder(value.path)) return false;
  try {
    return fs.statSync(path.resolve(baseDir, value.path)).isFile();
  } catch {
    return false;
  }
}

function validateStructuredFields(approval, requirement, errors) {
  if (!requirement.structured) return;
  const fields = approval[requirement.structured];
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) {
    errors.push(`${requirement.id}.${requirement.structured} must be an object`);
    return;
  }
  if (requirement.structured === "support" || requirement.structured === "productionOperations") {
    const fieldsToValidate = requirement.fields || (requirement.structured === "support" ? ["contactOwner", "escalationOwner"] : ["rollbackOwner", "monitoringOwner"]);
    for (const field of fieldsToValidate) {
      if (typeof fields[field] !== "string" || !fields[field].trim() || containsPlaceholder(fields[field])) errors.push(`${requirement.id}.${requirement.structured}.${field} must be a non-placeholder string`);
    }
  }
}

export function validateApprovalManifest(manifest, { packageData: expectedPackage = packageData, baseDir = root, now = Date.now() } = {}) {
  const errors = [];
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return ["manifest must be an object"];
  if (placeholderPattern.test(JSON.stringify(manifest))) errors.push("manifest contains unresolved placeholder values");
  if (manifest.schemaVersion !== 2) errors.push("schemaVersion must be 2");
  if (!manifest.release || typeof manifest.release !== "object" || manifest.release.package !== expectedPackage.name || manifest.release.version !== expectedPackage.version) errors.push("manifest package/version does not match package.json");
  if (!manifest.release?.artifacts || typeof manifest.release.artifacts !== "object") errors.push("release.artifacts must identify current local artifacts");
  else {
    const expectedVersions = { cli: expectedPackage.version, vsix: expectedPackage.extensionVersion || extensionPackageData.version || "0.1.4" };
    for (const [id, artifact] of Object.entries(manifest.release.artifacts)) {
      if (!artifact || typeof artifact !== "object" || artifact.version !== expectedVersions[id] || typeof artifact.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(artifact.sha256)) errors.push(`release.artifacts.${id} must contain the current local artifact version and SHA-256`);
    }
  }
  if (!manifest.approvals || typeof manifest.approvals !== "object" || Array.isArray(manifest.approvals)) return [...errors, "approvals must be an object"];
  for (const requirement of requirements) {
    const approval = manifest.approvals[requirement.id];
    if (!approval || typeof approval !== "object" || Array.isArray(approval)) {
      errors.push(`${requirement.id} approval is required`);
      continue;
    }
    for (const field of requiredApprovalFields) if (field !== "evidenceRef" && (typeof approval[field] !== "string" || !approval[field].trim() || containsPlaceholder(approval[field]))) errors.push(`${requirement.id}.${field} must be a non-placeholder string`);
    if (!validTimestamp(approval.approvedAt, now)) errors.push(`${requirement.id}.approvedAt must be a valid non-future ISO timestamp`);
    if (!validateEvidenceRef(approval.evidenceRef, baseDir)) errors.push(`${requirement.id}.evidenceRef must be a resolvable local file or external reference`);
    validateStructuredFields(approval, requirement, errors);
  }
  return errors;
}

export function readApprovalManifest(manifestPath = process.env[manifestEnvironmentVariable]) {
  if (!manifestPath) return { state: "MISSING", errors: [`approval manifest path was not supplied (${manifestEnvironmentVariable}); start from scripts/approval-manifest.example.json`] };
  const resolvedPath = path.resolve(manifestPath);
  try {
    const manifest = JSON.parse(fs.readFileSync(resolvedPath, "utf8"));
    const errors = validateApprovalManifest(manifest, { baseDir: path.dirname(resolvedPath) });
    return errors.length ? { state: "MALFORMED", errors } : { state: "VALID", manifest };
  } catch (error) {
    return { state: "MALFORMED", errors: [`approval manifest could not be read: ${error.message}`] };
  }
}

export function evaluateCommercialReadiness(documentReader = file => fs.readFileSync(path.join(root, file), "utf8"), manifest = readApprovalManifest()) {
  return requirements.map(requirement => {
    const text = requirement.files.map(documentReader).join("\n");
    const markers = detectApprovalMarkers(text, requirement.markers);
    const approval = manifest.state === "VALID" ? manifest.manifest.approvals[requirement.id] : null;
    const structured = !requirement.structured || Object.values(approval?.[requirement.structured] || {}).every(value => typeof value === "string" && value.trim());
    const approved = approval?.status === "APPROVED" && approval.owner.trim() && approval.decision.trim() && structured;
    const status = markers.length && requirement.status === "BLOCKED" ? "BLOCKED" : approved ? "PASS" : "UNVERIFIED";
    const detail = approved ? "explicit approval manifest evidence supplied" : manifest.state === "MALFORMED" ? "approval manifest is malformed" : manifest.state === "MISSING" ? "approval manifest was not supplied; start from scripts/approval-manifest.example.json" : "explicit approval is not recorded";
    return { id: requirement.id, status, markers, approvalState: approved ? "APPROVED" : manifest.state, detail };
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const manifestIndex = process.argv.indexOf("--manifest");
  if (manifestIndex >= 0) process.env[manifestEnvironmentVariable] = process.argv[manifestIndex + 1];
  const manifest = readApprovalManifest();
  const results = evaluateCommercialReadiness(undefined, manifest);
  const blocked = results.filter(result => result.status === "BLOCKED" || result.status === "UNVERIFIED");
  console.log(JSON.stringify({ checklist: results, approvalManifest: { state: manifest.state, errors: manifest.errors || [] }, releaseReady: blocked.length === 0 }, null, 2));
  if (blocked.length) process.exit(1);
}
