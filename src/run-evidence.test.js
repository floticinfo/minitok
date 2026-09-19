'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  recordRunEvidence,
  readRunEvidence,
  normalizeEvidence,
  createCycleEvidence,
  updateCycleEvidence,
  fileHashEntries,
  sha256,
  redactLimited
} = require('./run-evidence');
const { applyChanges } = require('./pipeline/implementer');

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

test('records a valid implementation with applied change using hashes only', () => {
  const repo = require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'minitok-cycle-'));
  try {
    const result = applyChanges(repo, { changes: [{ file: 'a.txt', action: 'create', content: 'secret source' }] });
    assert.equal(result.applied, 1);
    const cycle = createCycleEvidence({
      cycle: 1,
      task: 'write a file',
      plan: { valid: true, step_count: 1, target_files: ['a.txt'] },
      implementation: { response_valid: true, change_count: 1, changed_files: ['a.txt'], applied_count: result.applied, errors: [], content_hashes: fileHashEntries([{ file: 'a.txt', content: 'secret source' }]), patch_signature: sha256('patch') },
      verification: { status: 'passed', exit_code: 0, command: 'node VERIFY_CMD.mjs', output: 'ok' },
      review: { verdict: 'APPROVE', confidence: 0.9, finding_count: 0 },
      status: 'completed'
    });
    assert.equal(cycle.implementation.applied_count, 1);
    assert.equal(cycle.implementation.content_hashes[0].hash, sha256('secret source'));
    assert.doesNotMatch(JSON.stringify(cycle), /secret source/);
  } finally {
    require('node:fs').rmSync(repo, { recursive: true, force: true });
  }
});

test('classifies invalid JSON and empty changes as non-completed evidence', () => {
  const invalid = createCycleEvidence({ status: 'model_output_invalid', implementation: { response_valid: false, errors: ['Invalid JSON'] } });
  const empty = createCycleEvidence({ status: 'implementation_invalid', implementation: { response_valid: true, change_count: 0 } });
  assert.equal(invalid.status, 'model_output_invalid');
  assert.equal(empty.status, 'implementation_invalid');
  assert.notEqual(empty.status, 'completed');
});

test('records apply errors separately from verifier failures and review rejection', () => {
  const applyFailure = createCycleEvidence({ status: 'implementation_apply_failed', implementation: { error_count: 1, errors: ['write failed'] } });
  const verificationFailure = createCycleEvidence({ status: 'verification_failed', verification: { status: 'failed', exit_code: 3, output: 'boom' } });
  const rejection = createCycleEvidence({ status: 'review_rejected', review: { verdict: 'REJECT', confidence: 0.2, finding_count: 1 } });
  assert.equal(applyFailure.status, 'implementation_apply_failed');
  assert.equal(verificationFailure.status, 'verification_failed');
  assert.equal(rejection.status, 'review_rejected');
});

test('redacts and limits verifier output and keeps patch evidence secret-free', () => {
  const output = redactLimited(`token=secret ${'x'.repeat(5000)}`);
  const cycle = createCycleEvidence({ verification: { status: 'failed', output }, implementation: { patch_signature: sha256('diff') }, status: 'verification_failed' });
  assert.doesNotMatch(JSON.stringify(cycle), /secret/);
  assert.ok(cycle.verification.output.length <= 4012);
  assert.doesNotMatch(JSON.stringify(cycle), /diff/);
});

test('normalizes run terminal metadata and preserves the last cycle evidence id', () => {
  const cycle = createCycleEvidence({ cycle: 2, status: 'verification_failed', verification: { status: 'failed', exit_code: 1 } });
  const evidence = normalizeEvidence({
    task: 'verify fixture',
    terminal_status: 'verification_failed',
    failure_category: 'verification_failure',
    failure_stage: 'verify',
    recoverable: true,
    human_escalation_required: false,
    last_cycle_evidence_id: cycle.evidence_id,
    cycles: [cycle],
  });
  assert.equal(evidence.terminal_status, 'verification_failed');
  assert.equal(evidence.failure_stage, 'verify');
  assert.equal(evidence.last_cycle_evidence_id, cycle.evidence_id);
  assert.equal(evidence.cycles[0].evidence_id, cycle.evidence_id);
});

test('updates isolated merge evidence without changing the original patch body', () => {
  const initial = createCycleEvidence({ cycle: 1, status: 'merge_pending', workspace: { patch_generated: true } });
  const merged = updateCycleEvidence(initial, { status: 'completed', workspace: { merge_attempted: true, merge_applied: true, isolated_changed_files: ['a.txt'] } });
  const failed = updateCycleEvidence(initial, { status: 'merge_failed', workspace: { merge_attempted: true, merge_applied: false, patch_preserved: true } });
  assert.equal(merged.workspace.merge_applied, true);
  assert.equal(merged.status, 'completed');
  assert.equal(failed.status, 'merge_failed');
  assert.equal(failed.workspace.patch_preserved, true);
});
