# Legal review draft — EULA.md and POLICY.md review notes

**Status: APPLIED on 2026-09-13. The owner approved the text, so this is no longer a draft.**
The review notes were replaced in `EULA.md`, `POLICY.md`, and
`DATA_CLASSIFICATION.md`, so `legal-owner-approval`, `privacy-owner-approval`,
`support-commitments`, and `production-operations` no longer carry document markers
and report `UNVERIFIED` in `npm run commercial:readiness`. They still need the
recorded owner decision in an approval manifest before they can pass.

This file is now the record of what was applied, which published page each value
came from, and which pages must change to stay consistent with it.

## Decisions recorded

| Decision | Value | Applied in | Recorded |
|---|---|---|---|
| Contracting entity | **Flotic LC.** (the legal form includes the trailing period; 유한회사 플로틱), Representative 박주성, business registration number 180-88-03655 | EULA §11 | 2026-09-13 |
| Notice address | 경기도 용인시 수지구 문인로 57, 3층 301 - 나025호(풍덕천동, 삼익상가), Republic of Korea | EULA §11 | 2026-09-13 |
| Governing law and venue | **Republic of Korea**; the customer may also sue at their place of residence | EULA §12, §13 | 2026-09-13 |
| Refunds | **None.** Fees are charged in advance per period, cancelling stops the following period, the paid period stays usable, no credit or pro-rated refund; one sentence preserves non-waivable Korean consumer rights | EULA §4 | 2026-09-13 |
| Cancellation path | the Dodo customer portal linked from the account page | EULA §4 | 2026-09-13 |
| Support channel and hours | email to support@minitok.dev, 24–48 hours, Monday–Friday (UTC), not a guaranteed SLA | EULA §5 | 2026-09-13 |
| Privacy notice | https://minitok.dev/privacy | EULA §6, POLICY §10 | 2026-09-13 |
| Rights, processor, and transfer contact | support@minitok.dev | POLICY §10 | 2026-09-13 |
| Retention | Open telemetry 30 days, Select aggregate 14 days, Private none; account while the account exists; billing, support, and security as needed | POLICY §10, DATA_CLASSIFICATION §9 | 2026-09-13 |
| Controller and privacy officer | Flotic LC. (유한회사 플로틱); 개인정보 보호책임자 박주성, 대표 | POLICY §10 | 2026-09-13 |
| Effective date and version | EULA 2026-09-13; POLICY version 1.2.0 on 2026-09-13 | both | 2026-09-13 |

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

## 2. `EULA.md` — what was applied

### 2.1 Applied entity, governing law, and consumer-rights text

Replace the trailing blockquote with the sections below and keep the support
sentence that precedes it:

```markdown
## 11. Contracting entity and notices

This Agreement is entered into with Flotic LC. (유한회사 플로틱), the licensor of
minitok. Representative: 박주성. Business registration number: 180-88-03655. Notice
address: 경기도 용인시 수지구 문인로 57, 3층 301 - 나025호(풍덕천동, 삼익상가), Republic of
Korea. Notices to Flotic must be sent to that address or by email to
support@minitok.dev.

## 12. Governing law and venue

This Agreement is governed by the laws of the Republic of Korea, without regard to
its conflict-of-law rules. Disputes are subject to the courts of the Republic of
Korea, and Customer may also bring proceedings at their place of residence as
provided by Korean law. No specific court was named, because an
exclusive-jurisdiction clause is constrained against consumers by the Act on the
Regulation of Terms and Conditions.

## 13. Consumer rights

Nothing in this Agreement excludes or limits a right Customer has under mandatory
Korean law, including the Act on the Regulation of Terms and Conditions (약관의
규제에 관한 법률) and the Act on Consumer Protection in Electronic Commerce
(전자상거래 등에서의 소비자보호에 관한 법률). Where such law applies, it prevails
over sections 7, 8, and 9.

No "last reviewed" line was added: the published agreement ends with the support
contact line instead, and the approval record lives in the approval manifest.
```

### 2.2 Replace section 4 (billing and entitlement)

```markdown
## 4. Billing and entitlement

Subscriptions are charged in advance for the billing period displayed at checkout
and renew automatically for the same period until cancelled; there is no free plan
or free trial. Cancellation can be made at any time through the Dodo customer
portal linked from the account page, and takes effect at the end of the current
billing period: the period already paid for stays available for its full term, and
no further charge is made from the following period. Fees already paid are not
refunded, and no credit or pro-rated refund is given for the unused part of a
period. This does not limit any non-waivable right Customer has under Korean
consumer law. Taxes, if applicable, are shown at checkout, and LLM provider usage
is billed separately by the provider.

Entitlements may be suspended or revoked for non-payment, chargeback, abuse,
violation of this Agreement, or where required by law. Each activation is bound to
one installation and subject to the plan's device limits. The plan determines which
features are available; telemetry is always subject to Customer's consent, and the
Private plan never uploads or stores telemetry.
```

### 2.3 Applied section 6 (privacy)

```markdown
## 6. Privacy

Personal data handling is described in the minitok privacy notice at
https://minitok.dev/privacy, which forms part of this Agreement. Telemetry upload is
disabled by default and happens only with Customer's explicit consent, as described
in that notice. Customer can use the account export and deletion endpoints described
in the server documentation, or write to support@minitok.dev.
```

### 2.4 Applied section 5 support wording (also the `support-commitments` signal)

```markdown
## 5. Updates and support

Flotic may provide updates, security fixes, and compatibility changes. Update
notifications are optional and can be disabled with `minitok_no_update_check=1`.

Support is provided by email to support@minitok.dev. Flotic responds within 24–48
hours, Monday–Friday (UTC), and prioritises active subscribers' billing and account
questions when possible; this is not a guaranteed response-time SLA. Provider
outages, model behaviour, and Customer-authored verification commands are outside
support scope.
```

No internal escalation promise was added: the published support page does not state
one, and the EULA should not promise more than the support page advertises.

### 2.5 Effective date

Applied: `**Effective date:** 2026-09-13`, the date the owner approved this text. If
the text changes later, add a "Last updated" line instead of reusing the original
effective date.

### 2.6 Review notes on the Korean subscription model

- **No refunds, and the published refund page that now contradicts them.** The rule
  is stated the way other subscription services state it: fees are charged in
  advance, cancelling stops the following period, the paid period stays usable, and
  no credit or pro-rated refund is given. The live minitok.dev pages still advertise
  a different promise — "Request a full refund for the initial purchase within 7
  days, subject to the Refund Policy" on the pricing page, the plan cards, and the
  FAQ, plus a complete Refund & Cancellation Policy at `/refund` and a "Refund"
  contact-form category. Section 6 lists the exact edits those pages need. Korean
  consumer law can also grant a withdrawal right for a first purchase of digital
  content within a short statutory period, which is why section 4 keeps one sentence
  saying it does not limit a non-waivable right: removing the advertised window is a
  commercial decision, not a removal of the underlying legal right, and if that
  sentence is ever deleted the operator must handle first-purchase withdrawal
  requests anyway. Refunds were also named in the entitlement-revocation list of the
  published EULA; the applied text drops it because a refund is no longer a
  contract term.
- **Renewal handling.** Confirm the current advance-notice and cancellation-path
  requirements for automatic renewal under Korean e-commerce law, and make the
  portal and `minitok` CLI surface the cancellation path that section 4 promises.
  Marketing copy must not advertise a refund that section 4 no longer offers.
- **Entity versus governing law.** `EULA.md` names "Flotic LC" as the contracting
  entity. If that entity is not Korean while the governing law is Korean, confirm
  whether Korean law and venue are intended for all customers or only for customers
  in Korea.

## 3. `POLICY.md` — what was applied

`POLICY.md` no longer carries review sentences. The header now reads "It is not a
legal notice, data-processing agreement, or legal advice; the published positions
that govern the commercial service are recorded in section 10 and in the privacy
notice at https://minitok.dev/privacy.", and section 10 was replaced by "Published
Legal Positions" with the controller, provider roles, privacy officer, legal bases,
jurisdiction and transfers, rights, retention, and the contact/version/effective
date (version 1.2.0, 2026-09-13). `DATA_CLASSIFICATION.md` §9 points at those
positions instead of carrying its own TODOs.

The bracketed samples below are kept as the record of what was proposed; the applied
text is the version inside `POLICY.md`, and the values behind it are listed in
section 5.

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

## 5. Values applied, and where each one came from

| # | Value | Source | Applied in |
|---|---|---|---|
| 1 | `Flotic LC.` (the legal form includes the trailing period) | owner decision, matching minitok.dev/terms §10 and floticinfo.com | EULA §11 |
| 2 | 경기도 용인시 수지구 문인로 57, 3층 301 - 나025호(풍덕천동, 삼익상가) | floticinfo.com footer and privacy policy 제9조 | EULA §11 |
| 3 | the Dodo customer portal linked from the account page | minitok.dev/terms §3 and /privacy §3 | EULA §4 |
| 4 | no named court: the courts of the Republic of Korea, and the customer may also sue at their residence | owner decision (Republic of Korea) | EULA §12 |
| 5 | email to support@minitok.dev, 24–48 hours, Monday–Friday (UTC), no guaranteed SLA | minitok.dev/support | EULA §5 |
| 6 | https://minitok.dev/privacy | minitok.dev/privacy | EULA §6 |
| 7 | support@minitok.dev ("contact support@minitok.dev for processor and transfer details") | minitok.dev/privacy §6 | POLICY §10 |
| 8 | 박주성, 대표 (개인정보 보호책임자) | floticinfo.com privacy policy 제9조 | POLICY §10 |
| 9 | Flotic LC. (유한회사 플로틱) as controller; the server stores consented telemetry; LLM providers are the customer's own relationship | minitok.dev/privacy §5, §6 | POLICY §10 |
| 10 | operated from the Republic of Korea; Dodo Payments, Hetzner, and Let's Encrypt may process data outside the customer's country; the PIPA disclosures are those listed in the privacy notice | minitok.dev/privacy §6 | POLICY §10 |
| 11 | support@minitok.dev; actioned as soon as practicable and within the period required by applicable law | minitok.dev/privacy §8 | POLICY §10 |
| 12 | Open telemetry 30 days, Select aggregate 14 days, Private none, account while the account exists, billing/support/security as needed | minitok.dev/privacy §7 | POLICY §10, DATA_CLASSIFICATION §9 |
| 13 | support@minitok.dev, effective 2026-09-13, technical policy version 1.2.0 | owner decision | POLICY §10 |
| 14 | not used: the applied EULA ends with the support contact line instead of a "last reviewed" line, which a published agreement does not need | — | — |

Two items stay open: a named specific court for EULA §12, and the data-inventory
question recorded in `DATA_CLASSIFICATION.md` §9.

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

## 6. Published pages that must change to stay consistent

The applied text and the live pages disagree in one important place: **minitok.dev
still advertises a refund that EULA §4 no longer offers.** These are live fetches
from 2026-09-13, so each line below is the text to search for.

| Page | Current published text | Required change |
|---|---|---|
| `https://minitok.dev/pricing` | "Request a full refund for the initial purchase within 7 days, subject to the Refund Policy." | Replace with the applied model: renews automatically until cancelled, cancel any time through the Dodo customer portal, the paid period stays usable, no refund for the unused part |
| `https://minitok.dev` FAQ | "Each includes one installation; no free trial, cancel anytime, and an initial-purchase refund request within 7 days, subject to the Refund Policy." and the pricing-card copy "Request an initial-purchase refund within 7 days" | Drop the refund half-sentence from both; keep "no free trial" and "cancel anytime" |
| `https://minitok.dev/refund` | The complete Refund & Cancellation Policy, including the 7-day initial-purchase refund, the post-initial-purchase exclusions, and the payment-failure and processing sections | Reduce it to the cancellation model of EULA §4, or unpublish the page |
| Footer, every page | Legal → "Refund Policy" | Remove the link once the page changes |
| `https://minitok.dev/support` | Contact-form category "Refund" | Remove the category, or fold it into billing questions |
| `https://minitok.dev/terms` §3 | Already matches: "cancel at any time through the Dodo customer portal; access continues through the current paid billing period" | Keep as-is |
| `https://minitok.dev/terms` §9 | "The registered address and any jurisdiction-specific governing-law or venue terms should be confirmed with support@minitok.dev before purchasing; this page does not invent a jurisdiction where one has not been confirmed." | Replace with the applied position: governed by the laws of the Republic of Korea, courts of the Republic of Korea, plus the notice address from EULA §11 |
| `https://minitok.dev/terms` §10 | Company block without the address | Add the notice address from EULA §11 so the website and the EULA name the same entity and address |
| `https://floticinfo.com` footer vs privacy policy | Footer says "경기도 용인시 수지구 문인로 57, 3층 301호"; the privacy policy 제9조 says "…3층 301 - 나025호(풍덕천동, 삼익상가)" | Use one form in both places, so the EULA notice address has a single published twin |
| `https://minitok.dev/terms`, `/privacy`, `/refund` | "Last updated: August 2026" | Update the date when these pages change |

Also re-read section 2.6: the live 7-day window is close to the statutory
withdrawal period for a first purchase of digital content under Korean consumer law,
so removing it is a commercial decision, not a removal of the underlying right. That
is why the applied EULA §4 keeps the sentence preserving non-waivable rights.

The website source is not part of this repository (`minitok-client-release` ships
the CLI, the Extension, and the legal text only), so these edits have to be made
wherever minitok.dev is deployed from.



