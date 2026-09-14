"use strict";

const path = require("path");
const crypto = require("crypto");

const DEFAULT_IGNORED = [".git", ".minitok", "node_modules", ".env", ".env.*", "credentials", "secrets", "tokens"];
const SECRET_NAME = /(^|[/\\])(?:\.env(?:\..*)?|credentials?|secrets?|tokens?|.*\.(?:pem|key|p12|pfx|jks|der))$/i;
const SECRET_CONTENT = /(-----BEGIN .*PRIVATE KEY-----|AKIA[0-9A-Z]{16}|(?:password|passwd|secret|api[_-]?key|access[_-]?token)\s*[:=]\s*[^\s]+)/i;
const LICENSE_NAMES = new Set(["LICENSE", "COPYING", "NOTICE"]);

function isIgnoredPath(file, extra = []) {
  const normalized = file.replace(/\\/g, "/");
  if (normalized.startsWith("/") || normalized.split("/").includes("..")) return true;
  const parts = normalized.split("/");
  return [...DEFAULT_IGNORED, ...extra].some(pattern => pattern.includes("*")
    ? new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\\\*/g, ".*")}$`, "i").test(path.basename(normalized))
    : parts.some(part => part === pattern));
}
function classifyKnowledgeFile(file, content = "") {
  const normalized = file.replace(/\\/g, "/");
  if (SECRET_NAME.test(normalized) || SECRET_CONTENT.test(String(content).slice(0, 200000))) return { allowed: false, class: "D5_SECRET", reason: "secret-like file or content" };
  if (LICENSE_NAMES.has(path.basename(normalized).toUpperCase())) return { allowed: false, class: "D6_LICENSE", reason: "license/notice file requires explicit policy" };
  if (isIgnoredPath(normalized)) return { allowed: false, class: "D4_LOCAL_ONLY", reason: "internal or ignored path" };
  return { allowed: true, class: "D6_PROJECT_KNOWLEDGE" };
}
function exportKnowledgeFile(file, content, options = {}) {
  const decision = classifyKnowledgeFile(file, content);
  if (!decision.allowed && options.allowLicense !== true) return { allowed: false, file, ...decision };
  const value = String(content);
  return { allowed: true, file: file.replace(/\\/g, "/"), class: decision.class, content: value, content_hash: crypto.createHash("sha256").update(value).digest("hex"), bytes: Buffer.byteLength(value) };
}
function collectKnowledgeFiles(repoRoot, files, options = {}) {
  const root = path.resolve(repoRoot); const rootPrefix = `${root}${path.sep}`;
  return files.map(file => { const absolute = path.resolve(root, file); if (absolute !== root && !absolute.startsWith(rootPrefix)) return { allowed: false, file, class: "D4_LOCAL_ONLY", reason: "path escapes repository root" }; const pathDecision = classifyKnowledgeFile(file); if (!pathDecision.allowed) return { allowed: false, file, ...pathDecision }; try { return exportKnowledgeFile(file, require("fs").readFileSync(absolute, "utf8"), options); } catch (error) { return { allowed: false, file, class: "D4_LOCAL_ONLY", reason: error.message }; } }).filter(Boolean);
}
module.exports = { collectKnowledgeFiles, exportKnowledgeFile, classifyKnowledgeFile, isIgnoredPath, DEFAULT_IGNORED };
