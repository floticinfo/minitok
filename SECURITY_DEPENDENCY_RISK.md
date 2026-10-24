# Dependency Security Risk Register

This register documents unresolved dependency advisories. It is not an approval and does not make a release gate pass.

## Current unresolved roots

| Root | Current path | Reason unresolved | Required action |
|---|---|---|---|
| `node-forge` | `jks-js` → SAP Cloud SDK | npm reports no patched release for the advisory | Re-evaluate when a fixed release ships; obtain time-bounded owner acceptance before release |
| `zod` | Cline/SAP/AI provider transitive trees | Current provider graph contains vulnerable versions and cannot be upgraded globally without compatibility validation | Upgrade the owning provider graph or obtain time-bounded owner acceptance |
| `@ai-sdk/provider-utils` | Cline/Langfuse provider graph | npm reports no directly applicable fix for the affected transitive path | Update the owning provider graph or obtain time-bounded owner acceptance |

## Policy

- `npm audit` remains the source of truth for detected advisories.
- `scripts/audit-filter.mjs` is fail-closed and never treats this register as approval.
- A release requires either a patched dependency path or an explicit approval record containing an owner, scope, rationale, mitigation, expiry/review date, and evidence reference.
- Local parity, tests, and the absence of a direct import do not by themselves prove that a transitive advisory is harmless in production.
- The current release candidate is `@flotic/minitok@1.5.3`; an approval for another package/version or tag is invalid.

## Approval request packet

The following items must be supplied by the actual security/dependency owner before release:

- named owner and approving organization;
- exact package, version, tag, and affected dependency paths;
- advisory identifiers and current `npm audit` evidence;
- exploitability analysis for the shipped CLI and provider/runtime paths;
- mitigations and monitoring/rollback plan;
- decision (`approved` or `rejected`), approval timestamp, review/expiry date;
- external or signed evidence reference.

No field in this document constitutes an approval. Do not place secrets or personal credentials in the evidence reference.
