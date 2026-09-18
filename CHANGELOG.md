# Changelog

## 1.4.6 - 2026-09-15

### Added

- Added `minitok mcp setup cline` for first-time MCP onboarding. It checks entitlement, guides users to account creation and paid-plan setup when needed, activates an account-backed installation without printing the one-time activation key, refreshes the local runtime token, writes the Cline configuration, and reports the next restart step.
- Added validated `GoalSpec` compilation and validation, including repository path, verifier, dangerous-field, execution-policy, and Repository ODD constraints. Model completion claims are metadata only; they do not establish goal completion.
- Added `GoalEvaluator` evidence collection and completion gates, persistent Goal Sessions with atomic state, checkpoints, locks, pause/resume, migration, and corruption handling, plus `GoalController` cycle limits, recovery, escalation, and capability-based model routing.
- Added the six persistent MCP Goal tools (`minitok_goal_start`, `minitok_goal_status`, `minitok_goal_continue`, `minitok_goal_pause`, `minitok_goal_resume`, and `minitok_goal_cancel`), with explicit scope checks and source/runtime parity for the bundled Extension runtime.
- Added mock-first local application observation with allowlisted localhost HTTP, process, API, browser-driver, and read-only database adapters; external access and deployment remain disabled by default.
- Added deterministic benchmark raw artifacts and validation for baseline/minitok records, including evidence and negative/security-case metrics. Mock benchmark output is not a live-provider measurement or a product-superiority claim.
- The executed local verification set passed: Goal unit tests 114/114, Goal E2E tests 9/9, MCP Goal and transport tests 21/21, discovery/CLI/Phase 0/local fixture tests 14/14, Registry metadata tests 4/4, release artifact tests 10/10, and version metadata tests 2/2; lint, typecheck, documentation consistency, version metadata, MCP Registry metadata, package dry-run, and runtime parity checks also passed. Real provider/live E2E, external Registry publication, and production validation were not run.

## 1.4.5 - 2026-09-15

### Changed

- Switched official MCP Registry ownership from the GitHub organization namespace to the verified `minitok.dev` domain namespace `dev.minitok/minitok`, so Registry publication does not require exposing a personal GitHub account as an organization member. The npm package remains `@flotic/minitok`; only `mcpName`, server metadata, and Registry ownership proof changed.

## 1.4.4 - 2026-09-15

### Added

- Added official MCP Registry and downstream marketplace publication metadata. `server.json` follows the official npm/stdio Registry schema and uses `io.github.floticinfo/minitok` with npm ownership verification through `package.json.mcpName`. `mcp-marketplace.json` documents transports, tools, resources, prompts, authentication, active paid entitlement, scopes, approval behavior, privacy, telemetry, and provider-cost boundaries. Added offline metadata validation, npm-pack inclusion checks, and an OIDC-based tag publication workflow for operator-approved releases. No credentials or automatic publication are performed by local checks.

## 1.4.3 - 2026-09-15

### Added

- Added MCP compatibility for current commercial hosts: protocol negotiation for `2025-11-25`, `2025-06-18`, `2025-03-26`, `2024-11-05`, and `2024-10-07`, standard `Content-Length` stdio framing with legacy newline compatibility, response framing preservation, bounded frame parsing, current Cline configuration paths, and an explicit empty `autoApprove` default. The release is based on the complete 1.4.2 codebase; non-MCP features from 1.4.2 are retained.

## 1.4.2 - 2026-09-15

### Changed

- Repackaged the emoji-free CLI and Extension artifacts from the final emoji-removal sources.
- Bumped the npm CLI to 1.4.2 and the VS Code Extension to 0.3.2 so the corrected artifacts can be published without reusing already-published versions.

## 1.4.1 - 2026-09-15

### Changed

- Removed emoji and pictographic symbols from CLI, pipeline, model listings, OAuth messages, Extension UI, and packaged runtime output.
- Kept the Extension runtime and VSIX metadata synchronized with CLI 1.4.1.
- Excluded development-only undici mock and documentation files from the VSIX package.

## 1.4.0 - 2026-09-14

### Added

- **A single brand palette for every surface minitok owns.** `src/core/palette.js` now holds the brand colours (`primary` `#013DCF`, `primaryHover` `#012CA8`, `deepNavy` `#03045E`, `secondaryBlue` `#0077B6`, `cyanAccent` `#00B4D8`, `sky` `#90E0EF`, `pale` `#CAF0F8`, plus the `onPrimary` glyph colour) together with the role and the contrast ratio of each entry, so a colour decision is made once instead of once per surface. Neutral surfaces and backgrounds stay out of the palette on purpose: the CLI keeps the operator's terminal background and the webviews keep the editor's `--vscode-*` variables, so the brand only paints what minitok owns. The CLI derives 24-bit ANSI from the tokens instead of hardcoding indexes (` ACT ` is white on `primary` and ` PLAN ` is pale on `deepNavy`, both as filled tiles, because `primary` is 2.6:1 against a black terminal and would be unreadable as a foreground), the webviews declare the values as `--mt-brand-*` custom properties, and MCP stays colour-free because its JSON-RPC payload is rendered by the host and would show the escape sequence literally. README documents the tokens and `src/core/palette.test.js` locks the values, the legibility rules and the webview mirror.

### Changed

- **A run is successful only when its final cycle is approved.** `success` followed any cycle that reached `APPROVE`, but a goal-directed run keeps working after it approves a change set, so a run that approved and then failed the follow-up task it generated was reported as a success in `task-contract.json`, in the process exit code and in the evolution record -- while the change set it "succeeded" with was never merged. `success` now follows the last cycle, `approved` records that an earlier cycle passed, and the evolution record and upload use the documented third state `partial` for that case. The isolated runner merges only an approved final change set and preserves anything else at `.minitok/last-run.patch`, which also stops it from merging a change set that the final review rejected. The contract and the run evidence carry `last_cycle_status` so the verdict is readable without replaying the cycles. A run that approves and then fails its follow-up now exits non-zero where it used to exit zero; inspect `.minitok/last-run.patch` for the change set it did not merge.

### Fixed

- Fixed credentials stored under a provider alias (`claude`, `gpt`, `gemini`) never authenticating. `auth login`/`auth logout` and the token store keyed credentials by the raw argument while every consumer (`AuthManager.resolve()`, `doctor`, `run`, the pipeline loop) looked up the normalized name, so `minitok auth login gpt` stored `gpt.json` and every lookup reported the credential as missing. Provider aliases now resolve once, at every boundary (`src/auth/aliases.js`), and the token store falls back to the legacy alias key so a `gpt.json` written by an older version keeps working.
- Fixed multi-byte UTF-8 characters in HTTP response bodies being corrupted into `U+FFFD` replacement characters whenever a stream chunk boundary split the character (a Korean or emoji string in a provider error message, for example). `readCappedResponse` and `postJson` now accumulate the raw chunks and decode the concatenated bytes once instead of decoding every chunk independently.
- Fixed `minitok run --approval-file`, the sidebar and TUI approval wait, and the MCP approval tools in isolated mode. The approval path was validated against the disposable clone instead of the operator's repository, so every file-backed approval failed with `approval_file must be under workspace/.minitok` before a single change was reviewed, and the extension waited for a file that could never be written. The run now carries the operator-visible workspace through as `approvalRoot` and the GUI runner writes its approval file into `<repo>/.minitok` rather than the OS temp directory. `--auto-accept` is honoured before the approval file is consulted, so the extension's `autoApprove` setting (which passes both flags) no longer waits out the timeout and then rejects every change.
- Fixed an isolated run leaving the operator-visible `.minitok/contracts/task-contract.json` on `running` (or on the `interrupted` written by the heal at run start) after it had finished, because the terminal contract lived only in the clone that was deleted. The terminal state is now mirrored on completion, on a pipeline exception and on a failed final merge, together with `merged` and the merge outcome, so an approved run whose diff could not be applied is visible as such.
- Fixed a provider reply that carried no text being reported as `Invalid JSON in response`. A refusal (Anthropic `stop_reason`, OpenAI `finish_reason`, Gemini `promptFeedback.blockReason`) and an answer cut off by the output token budget are now explicit provider errors carrying the stop reason, and the planner, implementer, verifier and reviewer report "the model stopped at its output token limit" instead of retrying, escalating and paying for the same overflow again. A truncated reply is not retried, because the same budget truncates it again; a malformed reply still is.
- Fixed the verification gate blocking the whole host: the gate ran through `execFileSync`, which freezes the event loop of the long-lived MCP stdio server, so health, status and every other MCP session stalled for the duration of the gate and a gate that never exits held the server until it was killed. `check.js` now has an asynchronous twin (`runProcessAsync`, `runVerificationAsync`, `verifyCommandAsync`) with the same contract -- the bundled-gate refusal, the Windows bash fallback and the timeout -- and the cycle awaits it.
- Fixed the write policy protecting the verification gate only through a hardcoded path list. A repository that moves the gate (`validation.script_path`) could have its own verifier rewritten by the model that has to pass it, and `applyChanges` accepted a protected-path option that no caller passed. The resolved gate now reaches the write policy as an extra protected path, `security.blocked_extensions` is read from `minitok.yml` as well as from the defaults, credential files and unpacked keys are refused by name, and a large file is no longer replaced by a much smaller one.
- Fixed the isolation git calls hanging: clone, merge and cleanup shelled out to git without a timeout or a prompt guard, so a repository that asked for credentials, or a stalled network operation, held the operator's terminal open indefinitely. Every call in `isolation.js` is now bounded and runs with terminal prompting and askpass disabled, and fails with a clear error instead of waiting on a prompt nobody can answer.
- Fixed an unreadable run lock -- empty, truncated mid-write, no PID, not an object -- being treated as a stale lock, which is the same as no lock at all: a second run started while the first was still writing and two runs then edited the same repository. Unreadable locks now fail closed with a grace window that separates a lock being written right now from a dead writer, a lock held by another host is judged by age only, and the workspace registry lock follows the same rule.
- Fixed `minitok status --json` printing no JSON at all when one unreadable workspace state, entitlement record or configuration file made the command throw -- the exact case the machine-readable form exists for. Each section is read defensively, a failure is reported as `workspace_error` with the rest of the report intact, and the command sets an exit code instead of calling `process.exit` so buffered output is flushed.
- Fixed MCP `tools/list` returning the full catalogue to every session: a read-only session was offered `minitok_run`, called it, and collected `PERMISSION_DENIED` for a tool it should never have been shown. The advertised list now runs through the same scope check as the call path (`_toolAllowed` over `TOOL_SCOPES` and `TOOL_EXTRA_SCOPES`), so the advertised surface and the enforced one cannot drift apart.
- Fixed a stdio MCP session reading the runtime token file only at startup: an expired or revoked record kept authenticating, and a rotated one kept the old session alive until the host was restarted. A session that authenticates with the process credential now re-reads the rotating record on every authentication (`MINITOK_MCP_AUTH_TOKEN_FILE_REFRESH_MS`, 5s by default, 0 = always), an unreadable record fails closed without blacklisting the process, and an explicit token still wins and disables the refresh. `minitok mcp disconnect` revokes the shared token file only when no other host configuration still references it, so disconnecting one editor no longer signs out the others.
- Fixed a failing pipeline being reported as successful over MCP: the tool handler always replied with `isError: false`, so a failed run looked successful in `run_get`, `run_list` and the persisted run record that survives a restart. The handler preserves the flag it was given, `minitok_run` sets it when the pipeline did not succeed, and the stdio runtime derives the run state from the result envelope as well as from the flag -- `failed` when the envelope says failed, when `success` is false, or when the run was cancelled.
- Fixed the extension's MCP model probe echoing the bearer token inside every JSON-RPC request, which is not how a real host authenticates: VS Code, Claude Desktop and Cursor pass the environment and the arguments and nothing else. The probe launches the CLI exactly like the generated host configuration does (`MINITOK_MCP_AUTH_TOKEN_FILE`) and never puts the token in request params. A run is cancelable and bounded again: status answers keep their short CLI timeout while a run gets a long one, and the sidebar has separate `minitok.approvalTimeoutMs` and `minitok.runTimeoutMs` settings instead of one 30-minute window that killed a run while it was still waiting for a human answer.

### Documentation

- README "Run evidence" documents the final-cycle outcome contract: `success`, `approved`, `last_cycle_status`, `merged`, the `approved-not-merged` outcome, and the `partial` evolution status that records an approval the run did not finish with.
- The bundled Extension runtime is re-synced with the sources above (`npm run sync:extension-runtime`), so the packaged extension and the CLI run the same pipeline.

## 1.3.19 - 2026-09-13

### Changed

- **The provider surface is now Anthropic, OpenAI, and Google, plus custom OpenAI-compatible endpoints.** OpenRouter had its own provider class, its own model-discovery tier, its own keychain entry, and its own row in `minitok doctor`, and the legacy credential map carried an environment variable for xAI, DeepSeek, Mistral, and Cohere as if they were shipped providers. All of that is gone: `openrouter`, `xai`, `deepseek`, `mistral`, `cohere`, and the GitHub and Azure AD OAuth logins are no longer first-class, and a configuration that names one of them without an endpoint is refused with `Unknown LLM provider: <name>. Set base_url for custom providers.`
  Migration for a repository that used one of the removed entries:

  ```yaml
  providers:
    openrouter:                      # any name, including the removed ones
      base_url: https://openrouter.ai/api/v1
      api_key_env: OPENROUTER_API_KEY
      model: anthropic/claude-sonnet-5
  ```

  The endpoint is validated and credential-scrubbed exactly like any other custom provider, and `minitok models --discover` lists it under the custom section. Nothing else changes: the model catalogs, roles, fallbacks, and `roles.<role>.provider` resolution are untouched.

### Fixed

- `providers.<name>.api_key_env` is now read. `minitok.yml` and the README documented the key, but no code path consulted it, so the credential came only from `api_key` or from the four built-in environment variables. A custom provider can now name the vendor's environment variable, which is what makes the endpoint-only configuration above usable.
- `api_key_env` is validated: a value that is not an environment variable name (a literal key, an empty string) fails configuration loading with `providers.<name>.api_key_env must name an environment variable` instead of silently leaving the provider without credentials.

### Documentation

- The 1.3.18 notes listed the live-page edits as remaining. They were deployed the same day: `/terms` section 9 now states the Republic of Korea governing law and venue with the customer's residence option, `/terms`, `/refund`, and `/privacy` publish the EULA section 11 notice address in one English form, and all three pages carry the September 2026 date.
- `DATA_CLASSIFICATION.md` no longer lists the telemetry retention mismatch as an open item: the server now applies the published 30-day (Open) and 14-day (Select) periods, so the inventory, `POLICY.md` section 10, and the live privacy notice agree.

## 1.3.18 - 2026-09-13

### Documentation

- Recorded the operator's data-inventory answers in `DATA_CLASSIFICATION.md` section 9.1, each answered from the implementation that produces the data: hostnames (the shipped client sends only `{ key, installation_id }`; the server accepts an optional activation hostname and the deletion path clears it), IP addresses (derived by the server for rate limiting and the request log, never a telemetry field), support messages (the published form posts to `POST /api/support`, which delivers by email and keeps no support table), Sentry events (no error-reporting SDK in either implementation), and infrastructure logs (framework request logging plus host and proxy access logs). The document is version 1.2.0.
- Opened one item that the audit of the two implementations raised: the server deletes telemetry on a single 90-day schedule and the privacy policy it serves states 90 days, while `POLICY.md` section 10, `DATA_CLASSIFICATION.md`, and the live privacy notice publish 30 days for Open and 14 days for Select. Either the cleanup or the published periods have to change; until then the implementation retains telemetry longer than the published commitment.
- Re-verified the legal-consistency table in `LEGAL_REVIEW_DRAFT.md` section 6 against the live pages. The refund promise is gone from the pricing page, the pricing note, the FAQ, and the refund page (the remaining items are the terms governing-law paragraph, one English form for the company address, the last-updated dates, and the install command, which follows the npm publish).


## 1.3.17 - 2026-09-13

### Security

- **MCP `minitok_run` now requires the `verify_exec` scope** in addition to `write`. A run executes the target repository's own verification script (`validation.script_path` / `VERIFY_CMD.*`), and a client that could write files was implicitly allowed to run repository code with the operator's account. A client granted only `read,write` is refused with `PERMISSION_DENIED` (`data.scope: verify_exec`) until the grant is added: `minitok mcp connect <host> --scopes read,write,verify_exec`, `minitok runtime start --scopes read,write,verify_exec`, or `MINITOK_MCP_SCOPES=read,write,verify_exec`. Existing MCP configurations that only list `read,write` must add the scope to keep using `minitok_run`.
- **The verification gate no longer receives credentials.** The repository's verification script now runs with the MCP auth token (`MINITOK_MCP_AUTH_TOKEN*`), minitok account/activation tokens, and provider API keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `GOOGLE_API_KEY`, `OPENROUTER_API_KEY`, and equivalents) removed from its environment. `PATH`, `HOME`, proxy settings, and unrelated application variables are still passed through, so an ordinary build gate is unaffected.
- **The Windows and macOS keychain writes no longer expose the secret on the command line.** Storing a provider token passed the JSON payload as a PowerShell `-Command` argument (or `security … -w <payload>`), which every local process can read through `Win32_Process.CommandLine` (Task Manager, WMI, Sysmon) or `ps`. The payload is now written to the child's stdin, and a write is only treated as successful when the stored secret can be read back with the same token — otherwise the owner-only token file is used as before.

### Fixes

- Fixed the MCP run registry growing without bound. The in-memory map kept one entry per run for the life of the runtime process (the persisted file was capped at 100 records, memory was not), so a long editor session accumulated every run and `minitok_run_list` returned them all. Finished runs are now evicted oldest-first beyond 100 entries; recent runs stay addressable and a running run is never evicted.
- Fixed a completed oversized stdio request being parsed instead of refused. The 4 MB line cap only applied to an unterminated remainder, so a line that arrived with its newline was handed to the JSON parser and its tail could be answered with a confusing parse error. The cap now applies to complete lines as well, and the remainder of an oversized line is discarded until its newline so following requests stay in sync.
- Fixed the provider verification cache serving a verdict that belonged to a different credential. The cache key was `provider + endpoint`, so a key the user had just replaced kept its previous 401 rejection (and a revoked key kept its OK) until the TTL expired. The cache is now keyed by a fingerprint of the resolved credential, and `minitok auth login`/`auth logout` clear it explicitly (`resetVerifyCache` previously had no caller).
- Fixed the VS Code extension writing the MCP host entry to the wrong container. A host configuration that lists its servers under `servers` was read from that key and then written to `mcpServers`, so the host never loaded the minitok entry listed as connected.
- `minitok mcp status` now reports whether the configured MCP auth token file is usable and names the reason and the expected binding path. A runtime token record is only accepted when its `installation_id` matches the `installation-token.json` beside it, so a token file outside `~/.minitok/mcp/` was refused with no diagnostic while every call failed with `AUTH_REQUIRED`.
- The expected "keychain module missing" PowerShell error no longer leaks into `minitok auth` output: the keychain child's stderr is discarded, and the owner-only token file remains the documented fallback.

### Changed

- `LOCAL_MCP_SCOPES` gained `verify_exec`; `minitok mcp connect --scopes` and `minitok runtime start --scopes` help text lists it. The CLI `minitok run` command is unaffected: the scope gates the MCP surface only.

## 1.3.16 - 2026-09-13

### Fixes

- Fixed the interactive TUI approval prompt (`minitok gui`). The answer was written as `{ decision }` alone, while the pipeline only accepts a response that repeats the request nonce and run id, so every approval was discarded as invalid and the run waited out the full approval timeout (30 minutes by default) before failing closed. The response is now built from the request file and written atomically.
- Fixed the VS Code `minitok: Run Task` command for the default configuration. The consent dialog was collected and then not forwarded, so the CLI (which has no TTY) refused every file change with `No TTY detected` after the cycle had already been paid for. Consent now passes `--auto-accept`, matching the panel's behaviour.
- Fixed a malformed `minitok.yml` being silently ignored. Unparseable or unreadable project and global configuration files now raise a `ConfigError` that names the file, so the run no longer proceeds with defaults the user never wrote; a missing file is still the only silent fallback, and a directory that happens to be named `minitok.yml` is skipped as before. `minitok run` reports the error before any provider probe.
- Fixed the file-name policy being bypassable with names the operating system normalizes: `minitok.yml.`, `minitok.yml `, `evil.ps1.`, `evil.ps1 `, `evil.ps1:hidden`, and `MINITO~1.YML` all passed the protected-path and blocked-extension checks and were written as near-miss files (the alternate-data-stream case also left a 0-byte `evil.ps1` behind). Names that end with a dot or space, contain `:`, an invalid or control character, or a Windows device name, or (on Windows) look like an 8.3 short name are now refused; the protected-path and blocked-extension checks also normalize before comparing. A change set containing such a name is refused as a whole.
- Fixed the VS Code extension spawning the CLI for every entitlement question. Activation, each sidebar command, and the panel each started a separate process for the same answer; a granted decision is now reused for 60 seconds and a denial for 10 seconds, and a login, logout, or manual refresh drops the cached decision.
- Fixed `minitok run` live-checking every configured provider before starting. Only the providers the roles resolve to are probed now (up to 8 seconds per unused key before, plus a warning about keys that could not affect the run); `minitok doctor --verify` remains the command that audits all of them.
- Fixed the MCP stdio transport buffering an unbounded line: a client that never sent a newline could grow the buffer until the process ran out of memory. A line above 4 MB is now rejected with an `INVALID_REQUEST` error instead (the HTTP transport already capped a body at 1 MB).
- Fixed the update-check lock overriding a live writer on another machine that shares the home directory; only the stale age decides for a foreign host, and the wait is bounded at roughly 200 ms so it cannot delay a command.

### Changed

- Removed the role options `tools`, `variant`, and `mode` and the `execution.search` block from the defaults, where nothing read them. A `minitok.yml` that still contains them is ignored; `minitok doctor --verify` and the role `provider`, `adapter`, `model`, `effort`, `reasoning`, `thinking_budget`, `fallback_model`, `fallback`, and `timeout_sec` options are unaffected.
- `project.name` and `project.stack` now reach the model: they are added to the planner and implementer prompts as a `Project:` line instead of being written and never read.

## 1.3.15 - 2026-09-13

### Fixes

- Fixed `minitok run --approval-file` and `--approval-timeout-ms` being parsed by the CLI and then dropped before the pipeline. File-backed approval works from the CLI again, and the VS Code sidebar's Approve/Reject buttons work instead of waiting for a `MINITOK_APPROVAL_REQUEST` line that was never written; the run signal is forwarded too, so Ctrl+C ends the approval wait instead of holding it for the full timeout.
- Fixed the VS Code extension on Windows, where no extension command could launch the CLI: the resolved `minitok.cmd` shim was handed to `cmd.exe` as a single argument escaped for the MSVCRT parser, so cmd.exe reported `'\"…minitok.cmd\"' is not recognized`. The entitlement preflight therefore reported "an active paid plan is required" to paying customers. CLI resolution now prefers the package's JavaScript entry point (executed by node, so cmd.exe is not involved), `.cmd` shims are launched with the command line passed verbatim, and an argument containing characters cmd.exe would re-parse is refused for a shim instead of executed. The panel's consent dialog now authorizes the run, and the update check/install and `minitok models --discover` use the same launch path.
- Fixed `minitok mcp connect` writing `%APPDATA%`-based paths on macOS and Linux, where it created `~/AppData/Roaming/...`, printed "Connected", and left the editor's real configuration untouched. Host locations are per platform now, an uninstalled host fails closed with the locations it checked, `--host-file <path>` writes a specific file, `minitok mcp status` prints the resolved path, and `--keep-backup` keeps the restore copy that `--no-backup` skips.
- Fixed configuration and flags that were accepted, documented, and env-mapped without a consumer: `roles.<role>.timeout_sec` / `execution.timeout_hard_limit_sec` now bound each provider request, `security.blocked_extensions` reaches `applyChanges` (as a floor that configuration can extend but not weaken), `validation.enabled: false` skips the verification command, `validation.max_changed_files` refuses an oversized change set before anything is written, and `validation.confidence_threshold` downgrades a low-confidence APPROVE and drives the goal-progress gate.
- Fixed `--coding-adapter`, `--research-adapter`, and `--review-adapter` being forwarded and then ignored; they now configure the work, intel, and review roles.
- Fixed the temp sweeper reclaiming any entry whose name merely began with `mt-`, which risked deleting an unrelated program's temporary data. The default ownership rule is `minitok-`, `mtok-`, `evo-optin-`; pass `--prefixes minitok-,mt-` to collect legacy fixtures explicitly.
- Fixed device login deciding whether to keep polling by comparing human-readable error text, which failed for a structured error body.
- Fixed a stale extension test assertion (the panel timeout had been extracted into a constant) and wired the extension unit tests into `npm run release:check` through the new `npm run test:extension`.

### Changed

- Removed the unimplemented `commit` section from the defaults, the `minitok migrate` template, and the shipped `minitok.yml`: `commit.enabled` and `commit.auto_message` never had a consumer. A configuration that still contains the section is ignored.
- `roleOpts` now passes the resolved per-role timeout with every request, and the goal-progress confidence gate uses the configured `validation.confidence_threshold` instead of a hardcoded `0.8`.

## 1.3.14 - 2026-09-13

### Documentation

- `EULA.md` now publishes the approved commercial terms: the contracting entity **Flotic LC.** with its notice address, Republic of Korea governing law and venue, the Korean consumer-rights carve-out, email support within 24–48 hours Monday–Friday (UTC), the privacy notice URL, and the subscription model with no refunds — fees are charged in advance per period, cancelling stops the following period, the paid period stays usable, and no credit or pro-rated refund is given.
- `POLICY.md` section 10 records the published legal positions (controller, provider roles, privacy officer, legal bases, international transfers, rights handling, retention) instead of asking for them, `DATA_CLASSIFICATION.md` section 9 points at that section, and `npm run commercial:readiness` no longer reports `BLOCKED` for `legal-owner-approval` or `privacy-owner-approval`.
- `LEGAL_REVIEW_DRAFT.md` is the record of what was applied, which published page each value came from, which minitok.dev pages still advertise the refund promise that `EULA.md` no longer offers, and the ready-to-paste English copy for those pages.
- Every business and product string in the shipped package is English-only: the Korean legal-entity name, representative name, notice address, and statute names in `EULA.md` and `POLICY.md` are their English forms; the Windows localized-name comments in `src/utils/file-permissions.js` and the embedded runtime copy are English; and the multi-byte audit fixture in `src/core/audit.test.js` is written as escapes, so the source stays ASCII while the runtime string stays multi-byte.

## 1.3.13 - 2026-09-13

### Fixes

- Fixed the MCP tools that take a `run_id` (`minitok_run_get`, `minitok_run_cancel`, `minitok_approve_run`, `minitok_reject_run`). The server overwrote the client-supplied id with `null`, so all four failed schema validation with `INVALID_PARAMS` on both transports. The file-backed approval flow documented for `minitok_run` works again.
- Fixed the local MCP `read` scope not being read-only. `minitok_knowledge_record` and `minitok_observe` persist to the home directory but were annotated as non-destructive, so they ran under the default scope. Scope requirements now come from an explicit per-tool table.
- Fixed unvalidated arguments reaching tool handlers. `minitok_run` accepted a `run_id` that no schema checked, while every other tool silently ignored one; the transport injects the server-generated id for `minitok_run` only, and handlers receive the validated argument object.
- Fixed `minitok_analyze_failures` and `minitok_recommend_policy` rejecting the `project` argument their handlers read, which made every call analyze all projects instead of the requested one.
- Fixed `RuntimeStdio` accepting and ignoring an injected `runPipeline`, which sent embedders and tests to the real pipeline.
- Fixed an unknown command reaching the default CLI action, which opened the terminal interface on a TTY and printed the bare-invocation hint on a pipe.
- Fixed the Extension CLI version gate: it rejected `minitok 1.3.12` because the CLI prints a product prefix, and rejected every future major release because major and minor were compared independently.
- Fixed arbitrary PowerShell execution through a provider name on Windows. `TokenStore` interpolated the provider name from `minitok.yml` into a `powershell.exe -Command` script, so a name such as `x') ; <payload> ; ('y` ran the payload while resolving OAuth credentials (reproduced: the injected statement created a file). Names are escaped for the single-quoted literal, and `validateConfig` rejects provider names containing shell or path metacharacters.
- Fixed `minitok run` refusing a workspace whose path casing differs from the on-disk casing. `realpathSync.native()` returns the on-disk casing while `path.resolve()` keeps the caller's, so `--repo c:\src\app` failed the link check with `Unsafe workspace path` before the run started.
- Fixed the built-in providers ignoring a configured `auth:` block. `_probeProvider()` merged the resolved headers but `complete()` did not, so `auth: { header: ..., scheme: ... }` had no effect on real requests and an OAuth bearer token was sent as Anthropic's `x-api-key`. Configured headers now win, and a credential is never sent twice.
- Fixed reasoning models on the OpenAI-compatible path: `o1`/`o3`/`o4` (and the GPT-5 family on the official endpoint) reject `max_tokens` with "Unsupported parameter", so they now receive `max_completion_tokens` and only a temperature they were explicitly given. Compatible gateways keep `max_tokens`.
- Fixed credential files that were copied or previously shared keeping an explicit grant for Everyone after `setOwnerOnlyPermissions()`. `/grant:r <user>:F` only replaces the current user's entries; the broad principals (Everyone, Users, Authenticated Users, INTERACTIVE, Guests) are now removed by well-known SID, which also works on non-English Windows.
- Fixed browser auto-launch during `auth login` in a non-interactive session: the browser command is only spawned when stdin and stdout are a terminal. The authorization URL is always printed, so a remote session can still complete the flow.
- Fixed roughly one second of avoidable latency per LLM call on Windows: `TokenStore.load()` started a PowerShell process for every `isValid()`/`load()` pair, which the auth resolver performs on each request. Reads are cached for 5 seconds and every write invalidates the entry.


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
- Fixed the knowledge-store lock spinning a full CPU core for the whole 30 second timeout whenever another run held it; retries now back off 50 ms, and a lock file corrupted by a crash no longer masks the caller's error.
- Fixed the runtime idle shutdown calling `process.exit()` without waiting for `stop()`. The lock release runs inside the server close callback, so the exit aborted it and left a stale lock behind.
- Temporary and lock file names are now derived from `crypto.randomBytes()` instead of `Math.random()`/pid (isolation patch, `last-run.json.tmp`, change temporaries, keychain temporary, update-cache lock, workspace registry lock), so two runs inside one process can no longer unlink each other's in-flight file.
- `applyChanges` records `overwrote: true` on the audit entry when a `create` replaces an existing file, instead of replacing it silently.
- Provider failures include the API's own error message (invalid model, quota, oversized request) instead of only the HTTP status code.
- The type checker is clean again: four pre-existing `tsc` errors in `src/cli/commands/run.js` (provider names inferred as `boolean`) and `src/utils/temp-cleanup.js` (undocumented options) are fixed, so `npm run typecheck` (part of `release:check`) passes.



### Added

- `minitok mcp token` ensures the local MCP runtime token is valid, rotating it when missing or expired. It never prints the token itself.
- `minitok runtime start --idle-timeout <minutes>` configures the idle shutdown; 0 disables it.

### Extension

- Moved the CLI compatibility check to `extension/src/version.ts` so it can be exercised under Node, with a test that asserts the gate accepts the exact string `minitok --version` prints.
- The panel's workspace trust check now runs inside the handler's `try`: it threw before the `catch`, which became an unhandled rejection with no feedback in the webview. The 30 minute run timeout also settles its promise, so a kill that cannot be delivered no longer leaves the panel stuck on "A minitok run is already active".
- Device authorization requests have a 15 second deadline (`fetch` had none) and `slow_down` is honored per RFC 8628 instead of failing an otherwise valid login.


### Tests

- Added transport-level coverage for the MCP tool surface (`tests/test-mcp-tool-transport.js`), which previously only tested unauthenticated requests and therefore never reached the entitlement, scope, or run_id paths.
- Corrected stdio test names that claimed to verify the paid entitlement gate while asserting pre-authentication rejection.
- Added pipeline hardening coverage: signal listener counts across repeated runs, cancellation during an approval wait, and `execution.research_enabled`.
- Added runtime coverage: least-recently-used session eviction and the configurable idle shutdown.
- Added remote MCP coverage: an expired cached OAuth token is never reused and a 401 starts the OAuth refresh path.
- Added extension coverage: Windows paths survive `parseMcpCommand`, the MCP handshake can refresh the runtime token, and `run`/`status` target the open folder.
- Added `src/entitlement/model.test.js` (timestamp acceptance) and `tests/test-migrate-output.js` (generated configuration and `.gitignore` preservation).
- Added regression coverage for the provider-name injection (a marker file that must not be created on Windows), provider-name validation, acceptance of a workspace whose path casing differs, the knowledge-store lock back-off (with a CPU assertion), idle-shutdown ordering, the create-overwrite audit entry, and provider error details.
- Added coverage for provider request headers, the reasoning-model request body, the Windows ACL cleanup (asserting the removed SIDs against a live ACL), the token read cache, and the OAuth browser policy.



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
