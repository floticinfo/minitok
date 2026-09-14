'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  recordRunEvidence,
  readRunEvidence,
  normalizeEvidence
} = require('./run-evidence');

async function temporaryWorkspace() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'minitok-evidence-'));
}

function sample(overrides = {}) {
  return {
    workspaceRoot: overrides.workspaceRoot,
    run_id: overrides.run_id || 'run-test-1',
    task: overrides.task || 'Improve the test workflow',
    dry_run: overrides.dry_run || false,
    stages: {
      selected_plan: 'plan-a',
      work: 'work-a',
      review: 'review-a'
    },
    changed_files: ['src/example.js'],
    verification: {
      commands: ['npm test'],
      exit_status: overrides.exit_status ?? 0,
      passed: overrides.passed ?? true
    },
    outcome: overrides.outcome || 'success'
  };
}

test('records and reads successful evidence', async () => {
  const workspaceRoot = await temporaryWorkspace();
  const result = await recordRunEvidence(sample({ workspaceRoot }));
  const latest = await readRunEvidence(workspaceRoot);

  assert.equal(result.evidence.schema_version, 1);
  assert.equal(latest.outcome, 'success');
  assert.equal(latest.verification.exit_status, 0);
  assert.match(result.artifact_path, /run-test-1\.json$/);
});

test('records failed verification explicitly', async () => {
  const workspaceRoot = await temporaryWorkspace();
  const result = await recordRunEvidence(sample({
    workspaceRoot,
    outcome: 'verification-failed',
    exit_status: 1,
    passed: false
  }));

  assert.equal(result.evidence.outcome, 'verification-failed');
  assert.equal(result.evidence.verification.exit_status, 1);
  assert.equal(result.evidence.verification.passed, false);
});

test('records dry runs', async () => {
  const workspaceRoot = await temporaryWorkspace();
  const result = await recordRunEvidence(sample({ workspaceRoot, dry_run: true, outcome: 'dry-run' }));
  assert.equal(result.evidence.dry_run, true);
  assert.equal(result.evidence.outcome, 'dry-run');
});

test('repeated runs update latest while retaining individual artifacts', async () => {
  const workspaceRoot = await temporaryWorkspace();
  await recordRunEvidence(sample({ workspaceRoot, run_id: 'run-one' }));
  await recordRunEvidence(sample({ workspaceRoot, run_id: 'run-two' }));

  const latest = await readRunEvidence(workspaceRoot);
  assert.equal(latest.run_id, 'run-two');
  await fs.access(path.join(workspaceRoot, '.minitok/evidence/runs/run-one.json'));
  await fs.access(path.join(workspaceRoot, '.minitok/evidence/runs/run-two.json'));
});

test('supports a workspace-relative custom evidence path', async () => {
  const workspaceRoot = await temporaryWorkspace();
  const evidencePath = '.minitok/custom/latest.json';
  await recordRunEvidence(sample({ workspaceRoot, run_id: 'custom-path' }), { evidencePath });
  const latest = await readRunEvidence(workspaceRoot, { evidencePath });
  assert.equal(latest.run_id, 'custom-path');
  await fs.access(path.join(workspaceRoot, evidencePath));
});

test('rejects evidence paths outside the workspace', async () => {
  const workspaceRoot = await temporaryWorkspace();
  await assert.rejects(() => recordRunEvidence(sample({ workspaceRoot }), { evidencePath: '../outside.json' }), /stay inside the workspace/);
});

test('reports malformed existing evidence', async () => {
  const workspaceRoot = await temporaryWorkspace();
  const file = path.join(workspaceRoot, '.minitok/evidence/runs/latest.json');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, '{not-json', 'utf8');

  await assert.rejects(() => readRunEvidence(workspaceRoot), /malformed/);
});

test('reports atomic persistence failures', async () => {
  const workspaceRoot = await temporaryWorkspace();
  const failingFs = {
    mkdir: fs.mkdir,
    writeFile: async () => { throw new Error('disk full'); },
    rename: fs.rename,
    unlink: async () => {}
  };

  await assert.rejects(
    () => recordRunEvidence(sample({ workspaceRoot }), { fs: failingFs }),
    /Unable to persist run evidence.*disk full/
  );
});

test('redacts sensitive values', () => {
  const evidence = normalizeEvidence({
    task: 'Do not expose token=abc123',
    authorization: 'Bearer secret-value',
    api_key: 'private-key',
    outcome: 'success'
  });

  assert.doesNotMatch(JSON.stringify(evidence), /abc123|secret-value|private-key/);
  assert.equal(evidence.task, 'Do not expose token=[REDACTED]');
});
