# Product Hunt

## Product name
minitok

## Tagline
AI coding with a verification loop, not just code generation.

## Description
minitok is a repository-aware coding workflow CLI for teams that want AI-assisted changes to be researched, planned, implemented, deterministically verified, reviewed, repaired, and recorded as inspectable evidence. It supports multiple LLM providers, VS Code integration, and authenticated MCP transports, including a read-only HTTPS remote endpoint.

It supports Anthropic, OpenAI, and Google, plus OpenAI-compatible endpoints as custom providers, while keeping execution local-first. It also provides VS Code integration and authenticated MCP transports, including an HTTPS remote endpoint with read-only status and compaction tools. Telemetry is opt-in and disabled by default.

This launch focuses on the workflow and evidence model rather than unsupported speed or accuracy claims. The demo uses a disposable repository, and benchmark evidence should only be published when real paired runs are available.

## Links
- Website: https://minitok.dev
- Documentation: https://minitok.dev/docs
- GitHub: https://github.com/floticinfo/minitok
- npm: https://www.npmjs.com/package/@flotic/minitok

## Install
```bash
npm install -g @flotic/minitok
minitok doctor
```

## Disclosure
minitok is paid software; provider costs also apply. It is a workflow tool, not an AI model, and it does not guarantee correctness or deployment outcomes.
