# Changelog

## Unreleased

### Fixes

- Fixed the MCP tools that take a `run_id` (`minitok_run_get`, `minitok_run_cancel`, `minitok_approve_run`, `minitok_reject_run`). The server overwrote the client-supplied id with `null`, so all four failed schema validation with `INVALID_PARAMS` on both transports. The file-backed approval flow documented for `minitok_run` works again.
- Fixed the local MCP `read` scope not being read-only. `minitok_knowledge_record` and `minitok_observe` persist to the home directory but were annotated as non-destructive, so they ran under the default scope. Scope requirements now come from an explicit per-tool table.
- Fixed unvalidated arguments reaching tool handlers. `minitok_run` accepted a `run_id` that no schema checked, while every other tool silently ignored one; the transport injects the server-generated id for `minitok_run` only, and handlers receive the validated argument object.
- Fixed `minitok_analyze_failures` and `minitok_recommend_policy` rejecting the `project` argument their handlers read, which made every call analyze all projects instead of the requested one.
- Fixed `RuntimeStdio` accepting and ignoring an injected `runPipeline`, which sent embedders and tests to the real pipeline.
- Fixed an unknown command reaching the default CLI action, which opened the terminal interface on a TTY and printed the bare-invocation hint on a pipe.
- Fixed the Extension CLI version gate: it rejected `minitok 1.3.12` because the CLI prints a product prefix, and rejected every future major release because major and minor were compared independently.

### Hardening

- Fixed signal handlers doubling on every pipeline run. The pipeline snapshotted the existing SIGINT/SIGTERM listeners and re-added them without removing them first, so the count doubled per run (2, 4, 8, 16, ...). The default terminal interface installs both handlers, which produced `MaxListenersExceededWarning` on the fourth task and ran each handler 2^N times on Ctrl+C.
- Fixed an approval wait ignoring cancellation. Cancelling a run (`:cancel`, `minitok_run_cancel`, Ctrl+C) now ends the wait immediately instead of blocking for the full approval timeout (30 minutes by default) while holding the MCP run slot and the diverted stdout.
- Fixed `execution.research_enabled` being ignored. The setting is accepted, env-mapped and written by `minitok migrate`, but the intelligence phase ran every cycle regardless and required the `intel` provider credentials; disabling research now skips both.
- Fixed the MCP runtime token expiring after 15 minutes with no way to refresh it, because only `minitok mcp connect` rotated it. The new `minitok mcp token` command rotates it on demand, and the VS Code extension calls it before a handshake when the recorded token is unusable.
- Fixed `parseMcpCommand` consuming Windows backslashes: a `minitok.mcpCommand` value such as `"C:\Program Files\nodejs\node.exe"` was silently parsed into an invalid path. A backslash now escapes only a quote, a backslash or whitespace, and single quotes are literal.
- Fixed an expired cached OAuth token permanently blocking remote MCP. The client presented the stale token and the 401 handler only re-authorized when no token existed, so it never refreshed; expired entries are no longer used, are discarded on 401, and `TokenStore.isValid()` is consulted.
- Fixed the Extension `minitok.run` command ignoring the workspace folder that is open in the editor and running against the globally registered workspace, which could modify a different repository.
- Fixed the localhost runtime stopping itself after 30 minutes with no documented control: `minitok runtime start --idle-timeout <minutes>` (0 disables) is now available and the default is documented.
- Fixed MCP session eviction dropping the oldest created session instead of the least recently used one, which could evict the session in active use.
- Fixed `initialize` accepting any token. A value the server would refuse later now fails the handshake instead of succeeding and failing every subsequent call.
- Fixed the GUI approval watcher polling a deleted path forever (one leaked 150 ms timer per task).
- Fixed `minitok migrate` writing a `providers.default` placeholder that could never work plus a `default_provider` pointing at it, and its next-steps text implying any provider key works out of the box.
- Fixed `minitok migrate` rewriting `.gitignore` as LF, which marked every line as modified in a CRLF repository, and resetting the file mode; line endings and permissions are preserved.
- Fixed entitlement persistence deleting the target before renaming on Windows, which left a window with no entitlement on disk; `rename()` already replaces atomically.
- Fixed the global configuration being read only from the hardcoded `~/.config/minitok/config.yml`, which ignored Windows (`%APPDATA%`) and `$XDG_CONFIG_HOME`; the platform path, the legacy path and `~/.minitok/config.yml` are all honored.
- Fixed entitlement timestamps requiring milliseconds: an issuer signing a valid instant such as `2026-01-01T00:00:00Z` would have made every entitlement MALFORMED.
- Fixed the Extension probing the CLI synchronously on every call (up to three 10 second `execFileSync` probes); the result is cached per setting and the probe is capped at 3 seconds.

### Added

- `minitok mcp token` ensures the local MCP runtime token is valid, rotating it when missing or expired. It never prints the token itself.
- `minitok runtime start --idle-timeout <minutes>` configures the idle shutdown; 0 disables it.

### Extension

- Moved the CLI compatibility check to `extension/src/version.ts` so it can be exercised under Node, with a test that asserts the gate accepts the exact string `minitok --version` prints.

### Tests

- Added transport-level coverage for the MCP tool surface (`tests/test-mcp-tool-transport.js`), which previously only tested unauthenticated requests and therefore never reached the entitlement, scope, or run_id paths.
- Corrected stdio test names that claimed to verify the paid entitlement gate while asserting pre-authentication rejection.
- Added pipeline hardening coverage: signal listener counts across repeated runs, cancellation during an approval wait, and `execution.research_enabled`.
- Added runtime coverage: least-recently-used session eviction and the configurable idle shutdown.
- Added remote MCP coverage: an expired cached OAuth token is never reused and a 401 starts the OAuth refresh path.
- Added extension coverage: Windows paths survive `parseMcpCommand`, the MCP handshake can refresh the runtime token, and `run`/`status` target the open folder.
- Added `src/entitlement/model.test.js` (timestamp acceptance) and `tests/test-migrate-output.js` (generated configuration and `.gitignore` preservation).

## 1.3.12 - 2026-09-11

### Fixes

- Fixed Windows activation requests failing when fetch rejects manually supplied Content-Length headers.
- Fixed activation CLI exit handling and repository-local configuration loading for `--repo` runs.
- Synchronized the embedded Extension runtime with the CLI fixes.

## 1.3.11 - 2026-09-11

### Release integrity

- Prepared the next release from the canonical source after separating the published 1.3.10 artifact from the unreproducible local worktree.
- Aligned CLI, embedded runtime, extension metadata, and release documentation on 1.3.11.

## 1.3.6 - 2026-09-07

### Release integrity

- Reconciled the trusted production signing-key rotation and current CLI/Extension release artifacts.

## 1.3.5 - 2026-09-07

### Security

- Added the staged production signing key to the trusted entitlement key registry while retaining the previous production key for rotation compatibility.

## 1.3.4 - 2026-09-07

### Release integrity

- Added clean-source release manifests binding the CLI package to its commit, tree, tag, and artifact hashes.
- Added read-only npm registry compatibility verification and integrity checks for verified Windows installation.
- Added stricter commercial approval evidence validation and deterministic CLI release gates.

### CLI

- Added standard UI, billing, account, license, and run aliases while preserving existing commands.
- Improved fullscreen compose, conversation scrolling, terminal resize, cleanup, and non-TTY behavior.

## 1.3.3 - 2026-09-04

### Commercial contract

- Current paid plans are Open, Select, and Private; there is no free plan.
- Open supports consented per-run telemetry, Select supports consented aggregate-only telemetry, and Private disables telemetry upload.

### Packaging

- Removed development and release verification scripts from the published npm package; packed-install smoke now verifies that only runtime-required files are installed.
- Updated package metadata and documentation for the 1.3.3 patch release.

## 1.3.2 - 2026-09-04

### Critical fixes

- Fixed (critical): the deterministic verification gate now runs the customer's own repo-local `VERIFY_CMD.mjs` — previously any `.mjs` gate executed the bundled `scripts/verify.mjs`, which tests minitok itself and approved pipeline changes with a vacuous green gate.
- Fixed: isolated workspaces layer ALL uncommitted work (staged + unstaged, binary files included via `diff HEAD --binary`); a failed layering is now a hard error instead of silently running against stale code.
- Reliability: runs that end in REJECT/verification-failure now preserve the generated diff at `.minitok/last-run.patch` instead of discarding paid output with the temp clone.
- Fixed: interrupted-contract cleanup now heals the REAL repository's contract (previously only touched the disposable clone's copy).
- Security: removed the `minitok_dev_mode` entitlement gate bypass. Paid execution now always requires a valid entitlement; internal tests use an excluded test-only authorization capability.

### Security & privacy

- Privacy: `last-run.json` is now sanitized with the same redaction rules as run evidence (plans/review LLM output previously persisted unredacted).
- Security: removed the non-functional AWS IAM (SigV4) auth stub — it shipped a `Credential=`-only header that cannot authenticate. `auth.type: iam` now fails with a clear error and an OpenAI-compatible-proxy workaround.
- Security: customer token files now receive owner-only permissions/ACLs after atomic replacement on Windows and POSIX.
- Packaging: LICENSE file restored to the tarball file list; `POLICY.md`/`DATA_CLASSIFICATION.md` ship in the tarball; stale `.tgz` archives removed; `.gitignore` typo fixed (`_last_run.json` → `last-run.json`); EULA referenced from README and shipped.

### Reliability

- Availability: offline grace is activated after a successful online validation for a bounded 7-day window (fail-closed before the first validation and after grace elapses; signed-expiry enforcement unchanged).
- Hardened: LLM HTTP calls retry 429/5xx and timeouts with exponential backoff honoring `Retry-After` (capped by the retry ceiling so a provider cannot suspend a paid run for hours); `execution.max_retries`, `retry_backoff_sec`, `retry_max_sec` consumed; `roles.<role>.fallback_model` retries failed completions on the fallback model.
- Reliability: `HTTPS_PROXY`/`HTTP_PROXY`/`NO_PROXY` are honored for LLM providers, entitlement validation, evolution uploads, and the update check; streamed responses are capped at 2MB instead of relying only on Content-Length.
- Reliability: update-check abort timers are unref'd; its cache writes are atomic; entitlement `status` shows plan/expiry again; run-lock stale reclaim is bounded (no infinite recursion on undeletable locks).
- Diagnostics: `minitok doctor` now checks entitlement state and installation-token presence, and gates on "at least one LLM provider configured" instead of failing single-provider customers.
- Fixed: `minitok status`/`doctor` now report the real package version (single source of truth in package.json).
- Fixed: run evidence now propagates from the isolated workspace back to the real repository on the default run path (`.minitok/evidence/runs/` no longer destroyed with the temp clone).
- Added: workspace run lock — concurrent `minitok run` invocations fail fast with a clear error; stale locks from crashed processes are reclaimed (bounded); interrupted runs mark the real repository's contract `interrupted` instead of leaving it `running` forever.
- Added: optional USD cost tracking via `providers.<name>.pricing` (`input_per_mtok`/`output_per_mtok`) shown in the run summary and recorded in the knowledge store.
- Windows: the verification gate no longer hard-requires Git Bash — WSL is detected explicitly and the portable `VERIFY_CMD.mjs` gate is used instead; without either it fails with actionable guidance. CI runs the full test matrix on `windows-latest` with lint enforced.

### Tests & tooling

- Tooling: replaced the syntax-only lint with ESLint (`npm run lint`), fixing all flagged issues in `src/`.
- Packaging: the published tarball contains the runtime, CLI, release verification scripts, and documentation listed by the package manifest; repository tests remain development-only.
- Tests: made the client/server contract test self-contained (no sibling repository dependency on fresh clones or CI).
- Tests: `npm test` now uses recursive test discovery (`node --test`), independent of shell glob expansion on supported Node versions and Windows.
- Tests: updated stale budget-default assertions to match the unlimited-with-hard-limits configuration.

## 1.3.1 - 2026-08-30

- Added role-specific provider selection with default-provider fallback.
- Added the complete intel, plan, implement, check, review, repair, and knowledge pipeline.
- Made `VERIFY_CMD.sh` the mandatory deterministic verification gate.
- Added `.minitok/contracts/` task contracts and context manifests.
- Added sanitized per-run evidence under `.minitok/evidence/runs/`.
- Added customer login and secure customer-token reuse for billing commands.
- Hardened production deployment image references, migrations, health checks, and rollback.

## 1.3.0

- Added online entitlement validation and installation-bound runtime enforcement.
- Added Dodo checkout, portal, webhook, activation-key, and subscription flows.
