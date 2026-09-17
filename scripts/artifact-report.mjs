import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extensionRoot = path.join(root, "extension");
const runtimeRoot = path.join(extensionRoot, "runtime");
const artifactsRoot = path.join(extensionRoot, "artifacts");
const JSZip = createRequire(path.join(extensionRoot, "package.json"))("jszip");
const readJson = file => JSON.parse(readFileSync(file, "utf8"));
const relative = file => path.relative(root, file).replaceAll(path.sep, "/");
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const integrity = bytes => `sha512-${createHash("sha512").update(bytes).digest("base64")}`;

function inspectSourceState() {
  try {
    const status = execFileSync("git", ["status", "--short", "--untracked-files=all"], { cwd: root, encoding: "utf8" }).trim();
    const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    const tree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], { cwd: root, encoding: "utf8" }).trim();
    const tags = execFileSync("git", ["tag", "--points-at", "HEAD"], { cwd: root, encoding: "utf8" }).trim().split(/\r?\n/).filter(Boolean);
    const packageJson = readJson(path.join(root, "package.json"));
    const expectedTag = `v${packageJson.version}`;
    const manifestPath = path.join(root, "release-manifest.json");
    const release = existsSync(manifestPath) ? readJson(manifestPath).release || {} : {};
    const manifestTagAtHead = release.tag && tags.includes(release.tag);
    return {
      worktree: status ? "DIRTY" : "CLEAN",
      commit,
      tree,
      tag: tags.includes(expectedTag) ? "PRESENT_AT_HEAD" : "ABSENT_AT_HEAD",
      expectedTag,
      changedFiles: status ? status.split(/\r?\n/).filter(Boolean) : [],
      manifest: {
        path: "release-manifest.json",
        commit: release.commit || null,
        tree: release.tree || null,
        tag: release.tag || null,
        commitMatches: Boolean(release.commit && release.commit === commit),
        treeMatches: Boolean(release.tree && release.tree === tree),
        tagMatches: Boolean(manifestTagAtHead),
      },
      provenance: "local git worktree",
    };
  } catch (error) {
    return { worktree: "UNKNOWN", tag: "UNKNOWN", provenance: "local git worktree", error: error.message };
  }
}

const externalStates = { publication: "UNVERIFIED", production: "UNVERIFIED", approval: "NOT_GRANTED" };

function filesUnder(directory) {
  if (!existsSync(directory)) return [];
  const result = [];
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory() && entry.name !== "node_modules") result.push(...filesUnder(file));
    else if (entry.isFile()) result.push(file);
  }
  return result;
}

function npmCommand(args, cwd = root) {
  if (process.platform === "win32") return execFileSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `npm ${args.join(" ")}`], { cwd, encoding: "utf8" });
  return execFileSync("npm", args, { cwd, encoding: "utf8" });
}

function parseNpmJson(output) {
  const start = output.indexOf("[");
  const end = output.lastIndexOf("]");
  if (start < 0 || end < start) throw new Error("npm pack dry-run did not return JSON");
  return JSON.parse(output.slice(start, end + 1))[0];
}

function extensionCandidates() {
  const locations = [extensionRoot, artifactsRoot];
  return locations.flatMap(directory => existsSync(directory) ? readdirSync(directory, { withFileTypes: true }).filter(entry => entry.isFile() && entry.name.endsWith(".vsix")).map(entry => path.join(directory, entry.name)) : []).sort((a, b) => relative(a).localeCompare(relative(b)));
}

export function inspectCliDryRun() {
  const packageJson = readJson(path.join(root, "package.json"));
  const artifact = parseNpmJson(npmCommand(["pack", "--dry-run", "--json"]));
  return { program: "cli-npm-package", status: "GENERATED", verificationStatus: "LOCAL_ONLY", source: "git worktree", manifest: { name: packageJson.name, version: packageJson.version, main: packageJson.main, bin: packageJson.bin, engines: packageJson.engines, files: packageJson.files }, dryRun: { filename: artifact.filename, size: artifact.size, unpackedSize: artifact.unpackedSize, shasum: artifact.shasum || null, integrity: artifact.integrity || null, tarballHash: artifact.shasum || null, tarballIntegrity: artifact.integrity || null, files: (artifact.files || []).map(file => file.path).sort() }, external: { ...externalStates } };
}

export function inspectRuntime() {
  const packageJson = readJson(path.join(runtimeRoot, "package.json"));
  const files = filesUnder(runtimeRoot).map(file => ({ path: relative(file), size: statSync(file).size, sha256: sha256(readFileSync(file)) }));
  const entrypoint = path.join(runtimeRoot, "src", "runtime", "stdio-entry.js");
  const status = existsSync(entrypoint) ? "generated" : "missing";
  return { program: "mcp-stdio-package-runtime", status, verificationStatus: "unverified", missingStatus: "missing", source: "extension/runtime", manifest: { name: packageJson.name, version: packageJson.version, type: packageJson.type, main: packageJson.main, bin: packageJson.bin, engines: packageJson.engines }, entrypoint: relative(entrypoint), files };
}

export function inspectHttpContract() {
  const server = readFileSync(path.join(root, "src", "runtime", "server.js"), "utf8");
  const stdio = readFileSync(path.join(root, "src", "runtime", "stdio.js"), "utf8");
  const packageJson = readJson(path.join(root, "package.json"));
  const host = server.match(/const HOST = "([^"]+)"/)?.[1];
  const protocol = stdio.match(/const SUPPORTED_PROTOCOLS = \[(.*?)\]/)?.[1]?.replaceAll('"', "").trim();
  if (!host || !protocol) throw new Error("MCP HTTP contract metadata is unavailable");
  return { program: "mcp-localhost-http-contract", status: "generated", verificationStatus: "unverified", source: "git worktree", manifest: { name: packageJson.name, version: packageJson.version }, contract: { host, endpoint: "POST /mcp", protocolVersion: protocol, authentication: "Bearer runtime token", health: "GET /health", remoteHttp: false, contentType: "application/json", unauthorizedStatus: 401, notificationStatus: 202 }, sources: ["src/runtime/server.js", "src/runtime/stdio.js"] };
}

export async function inspectExtensionArtifacts() {
  const packageJson = readJson(path.join(extensionRoot, "package.json"));
  const runtimeJson = readJson(path.join(runtimeRoot, "package.json"));
  const cliJson = readJson(path.join(root, "package.json"));
  const canonical = `minitok-extension-${packageJson.version}.vsix`;
  const candidates = extensionCandidates().map(file => ({ path: relative(file), status: path.basename(file) === canonical && path.dirname(file) === artifactsRoot ? "generated" : "stale", size: statSync(file).size, sha256: sha256(readFileSync(file)) }));
  const authoritative = candidates.find(candidate => candidate.path === `extension/artifacts/${canonical}`);
  let embedded;
  let manifestMatches = false;
  if (authoritative) {
    const archive = await JSZip.loadAsync(readFileSync(path.join(root, authoritative.path)));
    const extensionEntry = archive.file("extension/package.json");
    const runtimeEntry = archive.file("extension/runtime/package.json");
    if (extensionEntry && runtimeEntry) {
      const extensionManifest = JSON.parse(await extensionEntry.async("string"));
      const runtimeManifest = JSON.parse(await runtimeEntry.async("string"));
      embedded = { extension: { name: extensionManifest.name, version: extensionManifest.version, publisher: extensionManifest.publisher, cliPackage: extensionManifest.minitok?.cliPackage, cliVersion: extensionManifest.minitok?.cliVersion }, runtime: { name: runtimeManifest.name, version: runtimeManifest.version } };
      manifestMatches = extensionManifest.name === packageJson.name && extensionManifest.version === packageJson.version && extensionManifest.publisher === packageJson.publisher && extensionManifest.minitok?.cliPackage === cliJson.name && extensionManifest.minitok?.cliVersion === cliJson.version && runtimeManifest.name === runtimeJson.name && runtimeManifest.version === runtimeJson.version;
    }
  }
  const status = authoritative && manifestMatches ? "generated" : authoritative ? "stale" : "missing";
  const authoritativeEvidence = authoritative ? { path: authoritative.path, sha256: authoritative.sha256, size: authoritative.size } : { path: `extension/artifacts/${canonical}`, sha256: null, size: null };
  return { program: "vscode-extension-vsix", status, verificationStatus: "LOCAL_ONLY", source: "git worktree", staleReportStatus: "stale", missingStatus: "missing", staleStatus: "stale", authoritative: authoritativeEvidence, candidates, manifest: { name: packageJson.name, displayName: packageJson.displayName, version: packageJson.version, publisher: packageJson.publisher, engines: packageJson.engines }, embedded, manifestMatches, compatibility: { cli: `${cliJson.name}@${cliJson.version}`, runtime: `${runtimeJson.name}@${runtimeJson.version}`, extension: `${packageJson.name}@${packageJson.version}`, extensionCliMatches: embedded?.extension?.cliPackage === cliJson.name && embedded?.extension?.cliVersion === cliJson.version, embeddedRuntimeMatches: embedded?.runtime?.name === runtimeJson.name && embedded?.runtime?.version === runtimeJson.version }, external: { ...externalStates } };
}

export async function inspectExtensionArtifact(artifact) {
  const packageJson = readJson(path.join(extensionRoot, "package.json"));
  const runtimeJson = readJson(path.join(runtimeRoot, "package.json"));
  const bytes = readFileSync(artifact);
  const archive = await JSZip.loadAsync(bytes);
  const extensionEntry = archive.file("extension/package.json");
  const runtimeEntry = archive.file("extension/runtime/package.json");
  if (!extensionEntry || !runtimeEntry) throw new Error("authoritative VSIX is missing embedded release manifests");
  const embeddedExtension = JSON.parse(await extensionEntry.async("string"));
  const embeddedRuntime = JSON.parse(await runtimeEntry.async("string"));
  const manifestMatches = embeddedExtension.name === packageJson.name && embeddedExtension.version === packageJson.version && embeddedExtension.publisher === packageJson.publisher && embeddedExtension.minitok?.cliPackage === readJson(path.join(root, "package.json")).name && embeddedExtension.minitok?.cliVersion === readJson(path.join(root, "package.json")).version && embeddedRuntime.name === runtimeJson.name && embeddedRuntime.version === runtimeJson.version;
  return { program: "vscode-extension-vsix", status: manifestMatches ? "generated" : "stale", verificationStatus: "local-only", source: "git worktree", manifest: { name: packageJson.name, displayName: packageJson.displayName, version: packageJson.version, publisher: packageJson.publisher, engines: packageJson.engines }, embedded: { extension: { name: embeddedExtension.name, version: embeddedExtension.version, publisher: embeddedExtension.publisher, cliPackage: embeddedExtension.minitok?.cliPackage, cliVersion: embeddedExtension.minitok?.cliVersion }, runtime: { name: embeddedRuntime.name, version: embeddedRuntime.version } }, artifact: { path: relative(artifact), sha256: sha256(bytes), size: bytes.length }, manifestMatches };
}

if (path.resolve(process.argv[1] || "") === path.resolve(fileURLToPath(import.meta.url))) {
  const mode = process.argv[2];
  if (mode === "cli") console.log(JSON.stringify(inspectCliDryRun()));
  else if (mode === "runtime") console.log(JSON.stringify(inspectRuntime()));
  else if (mode === "http") console.log(JSON.stringify(inspectHttpContract()));
  else if (mode === "extension") console.log(JSON.stringify(await inspectExtensionArtifacts()));
  else if (mode === "report") console.log(JSON.stringify({ schemaVersion: 1, status: "LOCAL_ONLY", source: inspectSourceState(), external: { ...externalStates }, artifacts: [inspectCliDryRun(), await inspectExtensionArtifacts(), inspectRuntime(), inspectHttpContract()] }));
  else throw new Error("usage: node scripts/artifact-report.mjs report|cli|runtime|http|extension");
}
