"use strict";

/**
 * Implementer — executes code changes based on the plan.
 */

const fs = require("fs");
const path = require("path");
const { auditLog } = require("../core/audit");

/**
 * Files/directories protected from autonomous pipeline modification.
 * These control minitok's own runtime behavior and provider selection.
 */
const PROTECTED_PATHS = ["minitok.yml", ".minitok"];
const RELEASE_PROTECTED_PATHS = ["package.json", "package-lock.json", "extension/package.json", "extension/package-lock.json", "extension/runtime/package.json", "extension/runtime/runtime-manifest.json"];
const VERIFICATION_PROTECTED_PATHS = ["tests", "scripts", "VERIFY_CMD.mjs", "VERIFY_CMD.sh", "release-manifest.json"];

/**
 * Default blocked file extensions for autonomous pipeline.
 * Configurable via config.security.blocked_extensions.
 */
const DEFAULT_BLOCKED_EXTENSIONS = [".sh", ".bat", ".cmd", ".ps1", ".exe", ".dll", ".so"];

const IMPLEMENT_SYSTEM_PROMPT = `You are an expert software engineer. Given an implementation plan and repository context, produce the exact code changes needed.

Output format (strict JSON):
{
  "changes": [
    {
      "file": "path/to/file",
      "action": "create|modify|delete",
      "content": "full file content for create or modify"
    }
  ],
  "summary": "what was implemented",
  "files_changed": 3
}`;

async function implement(provider, planResult, repoContext, options = {}) {
  const messages = [
    { role: "system", content: IMPLEMENT_SYSTEM_PROMPT },
    {
      role: "user",
      content: `## Plan\n${JSON.stringify(planResult.plan, null, 2)}\n\n## Repository Context\n${repoContext}\n\n## Instructions\n- Produce complete, working code\n- Follow existing code style\n- Include imports and dependencies
- For modify, content must be the complete replacement file contents
- Do not include line_range or unified diff syntax`,
    },
  ];

  const { parseResponseJSON } = require("./json_utils");
  const attempts = options.json_retry === false ? 1 : 2;
  let result;
  let parsedResult;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const response = await provider.complete(messages, {
      ...options,
      max_tokens: options.max_tokens || 8192,
      temperature: 0.2,
    });
    result = response;
    parsedResult = parseResponseJSON(response.text, { error: "No JSON", raw: response.text });
    if (parsedResult.valid || attempt === attempts) break;
    messages.push({ role: "user", content: "Your previous response was not valid JSON. Return only the strict JSON object with a changes array; do not include markdown or explanation." });
  }

  const changes = parsedResult.valid ? parsedResult.parsed : { error: parsedResult.parsed.error || "Invalid JSON", raw: parsedResult.parsed.raw || result.text };
  return { changes, tokens: result.tokens, model: result.model };
}

/**
 * Resolve and validate a file path stays within repoRoot.
 * Checks both lexical path and symlink/junction target.
 * @param {string} child - resolved child path
 * @param {string} parent - resolved parent path
 * @returns {boolean}
 */
function isWithinLexical(child, parent) {
  return child === parent || child.startsWith(parent + path.sep);
}

function safePath(repoRoot, filePath) {
  const resolved = path.resolve(repoRoot, filePath);
  let root;
  try { root = fs.realpathSync.native(path.resolve(repoRoot)); } catch (error) { return { resolved, safe: false, reason: `Path check failed: ${repoRoot}: ${error.message}` }; }
  if (!isWithinLexical(resolved, path.resolve(repoRoot))) {
    return { resolved, safe: false, reason: `Path traversal blocked: ${filePath} resolves outside repo` };
  }
  const lexicalRoot = path.resolve(repoRoot);
  let current = resolved;
  while (true) {
    try {
      const stat = fs.lstatSync(current);
      const real = fs.realpathSync.native(current);
      if (!(real === root || real.startsWith(root + path.sep))) return { resolved, safe: false, reason: `Symlink or junction escape blocked: ${filePath}` };
      if (stat.isSymbolicLink()) return { resolved, safe: false, reason: `Symlink path blocked: ${filePath}` };
    } catch (error) {
      if (error.code !== "ENOENT") return { resolved, safe: false, reason: `Path check failed: ${filePath}: ${error.message}` };
    }
    if (current === lexicalRoot) break;
    const parent = path.dirname(current);
    if (parent === current || !isWithinLexical(parent, lexicalRoot)) return { resolved, safe: false, reason: `Path traversal blocked: ${filePath}` };
    current = parent;
  }
  return { resolved, safe: true };
}

function isCanonicalReleaseRepository(repoRoot) {
  try { return JSON.parse(fs.readFileSync(path.join(path.resolve(repoRoot), "package.json"), "utf8")).name === "@flotic/minitok"; } catch { return false; }
}

/**
 * Check if a resolved file path is protected from autonomous modification.
 * @param {string} repoRoot
 * @param {string} filePath - resolved absolute path
 * @returns {{ protected: boolean, reason?: string }}
 */
function isProtectedPath(repoRoot, filePath) {
  const root = path.resolve(repoRoot);
  let rel = path.relative(root, filePath).replace(/\\/g, "/");
  // On Windows/NTFS the filesystem is case-insensitive, normalize for comparison
  if (process.platform === "win32") {
    rel = rel.toLowerCase();
  }
  const releaseProtected = isCanonicalReleaseRepository(root);
  const protectedPaths = releaseProtected ? [...PROTECTED_PATHS, ...RELEASE_PROTECTED_PATHS, ...VERIFICATION_PROTECTED_PATHS] : PROTECTED_PATHS;
  for (const p of protectedPaths) {
    const pat = process.platform === "win32" ? p.toLowerCase() : p;
    if (rel === pat || rel.startsWith(pat + "/")) {
      return { protected: true, reason: `Protected path: ${p}` };
    }
  }
  return { protected: false };
}

/**
 * Check if a file extension is blocked by policy.
 * @param {string} filePath
 * @param {string[]} blockedExtensions
 * @returns {{ blocked: boolean, reason?: string }}
 */
function isBlockedExtension(filePath, blockedExtensions) {
  const ext = path.extname(filePath).toLowerCase();
  if (blockedExtensions.includes(ext)) {
    return { blocked: true, reason: `Blocked extension: ${ext}` };
  }
  return { blocked: false };
}

function applyChanges(repoRoot, changesResult, dryRun = false, options = {}) {
  if (changesResult.error) return { applied: 0, errors: [changesResult.error] };

  // 🔒 Validate LLM output before processing
  const { valid, errors: validationErrors, validatedChanges } = validateChanges(changesResult);
  if (!valid) {
    return { applied: 0, errors: validationErrors };
  }

  const results = { applied: 0, skipped: 0, errors: [], audit: { persisted: true, warnings: [] } };
  const recordAudit = (entry) => {
    const result = auditLog(entry, options.auditPath);
    if (result && result.persisted === false) {
      results.audit.persisted = false;
      results.audit.warnings.push(result.warning);
    }
    return result;
  };
  for (const change of validatedChanges) {
    // 🔒 Validate path stays within repoRoot
    const { resolved: filePath, safe, reason } = safePath(repoRoot, change.file);
    if (!safe) {
      recordAudit({ action: change.action, file: change.file, result: "rejected", reason });
      results.errors.push(reason);
      continue;
    }

    // 🔒 Check protected paths
    const { protected: isProtected, reason: protReason } = isProtectedPath(repoRoot, filePath);
    const releaseProtected = isCanonicalReleaseRepository(repoRoot);
    if (isProtected && !(releaseProtected && change.action === "create" && path.relative(path.resolve(repoRoot), filePath).replace(/\\/g, "/").startsWith("tests/"))) {
      recordAudit({ action: change.action, file: change.file, result: "rejected", reason: protReason });
      results.errors.push(protReason);
      continue;
    }

    // 🔒 Check blocked extensions
    const blockedExtensions = options.blockedExtensions || DEFAULT_BLOCKED_EXTENSIONS;
    const { blocked, reason: extReason } = isBlockedExtension(filePath, blockedExtensions);
    if (blocked) {
      recordAudit({ action: change.action, file: change.file, result: "rejected", reason: extReason });
      results.errors.push(extReason);
      continue;
    }

    try {
      if (dryRun) {
        results.applied++;
        continue;
      }
      if (change.action === "create") {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        const temporary = `${filePath}.tmp.${process.pid}.${Math.random().toString(16).slice(2)}`;
        fs.writeFileSync(temporary, change.content, { encoding: "utf-8", flag: "wx" });
        try { fs.renameSync(temporary, filePath); } catch (error) { try { fs.unlinkSync(temporary); } catch {} throw error; }
        recordAudit({ action: "create", file: change.file, result: "applied" });
        results.applied++;
      } else if (change.action === "modify") {
        if (!fs.existsSync(filePath)) {
          results.errors.push(`File not found: ${change.file}`);
          continue;
        }
        const current = fs.lstatSync(filePath);
        if (current.isSymbolicLink() || !current.isFile()) throw new Error("Modify target must be a regular file");
        const temporary = `${filePath}.tmp.${process.pid}.${Math.random().toString(16).slice(2)}`;
        fs.writeFileSync(temporary, change.content, { encoding: "utf-8", flag: "wx" });
        try { fs.renameSync(temporary, filePath); } catch (error) { try { fs.unlinkSync(temporary); } catch {} throw error; }
        recordAudit({ action: "modify", file: change.file, result: "applied" });
        results.applied++;
      } else if (change.action === "delete") {
        if (!fs.existsSync(filePath)) continue;
        const current = fs.lstatSync(filePath);
        if (current.isSymbolicLink() || !current.isFile()) throw new Error("Delete target must be a regular file");
        fs.unlinkSync(filePath);
        recordAudit({ action: "delete", file: change.file, result: "applied" });
        results.applied++;
      } else {
        results.skipped++;
      }
    } catch (e) {
      results.errors.push(`${change.file}: ${e.message}`);
    }
  }
  return results;
}

/**
 * Validate a single change object from LLM output.
 * @param {any} change
 * @returns {{ valid: boolean, reason?: string }}
 */
function validateChange(change) {
  if (!change || typeof change !== "object") {
    return { valid: false, reason: "Change entry must be an object" };
  }
  if (typeof change.file !== "string" || change.file.trim() === "") {
    return { valid: false, reason: "Change 'file' must be a non-empty string" };
  }
  const validActions = ["create", "modify", "delete"];
  if (!validActions.includes(change.action)) {
    return { valid: false, reason: `Change 'action' must be one of: ${validActions.join(", ")}` };
  }
  if (Object.prototype.hasOwnProperty.call(change, "line_range")) {
    return { valid: false, reason: "Change 'line_range' is not supported; provide complete file content" };
  }
  if (change.action !== "delete") {
    if (change.content === undefined || change.content === null) {
      return { valid: false, reason: `Change 'content' is required for ${change.action} action` };
    }
    if (typeof change.content !== "string") {
      return { valid: false, reason: "Change 'content' must be a string" };
    }
  }
  return { valid: true };
}

/**
 * Validate an LLM output object before applying changes.
 * @param {object} changesResult - parsed LLM output
 * @returns {{ valid: boolean, errors: string[], validatedChanges: Array }}
 */
function validateChanges(changesResult) {
  if (!changesResult || typeof changesResult !== "object") {
    return { valid: false, errors: ["Changes result must be an object"], validatedChanges: [] };
  }
  if (changesResult.error) {
    return { valid: false, errors: [changesResult.error], validatedChanges: [] };
  }
  if (!Array.isArray(changesResult.changes)) {
    return { valid: false, errors: ["'changes' must be an array"], validatedChanges: [] };
  }
  const errors = [];
  const validated = [];
  for (let i = 0; i < changesResult.changes.length; i++) {
    const { valid, reason } = validateChange(changesResult.changes[i]);
    if (valid) {
      validated.push(changesResult.changes[i]);
    } else {
      errors.push(`Change ${i}: ${reason}`);
    }
  }
  return { valid: errors.length === 0, errors, validatedChanges: validated };
}

module.exports = { implement, applyChanges, safePath, isProtectedPath, isBlockedExtension, validateChange, validateChanges, PROTECTED_PATHS, RELEASE_PROTECTED_PATHS, VERIFICATION_PROTECTED_PATHS, DEFAULT_BLOCKED_EXTENSIONS, IMPLEMENT_SYSTEM_PROMPT };
