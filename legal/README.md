# Legal documents

Source-of-truth **drafts** for Gennety's user-facing legal documents.

| File | Publish to | Live version to publish |
|---|---|---|
| [privacy-policy.md](privacy-policy.md) | `https://gennety.com/privacy` | v4.2 — "Last Updated: 26 September 2026" |
| [terms-of-service.md](terms-of-service.md) | `https://gennety.com/terms` | v3.0 — "Last Updated: 1 August 2026" |
| [cookie-policy.md](cookie-policy.md) | `https://gennety.com/cookies` | v1.0 — "Last Updated: 23 July 2026" |

Two further documents in this directory are **internal** and are never
published — they are produced to a supervisory authority on request:

| File | What it is |
|---|---|
| [ropa.md](ropa.md) | Record of Processing Activities (Art. 30) — the inventory: every purpose, its legal basis, data categories, recipients, transfers and retention |
| [dpia.md](dpia.md) | Data Protection Impact Assessment (Art. 35) — necessity and proportionality, ten assessed risks with residuals, and the action list |

Both are derived from the code rather than from memory: **update them in the
same commit as any change to a processing activity, a retention period, or a
processor**, exactly like the published documents above.

**The Terms and the Privacy Policy share one version stamp**, because the
consent screen accepts them with a single checkbox. That stamp lives in code as
`LEGAL_DOCS_VERSION` (`packages/shared/src/constants.ts`, currently
`"2026-09-26"`) and is written to `User.policyVersion` at the moment of the
click, so we can demonstrate WHICH text any given user agreed to (GDPR Art.
7(1)). **Bump the constant in the same commit as any material edit to either
document.**

These documents are published on the **marketing website** (`gennety.com`,
hosted separately in `~/Desktop/Gennety dating website`, **not** in this backend
repo). To go live, the text here must be transcribed into the website's
`src/app/privacy/page.tsx`, `src/app/terms/page.tsx`, and a new
`src/app/cookies/page.tsx`, and linked from the footer.

## Applied draft — Tempo Sync (Apple Health)

[tempo-sync-draft.md](tempo-sync-draft.md) was the text Tempo Sync adds to the
Privacy Policy, the ROPA and the DPIA. **Applied 2026-09-26** (privacy v4.2, ROPA
v1.1, DPIA v1.1); the file stays as the record of what was moved in and of the
switch-on order.

## Website state (checked 2026-09-26)

Until 2026-09-26 the website still showed **privacy v3.0 and terms v2.0** (both
23 July 2026): v4.0, v4.1 and terms v3.0 had been written here and stamped by
`LEGAL_DOCS_VERSION`, but never transcribed. They went live together with v4.2
on 2026-09-26. The website's §2 had meanwhile been edited by hand to "operated by
sverkaus labs"; the founder confirmed the text here ("Gleb Gosha, an individual")
is the correct one, and the site now carries it. Transcription tool:
`scripts/legal-md-to-tsx.py` (the page header — H1 and the "Last Updated ·
Version" line — stays hand-written, as in July).

## ⚠️ Not legal advice

These drafts were written to be **technically accurate** to what the product
actually does today (data flows, processors, biometrics, payments, the no-chat
model, freeze/delete, Premium, venue intent). They are **not a substitute for
legal review.** Have a qualified lawyer review them before publishing —
especially the biometric-data (GDPR Art. 9), dietary/accessibility special-
category (Art. 9), automated-decision (Art. 22), payment/refund/subscription,
and Apple App Store sections.

## What changed in v4.2 (2026-09-26)

One optional feature, **Tempo Sync**: the iPhone app reads 28 days of Apple Health
step counts (wheelchair pushes included), reduces them on the phone to two coarse
labels (activity level, time of day most active) and uploads only those. The
text is the draft in [tempo-sync-draft.md](tempo-sync-draft.md), moved in as
written, plus what applying it turned up:

- **Privacy §5.5** (new) names Apple Health as a data source — §5 lists where
  data comes from and the draft had not touched it.
- **The version line** keeps the v4.0/v4.1 summary: the website still showed
  v3.0 until this release, so v4.2 is the first published version carrying them.
- **§2 loses the "Postal address: [to be completed before publication]" line**
  rather than publish a placeholder. The address is still owed — ROPA §6 item 1,
  DPIA action 2 — and goes back into §2 when there is one.
- Privacy §4.3, §6 (row + paragraph), §8, §12.1 and §16 as drafted; ROPA gains
  activity 2.5c and §5 item 5; DPIA gains R11, two §3.2 exclusions and action 11.
  R11 states the weight as it is actually run: shipped at 0 with the similarity
  logged, switched to 0.05 once this version was published.

## What changed in v4.1 (2026-08-27)

One disclosure, driven by shipping the feature it describes. The **Scratch Map**
("colour in the parts of the city you have been to") had been built end to end —
server, endpoint, fog layer, percentage, consent column — and was **unreachable**,
because nothing in the client ever called the opt-in. Making it reachable makes it
collectable, so the documents move in the same commit as the switch:

- **Privacy §11 said "two narrow purposes" and now says three.** The two existing
  statements stay true and are now stated more strongly: this collection is
  foreground-only and off until switched on, so "no background collection" is a
  property of the build rather than a promise.
- **Privacy §4** gains an "explored areas" row, **§16** a retention row.
- **ROPA gains activity 2.5b**, on Art. 6(1)(a) consent — deliberately not folded
  into the research opt-in, because that governs analytics use of data we already
  hold while this authorises collecting a new class of it.
- **No DPIA risk was added.** The assessment's location risk is about precision
  and linkage; this feature stores geohash-6 tiles (~1.2 km) and no coordinate,
  so it lands inside the existing minimisation finding rather than beside it.

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
  price: code default `$17.99` = 750⭐; prod `.env` still shows `$11.99`/500⭐
  and App Store Connect still shows `$9.99` — reconcile all three).
- Governing law / jurisdiction wording (drafts use Ukraine / Kyiv — confirmed).
- The sub-processor list (Privacy §12.4) — keep it in sync as providers change.
- Art. 15 / Art. 20 requests are served by `pnpm gdpr:export -- --telegram=<id>
  --prod` (also `--user` / `--email` / `--phone`). It discovers tables from
  `information_schema` rather than a hand-written list, so a table added later
  cannot fall out of the export silently, and it redacts another user's
  free-text account of a report under Art. 15(4). There is still no
  *self-service* export in the product — the operator runs it.

## Follow-up code tasks (separate from these drafts)

- **iOS:** add Privacy Policy + Terms links to `ConsentView.swift` and the App
  Store Connect listing.
- **Website:** add `/cookies` page + footer/banner link; bump `POLICY_VERSION`.
- **Website:** transcribe the three drafts into the `page.tsx` files (they are
  hand-written JSX mirrors of this Markdown, not rendered from it) — v4.0 /
  v3.0 are NOT live until this is done.
