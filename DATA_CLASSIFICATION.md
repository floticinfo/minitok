# minitok Data Classification

> **Document type:** Technical data-processing boundary definition
> **Version:** 1.2.0
> **Last updated:** 2026-09-13
> **Applies to:** the current `@flotic/minitok` client and compatible `minitok-server` v0.1.0 API

This inventory describes implementation boundaries. It does not establish legal classifications, retention obligations, or jurisdiction-specific rights.

## 1. Classification Categories

| Class | Label | Description | Transfer boundary |
|---|---|---|---|
| D0 | PUBLIC | Public product and operational data | Publicly displayed or operationally shared |
| D1 | LICENSE | Activation and entitlement lifecycle data | MinTok server for activation and validation |
| D2 | BILLING | Account, subscription, and payment-event data | MinTok server and payment provider as required by the service |
| D3 | TELEMETRY | Sanitized allowlisted workflow metrics | MinTok server only after opt-in and entitlement gates |
| D4 | LOCAL_ONLY | User content and workflow content | Not sent to minitok server |
| D5 | SECRET | API keys, private keys, passwords, and token values | Not sent to minitok server; provider-specific credentials go only to their configured provider |
| D6 | PROJECT_KNOWLEDGE | User-approved source documents for tenant-scoped retrieval | MinTok server only after separate knowledge consent and plan capability; encrypted and tenant-scoped |
| D7 | TENANT_TRAINING | User-approved documents eligible for one customer's adapter/job | Dedicated tenant training boundary only; never global by default |
| D8 | GLOBAL_TRAINING | Data explicitly approved for cross-tenant model training | Disabled by default; requires separate contract, consent, license review, and approved training pipeline |

## 2. D4 — LOCAL_ONLY

Prompts, source code, file contents, command output, terminal output, generated code and text, knowledge entries, goals, summaries, decision traces, agent context, repository names and paths, LLM request/response content, and path-bearing error messages are outside the minitok-server telemetry payload. Configured LLM providers may receive the data required by the user's workflow.

## 2.1 Knowledge and training boundaries

D4 remains local-only unless the user explicitly enables the separate D6 project-knowledge scope. D6 is used for tenant-scoped retrieval and is not model training. D7 is only for dedicated tenant training jobs. Consent withdrawal deletes tenant knowledge and revokes queued tenant training jobs. D8 is disabled by default and is not accepted by the current client or server. Embeddings, hashes, indexes, adapters, and derived representations inherit the source document's classification.

## 3. D3 — TELEMETRY

The current client sanitizer and server endpoint allow exactly these fields:

| Field | Required | Values or range |
|---|---:|---|
| `status` | yes | `success`, `failure`, `partial` |
| `cycles` | yes | integer 0–100 |
| `duration_ms` | yes | integer 0–3,600,000 |
| `files_changed` | yes | integer 0–1,000 |
| `total_tokens` | no | integer 0–10,000,000 |
| `failure_category` | no | `lint`, `test`, `validation`, `type_error`, `timeout`, `api_error`, `unknown` |

Upload requires valid entitlement, the `evolution_upload` feature, explicit local opt-in, sanitizer success, a configured server URL and token, server-side customer/subscription/plan/feature validation, and schema acceptance.

## 4. D1 — LICENSE

The activation and entitlement flows process identifiers and entitlement attributes such as `entitlement_id`, `installation_id`, `plan_id`, `features`, `max_devices`, `issued_at`, `expires_at`, and `key_id`. The server also accepts an optional activation `hostname`; the current server deletion path clears stored installation hostnames.

## 5. D2 — BILLING and Account Data

The server implementation includes customer email, customer/account status, subscription identifiers and status, payment and webhook event identifiers, activation metadata, and billing-provider identifiers. Payment details are handled by the configured payment provider; this repository does not define a complete legal payment-data notice.

## 6. D5 — SECRET

Secret values include LLM API keys, OAuth tokens, installation bearer tokens, Ed25519 private keys, JWT secrets, activation-key encryption keys, Dodo credentials, SMTP credentials, and npm tokens. Secret values are not part of telemetry. The installation bearer token is used for authenticated service requests, but its value is not included in telemetry fields.

## 7. Server Boundary

```text
Client -> minitok server: D1, D2, and conditional D3
Client -> configured LLM provider: workflow data required by the user's provider configuration
Client -> minitok server: not D4 or D5 payload values
```

## 8. Fail-Closed Behavior

Unknown classification, unknown consent, unknown entitlement, sanitizer failure, server validation failure, or missing credentials blocks telemetry transfer. This technical behavior does not determine whether a legal notice or consent mechanism is sufficient.

## 9. Published Positions and Open Items

The legal positions for the categories above are recorded in [POLICY.md](./POLICY.md) section 10: controller and processor roles, privacy officer, legal bases, international-transfer disclosure, rights handling, and retention periods.

- Account and authentication records are kept while the account exists and for the period required by legal and security obligations. Open telemetry records are kept for 30 days, Select aggregate telemetry for 14 days, and Private telemetry is not collected. Billing records are kept as needed to meet tax and accounting obligations, and support and security records as needed to handle the request, prevent abuse, and resolve disputes.
- Support messages are processed under the support address published in POLICY.md section 10.

### 9.1 Inventory Answers Recorded 2026-09-13

The operator's open question was whether hostnames, IP addresses, support messages, Sentry events, and infrastructure logs are part of the public inventory, and which source answers it. Each row is answered by the implementation that produces the data, audited on 2026-09-13.

| Question | Answer | Source |
|---|---|---|
| Hostnames | In the inventory as D1 LICENSE. The shipped client sends only `{ key, installation_id }` to `POST /v1/activate`, so it sends no hostname; the server accepts an optional activation `hostname` (maximum 255 characters) from any client, stores it on the installation record, and the account deletion path clears it. | client `src/cli/commands/activate.js`; server `src/api/activation.js`, `installations.hostname` |
| IP addresses | The client never sends an IP address. The server derives the requester address for two purposes only: rate limiting (`public:ip:*`, `auth-email:ip:*`, and `mcp:ip:*` buckets, deleted once `expires_at` passes) and the framework request log. Neither is a telemetry field, and neither is inside the D3 allowlist in section 3. | server `src/app.js`, `src/services/mcp.js`, `src/services/rate-limit.js` |
| Support messages | In the inventory as D2 account and service data. The published support form posts to `POST /api/support`, which validates, rate-limits, and delivers the message by email; the server keeps no support table. The message, the address, and the mailbox copy are handled under the support address published in POLICY.md section 10. | live `/support` page; server `src/api/support.js` |
| Sentry events | Not in the inventory. Neither the client nor the server source embeds Sentry or any other error-reporting SDK. | client and server source audit 2026-09-13 |
| Infrastructure logs | In the inventory as operational data. The server enables the framework request logger, so each request emits a log line carrying the method, the URL, and the requester address to the container's standard output, and the production host and reverse proxy keep their own access logs. Log retention is an infrastructure setting; the application configures none. | server `src/index.js` (logger enabled); deployment configuration |

### 9.2 Open Items

- **Infrastructure log retention** is not configured in the application source, so the position for the host and reverse-proxy logs is recorded by the operator rather than by this repository.
- **Telemetry retention was implemented longer than published** and is now aligned: the server deletes Open per-run telemetry after 30 days and Select aggregate telemetry after 14 days (`src/services/evolution-telemetry.js`), which is the position published in POLICY.md section 10, section 3 of this document, and the live privacy notice, and the privacy policy the server itself serves. The previous single 90-day schedule, which also left the aggregate table outside the cleanup, was recorded here on 2026-09-13 and removed the same day.
