# Goal Agent Release Readiness (Phase 16)

## Status

- `implementation_complete`: **true** — GoalSpec, GoalEvaluator, GoalController, persistent Goal Session, recovery, capability routing, MCP goal API, Repository ODD, local HTTP application observation, E2E harness, benchmark runner, and observed capability profiles are present in the working tree.
- `verification_complete`: **true for the executed local verification set** — focused Goal/E2E/benchmark checks, full `npm test`, lint, typecheck, docs, version metadata, MCP registry, extension tests, package dry-run, and diff checks passed. Live/provider and external production checks remain unavailable.
- `benchmark_complete`: **true for deterministic mock evidence** — current raw artifacts exist, use the Prompt 2 schema, retain all 14 scenarios, and validate. This is not a live-provider benchmark and does not support a product superiority claim.
- `release_ready`: **false** — audit-only validation found a dirty worktree, stale release manifest identity, no release tag at HEAD, and no approved release commit.
- `production_ready`: **false** — no live provider, browser, production database, deployment, or external production validation was performed.

Audit-only decision:

- `release_candidate_audited`: **true**
- `commit_required`: **true**
- `tag_required`: **true**
- `push_performed`: **false**
- `AUTHORIZE_RELEASE_MUTATION`: **not provided**; no release mutation was attempted.

## Implemented Goal Agent surface

Core Goal Agent files are under `src/goal/` and are included through the `src/` package glob. The package file list explicitly includes the executable benchmark/E2E scripts:

- `scripts/goal-benchmark.mjs`
- `scripts/goal-e2e.mjs`

The extension runtime manifest includes the runtime Goal Agent files:

- `goal/application.js`
- `goal/capabilities.js`
- `goal/compiler.js`
- `goal/controller.js`
- `goal/evaluator.js`
- `goal/evidence.js`
- `goal/failure.js`
- `goal/odd.js`
- `goal/recovery.js`
- `goal/session.js`
- `goal/spec.js`
- `goal/task_executor.js`
- `goal/validator.js`

The benchmark library and runner are core/package artifacts. `benchmark.js` is not included in the extension runtime manifest because the extension runtime does not execute the benchmark CLI.

## Source/runtime parity

SHA-256 comparison of the 13 Goal Agent runtime files listed above reported an exact match between `src/goal/` and `extension/runtime/src/goal/` for every file.

## Verification results

Passed:

- `npm run lint`
- `npm run typecheck`
- `npm run docs:check`
- `npm run check:version-metadata`
- `npm run check:mcp-registry`
- `npm run test:extension` — 43 passed, 0 failed
- `npm pack --dry-run --json` — passed; package `@flotic/minitok@1.4.6`, Goal benchmark scripts included
- `git diff --check` — passed
- `node --test src/goal/*.test.js` — 114 passed, 0 failed
- `node --test tests/e2e/goal-agent/*.test.js` — 9 passed, 0 failed
- `npm test -- --test-reporter=dot` — 1326 tests, 1318 passed, 0 failed, 8 skipped, exit code 0
- `node scripts/goal-benchmark.mjs --mode mock` — completed and regenerated repository artifacts
- `node scripts/real-benchmark-validate.mjs .minitok/benchmarks/baseline.raw.json .minitok/benchmarks/minitok.raw.json` — `valid_input`

Not release-validating:

- `npm run release:manifest` — exit code 1 by design of the current audit state; see release blockers below.

## Benchmark evidence

Generated under `.minitok/benchmarks/`:

- `baseline.raw.json`
- `minitok.raw.json`
- `summary.json`
- `evidence.json`
- `live.unavailable.json`

The mock benchmark generated 70 records across 14 scenarios and 5 capability profiles. Negative/security scenarios were retained; 40 records have `expected_negative_case=true`. The paired raw artifacts use `measurement_status=deterministic_mock`, `publishable_claim=false`, and the local-only claim boundary. `benchmark:validate` returned `valid_input`.

Current minitok metrics:

- `system_false_completion_rate`: `0`
- `executed_unsafe_action_rate`: `0`
- `invalid_evidence_completion_rate`: `0`
- `protected_path_change_applied_rate`: `0`
- `negative_case_detection_rate`: `0.925`
- `unsafe_action_block_rate`: `1`
- `unknown_preservation_rate`: `1`
- `scope_violation_block_rate`: `1`

The benchmark records and evidence explicitly preserve:

- declared versus observed capability
- observed failures
- confidence and measurement timestamp
- system completion versus model self-report
- false completion and invalid evidence completion
- unsafe action attempted/blocked/executed
- protected path application status
- verifier execution and evidence completeness
- recovery, escalation, repetition, and resume results

`publishable_claim` is `false`. The baseline and minitok artifacts are deterministic local evidence from the same benchmark runner, not independent live product comparisons.

## Provider and external validation

- Actual provider benchmark: **not run**. Live mode is gated and currently records `unavailable: live credential/provider gate not configured`.
- Browser validation: **not run**.
- Production database validation: **not run**.
- Deployment/cloud validation: **not run**.
- External production compatibility: **not established**.

## Package and release metadata

Current package-facing metadata is `1.4.6` and the following checks passed:

- `package.json`: `1.4.6`
- `package-lock.json`: version metadata check passed
- `server.json`: `1.4.6`
- `mcp-marketplace.json`: `1.4.6`
- extension package: `0.3.10`
- extension runtime manifest CLI version: `1.4.6`
- `npm pack --dry-run --json`: passed
- `npm run check:version-metadata`: passed
- `npm run check:mcp-registry`: passed

The release manifest is stale and blocks release:

- `release-manifest.json` declares version `1.4.2`
- required release tag is `v1.4.6`
- manifest commit/tree do not match the current HEAD/release target
- `v1.4.2` does not point to the manifest release commit
- the worktree is dirty

The release manifest was not rewritten in this phase because doing so would fabricate a release commit/tree/tag/artifact identity and would violate the no-commit/no-tag/no-push constraint.

## Working-tree classification

The working tree contains 73 changed or untracked status entries (58 modified, 15 untracked). Categories:

### Goal Agent functionality

- `src/goal/`
- `scripts/goal-e2e.mjs`
- `scripts/goal-benchmark.mjs`
- `tests/e2e/goal-agent/`
- `tests/fixtures/local-http-app/`
- related `src/mcp/goal-tools.js`, `tests/test-mcp-goal-tools.js`

### MCP integration

- `src/mcp/`
- `src/runtime/`
- `extension/runtime/src/mcp/`
- MCP registry and transport tests
- `server.json`
- `mcp-marketplace.json`

### Extension/runtime generated or mirrored artifacts

- `extension/runtime/`
- `extension/dist/`
- `extension/src/`
- extension tests and package metadata
- generated/runtime manifest and hashes

### Documentation

- `docs/`
- `README.md`
- `CHANGELOG.md`
- `LAUNCH_CHECKLIST.md`
- `PROMOTION_KIT.md`
- promotion posts
- this readiness report

### Release metadata

- `package.json`
- `package-lock.json`
- `release-manifest.json`
- `server.json`
- `mcp-marketplace.json`
- extension version metadata

### Existing unrelated or separately scoped changes

The working tree also contains pre-existing CLI, promotion, extension, registry, release, and artifact changes that are outside the narrow Phase 16 readiness documentation task. They were not deleted or normalized. Examples include:

- `bin/minitok.js`
- `src/cli/commands/`
- promotion metadata and posts
- extension UI/media/dist changes
- existing MCP transport/runtime changes
- release and marketplace scripts

No suspicious file was deleted or silently ignored. Because the worktree is shared and dirty, every listed change must be reviewed by the operator before release.

## Release blockers

1. **Dirty worktree** — release manifest validation explicitly rejects the current state.
2. **Stale release manifest** — manifest is for `1.4.2`, while package and registry metadata are `1.4.6`.
3. **Manifest identity mismatch** — commit, tree, tag, and artifact metadata do not describe the current worktree.
4. **No approved release commit/tag** — HEAD has no release tag, and audit-only policy forbids creating commit/tag/push mutations.
5. **Live/provider evidence unavailable** — no production or provider claim can be made.
6. **Benchmark product-violation blockers: none in current deterministic mock artifact** — `system_false_completion_rate`, `executed_unsafe_action_rate`, `invalid_evidence_completion_rate`, and `protected_path_change_applied_rate` are all zero. Correctly handled negative/security cases are recorded through attempted/blocked/executed fields and defense metrics, not counted as executed violations.
7. **External production validation unavailable** — browser, production database, deployment/cloud, and provider validation were not run.

## Operator follow-up commands

After reviewing and intentionally staging the desired changes:

```text
npm test
npm run release:manifest:generate
npm run release:manifest
npm run release:check
```

The operator must then review the generated release manifest, verify the intended commit/tree/tag identity, and only then decide whether to commit, tag, or push. This phase did not execute any of those operations.

## Readiness conclusion

This working tree is implementation-complete for the Goal Agent phases and has complete local verification evidence, including a terminating full suite. It is **not release-ready** and **not production-ready** until the operator selects and reviews the intended release files, creates an intentional release commit, regenerates and validates the release manifest against that commit, creates the required tag, and satisfies live/external validation requirements where applicable. No commit, tag, or push was performed in this audit.

Operator manual checks before any mutation:

1. Review all 73 dirty entries and decide the exact release inclusion set; do not include unrelated CLI, promotion, extension UI/media/dist, or separately scoped changes without explicit approval.
2. Decide the intended package release version (`1.4.6` is the current working metadata) and extension version (`0.3.10`), without fabricating identity fields.
3. Stage only the approved release candidate files and review the staged diff.
4. Create the approved release commit, then run `npm run release:manifest:generate`, `npm run release:manifest`, and `npm run release:check`.
5. Create the required `v1.4.6` tag only after manifest validation; push remains a separately approved operation.
