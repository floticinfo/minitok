import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packagePath = path.join(root, "package.json");
const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
const run = (command, args) => execFileSync(command, args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const git = (...args) => run("git", args);
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const integrity = bytes => `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
const normalized = value => String(value).replaceAll("\\", "/");

function changelogHasVersion(version) {
  const changelog = readFileSync(path.join(root, "CHANGELOG.md"), "utf8");
  return new RegExp(`^##\\s+${version.replaceAll(".", "\\.")}(?:\\s|$)`, "m").test(changelog);
}

function pack() {
  const output = run(process.platform === "win32" ? process.env.ComSpec || "cmd.exe" : "npm", process.platform === "win32" ? ["/d", "/s", "/c", "npm pack --json"] : ["pack", "--json"]);
  const artifact = JSON.parse(output)[0];
  const archivePath = path.join(root, artifact.filename);
  const bytes = readFileSync(archivePath);
  const files = (artifact.files || []).map(entry => {
    const source = path.join(root, entry.path);
    return { path: normalized(entry.path), size: entry.size, sha256: existsSync(source) ? sha256(readFileSync(source)) : null };
  });
  return { archivePath, artifact: { filename: normalized(artifact.filename), size: bytes.length, sha256: sha256(bytes), integrity: integrity(bytes), files } };
}

export function validateManifest(manifest, { packageData = packageJson, gitData = null, changelog = true } = {}) {
  const errors = [];
  const release = manifest?.release;
  if (!release || release.package !== packageData.name || release.version !== packageData.version) errors.push("manifest package/version does not match package.json");
  if (!release?.tag || release.tag !== `v${packageData.version}`) errors.push(`release tag must be v${packageData.version}`);
  if (!release?.commit || !/^[0-9a-f]{7,40}$/.test(release.commit)) errors.push("manifest commit is missing or invalid");
  if (!release?.tree || !/^[0-9a-f]{40}$/.test(release.tree)) errors.push("manifest tree is missing or invalid");
  if (gitData) {
    if (gitData.status) errors.push("source worktree is dirty");
    if (gitData.commit !== release.commit && gitData.tagCommit !== release.commit) errors.push("manifest commit does not match HEAD or release tag target");
    if (gitData.tree !== release.tree && gitData.tagTree !== release.tree) errors.push("manifest tree does not match HEAD or release tag target");
    if (!gitData.tags.includes(release.tag) && gitData.tagCommit !== release.commit) errors.push(`release tag ${release.tag} does not point at the manifest release commit`);
  }
  if (changelog && !changelogHasVersion(packageData.version)) errors.push(`CHANGELOG.md has no ${packageData.version} heading`);
  if (!release?.artifact?.filename || !release.artifact.sha256 || !release.artifact.integrity || !Array.isArray(release.artifact.files)) errors.push("manifest npm pack evidence is incomplete");
  return errors;
}

function contentStatus() {
  const changed = [];
  for (const args of [["diff", "--name-only"], ["diff", "--cached", "--name-only"]]) {
    const files = git(...args).split(/\r?\n/).filter(Boolean);
    changed.push(...files);
  }
  const untracked = git("ls-files", "--others", "--exclude-standard").split(/\r?\n/).filter(Boolean);
  changed.push(...untracked);
  return [...new Set(changed)].filter(file => file !== "release-manifest.json").sort().join("\n");
}

export function readGitData() {
  const status = contentStatus();
  const commit = git("rev-parse", "HEAD");
  const tree = git("rev-parse", "HEAD^{tree}");
  const tags = git("tag", "--points-at", "HEAD").split(/\r?\n/).filter(Boolean);
  const releaseTag = `v${packageJson.version}`;
  let tagCommit = "";
  let tagTree = "";
  try {
    tagCommit = git("rev-parse", `${releaseTag}^{commit}`);
    tagTree = git("rev-parse", `${releaseTag}^{commit}^{tree}`);
  } catch {}
  return { commit, tree, tagCommit, tagTree, status, tags };
}

export function generateManifest() {
  const gitData = readGitData();
  if (gitData.status) throw new Error(`source worktree is dirty; refusing release manifest generation:\n${gitData.status}`);
  const tag = `v${packageJson.version}`;
  if (!gitData.tags.includes(tag) && gitData.tagCommit !== gitData.commit) throw new Error(`HEAD is untagged for ${tag}; refusing release manifest generation`);
  const releaseCommit = gitData.tags.includes(tag) ? gitData.commit : gitData.tagCommit;
  const releaseTree = gitData.tags.includes(tag) ? gitData.tree : gitData.tagTree;
  const packed = pack();
  rmSync(packed.archivePath, { force: true });
  const manifest = { schemaVersion: 1, release: { package: packageJson.name, version: packageJson.version, commit: releaseCommit, tree: releaseTree, tag, changelog: `## ${packageJson.version}`, artifact: packed.artifact }, approvals: { legal: "NOT_GRANTED", support: "NOT_GRANTED", operations: "NOT_GRANTED", publication: "NOT_GRANTED" } };
  const output = path.join(root, "release-manifest.json");
  writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
}

if (path.resolve(process.argv[1] || "") === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    const mode = process.argv[2] || "validate";
    if (mode === "generate") {
      const manifest = generateManifest();
      console.log(JSON.stringify(manifest, null, 2));
    } else if (mode === "validate") {
      const file = process.argv[3] || path.join(root, "release-manifest.json");
      const manifest = JSON.parse(readFileSync(file, "utf8"));
      const errors = validateManifest(manifest, { gitData: readGitData() });
      if (errors.length) throw new Error(errors.join("\n"));
      console.log(`release manifest passed for ${packageJson.name}@${packageJson.version}`);
    } else throw new Error(`unknown mode: ${mode}`);
  } catch (error) {
    console.error(`release manifest failed: ${error.message}`);
    process.exitCode = 1;
  }
}
