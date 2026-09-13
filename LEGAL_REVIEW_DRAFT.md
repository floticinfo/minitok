# Legal review record — EULA.md and POLICY.md review notes and the applied text

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
| Contracting entity | **Flotic LC.** (the legal form includes the trailing period), Representative JOO SUNG PARK, business registration number 180-88-03655 | EULA §11 | 2026-09-13 |
| Notice address | 3F 301-Na025, Sangik Plaza, 57 Munin-ro, Suji-gu, Yongin-si, Gyeonggi-do, Republic of Korea | EULA §11 | 2026-09-13 |
| Governing law and venue | **Republic of Korea**; the customer may also sue at their place of residence | EULA §12, §13 | 2026-09-13 |
| Refunds | **None.** Fees are charged in advance per period, cancelling stops the following period, the paid period stays usable, no credit or pro-rated refund; one sentence preserves non-waivable Korean consumer rights | EULA §4 | 2026-09-13 |
| Cancellation path | the Dodo customer portal linked from the account page | EULA §4 | 2026-09-13 |
| Support channel and hours | email to support@minitok.dev, 24–48 hours, Monday–Friday (UTC), not a guaranteed SLA | EULA §5 | 2026-09-13 |
| Privacy notice | https://minitok.dev/privacy | EULA §6, POLICY §10 | 2026-09-13 |
| Rights, processor, and transfer contact | support@minitok.dev | POLICY §10 | 2026-09-13 |
| Retention | Open telemetry 30 days, Select aggregate 14 days, Private none; account while the account exists; billing, support, and security as needed | POLICY §10, DATA_CLASSIFICATION §9 | 2026-09-13 |
| Controller and privacy officer | Flotic LC.; privacy officer JOO SUNG PARK, Representative | POLICY §10 | 2026-09-13 |
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

This Agreement is entered into with Flotic LC., the licensor of minitok.
Representative: JOO SUNG PARK. Business registration number: 180-88-03655. Notice
address: 3F 301-Na025, Sangik Plaza, 57 Munin-ro, Suji-gu, Yongin-si, Gyeonggi-do,
Republic of Korea. Notices to Flotic must be sent to that address or by email to
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
Korean law, including the Act on the Regulation of Terms and Conditions and the Act
on Consumer Protection in Electronic Commerce. Where such law applies, it prevails
over sections 7, 8, and 9.

No "last reviewed" line was added: the published agreement ends with the support
contact line instead, and the approval record lives in the approval manifest.
```

### 2.2 Applied section 4 (billing and entitlement)

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

### 3.1 Header block

The review sentence was replaced by the applied wording: "It is not a legal notice,
data-processing agreement, or legal advice; the published positions that govern the
commercial service are recorded in section 10 and in the privacy notice at
https://minitok.dev/privacy." The document stays a technical policy, so it does not
claim to be the privacy notice; the notice itself is the published page.

### 3.2 Section 10

Section 10 is now "Published Legal Positions" and records the controller and
address, the provider roles, the privacy officer, the legal bases, jurisdiction and
international transfers, rights handling, and retention, ending with the contact,
version (1.2.0), and effective date (2026-09-13). The values behind each item are
listed in section 5.

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
| 2 | 3F 301-Na025, Sangik Plaza, 57 Munin-ro, Suji-gu, Yongin-si, Gyeonggi-do, Republic of Korea | floticinfo.com footer and privacy policy, Article 9 | EULA §11 |
| 3 | the Dodo customer portal linked from the account page | minitok.dev/terms §3 and /privacy §3 | EULA §4 |
| 4 | no named court: the courts of the Republic of Korea, and the customer may also sue at their residence | owner decision (Republic of Korea) | EULA §12 |
| 5 | email to support@minitok.dev, 24–48 hours, Monday–Friday (UTC), no guaranteed SLA | minitok.dev/support | EULA §5 |
| 6 | https://minitok.dev/privacy | minitok.dev/privacy | EULA §6 |
| 7 | support@minitok.dev ("contact support@minitok.dev for processor and transfer details") | minitok.dev/privacy §6 | POLICY §10 |
| 8 | JOO SUNG PARK, Representative (privacy officer) | floticinfo.com privacy policy, Article 9 | POLICY §10 |
| 9 | Flotic LC. as controller; the server stores consented telemetry; LLM providers are the customer's own relationship | minitok.dev/privacy §5, §6 | POLICY §10 |
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

## 6. Published pages: state on 2026-09-13

The pages were fetched again on 2026-09-13, after the owner applied part of this
table. **The refund promise that EULA §4 no longer offers has been removed** from the
pricing page, the pricing note, the FAQ, and the refund page: those pages now print the
cancellation model ("renew automatically until cancelled … the current paid billing
period is not automatically refunded"). This table is therefore the list of what
remains, each line still being the text to search for.

| Page | State | Remaining change |
|---|---|---|
| `https://minitok.dev/pricing` | Applied: the note ends with "cancellation stops the next renewal. The current paid billing period is not automatically refunded." | — |
| `https://minitok.dev` FAQ and pricing card | Applied: the FAQ answer and the card describe the cancellation model; no initial-purchase refund is offered | — |
| `https://minitok.dev/refund` | Applied: the page is cancellation-first ("Subscriptions are not automatically refunded when canceled… subject to applicable law and provider rules") | Optional: rename the page and the footer link to "Cancellation Policy", since EULA §4 offers no refund |
| Footer, every page | Pending (optional) | Remove or rename the "Refund Policy" link once the page is renamed |
| `https://minitok.dev/support` | Pending | The contact form offers category "Refund", and the server accepts it (`src/api/support.js`). Keep it as an eligibility question or rename both to "Billing" |
| `https://minitok.dev/terms` §3 | Applied: "cancel at any time through the Dodo customer portal; access continues through the current paid billing period" | — |
| `https://minitok.dev/terms` §9 | **Pending** | Replace "The governing law, venue, and any jurisdiction-specific terms remain …" with the applied position: governed by the laws of the Republic of Korea, courts of the Republic of Korea, the customer's residence option, and the sentence preserving non-waivable rights |
| `https://minitok.dev/terms` §10 and the footers | **Pending** | Publish one English address form matching EULA §11: the pages print "Room 301, 3rd Floor, 57 Munin-ro, Suji-gu, Yongin-si, Gyeonggi-do", which omits the unit suffix and "Sangik Plaza"; the privacy policy the server serves uses the same shorter form |
| `https://floticinfo.com` footer and privacy policy | Pending | Same single English form in both places, so the EULA notice address has one published twin |
| `https://minitok.dev/terms`, `/privacy`, `/refund` | Pending | "Last updated: August 2026" → the month the pages are actually changed |
| `https://minitok.dev` install command | Pending (follows the publish) | "npm install -g @flotic/minitok@1.3.12" → the version published to npm; 1.3.18 is the version prepared here. The live command is correct until that publish happens |
| `https://minitok.dev/privacy` §7 vs the server | **Open** | The page publishes 30 days for Open telemetry and 14 days for Select; the server retains telemetry for 90 days and the policy the server itself serves says 90. See `DATA_CLASSIFICATION.md` section 9.2 |

**Version strings.** The homepage still advertises the 1.3.12 install command while
this repository prepares 1.3.18, so the command has to follow the publish. The
Extension was repackaged so its embedded CLI runtime matches 1.3.18 and reports 0.2.9,
which is the correct next version: the Marketplace serves
`…/minitok-extension/0.2.5/vspackage` with HTTP 200 and a 725,989 byte VSIX, while the
same URL for 0.2.6 through 0.2.9 all return HTTP 404, so 0.2.5 is the published
version and none of 0.2.6 through 0.2.9 has been used. Publish the repackaged VSIX as
0.2.9, and bump the Extension version whenever a version that was already published has
to change.

Also re-read section 2.6: the live 7-day window is close to the statutory
withdrawal period for a first purchase of digital content under Korean consumer law,
so removing it is a commercial decision, not a removal of the underlying right. That
is why the applied EULA §4 keeps the sentence preserving non-waivable rights.

The website source is not part of this repository (`minitok-client-release` ships
the CLI, the Extension, and the legal text only), so these edits have to be made
wherever minitok.dev is deployed from.

### Ready-to-paste English copy

The live pages print the company details in Korean. These English forms match EULA
§11 and POLICY §10, so the website and the shipped documents describe the same
entity in the same language.

**Company block (terms §10, the footers, and the refund page header):**

```text
Flotic LC. (a limited company organized under the laws of the Republic of Korea)
Representative: JOO SUNG PARK
Business Registration No.: 180-88-03655
Address: 3F 301-Na025, Sangik Plaza, 57 Munin-ro, Suji-gu, Yongin-si, Gyeonggi-do, Republic of Korea
Contact: support@minitok.dev
```

**Pricing page and plan cards, replacing the refund sentence:**

```text
Monthly subscriptions renew automatically until cancelled. Cancel any time through
the Dodo customer portal: the period already paid for stays available for its full
term, and no further charge is made from the following period.
```

**FAQ answer for "What do the plans include?":**

```text
Open includes consented per-run telemetry for 30 days; Select, consented
aggregate-only telemetry for 14 days; Private stores no telemetry. Each plan includes
one installation, there is no free trial, and you can cancel any time.
```

**Terms §9, replacing the "jurisdiction not confirmed" paragraph:**

```text
These Terms are governed by the laws of the Republic of Korea, without regard to its
conflict-of-law rules. Disputes are subject to the courts of the Republic of Korea,
and a customer may also bring proceedings at their place of residence as provided by
Korean law. Nothing in these Terms limits rights that cannot legally be excluded,
including mandatory consumer protections.
```

**Refund page, if it is kept at all — the cancellation model only:**

```text
Cancellation
You may cancel your monthly subscription at any time through the Dodo customer
portal. Cancellation stops the next renewal and access continues through the current
paid billing period. Cancellation does not refund the current billing period, and no
credit or pro-rated refund is given for the unused part of a period. This does not
limit any right you have that cannot legally be excluded.
```

**If a specific court is ever named**, EULA §12 would read: "The Seoul Central
District Court has exclusive jurisdiction, except where mandatory consumer law lets
Customer sue elsewhere." That is optional and it was not applied.

The pages were fetched again on 2026-09-13 and re-checked while preparing 1.3.18: the
refund promise is gone from the pricing page, the plan cards, the FAQ, and the refund
page, the footer now lists "Support requests" and "Pre-sales and general inquiries"
under support@minitok.dev, and terms §9, terms §10, the last-updated dates, and the
install command are still as the table above describes.

**Where the pages are edited.** The website is not part of this repository. The
deployable copy lives in the website workspace (`minitok-website/`), which is uploaded
with `scp` to the production VM (`/opt/minitok/website/`), and its own `static/`
directory is marked obsolete in `deployment/deploy.sh` and must not be uploaded over
the live pages. Edit the production HTML that was last uploaded (the `_*_prod.html`
copies used by `deployment/deploy_legal_remediation.sh`) or fetch the live pages first,
then upload only the pages that changed and restart the web container.



