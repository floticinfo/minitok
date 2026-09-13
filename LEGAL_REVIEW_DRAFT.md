# Legal review draft — EULA.md and POLICY.md review notes

**Status: DRAFT for owner and legal review. This file is not an approval and not legal advice.**
It does not change `EULA.md`, `POLICY.md`, or any gate state: while the review
notes remain in those documents, `legal-owner-approval` and
`privacy-owner-approval` stay `BLOCKED` in `npm run commercial:readiness`, and no
approval manifest can clear them.

Use it as drop-in text for the owners named below. Every bracket value is a
decision only they can make (`[JURISDICTION]`, `[REFUND WINDOW]`, `[OWNER]`, ...).
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

This Agreement is governed by the laws of [JURISDICTION], without regard to its
conflict-of-law rules. The courts of [VENUE] have exclusive jurisdiction, except
where mandatory consumer law lets Customer sue at their place of residence.

## 13. Consumer rights

Nothing in this Agreement excludes or limits any right Customer has under
mandatory consumer-protection law, including statutory withdrawal, warranty, or
refund rights. Where such law applies, it prevails over sections 7, 8, and 9.

Last reviewed: [REVIEW DATE] by [LEGAL OWNER NAME AND ROLE].
```

### 2.2 Replace section 4 (billing and entitlement)

```markdown
## 4. Billing and entitlement

Subscriptions are billed for the period displayed at checkout and renew until
cancelled. Cancellation stops the next renewal; access continues to the end of the
paid period. Refunds are available within [REFUND WINDOW, e.g. "14 days of the
initial purchase"] unless mandatory law provides otherwise, and are not available
for periods already used where the law permits. Billing, cancellation, refund, and
payment processing are governed by the checkout terms and the refund policy shown
there.

Entitlements may be suspended or revoked for non-payment, refund, chargeback,
abuse, violation of this Agreement, or where required by law. Each activation is
bound to one installation and subject to the plan's device limits. The plan
determines which features are available; telemetry is always subject to Customer's
consent, and the Private plan never uploads or stores telemetry.
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

## 5. Owner checklist and how to verify

Decisions only the owners can make (each maps to a bracket above):

1. Contracting entity and notice address (EULA §11).
2. Governing law, venue, and the consumer-law carve-out (EULA §12, §13).
3. Billing period wording, refund window, and alignment with the checkout terms
   delivered by the payment provider (EULA §4).
4. Support channel, hours, and escalation path (EULA §5).
5. Privacy notice URL, data-processing agreement contact (EULA §6).
6. Controller identity, legal bases, transfers, rights process, response period
   (POLICY §10).
7. Retention periods — including that the telemetry retention is not longer than
   the published 30-day (Open) and 14-day (Select) client policies (POLICY §10).
8. Effective dates and document versions for both documents.

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



