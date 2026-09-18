# minitok promotion kit

## Canonical links

- Website: https://minitok.dev
- Documentation: https://minitok.dev/docs
- npm: https://www.npmjs.com/package/@flotic/minitok
- GitHub: https://github.com/floticinfo/minitok
- Install: `npm install -g @flotic/minitok`

## One-line pitch

minitok gives AI coding tasks a workflow: research, plan, implement, verify, review, repair, and preserve evidence.

## Directory listing

**Title:** minitok — verified repository-aware coding workflow for AI agents

**Description:** minitok is a Node.js CLI that turns repository context into inspectable code changes through explicit research, planning, implementation, deterministic verification, review, repair, and evidence recording. The local canonical CLI is `@flotic/minitok@1.4.7`. Treat publication as unverified until the approved release manifest and registry evidence are available. It supports Anthropic, OpenAI, and Google, plus OpenAI-compatible endpoints as custom providers, with local-first execution and opt-in telemetry.

**Call to action:** Install with `npm install -g @flotic/minitok@1.4.7`, run `minitok doctor`, then initialize a repository with `minitok migrate`.

## VS Code Marketplace submission

**Display name:** minitok

**Tagline:** Verified coding workflows for the terminal

**Categories:** AI, Other

**Keywords:** AI agent, coding agent, repository automation, verified coding, MCP, code review, developer tools.

**Marketplace description:** Use the repository's `extension/README.md` as the long description. Publish only the generated versioned VSIX after `npm run release:extension`, `npm run extension:marketplace:check`, and operator approval.

## Copy-ready post files

The complete channel-specific copy is split into standalone files for direct review and pasting:

- `promotion-posts/product-hunt.md`
- `promotion-posts/reddit.md`
- `promotion-posts/linkedin.md`
- `promotion-posts/mcp-directory.md`

These files are drafts for operator review. They do not publish automatically and should be checked against each platform's current rules before submission.

## MCP directory submission

**Name:** minitok MCP

**Transport:** local stdio, authenticated localhost HTTP, and an authenticated HTTPS remote MCP endpoint at `https://api.minitok.dev/mcp`.

**Description:** Exposes repository-aware coding workflow controls to MCP clients with customer JWT authentication, paid entitlement enforcement, session binding and expiry, read-only remote tool boundaries, deterministic verification, and recorded evidence. It is not an AI model and does not replace the configured model provider.

**Configuration note:** Use the installed package's `minitok mcp connect <host>` output. Never publish tokens, customer JWTs, installation-token files, or provider API keys.

## Product Hunt launch copy

**Tagline:** AI coding with a verification loop, not just code generation.

**Description:** minitok is a repository-aware coding workflow CLI that adds explicit research, planning, implementation, deterministic verification, review, repair, and evidence recording to AI-assisted development. It supports multiple LLM providers, VS Code integration, and authenticated MCP transports while keeping execution local-first. Telemetry is opt-in and disabled by default. This launch focuses on traceability and workflow structure rather than unsupported speed or accuracy claims.

**Maker comment:** I built minitok because generating a diff is only one part of repository work. The difficult part is understanding the existing codebase, making a plan, running deterministic checks, reviewing failures, repairing the change, and preserving an inspectable record. minitok separates those stages into a repeatable workflow. I’m looking for feedback on the workflow boundaries, verification model, and evidence format. minitok is paid proprietary software; provider costs apply, and it does not guarantee correctness or deployment outcomes.

## Hacker News title and text

**Title:** Show HN: minitok – a repository-aware coding workflow with deterministic verification

**Text:** I built minitok to put explicit stage boundaries around AI-assisted repository work: research, planning, implementation, deterministic project checks, review, repair, and evidence recording. It is a Node.js CLI that supports several LLM providers and local-first execution. The README includes a disposable-repository demo and a reproducible benchmark format. Feedback on the workflow boundaries and evidence model is welcome.

## Reddit post

**Title:** I built a coding-agent workflow that makes verification and evidence first-class

**Body:** AI coding tools can generate changes quickly, but repository work also needs planning, project checks, review, repair, and a record of what happened. minitok is a Node.js CLI that separates those stages and supports multiple model providers. I am sharing the installable package, a disposable-repository demo, and a benchmark format that records raw runs, models, commits, costs, and manual interventions. I am looking for technical feedback rather than claiming universal superiority.

## LinkedIn post

AI-assisted coding needs more than generated diffs. minitok turns a repository task into an inspectable workflow: research, plan, implement, verify, review, repair, and evidence. It supports multiple LLM providers and local-first execution. The public demo and benchmark format focus on verification pass rate and manual intervention count, with raw evidence instead of inflated claims.

Install: `npm install -g @flotic/minitok`
Docs: https://minitok.dev/docs

## Publishing rules

- Use one real demo recording and link the exact repository commit.
- Publish raw benchmark JSON with model, prompt, repository, cost, verification result, and intervention data.
- Do not claim guaranteed correctness, universal speedups, deployment proof, or AI-model status.
- Disclose paid plans and provider costs.
- Do not mass-post identical content or automate unsolicited replies.
