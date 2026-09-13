# Legal review draft — EULA.md and POLICY.md review notes

**Status: DRAFT for owner and legal review. This file is not an approval and not legal advice.**
It does not change `EULA.md`, `POLICY.md`, or any gate state: while the review
notes remain in those documents, `legal-owner-approval` and
`privacy-owner-approval` stay `BLOCKED` in `npm run commercial:readiness`, and no
approval manifest can clear them.

Use it as drop-in text for the owners named below. Every bracket value is a
decision only they can make (`[CONTRACTING ENTITY]`, `[NOTICE ADDRESS]`,
`[SUPPORT HOURS]`, `[PERIOD]`, ...).

## Decisions recorded so far

| Decision | Value | Recorded |
|---|---|---|
| Governing law and venue | **Republic of Korea** (EULA §12, §13) | 2026-09-13 |
| Refunds | **None.** Fees are charged in advance per period; cancelling stops the following period, the paid period stays usable, and no credit or pro-rated refund is given (EULA §4, review notes in §2.6) | 2026-09-13 |

Every other bracket in sections 2 and 3 still needs an owner value; section 5 lists
them with a suggested default.

Replacing the notes with approved wording clears the `BLOCKED` status but does
**not** pass the gate on its own: the manifest prepared by
`scripts/approval-manifest-prepare.mjs` still has to record the owner decision.

## 1. Review notes this draft replaces

| Requirement | Document | Current note (detected marker) | Cleared by |
|---|---|---|---|
| `legal-owner-approval` | `EULA.md` (final blockquote) | "Legal owner must approve the contracting entity, governing law, venue, consumer-rights wording, billing/refund terms, privacy notice reference, and effective date" | The clauses in section 2 |
| `privacy-owner-approval` | `POLICY.md` (header) | "Legal review is required before publication as a legal policy." | The wording in section 3.1 |
| `privacy-owner-approval` | `POLICY.md` (§10) | "Legal owner must approve the public privacy notice, legal bases, ..." | The text in section 3.2 |
| `production-operations` (operator, not legal) | `POLICY.md` (§10) | "Operator must confirm production retention periods ..." | Operator confirmation; see sections 3.2 and 4 |
| `support-commitments` (owner) | `EULA.md` §5 / `README.md` | "Support is provided according to the plan or purchase terms." | The statement in section 2.4 |

The markers are matched by `scripts/commercial-readiness.mjs`. After replacing
them, run the readiness command in section 5 to confirm the two `BLOCKED` rows
became `UNVERIFIED`.

## 2. `EULA.md` — drop-in text

### 2.1 Replace the final review blockquote

Replace the trailing blockquote with the sections below and keep the support
sentence that precedes it:

```markdown
## 11. Contracting entity

This Agreement is entered into with [CONTRACTING ENTITY, e.g. "Flotic LC"], the
licensor of minitok. Notices to Flotic must be sent to [NOTICE ADDRESS] or
support@minitok.dev.

## 12. Governing law and venue

This Agreement is governed by the laws of the Republic of Korea, without regard to
its conflict-of-law rules. Disputes are subject to the courts of the Republic of
Korea, and Customer may also bring proceedings at their place of residence as
provided by Korean law. [OPTIONAL: name a specific court, e.g. the Seoul Central
District Court, if the reviewer confirms an exclusive-jurisdiction clause is
enforceable against consumers under the Act on the Regulation of Terms and
Conditions.]

## 13. Consumer rights

Nothing in this Agreement excludes or limits a right Customer has under mandatory
Korean law, including the Act on the Regulation of Terms and Conditions (약관의
규제에 관한 법률) and the Act on Consumer Protection in Electronic Commerce
(전자상거래 등에서의 소비자보호에 관한 법률). Where such law applies, it prevails
over sections 7, 8, and 9.

Last reviewed: [REVIEW DATE] by [LEGAL OWNER NAME AND ROLE].
```

### 2.2 Replace section 4 (billing and entitlement)

```markdown
## 4. Billing and entitlement

Subscriptions are charged in advance for the billing period displayed at checkout
and renew automatically for the same period until cancelled. Cancellation can be
made at any time through [CANCELLATION PATH, e.g. the customer portal or
billing@minitok.dev] and takes effect at the end of the current billing period: the
period already paid for stays available for its full term, and no further charge is
made from the following period. Fees already paid are not refunded, and no credit
or pro-rated refund is given for the unused part of a period. This does not limit
any non-waivable right Customer has under Korean consumer law.

Entitlements may be suspended or revoked for non-payment, chargeback, abuse,
violation of this Agreement, or where required by law. Each activation is bound to
one installation and subject to the plan's device limits. The plan determines which
features are available; telemetry is always subject to Customer's consent, and the
Private plan never uploads or stores telemetry.
```

### 2.3 Replace section 6 (privacy)

```markdown
## 6. Privacy

Personal data handling is described in the minitok privacy notice at
[PRIVACY NOTICE URL], which forms part of this Agreement. Telemetry upload is
disabled by default and happens only with Customer's explicit consent, as
described in that notice. Customer can use the account export and deletion
endpoints described in the server documentation.
```

### 2.4 Replace the section 5 support wording (also the `support-commitments` signal)

```markdown
## 5. Updates and support

Flotic may provide updates, security fixes, and compatibility changes. Update
notifications are optional and can be disabled with `minitok_no_update_check=1`.

Support is provided according to the plan or purchase terms: [SUPPORT CHANNEL,
e.g. "email to support@minitok.dev"] during [SUPPORT HOURS, e.g. "business hours
in [TIMEZONE]"], with security fixes prioritised over feature requests.
[ESCALATION PATH, e.g. "unresolved issues escalate to [ROLE] within [N] business
days"]. Provider outages, model behaviour, and Customer-authored verification
commands are outside support scope.
```

### 2.5 Effective date

Keep the existing `**Effective date:**` line and set it to the date the approved
text is published. If the text changes later, add a "Last updated" line instead of
reusing the original effective date.

### 2.6 Review notes on the Korean subscription model

- **No refunds.** The rule is stated the way other subscription services state it:
  fees are charged in advance, cancelling stops the following period, the paid
  period stays usable, and no credit or pro-rated refund is given. Korean consumer
  law can still grant a withdrawal right for a first purchase of digital content
  within a short statutory period, which is why section 4 keeps one sentence saying
  it does not limit a non-waivable right. The reviewer decides whether to keep,
  reword, or delete that sentence; if it is deleted, the operator must be ready to
  handle first-purchase withdrawal requests. Note that refunds are also named in
  the entitlement-revocation list of the published EULA — the text above drops it,
  because a refund is no longer a contract term.
- **Renewal handling.** Confirm the current advance-notice and cancellation-path
  requirements for automatic renewal under Korean e-commerce law, and make the
  portal and `minitok` CLI surface the cancellation path that section 4 promises.
  Marketing copy must not advertise a refund that section 4 no longer offers.
- **Entity versus governing law.** `EULA.md` names "Flotic LC" as the contracting
  entity. If that entity is not Korean while the governing law is Korean, confirm
  whether Korean law and venue are intended for all customers or only for customers
  in Korea.

## 3. `POLICY.md` — drop-in text

### 3.1 Replace the review sentence in the header block

Current:

```text
This is a technical description of current implementation behavior. It is not a
privacy notice, data-processing agreement, or legal advice. Legal review is
required before publication as a legal policy.
```

Approved replacement (drops the review note and names the owner):

```markdown
This document is the minitok privacy notice for the current `@flotic/minitok`
client and the compatible `minitok-server` API. It is reviewed by [PRIVACY OWNER
NAME AND ROLE] and approved for publication on [APPROVAL DATE]. It describes
implemented behaviour and is not legal advice; business customers can request a
data-processing agreement at [DPA CONTACT OR URL].
```

### 3.2 Replace section 10 with the recorded decisions

```markdown
## 10. Published legal positions

- **Controller.** [CONTROLLER LEGAL ENTITY AND ADDRESS] is the controller for
  account, subscription, installation, and billing data (D1/D2). [PROCESSOR ROLE,
  e.g. "Flotic acts as a processor for telemetry a customer enables"].
- **Legal bases.** Contract performance for account, entitlement, and billing
  data; consent for telemetry (D3), withdrawable at any time with
  `minitok evolution disable`; legitimate interests, balanced against data-subject
  rights, for security and abuse-prevention records.
- **International transfers.** Data is processed in [PROCESSING REGIONS]. Transfers
  outside [REGION GROUP] rely on [TRANSFER MECHANISM, e.g. "the EU Standard
  Contractual Clauses"].
- **Rights.** Access, correction, export, and deletion requests are actioned within
  [RESPONSE PERIOD, e.g. "30 days"] through the export and deletion endpoints
  documented on the server, or by writing to [RIGHTS CONTACT, e.g.
  "privacy@minitok.dev"].
- **Retention.** Account and installation records: [PERIOD]. Billing records:
  [PERIOD] (often set by tax law). Telemetry records: [PERIOD]; the 90-day cleanup
  in the implementation is a setting, not the policy, and it must be at least as
  short as the client policies published with the plans. Audit records: [PERIOD].
  Backups: [PERIOD].
- **Contact and effective date.** The authoritative support and privacy contact is
  [SUPPORT ADDRESS, e.g. "support@minitok.dev"]. This policy takes effect on
  [EFFECTIVE DATE] as version [VERSION].
```

### 3.3 What removing these notes does and does not do

- It clears the two `BLOCKED` rows in `npm run commercial:readiness` and turns them
  into `UNVERIFIED`, because the readiness check matches the note text itself.
- It does **not** pass `npm run release:verify`: the approval manifest still has to
  record `status: APPROVED`, the named owner, the decision, a timestamp, and an
  evidence reference for each item.
- Keep the retention values consistent with the plan descriptions published on the
  website and in `extension/README.md` (section 4).

## 4. Consistency with the public website and marketing copy

The published pages, the Marketplace listing, and the legal text have to describe
the same product. These are the claims already written into the repository that the
legal wording must not contradict.

| Public claim | Where it is written | Legal text that must mirror it |
|---|---|---|
| "verified repository-aware coding workflow", research → plan → implement → verify → review → repair → evidence | `PROMOTION_KIT.md` (one-line pitch, directory listing), `README.md` | Keep EULA §7/§8 as-is: no correctness, uptime, or "verified means bug-free" promise |
| Paid proprietary software, **no free plan** | `CHANGELOG.md` (plans), `POLICY.md` §5.1, `extension/README.md` | EULA §1 (license is subject to payment), §4 (plan determines features) |
| Plans **Open**, **Select**, **Private**; one installation per plan; provider usage separate | `extension/README.md` (Plans), `POLICY.md` §5.1, `tests/fixtures/auth-contract-v1.fixture.json` | EULA §4 device limits; section 2.2 text above names the Private plan explicitly |
| Telemetry is opt-in and disabled by default | `PROMOTION_KIT.md` (Product Hunt, HN), `POLICY.md` §2.1, `README.md` | EULA §3/§6 (already), section 2.3 text above |
| Client telemetry policy: Open = per-run, Select = aggregate-only, Private = none | `extension/README.md` (Plans) | POLICY retention (section 3.2) must be no longer than those client policies |
| Provider costs and API keys are the customer's | `PROMOTION_KIT.md` ("Disclose paid plans and provider costs") | EULA §3 (unchanged) and the support scope in section 2.4 |
| "Not an AI model and does not replace the configured model provider" | `PROMOTION_KIT.md` (MCP directory submission) | EULA §3 provider relationship wording |
| Website `https://minitok.dev`, docs `https://minitok.dev/docs`, `support@minitok.dev` | `package.json` (`homepage`, `bugs`), `PROMOTION_KIT.md` (canonical links), `EULA.md` closing line | EULA §11 notice address, §6 privacy notice URL, POLICY contact block |
| Publishing rules forbid guaranteed correctness, universal speedups, deployment proof, and AI-model status | `PROMOTION_KIT.md` (publishing rules) | Do not add uptime, accuracy, or outcome guarantees while approving sections 2 and 3 |

## 5. Still to decide, and how to verify

| # | Bracket | Where | Suggested default |
|---|---|---|---|
| 1 | `[CONTRACTING ENTITY]` | EULA §11 | Confirm "Flotic LC", or the Korean entity that invoices |
| 2 | `[NOTICE ADDRESS]` | EULA §11 | Registered address, or `support@minitok.dev` |
| 3 | `[CANCELLATION PATH]` | EULA §4 | Customer portal, falling back to `billing@minitok.dev` |
| 4 | optional specific court | EULA §12 | Omit unless the reviewer wants the Seoul Central District Court |
| 5 | `[SUPPORT CHANNEL]`, `[SUPPORT HOURS]`, `[TIMEZONE]`, `[ROLE]`, `[N]` | EULA §5 | Business-hours email support with a named internal escalation role |
| 6 | `[PRIVACY NOTICE URL]` | EULA §6 | The public path that serves this `POLICY.md` |
| 7 | `[DPA CONTACT OR URL]` | POLICY §3.1 | `privacy@minitok.dev`, or a data-processing-agreement request page |
| 8 | `[PRIVACY OWNER NAME AND ROLE]`, `[APPROVAL DATE]` | POLICY §3.1 | The reviewer who approves publication, and the date |
| 9 | `[CONTROLLER LEGAL ENTITY AND ADDRESS]`, `[PROCESSOR ROLE]` | POLICY §10 | Same entity as EULA §11; state the processor role for customer-enabled telemetry |
| 10 | `[PROCESSING REGIONS]`, `[REGION GROUP]`, `[TRANSFER MECHANISM]` | POLICY §10 | Republic of Korea; for any overseas transfer, confirm the requirements of the Personal Information Protection Act (개인정보보호법) |
| 11 | `[RIGHTS CONTACT]`, `[RESPONSE PERIOD]` | POLICY §10 | `privacy@minitok.dev`, 30 days |
| 12 | `[PERIOD]` (account, billing, telemetry, audit, backups) | POLICY §10 | Telemetry no longer than the published 30-day (Open) and 14-day (Select) client policies |
| 13 | `[SUPPORT ADDRESS]`, `[EFFECTIVE DATE]`, `[VERSION]` | POLICY §10 | `support@minitok.dev`, publication date, document version |
| 14 | `[REVIEW DATE]`, `[LEGAL OWNER NAME AND ROLE]` | EULA §11–§13 block | The reviewer names and the review date |

Recorded already: governing law and venue = Republic of Korea; refunds = none (see
"Decisions recorded so far").

Verify after applying the text:

```bash
npm run commercial:readiness                 # the two BLOCKED rows become UNVERIFIED
node scripts/approval-manifest-prepare.mjs --out ../approvals.json
# record the owner decisions in that file, then:
MINITOK_COMMERCIAL_APPROVAL_MANIFEST=../approvals.json npm run release:verify
```

The document text itself is not machine-parsed beyond the review-note markers in
`scripts/commercial-readiness.mjs`, so `npm start`-style behaviour, tests, and
`npm run docs:check` are unaffected by the wording chosen here.



