"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const WORKFLOW_IR_SCHEMA_VERSION = 1;
const DEFAULT_MAX_FILES = 5000;
const IGNORED_DIRECTORIES = new Set([".git", ".minitok", "node_modules"]);

function digestFile(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function listRepositoryFiles(root, options = {}) {
  const maxFiles = Number.isInteger(options.max_files) && options.max_files > 0 ? options.max_files : DEFAULT_MAX_FILES;
  const files = [];
  const visit = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) {
        files.push(absolute);
        if (files.length >= maxFiles) return;
      }
      if (files.length >= maxFiles) return;
    }
  };
  visit(root);
  return files.map(absolute => {
    const relative = path.relative(root, absolute).replaceAll(path.sep, "/");
    const stat = fs.statSync(absolute);
    return { path: relative, bytes: stat.size, sha256: digestFile(absolute) };
  });
}

function shortText(value, max = 240) {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function normalizeFiles(files) {
  return (Array.isArray(files) ? files : [])
    .filter(file => file && typeof file.path === "string")
    .map(file => ({
      path: file.path.replaceAll("\\", "/"),
      bytes: Number(file.bytes) || 0,
      sha256: typeof file.sha256 === "string" ? file.sha256 : "",
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

function normalizePlan(plan = {}) {
  return {
    steps: (Array.isArray(plan.steps) ? plan.steps : []).map(step => ({
      id: step?.id ?? null,
      action: shortText(step?.action, 40),
      file: shortText(step?.file, 240),
      description: shortText(step?.description),
      rationale: shortText(step?.rationale),
    })),
    risk_level: shortText(plan.risk_level, 40),
  };
}

function normalizeChanges(changes) {
  return (Array.isArray(changes) ? changes : []).map(change => ({
    action: shortText(change?.action, 40),
    file: shortText(change?.file, 240),
    digest: typeof change?.digest === "string" ? change.digest : "",
  }));
}

function normalizeIntelligence(intelligence) {
  if (!intelligence || typeof intelligence !== "object") return null;
  const list = key => Array.isArray(intelligence[key]) ? intelligence[key].map(item => shortText(item)).filter(Boolean) : [];
  return {
    summary: shortText(intelligence.summary, 500),
    relevant_files: list("relevant_files"),
    existing_patterns: list("existing_patterns"),
    risks: list("risks"),
    constraints: list("constraints"),
    recommendations: list("recommendations"),
  };
}

function createWorkflowContext(input = {}) {
  return {
    schema_version: WORKFLOW_IR_SCHEMA_VERSION,
    kind: "minitok.workflow-context",
    repository: {
      branch: shortText(input.repository?.branch, 120),
      commit: shortText(input.repository?.commit, 120),
      file_count: Number(input.repository?.file_count) || normalizeFiles(input.files).length,
    },
    task: shortText(input.task, 1000),
    files: normalizeFiles(input.files),
    intelligence: normalizeIntelligence(input.intelligence),
    plan: normalizePlan(input.plan),
    changes: normalizeChanges(input.changes),
    verification: input.verification ? {
      passed: input.verification.passed === true,
      exit_code: input.verification.exit_code ?? null,
      status: shortText(input.verification.status, 80),
    } : null,
    review: input.review ? {
      verdict: shortText(input.review.verdict, 40),
      confidence: Number.isFinite(Number(input.review.confidence)) ? Number(input.review.confidence) : null,
      summary: shortText(input.review.summary),
      finding_count: Array.isArray(input.review.findings) ? input.review.findings.length : Number(input.review.finding_count) || 0,
    } : null,
  };
}

function updateWorkflowContext(context, updates = {}) {
  if (!context || typeof context !== "object") throw new TypeError("workflow context is required");
  return createWorkflowContext({
    ...context,
    ...updates,
    repository: context.repository,
    files: context.files,
  });
}

function buildWorkflowContext(repoRoot, options = {}) {
  if (!repoRoot || typeof repoRoot !== "string") throw new TypeError("repoRoot is required");
  const files = listRepositoryFiles(repoRoot, options);
  return createWorkflowContext({
    repository: {
      branch: options.branch,
      commit: options.commit,
      file_count: files.length,
    },
    task: options.task,
    files,
    intelligence: options.intelligence,
    plan: options.plan,
    changes: options.changes,
    verification: options.verification,
    review: options.review,
  });
}

function attachFileExcerpts(context, repoRoot, maxChars = 4000, targetPaths = null) {
  if (!context || !repoRoot) return context;
  const root = path.resolve(repoRoot) + path.sep;
  const targets = targetPaths ? new Set(targetPaths) : null;
  for (const file of context.files) {
    if (targets && !targets.has(file.path)) continue;
    const absolute = path.resolve(repoRoot, file.path);
    if (!absolute.startsWith(root) || !fs.existsSync(absolute)) continue;
    try {
      const stat = fs.statSync(absolute);
      if (stat.isFile()) file.excerpt = fs.readFileSync(absolute, "utf8").slice(0, maxChars);
    } catch {}
  }
  return context;
}

function projectWorkflowContext(context, stage) {
  if (!context || typeof context !== "object") throw new TypeError("workflow context is required");
  const common = { schema_version: context.schema_version, kind: context.kind, stage, repository: context.repository, task: context.task };
  if (stage === "intel") return { ...common, files: context.files.map(file => ({ path: file.path, bytes: file.bytes, fingerprint: file.sha256.slice(0, 16) })) };
  if (stage === "plan") {
    const relevant = new Set([...(context.intelligence?.relevant_files || []), ...context.plan.steps.map(step => step.file).filter(Boolean)]);
    const files = relevant.size ? context.files.filter(file => relevant.has(file.path)) : context.files;
    return { ...common, files: files.map(file => ({ path: file.path, bytes: file.bytes, fingerprint: file.sha256.slice(0, 16) })), intelligence: context.intelligence };
  }
  if (stage === "work") {
    const plannedFiles = context.plan.steps.map(step => step.file).filter(Boolean);
    const changedFiles = context.changes.map(change => change.file).filter(Boolean);
    const relevantFiles = new Set([...plannedFiles, ...changedFiles]);
    return { ...common, plan: context.plan, intelligence: context.intelligence, changes: context.changes, files: context.files.filter(file => relevantFiles.has(file.path)).map(file => ({ path: file.path, bytes: file.bytes, fingerprint: file.sha256.slice(0, 16), excerpt: file.excerpt || "" })) };
  }
  if (stage === "review") return { ...common, changes: context.changes, verification: context.verification, review: context.review };
  throw new Error(`Unknown workflow context stage: ${stage}`);
}

function serializeWorkflowContext(context, stage) {
  return JSON.stringify(stage ? projectWorkflowContext(context, stage) : context);
}

// Compatibility names retained for the first benchmark experiment. New callers
// should use the canonical WorkflowContext names above.
const createWorkflowIR = createWorkflowContext;
const buildWorkflowIR = buildWorkflowContext;
const stageWorkflowIR = projectWorkflowContext;
const serializeWorkflowIR = serializeWorkflowContext;

module.exports = {
  WORKFLOW_IR_SCHEMA_VERSION,
  listRepositoryFiles,
  createWorkflowContext,
  buildWorkflowContext,
  updateWorkflowContext,
  projectWorkflowContext,
  attachFileExcerpts,
  serializeWorkflowContext,
  createWorkflowIR,
  buildWorkflowIR,
  stageWorkflowIR,
  serializeWorkflowIR,
};
