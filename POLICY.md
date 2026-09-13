# minitok Privacy & Entitlement Policy

> **Document type:** Technical policy — data processing, consent, and entitlement architecture
> **Version:** 1.2.0
> **Last updated:** 2026-09-13
> **Applies to:** the current `@flotic/minitok` package and compatible `minitok-server` v0.1.0 API

This is a technical description of current implementation behavior. It is not a legal notice, data-processing agreement, or legal advice; the published positions that govern the commercial service are recorded in section 10 and in the privacy notice at https://minitok.dev/privacy.

## 1. Scope

This document describes data processed by the client and server, client privacy controls, entitlement checks, telemetry boundaries, and enforcement mechanisms.

## 2. Core Principles

### 2.1 Privacy by default

Telemetry upload is disabled unless the user explicitly enables it.

### 2.2 Fail closed

Unknown consent, entitlement, feature, credential, schema, or server-validation state blocks telemetry upload.

### 2.3 Data minimization

The minitok server accepts licensing, billing, account, installation, and allowlisted telemetry data required by its implementation. User prompts, source code, file contents, repository metadata, LLM content, and credentials are not sent to the minitok server by the telemetry client.

### 2.4 Entitlement is separate from consent

A subscription or entitlement does not imply telemetry consent. Entitlement controls feature access; consent controls telemetry transmission. Both are required for telemetry upload.

## 3. Data Classification Summary

| Class | Label | Current boundary |
|---|---|---|
| D0 | PUBLIC | Public product and operational information |
| D1 | LICENSE | Activation and entitlement lifecycle data sent to the minitok server |
| D2 | BILLING | Account, subscription, and payment-event data processed by the minitok server and payment provider |
| D3 | TELEMETRY | Allowlisted workflow metrics sent only after all upload gates pass |
| D4 | LOCAL_ONLY | User content and workflow content not sent to the minitok server |
| D5 | SECRET | API keys, private keys, passwords, and token values; not sent to the minitok server |

See [DATA_CLASSIFICATION.md](./DATA_CLASSIFICATION.md) for the field-level inventory.

## 4. Privacy Consent Model

### 4.1 Consent states

| State | Meaning | Behavior |
|---|---|---|
| UNKNOWN | Consent cannot be read or has not been established | Treat as OFF |
| OFF | Explicitly disabled or default state | No telemetry upload |
| ON | Explicitly enabled | Upload may proceed only after the other gates pass |

### 4.2 Consent storage and controls

Consent is stored in `~/.minitok/evolution/optin.json` with owner-only permissions. Users can run:

```bash
minitok evolution status
minitok evolution enable
minitok evolution disable
```

## 5. Entitlement Model

### 5.1 Current paid plans

The current commercial contract has three canonical plan IDs: `open`, `select`, and `private`; there is no free plan. `open` permits consent-required per-run evolution uploads when the signed capability allows it, `select` permits consent-required aggregate-only telemetry, and `private` never uploads or stores telemetry. Entitlement is required for all plan-gated execution.

### 5.2 Feature flags

The signed entitlement and server-side plan determine feature access. `evolution_upload` is required for telemetry and does not override user consent.

### 5.3 Verification chain

```text
Signed entitlement
  -> verify Ed25519 signature
  -> check expiration
  -> verify installation binding
  -> check requested feature
  -> check privacy consent for telemetry
  -> execute operation
```

## 6. Telemetry Upload Gates

All conditions must pass:

1. The entitlement is valid.
2. The entitlement or server plan authorizes `evolution_upload`.
3. Local consent is ON.
4. The client sanitizer accepts the payload.
5. A server URL and installation token are configured.
6. The server validates the bearer token, customer, subscription, plan, and feature.
7. The server accepts the exact allowlisted schema.
8. The telemetry record is stored successfully.

If any condition fails, the client does not send telemetry or the server does not store it.

## 7. Telemetry Payload

The current client and server allow exactly these fields:

- Required: `status`, `cycles`, `duration_ms`, `files_changed`
- Optional: `total_tokens`, `failure_category`
- `failure_category` values: `lint`, `test`, `validation`, `type_error`, `timeout`, `api_error`, `unknown`

No prompt, source code, path, repository name, LLM request or response, credential, or free-form error message is part of this allowlist.

## 8. Data That the Telemetry Boundary Does Not Send

The telemetry upload boundary excludes user prompts, task descriptions, source code, file contents, command output, terminal output, generated code or text, knowledge entries, repository names and paths, agent context or reasoning, LLM request/response content, path-bearing error messages, API keys, and credentials. Configured LLM providers may receive workflow data required by the user's configuration; that is a separate provider relationship and is not a minitok-server transfer.

## 9. Enforcement Architecture

| Boundary | Implementation |
|---|---|
| Client entitlement | `src/entitlement/gate.js` and related verification modules |
| Client consent | `src/evolution/optin.js` and `src/evolution/privacy.js` |
| Client allowlist | `src/evolution/sanitize.js` |
| Client network gate | `src/evolution/upload.js` |
| Server authentication | `src/middleware/auth.js` |
| Server subscription and feature checks | `src/services/evolution-telemetry.js` |
| Server schema and unknown-field rejection | `src/api/evolution-telemetry.js` |
| Server telemetry storage | `evolution_telemetry` schema and database adapter |

## 10. Published Legal Positions

These are the positions published with the commercial service. They describe the same processing that sections 1 to 9 implement, and they are the statements the operator and the legal owner approved for publication.

- **Controller.** Flotic LC., 3F 301-Na025, Sangik Plaza, 57 Munin-ro, Suji-gu, Yongin-si, Gyeonggi-do, Republic of Korea, is the controller of account, authentication, billing, entitlement, and consented telemetry data. Representative: Juseong Park. Business registration number: 180-88-03655. The client, the account page, and the minitok server operate under that entity.
- **Processor and provider roles.** The minitok client sends consented telemetry to the minitok server, which stores it for the purposes published in the privacy notice. Billing is processed by Dodo Payments, hosting is provided by Hetzner, and TLS certificates by Let's Encrypt. Configured LLM providers receive workflow requests under the customer's own provider relationship; Flotic is not a party to it and does not receive that content.
- **Privacy officer.** Juseong Park, Representative of Flotic LC., reachable through the contact below.
- **Legal bases.** Depending on the activity: performance of the subscription contract, compliance with a legal obligation, a legitimate interest in service security, or consent for optional telemetry. Entitlement never implies consent, and telemetry upload additionally requires a valid entitlement (sections 2.1, 2.4, and 6).
- **Jurisdiction and international transfers.** The service is operated from the Republic of Korea. The providers named above may process data outside the customer's country, including payment, hosting, and certificate data. Where the Personal Information Protection Act applies, the items transferred, the recipients, the purposes, and the retention periods are those listed in the privacy notice at https://minitok.dev/privacy, and any consent the Act requires is collected before the transfer.
- **Rights.** Access, correction, export, deletion, and anonymization requests go to support@minitok.dev or to the export and deletion endpoints documented on the server. Requests are actioned as soon as practicable and within the period required by applicable law, after the requester is verified. Billing, security, support, and legal records may be retained where the law requires it.
- **Retention and deletion.** Account and authentication records: while the account exists and for the period required by legal and security obligations. Open telemetry: 30 days. Select aggregate telemetry: 14 days. Private telemetry: not collected. Billing records: as needed to provide the service and to meet tax and accounting obligations. Support and security records: as needed to handle the request, prevent abuse, and resolve disputes. Data is deleted or anonymized when the applicable retention purpose ends, subject to legal retention exceptions. The 90-day telemetry cleanup described in this document is an implementation setting, not the client plan policy.
- **Contact, version, and effective date.** The authoritative support and privacy contact is support@minitok.dev, and the privacy notice is published at https://minitok.dev/privacy. This document is technical policy version 1.2.0 and takes effect on 2026-09-13.

## 11. Future Changes

Cloud knowledge synchronization, diagnostic uploads, and organization-wide policy controls require a new classification and boundary review before implementation.
