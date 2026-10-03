import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateCommercialReadiness } from "./commercial-readiness.mjs";
import { validateManifest, readGitData } from "./release-manifest.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const run = (command, args) => execFileSync(command, args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const git = (...args) => run("git", args).trim();
const packageJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const lockJson = JSON.parse(readFileSync(path.join(root, "package-lock.json"), "utf8"));
const errors = [];
const releaseTag = process.env.RELEASE_TAG;


try {
  const readiness = evaluateCommercialReadiness();
  for (const result of readiness) {
    if (result.status === "BLOCKED" || result.status === "UNVERIFIED") errors.push(`commercial readiness ${result.id}: ${result.status}`);
  }

  const head = git("rev-parse", "HEAD");
  const tree = git("rev-parse", "HEAD^{tree}");
  const status = git("status", "--short").split(/\r?\n/).filter(line => line.trim() && !/^\s*M?\s+release-manifest\.json$/.test(line)).join("\n");
  const tags = git("tag", "--points-at", "HEAD").split(/\r?\n/).filter(Boolean);
  if (!head || !tree) errors.push("git HEAD/tree identity is unavailable");
  if (status) errors.push(`working tree is not clean; modified paths:\n${status}`);

  const expectedTags = [`v${packageJson.version}`, packageJson.version];
  const releaseManifest = JSON.parse(readFileSync(path.join(root, "release-manifest.json"), "utf8"));
  let taggedReleaseCommit = "";
  let taggedReleaseTree = "";
  try {
    taggedReleaseCommit = git("rev-parse", `${expectedTags[0]}^{commit}`);
    taggedReleaseTree = git("rev-parse", `${expectedTags[0]}^{tree}`);
  } catch {}
  const releaseTagMatches = tags.some(tag => expectedTags.includes(tag)) || (taggedReleaseCommit && taggedReleaseCommit === releaseManifest.release?.commit);
  if (!releaseTagMatches) errors.push(`release tag does not point at the manifest release commit; HEAD=${head || "(unknown)"}; tagTarget=${taggedReleaseCommit || "(none)"}`);
  const releaseCommitMatches = releaseManifest.release?.commit && (head === releaseManifest.release.commit || taggedReleaseCommit === releaseManifest.release.commit);
  const releaseTreeMatches = releaseManifest.release?.tree && (tree === releaseManifest.release.tree || taggedReleaseTree === releaseManifest.release.tree);
  if (releaseManifest.release?.commit && !releaseCommitMatches) errors.push(`HEAD or release tag does not match release manifest commit; HEAD=${head || "(unknown)"}; tagTarget=${taggedReleaseCommit || "(none)"}; manifest=${releaseManifest.release.commit}`);
  if (releaseManifest.release?.tree && !releaseTreeMatches) errors.push(`HEAD or release tag tree does not match release manifest tree; HEAD=${tree || "(unknown)"}; tagTree=${taggedReleaseTree || "(none)"}; manifest=${releaseManifest.release.tree}`);
  if (releaseTag && !expectedTags.includes(releaseTag)) errors.push(`release ref ${releaseTag} does not match package version ${packageJson.version}`);
  if (lockJson.packages?.[""]?.version !== packageJson.version) errors.push("package-lock version does not match package version");
  const output = run(process.platform === "win32" ? process.env.ComSpec || "cmd.exe" : "npm", process.platform === "win32" ? ["/d", "/s", "/c", "npm pack --json"] : ["pack", "--json"]);
  const artifact = JSON.parse(output)[0];
  const artifactPath = path.join(root, artifact.filename);
  const bytes = readFileSync(artifactPath);
  const digest = createHash("sha256").update(bytes).digest("hex");
  const manifest = artifact.files || [];
  const expected = ["package.json", "bin/minitok.js", "src/index.js"];
  const forbidden = ["VERIFY_CMD.mjs", "VERIFY_CMD.sh", "scripts/verify.mjs", "scripts/release-verify.mjs", "scripts/secret-scan.mjs", "scripts/documentation-consistency.mjs", "scripts/packed-install-smoke.mjs"];
  for (const file of expected) if (!manifest.some(entry => entry.path === file)) errors.push(`npm pack artifact omits runtime file ${file}`);
  for (const file of forbidden) if (manifest.some(entry => entry.path === file)) errors.push(`npm pack artifact includes development-only file ${file}`);
  if (!digest || artifact.size !== bytes.length || artifact.size <= 0) errors.push("npm pack artifact digest or size is invalid");
  if (!artifact.shasum || artifact.integrity === undefined) errors.push("npm pack artifact provenance metadata is missing");
  if (existsSync(artifactPath)) rmSync(artifactPath);
} catch (error) {
  errors.push(error.message);
}

if (errors.length) {
  console.error(`release:verify failed:\n- ${errors.join("\n- ")}`);
  process.exit(1);
}
console.log(`release:verify passed for ${packageJson.name}@${packageJson.version}`);
