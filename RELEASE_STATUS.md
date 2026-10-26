# MiniTok Release Status

This file is the canonical version map for the current checkout. Historical tags, changelog entries, and published npm versions are retained intentionally and must not be treated as the current source.

## Current source

- CLI package: `@flotic/minitok@1.5.6`
- CLI release tag: `v1.5.6`
- Extension: `0.3.3`
- MCP Registry namespace: `dev.minitok/minitok`
- Canonical branch: `release/1.5.6-candidate`
- Release commit: `326d1ef` (`release: prepare minitok 1.5.6`)
- Current canonical checkout: `7ccf121` (`docs: record canonical 1.5.6 checkout`)
- Release manifest commit: `33a9191`
- VSIX: `extension/artifacts/minitok-extension-0.3.3.vsix`

## Publication status

- npm published latest: `1.5.5`
- npm `1.5.6`: release candidate only; not published
- VS Code Marketplace: `0.3.3` not published; Marketplace lookup previously returned 404
- Remote MCP production entitlement/authentication: unverified without customer credentials

## Server versioning

The `minitok-server` repository uses an independent API version (`0.1.0`) and deployment history. It is not the CLI package version. The production server currently contains the administrator device authorization and Passkey approval changes from the admin-device-auth deployment.

## Historical versions

The following are retained as history and should not be selected as the current source:

- npm versions before `1.5.5`
- Git tags before `v1.5.6`
- old release/candidate branches such as `release/1.4.3-mcp`, `release/1.4.5-domain-mcp`, `release/1.4.6-candidate`, `release/1.4.7`, `release/1.4.10`, and `release/v1.4.11`

Some legacy worktrees contain uncommitted changes and are intentionally preserved until reviewed. Do not delete them automatically.
