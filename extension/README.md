# minitok

**Verified repository-aware coding workflows for AI agents**

minitok brings repository-aware coding workflows into VS Code. Describe a task, let minitok inspect and plan the change, run implementation, verify the result, review failures, and preserve evidence for review.

## What it provides

- Browser-based account sign-in with VS Code SecretStorage
- Sign out and account switching
- Repository-aware task execution through the minitok CLI
- Deterministic verification and recorded evidence
- Sidebar workflow status and session history
- MCP stdio integration through the embedded runtime
- Local-first execution with consent-controlled telemetry policies

## Getting started

1. Install `@flotic/minitok` globally:

   ```bash
   npm install -g @flotic/minitok@1.3.17
   ```

2. Open a trusted VS Code workspace.
3. Open the minitok activity bar panel.
4. Select **Sign in with browser**.
5. Describe the repository task and run it.

An active paid plan and a valid installation entitlement are required before a real run. Provider credentials remain configured through the minitok CLI configuration.

## Plans

- **Open**: consented per-run telemetry under the 30-day client policy.
- **Select**: consented aggregate-only telemetry under the 14-day client policy.
- **Private**: no telemetry upload or storage.

Each plan provides one installation per plan. LLM provider usage is separate from the minitok plan.

Learn more at [minitok.dev](https://minitok.dev) and [Documentation](https://minitok.dev/docs).
