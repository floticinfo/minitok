# MiniTok Release Status

This file is the canonical version map for the current checkout. Historical tags, changelog entries, and published npm versions are retained intentionally and must not be treated as the current source.

## Current source

- CLI package: `@flotic/minitok@1.5.6`
- CLI release tag: `v1.5.6`
- Extension: `0.3.3`
- MCP Registry namespace: `dev.minitok/minitok`
- Canonical branch: `release/1.5.6-candidate`
- Release commit: `326d1ef` (`release: prepare minitok 1.5.6`)
- Current canonical checkout: `dbdf221` (`docs: refresh canonical checkout status`)
- Release manifest commit: `33a9191`
- VSIX: `extension/artifacts/minitok-extension-0.3.3.vsix`

## Publication status

- npm published latest: `1.5.5`
- npm `1.5.6`: **BLOCKED** — npm authentication unavailable (`npm whoami` returned 401); publish not attempted
- npm `1.5.6` local tarball SHA-256: `c94d0a428a27465a53e0ff2023f417922e9db90dad0a28b6e8c38e81da61a0a8`
- VS Code Marketplace `Flotic.minitok@0.3.3`: **BLOCKED** — publisher/publish credential unavailable; Marketplace query returned not found; publish not attempted
- VSIX `extension/artifacts/minitok-extension-0.3.3.vsix` SHA-256: `5ae031b17125eaa67f3e3ec8458d38ea9ed3544fa39ffb01abed0de88cd271be`
- External publication verification timestamp: `2026-10-27` UTC; local artifact and clean-install verification passed
- Remote MCP production entitlement/authentication: unverified without customer credentials

## Server versioning

The `minitok-server` repository uses an independent API version (`0.1.0`) and deployment history. It is not the CLI package version. The production server currently contains the administrator device authorization and Passkey approval changes from the admin-device-auth deployment.

## Historical versions

The following are retained as history and should not be selected as the current source:

- npm versions before `1.5.5`
- Git tags before `v1.5.6`
- old release/candidate branches such as `release/1.4.3-mcp`, `release/1.4.5-domain-mcp`, `release/1.4.6-candidate`, `release/1.4.7`, `release/1.4.10`, and `release/v1.4.11`

Some legacy worktrees contain uncommitted changes and are intentionally preserved until reviewed. Do not delete them automatically.
