'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const SCHEMA_VERSION = 1;
const EVIDENCE_DIRECTORY = path.join('.minitok', 'evidence', 'runs');

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
    cycles: Array.isArray(input.cycles) ? input.cycles : [],
    verification: {
      commands: Array.isArray(input.verification?.commands) ? input.verification.commands : [],
      exit_status: input.verification?.exit_status ?? null,
      passed: input.verification?.passed ?? null
    },
    optimization_savings: input.optimization_savings && typeof input.optimization_savings === 'object' ? input.optimization_savings : null,
    metrics: input.metrics && typeof input.metrics === 'object' ? input.metrics : null,
    outcome: input.outcome || 'unknown',
    error: input.error || null
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
  recordRunEvidence,
  readRunEvidence,
  redact
};
