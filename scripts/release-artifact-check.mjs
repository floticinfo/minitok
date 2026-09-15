import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extensionRoot = path.join(root, "extension");
const JSZip = createRequire(path.join(extensionRoot, "package.json"))("jszip");
const artifactsRoot = path.join(extensionRoot, "artifacts");
const packageJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const extensionJson = JSON.parse(readFileSync(path.join(extensionRoot, "package.json"), "utf8"));
const runtimeJson = JSON.parse(readFileSync(path.join(extensionRoot, "runtime", "package.json"), "utf8"));
const canonicalArtifact = `minitok-extension-${extensionJson.version}.vsix`;
const relative = file => path.relative(root, file).replaceAll(path.sep, "/");
const sha256 = file => createHash("sha256").update(readFileSync(file)).digest("hex");
const findVsixFiles = directory => existsSync(directory) ? readdirSync(directory, { withFileTypes: true }).filter(entry => entry.isFile() && entry.name.endsWith(".vsix")).map(entry => path.join(directory, entry.name)).sort((a, b) => relative(a).localeCompare(relative(b))) : [];

function run(command, args, cwd = root) { return execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }

async function readVsixManifest(file) {
  const archive = await JSZip.loadAsync(readFileSync(file));
  const extensionEntry = archive.file("extension/package.json");
  const runtimeEntry = archive.file("extension/runtime/package.json");
  if (!extensionEntry || !runtimeEntry) throw new Error(`VSIX release manifests are incomplete: ${relative(file)}`);
  return { extension: JSON.parse(await extensionEntry.async("string")), runtime: JSON.parse(await runtimeEntry.async("string")) };
}

export async function inspectArtifacts() {
  const errors = [];
  const candidates = [...findVsixFiles(extensionRoot), ...findVsixFiles(artifactsRoot)];
  const authoritativePath = path.join(artifactsRoot, canonicalArtifact);
  const stale = candidates.filter(file => file !== authoritativePath).map(file => ({ file: relative(file), status: "stale", size: statSync(file).size, sha256: sha256(file) }));
  const authoritative = existsSync(authoritativePath) ? { file: relative(authoritativePath), status: "generated", size: statSync(authoritativePath).size, sha256: sha256(authoritativePath) } : { file: relative(authoritativePath), status: "missing" };
  if (stale.length) console.error(`stale VSIX artifacts (candidates): ${stale.map(item => item.file).join(", ")}`);
  if (authoritative.status === "missing") errors.push(`authoritative VSIX is missing: ${authoritative.file}`);
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(packageJson.version)) errors.push(`canonical CLI version is not normalized: ${packageJson.version}`);
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(extensionJson.version)) errors.push(`extension version is not normalized: ${extensionJson.version}`);
  if (extensionJson.version !== extensionJson.version.trim()) errors.push("extension version has surrounding whitespace");
  if (runtimeJson.name !== packageJson.name) errors.push("runtime package name does not match canonical package");
  if (runtimeJson.version !== packageJson.version) errors.push("runtime package version does not match canonical package version");
  if (extensionJson.minitok?.cliPackage !== packageJson.name || extensionJson.minitok?.cliVersion !== packageJson.version) errors.push("extension CLI compatibility metadata does not match canonical package");
  if (extensionJson.name !== "minitok-extension") errors.push(`unexpected extension package name: ${extensionJson.name}`);
  if (!extensionJson.main || !extensionJson.engines?.vscode) errors.push("extension manifest is missing main or VS Code engine metadata");
  if (extensionJson.minitok?.cliPackage !== packageJson.name) errors.push("extension CLI package does not match canonical package");
  if (extensionJson.minitok?.cliVersion !== packageJson.version) errors.push("extension CLI version does not match canonical package version");
  if (extensionJson.license !== "SEE LICENSE IN LICENSE") errors.push("extension license metadata is incomplete");
  if (!existsSync(path.join(extensionRoot, "LICENSE"))) errors.push("extension LICENSE is missing");
  if (authoritative.status !== "missing") {
    try {
      const vsixManifest = await readVsixManifest(authoritativePath);
      if (vsixManifest.extension.name !== extensionJson.name || vsixManifest.extension.version !== extensionJson.version || vsixManifest.extension.publisher !== extensionJson.publisher || vsixManifest.extension.minitok?.cliPackage !== packageJson.name || vsixManifest.extension.minitok?.cliVersion !== packageJson.version || vsixManifest.runtime.name !== runtimeJson.name || vsixManifest.runtime.version !== runtimeJson.version) errors.push("packaged VSIX manifest does not match canonical release versions");
    } catch (error) { errors.push(error.message); }
  }
  return { errors, status: errors.length ? "missing" : authoritative.status, metadata: { source: "git worktree", npm: { name: packageJson.name, version: packageJson.version }, runtime: { name: runtimeJson.name, version: runtimeJson.version }, extension: { name: extensionJson.name, version: extensionJson.version }, authoritative, stale } };
}

export function verifyPackageParity() {
  const errors = [];
  if (packageJson.name !== "@flotic/minitok") errors.push(`unexpected npm package name: ${packageJson.name}`);
  if (!packageJson.version) errors.push("npm package version is missing");
  if (extensionJson.version !== extensionJson.version.trim()) errors.push("extension version is not normalized");
  return errors;
}

if (path.resolve(process.argv[1] || "") === path.resolve(fileURLToPath(import.meta.url))) {
  const report = await inspectArtifacts();
  const errors = [...verifyPackageParity(), ...report.errors];
  const status = existsSync(path.join(root, ".git")) ? run("git", ["status", "--short", "--untracked-files=all"]) : "";
  const candidate = status ? "DIRTY CANDIDATE (not releasable source)" : "CLEAN SOURCE (artifact checks still required)";
  console.error(`release diagnostics: ${candidate}`);
  if (status) console.error(status);
  console.log(JSON.stringify({ status: errors.length ? "stale" : report.status, candidate, artifacts: report.metadata, errors }));
  if (errors.length) process.exitCode = 1;
}
