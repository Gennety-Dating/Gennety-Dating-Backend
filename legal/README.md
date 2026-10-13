# Legal documents

Source-of-truth **drafts** for Gennety's user-facing legal documents.

| File | Publish to | Live version to publish |
|---|---|---|
| [privacy-policy.md](privacy-policy.md) | `https://gennety.com/privacy` | v4.4 — "Last Updated: 13 October 2026" |
| [terms-of-service.md](terms-of-service.md) | `https://gennety.com/terms` | v3.2 — "Last Updated: 13 October 2026" |
| [cookie-policy.md](cookie-policy.md) | `https://gennety.com/cookies` | v1.0 — "Last Updated: 23 July 2026" |

Two further documents in this directory are **internal** and are never
published — they are produced to a supervisory authority on request:

| File | What it is |
|---|---|
| [ropa.md](ropa.md) | Record of Processing Activities (Art. 30) — the inventory: every purpose, its legal basis, data categories, recipients, transfers and retention |
| [ios-permission-strings.md](ios-permission-strings.md) | Source text for the iOS app's `Info.plist` purpose strings (en/ru/uk/de/pl), the pre-permission screens, and the App Store Connect App Privacy answers. Copied into the Gennety-iOS repo; change it here first |
| [dpia.md](dpia.md) | Data Protection Impact Assessment (Art. 35) — necessity and proportionality, ten assessed risks with residuals, and the action list |

Both are derived from the code rather than from memory: **update them in the
same commit as any change to a processing activity, a retention period, or a
processor**, exactly like the published documents above.

**The Terms and the Privacy Policy share one version stamp**, because the
consent screen accepts them with a single checkbox. That stamp lives in code as
`LEGAL_DOCS_VERSION` (`packages/shared/src/constants.ts`, currently
`"2026-10-13"`) and is written to `User.policyVersion` at the moment of the
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

## What changed in v4.4 / Terms v3.2 (2026-10-13)

An audit of both documents against the code (App Store review and GDPR), not a
product change. Every addition describes something already in the code.

- **Privacy** — version line; §1 (permissions row, the match row, self-service
  deletion); §4.1 (city stored as the city centre; frequently visited places;
  explored areas marked retired; music; voice answer; Prime Time and the
  Premium packages in payments); §4.2 (what a push can show on the lock screen;
  the Date Bump; the promo clipboard read; first-party product events — no
  third-party analytics, no tracking); **new §4.4, every iOS permission and why**;
  §7 (Date Radar / Bump on contract; frequently visited places on legitimate
  interests with an opt-out — not consent, because it is on by default; music
  and voice answer); §11 rewritten (city, logistics with what Google and
  Open-Meteo receive, Date Radar, Date Bump, frequently visited places with its
  controls, map colouring retired, ride hand-offs); §12.1 (songs, voice answer,
  up to three places); §12.4 (AWS and Supabase regions, AWS keeps no audit
  images, Telegram sign-in, Apple Music, Spotify); §14 (`appAccountToken`,
  Prime Time Pass, Premium packages); §16 (seven new rows); §18 (deletion paths
  in the app and the bot; deleting the app ≠ deleting the account; deleting the
  account cancels a Stars subscription, not an App Store one).
- **Terms** — version line; §2 (AI Export removed; venue change, Prime Time
  Pass, App); §5 (AI Export removed); §8 (zero tolerance, report and block, the
  24-hour aim — App Store 1.2); §9 and §11.3 (**two** venue changes per date,
  not one — the code's `VENUE_CHANGE_MAX_PER_DATE`; included in Premium); §11.4
  rewritten (monthly subscription vs three-/six-month Stars packages; the
  App Store 3.1.2 subscription disclosures; cancel before deleting); new §11.6
  Prime Time Pass; Refunds → §11.7 (survival clause in §12 follows); §13
  (in-app deletion paths); §18 rewritten as the full Apple minimum EULA terms.
- **ROPA v1.3** — §2.5g–2.5i, §2.8; open items 12 (partly closed), 13–15.
  **DPIA v1.3** — R15, actions 16–18.
- **New file** `ios-permission-strings.md`.
- **Re-consent.** `LEGAL_DOCS_VERSION` → `2026-10-13`. `LEGAL_DOCS_TASTE_HINTS_FROM`
  stays `2026-10-08` (a `>=` comparison, so new acceptances still qualify).
- **Website:** body via `scripts/legal-md-to-tsx.py`; header line hand-set to
  `Last Updated: 13 October 2026 · Version 4.4` and `… · Version 3.2`.

**Found by the audit and left for a decision (not fixed in this commit):**

1. Frequently visited places has been live since 2026-09-22, on by default and
   undisclosed. v4.4 discloses it; existing users still need a one-time notice
   (ROPA item 13, DPIA R15 / actions 16–17).
2. Fixed 2026-10-13: deleting an account now cancels a Telegram Stars Premium
   subscription (`deleteUserAccount` → `editUserStarSubscription`, founder alert
   if it fails), and a renewal that still arrives for a deleted account is
   cancelled and refunded (`refundOrphanPremiumRenewal` in
   `handlers/payments.ts`). App Store subscriptions remain Apple's to cancel
   (ROPA item 14, DPIA action 18 — closed).
3. `referral_identities` has no retention sweep (ROPA item 15) — referral is off.
4. The iOS app offers "Continue with Telegram" but no Sign in with Apple. App
   Store Guideline 4.8 requires an equivalent privacy-preserving login option
   when a third-party login is offered; phone/email OTP may or may not be
   accepted as that — expect the question in review.
5. Verify the iOS label of the deletion entry ("Settings → Delete account" is
   what both documents now say) and the Telegram path to Stars subscriptions.
6. The note below under 2026-08-01 says deletion "no longer sends your profile,
   phone, email and photos to the internal operations feed". The code
   (`services/founder-notify.ts`) still sends the full card, phone and photos
   after deletion; Privacy §12.2 describes the code, and is the one that is right.

## What changed in v4.3 / Terms v3.1 (2026-10-08)

Founder decisions of 2026-10-08: **The Morning After** (a double-blind
two-button question the morning after a date), the **Date Wishlist** (built with
the AI agent; OpenAI web search + server-side reads of public shop pages; image
copied to private storage; price kept as a band) shown to a mutual match as a
cheat sheet — a tenth free, the rest for a one-off unlock (150⭐ / $2.99 Apple
IAP) or with Premium — and **Premium without the Date Ticket cover**
(grandfathered to the end of the period already paid for).

- **Privacy** §1, §3, §4.1 (morning-after answer, wishlist, consent records,
  unlock purchases), §4.2 (look-up cache), §4.3 (mutual interest), new §5.6,
  §6, §7 (four rows; wishlist disclosure on Art. 6(1)(b) contract), §8, §9, §11,
  §12.1 (what the match sees and when; the flowers hint), §12.4 (OpenAI web
  search, Supabase images; shops are not processors), §14, §16, §18.
- **Terms** §2 (three definitions), §5 (The Morning After), §6 (wishlist rules,
  product images belong to their owners, takedown on request), §7, §11.2,
  §11.4 (benefits, grandfathering, notice of reduced benefits), new §11.5
  (Date Wishlist unlock), Refunds renumbered §11.6 (the survival clause in §12
  follows), §13.
- **ROPA v1.2** adds §2.5d–2.5f and the unlock in §2.8; open items 9–12.
- **Voice note and screenshots** as ways to fill the wishlist (third decision of
  2026-10-08; read once by OpenAI, never stored): Privacy header, §4.1, §7, §9,
  §12.4, §16; ROPA §2.5e; DPIA R12. Folded into v4.3 before publication.
  **DPIA v1.2** adds R12–R14 and actions 12–15.
- **Re-consent.** `LEGAL_DOCS_VERSION` → `2026-10-08`. Nothing in this release
  relies on accepting the new text as *consent*. The wishlist disclosure rests on
  contract (Art. 6(1)(b)) — the founder's second decision of 2026-10-08 replaced
  the separate consent screen, which read as a warning; consent could not simply
  move into the sign-up tick, where it would be invalid as bundled (Art. 7(2),
  7(4)). The session's first line is the notice at collection, and the owner can
  hide the list (`users.wishlist_hidden_at`). The flowers hint is gated on
  `policyVersion ≥ LEGAL_DOCS_TASTE_HINTS_FROM` or on having built a wishlist,
  never while the list is hidden. The viewer sees the list's age from 45 days
  after its last change (`users.wishlist_changed_at`). Existing users are still
  owed a notice (Art. 13) — ROPA §6 item 9.
- **Website:** body generated with `scripts/legal-md-to-tsx.py`; the header line
  is hand-set to `Last Updated: 8 October 2026 · Version 4.3` (privacy) and
  `Last Updated: 8 October 2026 · Version 3.1` (terms).

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
