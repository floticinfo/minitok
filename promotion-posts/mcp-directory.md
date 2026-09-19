# MCP Directory

> This file is a reviewed submission draft. It does not publish automatically.

## Official MCP Registry identity

- **Registry name:** `io.github.floticinfo/minitok`
- **Package:** `@flotic/minitok@1.4.10`
- **Standard metadata:** `server.json`
- **Downstream marketplace metadata:** `mcp-marketplace.json`
- **Ownership check:** `package.json.mcpName` exactly matches the Registry name

## Name
minitok MCP

## Short description
Repository-aware coding workflow controls for MCP clients with authentication, entitlement enforcement, policy boundaries, deterministic verification, and recorded evidence.

## Full description
minitok MCP exposes repository-aware coding workflow controls to MCP clients. The workflow separates repository research, planning, implementation, deterministic verification, review, repair, and evidence recording.

Supported transports:
- stdio
- authenticated localhost HTTP
- authenticated HTTPS remote MCP at `https://api.minitok.dev/mcp`

The remote endpoint exposes only read-only status and compaction tools. The MCP integration is not an AI model and does not replace the configured model provider.

## Setup
Install the public npm package, authenticate the user, and generate host configuration:

```bash
npm install -g @flotic/minitok@1.4.10
minitok doctor
minitok mcp connect cline --scopes read,write,verify_exec
```

The server requires an active paid minitok entitlement. `minitok mcp connect` creates an owner-only rotating runtime-token reference; it does not place a bearer token in the marketplace metadata or host configuration. Repository-changing tools require explicit `write,verify_exec` scopes and are not auto-approved by default.

## Links
- Documentation: https://minitok.dev/docs
- Source: https://github.com/floticinfo/minitok
- Package: https://www.npmjs.com/package/@flotic/minitok

## Security and privacy
- Never publish tokens, customer JWTs, installation-token files, provider API keys, or account cookies.
- Official Registry ownership is verified through the GitHub namespace and npm `mcpName` metadata.
- Authentication and active paid entitlement checks remain enabled for production MCP constructors.
- Local MCP defaults to `read`; `write`, `verify_exec`, and `auto_accept` are explicit scopes.
- Repository-changing tools require approval unless an explicit auto-accept policy is configured.
- Workflow content and secrets are not sent to minitok telemetry; configured LLM providers receive workflow data required by the user's provider relationship.
- Evolution telemetry is allowlisted, entitlement-gated, consent-gated, and disabled by default.
- Privacy policy: https://minitok.dev/privacy
- Technical data classification: `DATA_CLASSIFICATION.md`
- Technical policy: `POLICY.md`

## Publication note
Submit only after the target directory's transport, authentication, entitlement, and privacy requirements have been reviewed by an operator. Local readiness checks do not prove publication, deployment, or production compatibility.
