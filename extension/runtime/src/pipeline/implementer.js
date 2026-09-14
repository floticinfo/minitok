"use strict";

/**
 * Implementer — executes code changes based on the plan.
 */

const fs = require("fs");
const path = require("path");
const { auditLog } = require("../core/audit");
const { randomBytes } = require("crypto");

/**
 * Files/directories protected from autonomous pipeline modification.
 * These control minitok's own runtime behavior and provider selection.
 */
const PROTECTED_PATHS = ["minitok.yml", ".minitok"];
const RELEASE_PROTECTED_PATHS = ["package.json", "package-lock.json", "extension/package.json", "extension/package-lock.json", "extension/runtime/package.json", "extension/runtime/runtime-manifest.json"];
const VERIFICATION_PROTECTED_PATHS = ["tests", "scripts", "release-manifest.json"];

/**
 * Paths whose contents run outside the pipeline's own review.
 *
 * A `.git/hooks/pre-commit` file executes on the operator's next commit, a CI
 * workflow runs with the repository's secrets, and `.husky` installs those hooks.
 * The write policy only protected `minitok.yml` and `.minitok`, so an autonomous
 * run could install a persistent backdoor in the repository it was asked to fix.
 * Each entry matches the path itself and everything below it.
 */
const PROTECTED_EXECUTION_PATHS = [".git", ".github", ".gitlab", ".circleci", ".husky", ".gitlab-ci.yml", "Jenkinsfile", ".travis.yml", "azure-pipelines.yml"];

/**
 * The verification gate itself.
 *
 * The gate is the only independent evidence that a change is correct, and it was
 * protected only inside the canonical minitok repository: in a customer
 * repository the model could rewrite `VERIFY_CMD.mjs` and then satisfy its own
 * gate. It is protected everywhere now; a run that needs to change the gate has
 * to be approved by a human (`allowProtectedPaths` / a manual edit).
 */
const GATE_PROTECTED_PATHS = ["VERIFY_CMD.mjs", "VERIFY_CMD.sh"];

/**
 * Files whose contents are credentials, or whose presence is executed by another
 * program. Matching is by file name, not by extension: `path.extname(".env")`
 * is the empty string, so the previous extension-only rule never matched `.env`,
 * `.env.local` (extname `.local`), `.npmrc`, `id_rsa`, or a `.pem` bundle.
 */
const SENSITIVE_FILE_NAME_PATTERNS = [
  /^\.env$/i,
  /^\.env\.[^.]*$/i,
  /^\.envrc$/i,
  /^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?$/i,
  /^\.npmrc$/i,
  /^\.yarnrc(?:\.yml)?$/i,
  /^\.pypirc$/i,
  /^(?:\.netrc|_netrc)$/i,
  /^\.git-credentials$/i,
  /^\.(?:aws|docker|kube|terraformrc|pgpass|htpasswd|gitconfig)$/i,
  /^credentials(?:\.json|\.ya?ml|\.toml)?$/i,
  /^secrets?(?:\.json|\.ya?ml|\.toml)$/i,
  /^\.?keystore(?:\.json)?$/i,
  /\.(?:pem|key|p12|pfx|jks|keystore|ppk)$/i,
];

/** Committed templates of a `.env` file, which hold no secrets. */
const ENV_TEMPLATE_NAMES = /^\.env\.(?:example|sample|template|dist)$/i;

/** A file at or above this size is large enough for a silent truncation to matter. */
const SHRINK_GUARD_MIN_BYTES = 4096;
/** The replacement must keep at least this share of the original size. */
const SHRINK_GUARD_RATIO = 0.4;

/**
 * Default blocked file extensions for autonomous pipeline.
 * Configurable via config.security.blocked_extensions.
 */
const DEFAULT_BLOCKED_EXTENSIONS = [".sh", ".bat", ".cmd", ".ps1", ".exe", ".dll", ".so"];

/** Characters that cannot appear in a portable file name. `:` opens an NTFS alternate data stream. */
const INVALID_FILE_NAME_CHARS = /[<>:"|?*]/;
/** Windows device names, which address a device instead of a file in the repository. */
const RESERVED_DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
/** A Windows 8.3 short name such as `MINITO~1.YML`, which can alias another file. */
const SHORT_NAME_PATTERN = /^[^.]{1,8}~\d+(?:\.[^.]{0,3})?$/i;

/**
 * Reject a file name whose meaning changes once the operating system normalizes
 * it.
 *
 * The path policy in this module compares names as strings, so a name that only
 * differs by characters Windows strips (`minitok.yml.`, `evil.ps1 `) passed both
 * the protected-path and blocked-extension checks and was written as a near-miss
 * file. On a volume where 8.3 aliases or trailing-dot normalization is active the
 * same input lands on the real `minitok.yml`, `VERIFY_CMD.mjs`, or `evil.ps1`
 * instead. An NTFS alternate data stream (`evil.ps1:hidden`) additionally creates
 * the base file as a side effect, which left an unexpected 0-byte `evil.ps1`
 * behind when the rename failed.
 *
 * @param {string} filePath repository-relative or absolute path from the model
 * @returns {string|null} a rejection reason, or null when the name is usable
 */
function unsafeFileNameReason(filePath) {
  const name = path.basename(String(filePath).replace(/\\/g, "/"));
  if (!name) return `Change 'file' must name a file: ${JSON.stringify(filePath)}`;
  const invalid = name.match(INVALID_FILE_NAME_CHARS);
  if (invalid) return `Change 'file' must not contain ${JSON.stringify(invalid[0])} in a file name: ${name}`;
  // Control characters are written with a code-point test so the pattern above
  // stays free of a literal control range.
  if ([...name].some(character => character.charCodeAt(0) < 32)) return `Change 'file' must not contain control characters in a file name: ${JSON.stringify(name)}`;
  if (name !== name.replace(/[. ]+$/, "")) return `Change 'file' must not end with a dot or a space, which the operating system strips: ${JSON.stringify(name)}`;
  if (RESERVED_DEVICE_NAME.test(name)) return `Change 'file' uses a reserved device name: ${name}`;
  // On POSIX a name like `FOO~1.TXT` is an ordinary file, so only Windows rejects it.
  if (process.platform === "win32" && SHORT_NAME_PATTERN.test(name)) return `Change 'file' looks like a Windows 8.3 short name, which can alias another file: ${name}`;
  return null;
}

/**
 * Reject a file whose name marks it as a credential store or an unpacked key.
 *
 * @param {string} filePath repository-relative or absolute path from the model
 * @returns {string|null} a rejection reason, or null when the name is ordinary
 */
function sensitiveFileNameReason(filePath) {
  // Compare on the basename after the same normalization the write path uses:
  // `config/.env.` and `config/ENV` must not differ from `config/.env`.
  const name = path.basename(String(filePath).replace(/\\/g, "/")).replace(/[. ]+$/, "");
  if (!name) return null;
  if (ENV_TEMPLATE_NAMES.test(name)) return null;
  for (const pattern of SENSITIVE_FILE_NAME_PATTERNS) {
    if (pattern.test(name)) return `Sensitive file is protected from autonomous writes: ${name}`;
  }
  return null;
}

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
- Do not include line_range or unified diff syntax
- Never modify validation scripts, tests, scripts, minitok.yml, .minitok, credentials, CI/workflow files, or other protected paths
- Do not return an empty changes array unless the goal is already satisfied`,
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
    parsedResult = parseResponseJSON(response.text, {
      // The provider's stop reason is preserved so a truncated body is reported as
      // a truncation instead of as malformed output.
      error: response.truncated ? `The model stopped at its output token limit (finish_reason: ${response.finish_reason}) before it produced valid JSON` : "No JSON",
      raw: response.text,
    });
    // Retrying a token-limit overflow with the same budget costs another call and
    // truncates again; fail with the real reason instead.
    if (parsedResult.valid || response.truncated || attempt === attempts) break;
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
  // Reject a name the filesystem would normalize into a different file before
  // any policy comparison runs.
  const unsafeName = unsafeFileNameReason(filePath);
  if (unsafeName) return { resolved, safe: false, reason: unsafeName };
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
 * @param {{ protectedExtraPaths?: string[] }} [options] paths the caller resolves
 *   at run time (the configured verification gate, for example)
 * @returns {{ protected: boolean, reason?: string }}
 */
function isProtectedPath(repoRoot, filePath, options = {}) {
  const root = path.resolve(repoRoot);
  let rel = path.relative(root, filePath).replace(/\\/g, "/");
  // The same file can be named with a trailing dot or space, which Windows strips
  // before it opens the path. Normalize so a near-miss name is still protected.
  rel = rel.replace(/[. ]+$/, "");
  // Name-based rule first: it does not depend on the extension (`.env` has none)
  // and applies to every repository, canonical or customer.
  const sensitive = sensitiveFileNameReason(rel);
  if (sensitive) return { protected: true, reason: sensitive };
  // On Windows/NTFS the filesystem is case-insensitive, normalize for comparison
  if (process.platform === "win32") {
    rel = rel.toLowerCase();
  }
  const releaseProtected = isCanonicalReleaseRepository(root);
  const requested = Array.isArray(options.protectedExtraPaths) ? options.protectedExtraPaths : [];
  const extraPaths = requested
    .filter(value => typeof value === "string" && value.trim())
    .map(value => value.replace(/\\/g, "/").replace(/[. ]+$/, "").replace(/^\.\//, ""))
    .map(value => (process.platform === "win32" ? value.toLowerCase() : value));
  const protectedPaths = [
    ...PROTECTED_PATHS,
    ...PROTECTED_EXECUTION_PATHS,
    ...GATE_PROTECTED_PATHS,
    ...extraPaths,
    ...(releaseProtected ? [...RELEASE_PROTECTED_PATHS, ...VERIFICATION_PROTECTED_PATHS] : []),
  ];
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
  // Strip a trailing dot or space first: the operating system opens
  // `evil.ps1.` as `evil.ps1`, so the extension check has to see the same name.
  const ext = path.extname(String(filePath).replace(/[. ]+$/, "")).toLowerCase();
  if (blockedExtensions.includes(ext)) {
    return { blocked: true, reason: `Blocked extension: ${ext}` };
  }
  return { blocked: false };
}

/**
 * Reject a write that replaces a large file with a much smaller one.
 *
 * The implementer has to return the complete body of every file it modifies, and
 * a model that runs out of output tokens silently shortens a large file instead
 * of failing. The result is still valid JSON, so it passed validation and the
 * truncated body overwrote the real file. Only a large reduction is refused, and
 * the pipeline reports the change as rejected instead of writing it.
 *
 * @param {string} filePath absolute path of an existing file
 * @param {string} nextContent content the model wants to write
 * @param {{ allowLargeReduction?: boolean }} [options]
 * @returns {string|null} a rejection reason, or null when the write looks complete
 */
function suspiciousShrinkReason(filePath, nextContent, options = {}) {
  if (options.allowLargeReduction === true) return null;
  let previous;
  try {
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink() || !stat.isFile()) return null;
    previous = fs.readFileSync(filePath, "utf-8");
  } catch { return null; }
  const before = Buffer.byteLength(previous, "utf8");
  const after = Buffer.byteLength(String(nextContent ?? ""), "utf8");
  if (before < SHRINK_GUARD_MIN_BYTES || after >= before * SHRINK_GUARD_RATIO) return null;
  return `Refusing to replace ${before} bytes with ${after} bytes: the model very likely truncated the file content. Re-run the task, split the file, or pass allowLargeReduction to accept the reduction.`;
}

/**
 * Temporary sibling path for an atomic write.
 *
 * The suffix must be unique per call, not just per process: the MCP runtime can
 * apply changes inside one process, and a shared temporary name lets one writer
 * unlink another writer's in-flight file.
 */
function temporaryWritePath(filePath) {
  return `${filePath}.tmp.${process.pid}.${randomBytes(6).toString("hex")}`;
}

function applyChanges(repoRoot, changesResult, dryRun = false, options = {}) {
  if (changesResult?.error) return { applied: 0, skipped: 0, errors: [changesResult.error], atomic: true };

  // Validate the complete model response before doing any filesystem work.
  const { valid, errors: validationErrors, validatedChanges } = validateChanges(changesResult);
  if (!valid) return { applied: 0, skipped: 0, errors: validationErrors, atomic: true };

  const results = { applied: 0, skipped: 0, errors: [], atomic: true, audit: { persisted: true, warnings: [] } };
  const recordAudit = (entry) => {
    const result = auditLog(entry, options.auditPath);
    if (result && result.persisted === false) {
      results.audit.persisted = false;
      results.audit.warnings.push(result.warning);
    }
    return result;
  };
  const reject = (change, reason) => {
    recordAudit({ action: change.action, file: change.file, result: "rejected", reason });
    results.errors.push(`${change.file}: ${reason}`);
  };

  // Preflight every change. This is deliberately separate from commit: a valid
  // change must never be applied when another change in the same model response is
  // protected, malformed for the current filesystem, or otherwise unsafe.
  const prepared = [];
  const blockedExtensions = options.blockedExtensions || DEFAULT_BLOCKED_EXTENSIONS;
  const releaseProtected = isCanonicalReleaseRepository(repoRoot);
  for (const change of validatedChanges) {
    const { resolved: filePath, safe, reason } = safePath(repoRoot, change.file);
    if (!safe) { reject(change, reason); continue; }
    const { protected: isProtected, reason: protectedReason } = isProtectedPath(repoRoot, filePath, { protectedExtraPaths: options.protectedExtraPaths });
    const releaseTestException = releaseProtected && change.action === "create" && path.relative(path.resolve(repoRoot), filePath).replace(/\\/g, "/").startsWith("tests/");
    if (isProtected && !releaseTestException) { reject(change, protectedReason); continue; }
    const { blocked, reason: extensionReason } = isBlockedExtension(filePath, blockedExtensions);
    if (blocked) { reject(change, extensionReason); continue; }

    let exists = false;
    let stat = null;
    try {
      stat = fs.lstatSync(filePath);
      exists = true;
    } catch (error) {
      if (error.code !== "ENOENT") { reject(change, `Cannot inspect target: ${error.message}`); continue; }
    }
    if (exists && (stat.isSymbolicLink() || !stat.isFile())) {
      reject(change, `${change.action} target must be a regular file`);
      continue;
    }
    if (change.action === "modify" && !exists) { reject(change, "File not found"); continue; }
    if (change.action !== "delete" && exists) {
      const shrink = suspiciousShrinkReason(filePath, change.content, options);
      if (shrink) { reject(change, shrink); continue; }
    }
    prepared.push({ change, filePath, exists, orderIndex: prepared.length });
  }
  if (results.errors.length > 0) return results;

  if (dryRun) {
    results.applied = prepared.filter(item => item.change.action !== "delete" || item.exists).length;
    results.skipped = prepared.filter(item => item.change.action === "delete" && !item.exists).length;
    return results;
  }

  // Stage all new contents before touching a target. A commit record keeps the
  // old target until its replacement is safely renamed, allowing rollback if a
  // later rename fails (including Windows/NTFS rename behaviour).
  const staged = [];
  const committed = [];
  try {
    for (const item of prepared) {
      if (item.change.action === "delete") continue;
      fs.mkdirSync(path.dirname(item.filePath), { recursive: true });
      const temporary = temporaryWritePath(item.filePath);
      fs.writeFileSync(temporary, item.change.content, { encoding: "utf-8", flag: "wx" });
      staged.push({ ...item, temporary });
    }
    for (const item of prepared) {
      if (item.change.action === "delete" && !item.exists) {
        results.skipped++;
        continue;
      }
      const stagedItem = staged.find(candidate => candidate.orderIndex === item.orderIndex);
      const record = { ...item, backup: null };
      committed.push(record);
      if (item.exists) {
        record.backup = temporaryWritePath(item.filePath);
        fs.renameSync(item.filePath, record.backup);
      }
      if (stagedItem) fs.renameSync(stagedItem.temporary, item.filePath);
      results.applied++;
    }
  } catch (error) {
    for (const record of committed.reverse()) {
      try {
        if (fs.existsSync(record.filePath)) fs.unlinkSync(record.filePath);
        if (record.backup && fs.existsSync(record.backup)) fs.renameSync(record.backup, record.filePath);
      } catch {}
    }
    for (const item of staged) { try { fs.unlinkSync(item.temporary); } catch {} }
    results.applied = 0;
    results.errors.push(`Atomic apply rolled back: ${error.message}`);
    return results;
  }

  for (const record of committed) {
    if (record.backup) {
      try { fs.unlinkSync(record.backup); } catch (error) { results.audit.warnings.push(`Could not remove temporary backup for ${record.change.file}: ${error.message}`); }
    }
    const overwritten = record.change.action === "create" && record.exists;
    recordAudit(overwritten ? { action: record.change.action, file: record.change.file, result: "applied", overwrote: true } : { action: record.change.action, file: record.change.file, result: "applied" });
    if (overwritten) results.audit.warnings.push(`Overwrote existing file: ${record.change.file}`);
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
  // A name the filesystem would normalize into a different file must never reach
  // the write path, or the protected-path and blocked-extension checks can be
  // bypassed with a trailing dot, a trailing space, or a short name.
  const unsafeName = unsafeFileNameReason(change.file);
  if (unsafeName) return { valid: false, reason: unsafeName };
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

module.exports = { implement, applyChanges, safePath, isProtectedPath, isBlockedExtension, unsafeFileNameReason, sensitiveFileNameReason, suspiciousShrinkReason, validateChange, validateChanges, temporaryWritePath, PROTECTED_PATHS, PROTECTED_EXECUTION_PATHS, GATE_PROTECTED_PATHS, RELEASE_PROTECTED_PATHS, VERIFICATION_PROTECTED_PATHS, SHRINK_GUARD_MIN_BYTES, SHRINK_GUARD_RATIO, DEFAULT_BLOCKED_EXTENSIONS, IMPLEMENT_SYSTEM_PROMPT };
