# minitok

**Verified coding workflows for the terminal**

A repository-aware workflow for changes you can review. minitok brings the workflow from [minitok.dev](https://minitok.dev) into VS Code: describe a task, inspect the repository and proposed plan, execute the change, verify it with configured checks, review the result, adapt through bounded repair when checks fail, and preserve local evidence of the outcome.

## What it provides

- Browser-based account sign-in with VS Code SecretStorage
- Sign out and account switching
- Repository-aware task planning and execution through the minitok CLI
- Deterministic verification, review, bounded repair, and recorded evidence
- Sidebar workflow status and session history
- MCP stdio integration through the embedded runtime
- First-activation `Connect MCP Hosts` onboarding with read-only defaults
- Local-first execution with consent-controlled telemetry policies

The Extension lint gate runs `tsc -p extension/tsconfig.json` over all Extension TypeScript source and tests, then ESLint over the JavaScript unit-test files. TypeScript source is therefore typechecked, while a TypeScript-aware ESLint rule set is not currently enabled.

## Getting started

1. Install `@flotic/minitok` globally:

   ```bash
   npm install -g @flotic/minitok@1.5.3
   ```

2. Open a trusted VS Code workspace.
3. Open the minitok activity bar panel.
4. Select **Sign in with browser**.
5. Describe the repository task and run it.

You can also use **minitok: Run Selection through minitok** from the editor context menu, or **minitok: Run Problems through minitok** from the Command Palette. Both commands preserve workspace trust, entitlement, consent, cancellation, and verification safeguards.

The Extension is free to install, but a paid plan and valid installation entitlement are required before a real run. When enabled by the licensing server, a free trial can provide one installation, up to 14 days, up to 5 real runs, and telemetry OFF; trial quota is consumed online and cannot be extended offline. Provider credentials and provider API charges remain separate from minitok and are configured through the CLI.

## Plans

- **Level 1 ($8.99/month)**: the standard paid plan. Each plan provides one installation.
- **Free trial (server-issued only)**: up to 14 days, up to 5 real runs, one installation, telemetry OFF.

LLM provider usage is separate from the minitok plan.

Learn more at [minitok.dev](https://minitok.dev) and [Documentation](https://minitok.dev/docs).
