# Legal documents

Source-of-truth **drafts** for Gennety's user-facing legal documents.

| File | Publish to | Live version to publish |
|---|---|---|
| [privacy-policy.md](privacy-policy.md) | `https://gennety.com/privacy` | v4.0 — "Last Updated: 1 August 2026" |
| [terms-of-service.md](terms-of-service.md) | `https://gennety.com/terms` | v3.0 — "Last Updated: 1 August 2026" |
| [cookie-policy.md](cookie-policy.md) | `https://gennety.com/cookies` | v1.0 — "Last Updated: 23 July 2026" |

**The Terms and the Privacy Policy share one version stamp**, because the
consent screen accepts them with a single checkbox. That stamp lives in code as
`LEGAL_DOCS_VERSION` (`packages/shared/src/constants.ts`, currently
`"2026-08-01"`) and is written to `User.policyVersion` at the moment of the
click, so we can demonstrate WHICH text any given user agreed to (GDPR Art.
7(1)). **Bump the constant in the same commit as any material edit to either
document.**

These documents are published on the **marketing website** (`gennety.com`,
hosted separately in `~/Desktop/Gennety dating website`, **not** in this backend
repo). To go live, the text here must be transcribed into the website's
`src/app/privacy/page.tsx`, `src/app/terms/page.tsx`, and a new
`src/app/cookies/page.tsx`, and linked from the footer.

## ⚠️ Not legal advice

These drafts were written to be **technically accurate** to what the product
actually does today (data flows, processors, biometrics, payments, the no-chat
model, freeze/delete, Premium, venue intent). They are **not a substitute for
legal review.** Have a qualified lawyer review them before publishing —
especially the biometric-data (GDPR Art. 9), dietary/accessibility special-
category (Art. 9), automated-decision (Art. 22), payment/refund/subscription,
and Apple App Store sections.

## What changed in this rewrite (2026-08-01)

Driven by a full audit of the running code. Every item below is a change to the
PRODUCT that the documents now reflect — not a wording pass:

- **Nationality / ethnic origin is no longer collected.** The optional
  onboarding question was removed, the stored values erased, and the field
  dropped from the profile, the matching embedding, the operations feed and the
  admin analytics. It was Article 9 data feeding an automated matching decision
  with no Article 9 basis behind it. Privacy §4.1 and §6 now say so explicitly.
- **Identity verification: Persona → Amazon Rekognition Face Liveness.** The
  provider changed on 2026-07-26 but the documents still named Persona and
  still described a provider webhook that no longer exists. Privacy §5.3, §10,
  §12.4, §17 and ToS §4 are corrected.
- **The personal AI export ("Magic Prompt") is retired** (founder decision).
  Privacy §9 no longer describes it; §3, §4.1, §6, §12.1 and §12.4 no longer
  reference it.
- **Deleting your account no longer sends your profile, phone, email and photos
  to the internal operations feed** — it sends an anonymous lifecycle event.
  Freezing keeps the profile card but drops the phone number. Privacy §12.2.
- **Newly disclosed:** the 30-day chat timeline, the in-memory promo-code
  attribution fingerprint, and Open-Meteo as a processor. All three were live
  (or about to be) and undisclosed.
- **Corrected claims:** the research opt-in row in §7 no longer implies we
  already act on it; §12.3 now describes the real single-operator access model
  instead of implying a staffed team with per-person access control; §7 splits
  the visual-type feature into the part you consent to (your picks) and the
  part that runs for everyone (tagging your own photos).
- **Biometric consent is now a real consent step**, not an inference from
  tapping "Verify". Privacy §6 and §10, ToS §4.

## Blockers before these can be published as-is

Both are marked inline in Privacy §2 and must be resolved — they are the only
placeholders left in the text:

1. **Postal address of the controller.** Art. 13(1)(a) requires the controller's
   identity and contact details. There is no legal entity (confirmed
   2026-08-01: the operator is a natural person), which is lawful, but an
   address is still required.
2. **Article 27 EU representative — not appointed.** The Service ships German
   and Polish, so it targets the EEA, and a non-EU controller in that position
   must appoint a representative in the Union. Currently disclosed honestly as
   "not yet appointed"; publishing in that state is a known, recorded gap.

## Still open (not blockers for publishing)

- The Apple StoreKit product ids / display prices match what ships (Premium
  price: code default `$9.99`, prod `.env` still shows `$10` — reconcile).
- Governing law / jurisdiction wording (drafts use Ukraine / Kyiv — confirmed).
- The sub-processor list (Privacy §12.4) — keep it in sync as providers change.
- **No DPIA (Art. 35) and no RoPA (Art. 30) exist yet.** Both are mandatory for
  this processing (biometrics + large-scale profiling + special categories) and
  are the next deliverables after these documents.
- **No self-service data export** for Art. 15 / Art. 20 requests; they would be
  fulfilled by hand today.

## Follow-up code tasks (separate from these drafts)

- **Bot:** build the dedicated biometric-consent screen the documents now
  promise (Privacy §6/§10, ToS §4), and record the consent with its
  `LEGAL_DOCS_VERSION`.
- **iOS:** add Privacy Policy + Terms links to `ConsentView.swift` and the App
  Store Connect listing.
- **Website:** add `/cookies` page + footer/banner link; bump `POLICY_VERSION`.
- **Website:** transcribe the three drafts into the `page.tsx` files (they are
  hand-written JSX mirrors of this Markdown, not rendered from it) — v4.0 /
  v3.0 are NOT live until this is done.
