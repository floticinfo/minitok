"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { fileHash, buildEditManifest, decodeEditChanges, expandEditChanges } = require("./edit-ir");
const { applyChanges, isProtectedPath, DEFAULT_BLOCKED_EXTENSIONS } = require("./implementer");
const { verifyCommandAsync } = require("./check");

class DslSyntaxError extends Error {
  constructor(message, token) {
    super(`${message}${token?.line ? ` at ${token.line}:${token.column}` : ""}`);
    this.name = "DslSyntaxError";
    this.code = "DSL_SYNTAX_ERROR";
  }
}
class DslValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "DslValidationError";
    this.code = "DSL_VALIDATION_ERROR";
  }
}

function tokenize(source) {
  if (typeof source !== "string") throw new DslSyntaxError("DSL source must be a string");
  const tokens = [];
  let i = 0;
  let line = 1;
  let column = 1;
  const advance = () => {
    const c = source[i++];
    if (c === "\n") { line += 1; column = 1; } else column += 1;
    return c;
  };
  while (i < source.length) {
    const c = source[i];
    if (/\s/.test(c)) { advance(); continue; }
    if (c === "#" || (c === "/" && source[i + 1] === "/")) {
      while (i < source.length) {
        if (advance() === "\n") break;
      }
      continue;
    }
    const start = { line, column };
    if (c === "{" || c === "}") {
      tokens.push({ type: c, value: c, ...start }); advance(); continue;
    }
    if (c === '"') {
      advance(); let value = ""; let closed = false;
      while (i < source.length) {
        const current = advance();
        if (current === '"') { closed = true; break; }
        if (current === "\n") throw new DslSyntaxError("Newlines are not allowed inside strings", start);
        if (current !== "\\") { value += current; continue; }
        if (i >= source.length) break;
        const escaped = advance();
        const escapes = { n: "\n", r: "\r", t: "\t", "\\": "\\", '"': '"' };
        if (escapes[escaped] !== undefined) value += escapes[escaped];
        else if (escaped === "u") {
          const hex = source.slice(i, i + 4);
          if (!/^[0-9a-f]{4}$/i.test(hex)) throw new DslSyntaxError("Invalid unicode escape", start);
          value += String.fromCharCode(parseInt(hex, 16));
          for (let n = 0; n < 4; n += 1) advance();
        } else throw new DslSyntaxError(`Unknown string escape \\${escaped}`, start);
      }
      if (!closed) throw new DslSyntaxError("Unterminated string", start);
      tokens.push({ type: "string", value, ...start }); continue;
    }
    const number = source.slice(i).match(/^-?\d+/);
    if (number) {
      for (let n = 0; n < number[0].length; n += 1) advance();
      tokens.push({ type: "number", value: Number(number[0]), ...start }); continue;
    }
    const identifier = source.slice(i).match(/^[A-Za-z_][A-Za-z0-9_-]*/);
    if (identifier) {
      for (let n = 0; n < identifier[0].length; n += 1) advance();
      tokens.push({ type: "identifier", value: identifier[0], ...start }); continue;
    }
    throw new DslSyntaxError(`Unexpected character ${JSON.stringify(c)}`, start);
  }
  tokens.push({ type: "eof", value: "", line, column });
  return tokens;
}

function parseDsl(source) {
  const tokens = tokenize(source); let index = 0;
  const peek = () => tokens[index]; const take = () => tokens[index++];
  const expect = (type, value) => {
    const token = take();
    if (!token || token.type !== type || (value !== undefined && token.value !== value)) throw new DslSyntaxError(`Expected ${value || type}, got ${token?.value || "end of input"}`, token);
    return token;
  };
  const keyword = value => expect("identifier", value);
  const parseOperation = () => {
    const operation = take();
    const operationName = String(operation.value || "");
    if (operation.type !== "identifier" || !["replace_exact", "replace_lines", "create", "delete"].includes(operationName)) throw new DslSyntaxError(`Unknown operation ${operationName}`, operation);
    expect("{"); const fields = {};
    while (peek().type !== "}") {
      const field = take();
      const fieldName = String(field.value || "");
      if (field.type !== "identifier") throw new DslSyntaxError("Expected an operation field", field);
      if (fields[fieldName] !== undefined) throw new DslSyntaxError(`Duplicate operation field ${fieldName}`, field);
      if (fieldName === "start" || fieldName === "end") fields[fieldName] = expect("number").value;
      else if (["before", "after", "content"].includes(fieldName)) fields[fieldName] = expect("string").value;
      else throw new DslSyntaxError(`Unknown field ${fieldName}`, field);
    }
    expect("}"); return { kind: operationName, ...fields };
  };
  keyword("task"); const description = expect("string").value; expect("{");
  const targets = []; let current = null; let verification = null;
  while (peek().type !== "}") {
    const statement = take();
    if (statement.type !== "identifier") throw new DslSyntaxError("Expected a task statement", statement);
    if (statement.value === "target") { keyword("file"); current = { file: expect("string").value, operations: [] }; targets.push(current); }
    else if (statement.value === "operation") { if (!current) throw new DslSyntaxError("An operation requires a preceding target", statement); current.operations.push(parseOperation()); }
    else if (statement.value === "verify") { if (verification) throw new DslSyntaxError("Only one verify statement is allowed", statement); keyword("command"); verification = { kind: "command", path: expect("string").value }; }
    else throw new DslSyntaxError(`Unknown task statement ${statement.value}`, statement);
  }
  expect("}"); expect("eof"); return { type: "task", description, targets, verification };
}

function normalizeDslPath(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new DslValidationError(`${label} must be a non-empty relative path`);
  const normalized = value.replaceAll("\\", "/");
  if (normalized.includes("\0") || path.posix.isAbsolute(normalized) || path.win32.isAbsolute(value) || /^[A-Za-z]:/.test(normalized)) throw new DslValidationError(`${label} must be a repository-relative path`);
  const parts = normalized.split("/");
  if (parts.some(part => part === "..")) throw new DslValidationError(`${label} must not contain path traversal`);
  if (parts.some(part => !part || part === ".")) throw new DslValidationError(`${label} contains an empty or ambiguous path segment`);
  return normalized;
}

function targetAbsolute(repoRoot, relative) {
  const root = fs.realpathSync(repoRoot); const absolute = path.resolve(repoRoot, relative);
  if (absolute !== root && !absolute.startsWith(root + path.sep)) throw new DslValidationError(`Path escapes repository: ${relative}`);
  if (fs.existsSync(absolute)) {
    const stat = fs.lstatSync(absolute);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new DslValidationError(`DSL target must be a regular file: ${relative}`);
    const real = fs.realpathSync(absolute);
    if (real !== root && !real.startsWith(root + path.sep)) throw new DslValidationError(`DSL target resolves outside repository: ${relative}`);
  }
  return absolute;
}

function validateDslAst(ast, options = {}) {
  if (!ast || ast.type !== "task") throw new DslValidationError("DSL root must be a task");
  if (typeof ast.description !== "string" || !ast.description.trim()) throw new DslValidationError("Task description must not be empty");
  if (!Array.isArray(ast.targets) || ast.targets.length === 0) throw new DslValidationError("At least one target is required");
  if (!ast.verification || ast.verification.kind !== "command") throw new DslValidationError("A verify command is required");
  normalizeDslPath(ast.verification.path, "Verification command path");
  const seen = new Set();
  for (const target of ast.targets) {
    const file = normalizeDslPath(target.file, "Target file");
    if (options.repoRoot && isProtectedPath(options.repoRoot, path.resolve(options.repoRoot, file), { protectedExtraPaths: [] }).protected) throw new DslValidationError(`${file}: protected path`);
    if (seen.has(file)) throw new DslValidationError(`Duplicate target file: ${file}`); seen.add(file);
    if (!Array.isArray(target.operations) || target.operations.length === 0) throw new DslValidationError(`Target has no operations: ${file}`);
    const absolute = options.repoRoot ? targetAbsolute(options.repoRoot, file) : null;
    const exists = absolute ? fs.existsSync(absolute) : false;
    for (const operation of target.operations) {
      if (!operation || !["replace_exact", "replace_lines", "create", "delete"].includes(operation.kind)) throw new DslValidationError(`Unsupported operation for ${file}`);
      if (operation.kind === "replace_exact" && (typeof operation.before !== "string" || typeof operation.after !== "string" || !operation.before)) throw new DslValidationError(`${file}: replace_exact requires a non-empty before and an after string`);
      if (operation.kind === "replace_lines" && (!Number.isInteger(operation.start) || !Number.isInteger(operation.end) || operation.start < 1 || operation.end < operation.start || typeof operation.content !== "string")) throw new DslValidationError(`${file}: replace_lines requires positive start/end and content`);
      if (operation.kind === "create" && typeof operation.content !== "string") throw new DslValidationError(`${file}: create requires content`);
      if (operation.kind === "delete" && Object.keys(operation).length !== 1) throw new DslValidationError(`${file}: delete takes no fields`);
    }
    const kinds = new Set(target.operations.map(operation => operation.kind));
    if (kinds.has("create") && (target.operations.length !== 1 || exists)) throw new DslValidationError(`${file}: create requires one operation and a new file`);
    if (kinds.has("delete") && (target.operations.length !== 1 || !exists)) throw new DslValidationError(`${file}: delete requires one operation and an existing file`);
    if (!kinds.has("create") && !kinds.has("delete") && options.repoRoot && !exists) throw new DslValidationError(`${file}: modify target does not exist`);
  }
  if (options.repoRoot) {
    const verificationPath = normalizeDslPath(ast.verification.path, "Verification command path");
    const absolute = targetAbsolute(options.repoRoot, verificationPath);
    if (!fs.existsSync(absolute)) throw new DslValidationError(`Verification command does not exist: ${verificationPath}`);
  }
  return ast;
}

function compileDslToEditIr(repoRoot, ast) {
  validateDslAst(ast, { repoRoot });
  const existingFiles = ast.targets.filter(target => fs.existsSync(path.resolve(repoRoot, target.file))).map(target => target.file);
  const manifest = buildEditManifest(repoRoot, existingFiles);
  const changes = [];
  for (const target of ast.targets) {
    const file = normalizeDslPath(target.file, "Target file");
    const operations = target.operations;
    if (operations[0].kind === "create") { changes.push({ file, action: "create", content: operations[0].content }); continue; }
    if (operations[0].kind === "delete") { changes.push({ file, action: "delete" }); continue; }
    const entry = manifest.files.find(item => item.file === file);
    if (!entry) throw new DslValidationError(`${file}: target is missing from the edit manifest`);
    const content = fs.readFileSync(path.resolve(repoRoot, file), "utf8");
    changes.push({ f: entry.id, h: fileHash(content), e: operations.map(operation => operation.kind === "replace_exact"
      ? { k: "x", b: operation.before, a: operation.after }
      : { k: "l", s: operation.start, n: operation.end, c: operation.content }) });
  }
  return { v: 2, changes, manifest, verification: ast.verification, task: ast.description };
}

function executeDsl(repoRoot, source, options = {}) {
  const ast = validateDslAst(parseDsl(source), { repoRoot });
  const compiled = compileDslToEditIr(repoRoot, ast);
  let changes = decodeEditChanges({ changes: compiled.changes }, compiled.manifest);
  changes = expandEditChanges(repoRoot, changes);
  const changedFiles = changes.error ? [] : changes.changes.map(change => change.file).filter(Boolean);
  const base = { task: ast.description, verification: compiled.verification, ir: compiled, metrics: { provider_calls: 0, provider_usage: { input: 0, output: 0, total: 0 }, changed_files: changedFiles, token_savings: { compared_with_natural_language_pipeline: "all provider tokens avoided" } } };
  if (changes.error) return { ...base, applied: 0, errors: [changes.error], success: false };
  const applied = applyChanges(repoRoot, changes, options.dryRun === true, {
    blockedExtensions: options.blockedExtensions || DEFAULT_BLOCKED_EXTENSIONS,
    protectedExtraPaths: [compiled.verification.path],
    auditPath: options.auditPath,
  });
  if (applied.errors.length || options.dryRun === true || applied.applied === 0) return { ...base, ...applied, success: applied.errors.length === 0 };
  return verifyCommandAsync(repoRoot, { script_path: compiled.verification.path, timeout_ms: options.timeout_ms })
    .then(result => ({ ...base, ...applied, verification_result: result, success: result.passed }));
}

module.exports = { DslSyntaxError, DslValidationError, tokenize, parseDsl, normalizeDslPath, targetAbsolute, validateDslAst, compileDslToEditIr, executeDsl };
