import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tracked = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd: root, encoding: "utf8" }).split(/\r?\n/).filter(Boolean);
const allowlist = new Set([
  "tests/test-security.js",
  "tests/test-cv33-attack-matrix.js",
  "tests/test-mcp-host-auth.js",
]);
const patterns = [
  /sk_(?:live|test)_[A-Za-z0-9]{12,}/g,
  /whsec_[A-Za-z0-9]{12,}/g,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
  /(?:api[_-]?key|secret|token)\s*[:=]\s*["'][A-Za-z0-9_\-./+=]{24,}["']/gi,
];
const generatedRuntime = relative => relative.split(/[\\/]/).includes(".vscode-test");
const findings = [];
for (const relative of tracked) {
  if (allowlist.has(relative) || generatedRuntime(relative)) continue;
  const filePath = path.join(root, relative);
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) continue;
  const content = fs.readFileSync(filePath, "utf8");
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    if (pattern.test(content)) findings.push(relative);
  }
}
if (findings.length) {
  console.error(`Secret scan failed:\n- ${[...new Set(findings)].join("\n- ")}`);
  process.exit(1);
}
console.log(`Secret scan passed for ${tracked.length - allowlist.size} tracked and added files.`);
