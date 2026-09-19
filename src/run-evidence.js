'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const SCHEMA_VERSION = 1;
const EVIDENCE_DIRECTORY = path.join('.minitok', 'evidence', 'runs');
const MAX_VERIFICATION_OUTPUT = 4000;
const CYCLE_STATUSES = new Set([
  'model_output_invalid',
  'implementation_invalid',
  'implementation_apply_failed',
  'verification_failed',
  'review_rejected',
  'merge_failed',
  'completed',
  'merge_pending',
  'unknown'
]);

function sha256(value) {
  const data = Buffer.isBuffer(value) ? value : String(value);
  return crypto.createHash('sha256').update(data).digest('hex');
}

function redactLimited(value, limit = MAX_VERIFICATION_OUTPUT) {
  const redacted = redact(value == null ? '' : String(value));
  const suffix = '...[truncated]';
  return redacted.length > limit ? `${redacted.slice(0, Math.max(0, limit - suffix.length))}${suffix}` : redacted;
}

function fileHashEntries(changes) {
  if (!Array.isArray(changes)) return [];
  return changes.map(change => {
    const file = typeof change?.file === 'string' ? change.file : '[invalid-file]';
    // The content is never retained. Hash the proposed content when available;
    // callers may also provide a post-apply hash in `content_hash`.
    const content = Object.prototype.hasOwnProperty.call(change || {}, 'content') ? change.content : change?.content_hash;
    return { file, hash: content == null ? null : sha256(content) };
  });
}

function cycleEvidenceId(input = {}) {
  return `cycle_${sha256(JSON.stringify({
    cycle: input.cycle,
    status: input.status,
    plan: input.plan?.valid,
    target_files: input.plan?.target_files,
    changed_files: input.implementation?.changed_files,
    patch_signature: input.implementation?.patch_signature,
    verification: input.verification?.status,
    exit_code: input.verification?.exit_code,
    review: input.review?.verdict,
    merge_applied: input.workspace?.merge_applied,
  })).slice(0, 16)}`;
}

function normalizeCycleEvidence(input = {}) {
  const plan = input.plan || {};
  const implementation = input.implementation || {};
  const workspace = input.workspace || {};
  const verification = input.verification || {};
  const review = input.review || {};
  const requestedStatus = CYCLE_STATUSES.has(input.status) ? input.status : 'unknown';
  const errors = Array.isArray(implementation.errors)
    ? implementation.errors.map(error => redactLimited(error, 1000))
    : [];
  return {
    evidence_id: typeof input.evidence_id === 'string' && input.evidence_id ? input.evidence_id : cycleEvidenceId(input),
    cycle: Number.isInteger(input.cycle) ? input.cycle : 0,
    task: typeof input.task === 'string' ? redactLimited(input.task, 1000) : '',
    provider: typeof input.provider === 'string' ? input.provider : null,
    model: typeof input.model === 'string' ? input.model : null,
    plan: {
      valid: plan.valid === true,
      step_count: Number.isInteger(plan.step_count) ? plan.step_count : 0,
      target_files: Array.isArray(plan.target_files) ? plan.target_files.filter(file => typeof file === 'string') : [],
    },
    implementation: {
      response_valid: implementation.response_valid === true,
      change_count: Number.isInteger(implementation.change_count) ? implementation.change_count : 0,
      changed_files: Array.isArray(implementation.changed_files) ? implementation.changed_files.filter(file => typeof file === 'string') : [],
      applied_count: Number.isInteger(implementation.applied_count) ? implementation.applied_count : 0,
      skipped_count: Number.isInteger(implementation.skipped_count) ? implementation.skipped_count : 0,
      error_count: Number.isInteger(implementation.error_count) ? implementation.error_count : errors.length,
      errors,
      patch_signature: typeof implementation.patch_signature === 'string' ? implementation.patch_signature : null,
      content_hashes: Array.isArray(implementation.content_hashes) ? implementation.content_hashes.map(item => ({ file: item.file, hash: item.hash })) : [],
    },
    workspace: {
      isolated_changed_files: Array.isArray(workspace.isolated_changed_files) ? workspace.isolated_changed_files.filter(file => typeof file === 'string') : [],
      patch_generated: workspace.patch_generated === true,
      patch_preserved: workspace.patch_preserved === true,
      merge_attempted: workspace.merge_attempted === true,
      merge_applied: workspace.merge_applied === true,
    },
    verification: {
      status: ['passed', 'failed', 'unknown', 'timeout', 'missing'].includes(verification.status) ? verification.status : 'unknown',
      exit_code: Number.isInteger(verification.exit_code) ? verification.exit_code : null,
      command: typeof verification.command === 'string' ? redactLimited(verification.command, 1000) : null,
      output: redactLimited(verification.output || ''),
    },
    review: {
      verdict: ['APPROVE', 'REJECT', 'CHANGES_REQUESTED', 'UNKNOWN'].includes(review.verdict) ? review.verdict : 'UNKNOWN',
      confidence: Number.isFinite(review.confidence) ? review.confidence : null,
      finding_count: Number.isInteger(review.finding_count) ? review.finding_count : 0,
    },
    status: requestedStatus,
  };
}

function createCycleEvidence(input = {}) {
  return normalizeCycleEvidence(input);
}

function updateCycleEvidence(cycle, update = {}) {
  return normalizeCycleEvidence({ ...cycle, ...update, plan: { ...cycle?.plan, ...update.plan }, implementation: { ...cycle?.implementation, ...update.implementation }, workspace: { ...cycle?.workspace, ...update.workspace }, verification: { ...cycle?.verification, ...update.verification }, review: { ...cycle?.review, ...update.review } });
}

function evidencePaths(workspaceRoot, configuredPath) {
  const defaultLatest = path.resolve(workspaceRoot, EVIDENCE_DIRECTORY, 'latest.json');
  if (!configuredPath) return { directory: path.dirname(defaultLatest), latest: defaultLatest };
  const latest = path.resolve(workspaceRoot, configuredPath);
  const root = path.resolve(workspaceRoot) + path.sep;
  if (!latest.startsWith(root)) throw new Error('evidencePath must stay inside the workspace');
  return { directory: path.dirname(latest), latest };
}

function createRunId(now = new Date()) {
  const timestamp = now.toISOString().replace(/[:.]/g, '-');
  return `${timestamp}-${crypto.randomBytes(6).toString('hex')}`;
}

function redact(value, key = '') {
  const sensitiveKey = /(token|secret|password|credential|api[_-]?key|license|authorization|prompt)/i.test(key);

  if (sensitiveKey) return '[REDACTED]';
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, redact(item, name)]));
  }
  if (typeof value === 'string') {
    return value
      .replace(/(api[_-]?key|token|secret|password|license)[=:]\s*[^\s,]+/gi, '$1=[REDACTED]')
      .replace(/Bearer\s+[^\s]+/gi, 'Bearer [REDACTED]');
  }
  return value;
}

function normalizeEvidence(input) {
  if (!input || typeof input !== 'object') {
    throw new TypeError('Run evidence must be an object');
  }
  if (!input.task || typeof input.task !== 'string') {
    throw new TypeError('Run evidence requires a task');
  }

  const evidence = {
    schema_version: SCHEMA_VERSION,
    run_id: input.run_id || createRunId(),
    recorded_at: input.recorded_at || new Date().toISOString(),
    dry_run: Boolean(input.dry_run),
    task: input.task,
    stages: {
      selected_plan: input.stages?.selected_plan ?? null,
      work: input.stages?.work ?? null,
      review: input.stages?.review ?? null
    },
    changed_files: Array.isArray(input.changed_files) ? input.changed_files : [],
    verification: {
      commands: Array.isArray(input.verification?.commands) ? input.verification.commands : [],
      exit_status: input.verification?.exit_status ?? null,
      passed: input.verification?.passed ?? null
    },
    outcome: input.outcome || 'unknown',
    error: input.error || null,
    terminal_status: input.terminal_status || null,
    failure_category: input.failure_category || null,
    failure_stage: input.failure_stage || null,
    recoverable: input.recoverable ?? null,
    human_escalation_required: input.human_escalation_required ?? null,
    last_cycle_evidence_id: input.last_cycle_evidence_id || null,
    cycles: Array.isArray(input.cycles) ? input.cycles.map(normalizeCycleEvidence) : [],
    cycle_evidence: Array.isArray(input.cycle_evidence)
      ? input.cycle_evidence.map(normalizeCycleEvidence)
      : Array.isArray(input.cycles) ? input.cycles.map(normalizeCycleEvidence) : [],
  };

  return redact(evidence);
}

async function atomicWrite(file, value, fsImpl = fs) {
  const directory = path.dirname(file);
  const temporary = path.join(directory, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  const contents = `${JSON.stringify(value, null, 2)}\n`;

  try {
    await fsImpl.writeFile(temporary, contents, { encoding: 'utf8', flag: 'wx' });
    await fsImpl.rename(temporary, file);
  } catch (error) {
    try {
      await fsImpl.unlink(temporary);
    } catch {
      // The original persistence error is more actionable than cleanup errors.
    }
    throw new Error(`Unable to persist run evidence at ${file}: ${error.message}`, { cause: error });
  }
}

async function recordRunEvidence({ workspaceRoot, ...input }, options = {}) {
  if (!workspaceRoot || typeof workspaceRoot !== 'string') {
    throw new TypeError('workspaceRoot is required to record run evidence');
  }

  const fsImpl = options.fs || fs;
  const evidence = normalizeEvidence(input);
  const paths = evidencePaths(workspaceRoot, options.evidencePath);
  const directory = paths.directory;
  const artifact = path.join(directory, `${evidence.run_id}.json`);
  const latest = paths.latest;

  try {
    await fsImpl.mkdir(directory, { recursive: true });
  } catch (error) {
    throw new Error(`Unable to create the run evidence directory ${directory}: ${error.message}`, { cause: error });
  }

  await atomicWrite(artifact, evidence, fsImpl);
  await atomicWrite(latest, evidence, fsImpl);

  return {
    evidence,
    artifact_path: artifact,
    latest_path: latest
  };
}

async function readRunEvidence(workspaceRoot, options = {}) {
  const fsImpl = options.fs || fs;
  const file = evidencePaths(workspaceRoot, options.evidencePath).latest;
  let parsed;

  try {
    parsed = JSON.parse(await fsImpl.readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    if (error instanceof SyntaxError) {
      throw new Error(`Run evidence is malformed at ${file}: ${error.message}`, { cause: error });
    }
    throw new Error(`Unable to read run evidence at ${file}: ${error.message}`, { cause: error });
  }

  if (parsed.schema_version !== SCHEMA_VERSION || !parsed.run_id) {
    throw new Error(`Run evidence is unsupported or incomplete at ${file}`);
  }
  return parsed;
}

module.exports = {
  EVIDENCE_DIRECTORY,
  SCHEMA_VERSION,
  normalizeEvidence,
  normalizeCycleEvidence,
  createCycleEvidence,
  updateCycleEvidence,
  fileHashEntries,
  cycleEvidenceId,
  sha256,
  redactLimited,
  recordRunEvidence,
  readRunEvidence,
  redact
};
