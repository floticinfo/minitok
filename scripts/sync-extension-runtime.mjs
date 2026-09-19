import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, copyFileSync, writeFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = path.join(root, "src");
const runtimeRoot = path.join(root, "extension", "runtime");
const runtimeSourceRoot = path.join(runtimeRoot, "src");
const manifestPath = path.join(runtimeRoot, "runtime-manifest.json");
const entry = path.join(sourceRoot, "runtime", "stdio-entry.js");
const forbidden = /(^|[\\/])(?:admin|tests?)(?:[\\/]|$)|\.test\.js$|(?:credential|private|\.env)/i;

function resolveModule(file, request) {
  if (!request.startsWith(".")) return null;
  const base = path.resolve(path.dirname(file), request);
  const candidates = [base, `${base}.js`, `${base}.json`, path.join(base, "index.js")];
  return candidates.find(candidate => existsSync(candidate) && statSync(candidate).isFile() && candidate.startsWith(sourceRoot + path.sep)) || null;
}

function collectFiles() {
  const pending = [entry, path.join(sourceRoot, "runtime", "server.js"), path.join(sourceRoot, "runtime", "entitlement.js"), path.join(sourceRoot, "mcp", "tools.js"), path.join(sourceRoot, "entitlement", "trial.js")];
  const files = new Set();
  while (pending.length) {
    const file = pending.pop();
    const relative = path.relative(sourceRoot, file).replaceAll(path.sep, "/");
    if (files.has(relative) || forbidden.test(relative)) continue;
    files.add(relative);
    if (path.extname(file) !== ".js") continue;
    const source = readFileSync(file, "utf8");
    const requests = [...source.matchAll(/require\(["']([^"']+)["']\)/g)].map(match => match[1]);
    for (const request of requests) {
      const dependency = resolveModule(file, request);
      if (dependency) pending.push(dependency);
    }
  }
  return [...files].sort();
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

const files = collectFiles();
rmSync(runtimeSourceRoot, { recursive: true, force: true });
mkdirSync(runtimeSourceRoot, { recursive: true });
for (const relative of files) {
  const source = path.join(sourceRoot, relative);
  const destination = path.join(runtimeSourceRoot, relative);
  mkdirSync(path.dirname(destination), { recursive: true });
  copyFileSync(source, destination);
}
const rootPackage = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const runtimePackagePath = path.join(runtimeRoot, "package.json");
const runtimePackage = JSON.parse(readFileSync(runtimePackagePath, "utf8"));
runtimePackage.name = rootPackage.name;
runtimePackage.version = rootPackage.version;
runtimePackage.main = rootPackage.main;
runtimePackage.bin = rootPackage.bin;
writeFileSync(runtimePackagePath, `${JSON.stringify(runtimePackage, null, 2)}\n`);
const hashes = Object.fromEntries(files.map(relative => [relative, { source: sha256(path.join(sourceRoot, relative)), embedded: sha256(path.join(runtimeSourceRoot, relative)) }]));
const manifest = {
  source: "canonical-root-src",
  cliPackage: rootPackage.name,
  cliVersion: rootPackage.version,
  entry: "src/runtime/stdio-entry.js",
  files,
  hashes
};
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify({ status: "synced", cliPackage: rootPackage.name, cliVersion: rootPackage.version, files: files.length, manifest: path.relative(root, manifestPath).replaceAll(path.sep, "/") }));
