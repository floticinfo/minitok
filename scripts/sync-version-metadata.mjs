import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const checkOnly = process.argv.includes("--check");
const packagePath = path.join(root, "package.json");
const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
const version = packageJson.version;
const versionPattern = "\\d+\\.\\d+\\.\\d+";
const textFiles = [
  "MINITOK_ARTIFACT_ROLE.txt",
  "PROMOTION_KIT.md",
  "LAUNCH_CHECKLIST.md",
  "COMMUNITY_SUBMISSION_PREVIEW.example.json",
  "extension/README.md",
  "promotion-posts/mcp-directory.md",
];

function updateText(file, transform) {
  const absolute = path.join(root, file);
  const before = readFileSync(absolute, "utf8");
  const after = transform(before);
  if (before !== after && !checkOnly) writeFileSync(absolute, after, "utf8");
  return before !== after;
}

function updateJson(file, transform) {
  const absolute = path.join(root, file);
  const before = readFileSync(absolute, "utf8");
  const value = JSON.parse(before);
  transform(value);
  const after = `${JSON.stringify(value, null, 2)}\n`;
  if (before !== after && !checkOnly) writeFileSync(absolute, after, "utf8");
  return before !== after;
}

const changed = [];
const mark = (file, didChange) => { if (didChange) changed.push(file); };

mark("server.json", updateJson("server.json", server => {
  server.version = version;
  if (Array.isArray(server.packages)) for (const pkg of server.packages) if (pkg.registryType === "npm" && pkg.identifier === packageJson.name) pkg.version = version;
}));
mark("mcp-marketplace.json", updateJson("mcp-marketplace.json", marketplace => {
  marketplace.version = version;
}));
mark("package-lock.json", updateJson("package-lock.json", lock => {
  lock.version = version;
  if (lock.packages?.[""]) lock.packages[""].version = version;
}));
mark("extension/package.json", updateJson("extension/package.json", extension => {
  extension.minitok = { ...extension.minitok, cliPackage: packageJson.name, cliVersion: version };
}));
mark("extension/runtime/package.json", updateJson("extension/runtime/package.json", runtime => {
  runtime.name = packageJson.name;
  runtime.version = version;
  runtime.main = packageJson.main;
  runtime.bin = packageJson.bin;
}));
mark("extension/runtime/runtime-manifest.json", updateJson("extension/runtime/runtime-manifest.json", manifest => {
  manifest.cliPackage = packageJson.name;
  manifest.cliVersion = version;
}));
mark("MINITOK_ARTIFACT_ROLE.txt", updateText("MINITOK_ARTIFACT_ROLE.txt", text => text.replace(new RegExp(`VERSION: ${versionPattern}`), `VERSION: ${version}`)));
for (const file of textFiles.slice(1)) {
  mark(file, updateText(file, text => text.replace(new RegExp(`(@flotic/minitok@)${versionPattern}`, "g"), `$1${version}`)));
}

if (changed.length) {
  const mode = checkOnly ? "drift" : "synced";
  console.log(JSON.stringify({ status: mode, version, files: changed }, null, 2));
}
if (checkOnly && changed.length) process.exitCode = 1;
if (!changed.length) console.log(JSON.stringify({ status: "in_sync", version, files: [] }, null, 2));
