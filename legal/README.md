# Legal documents

Source-of-truth **drafts** for Gennety's user-facing legal documents.

| File | Publish to | Live version to publish |
|---|---|---|
| [privacy-policy.md](privacy-policy.md) | `https://gennety.com/privacy` | v3.0 — "Last Updated: 23 July 2026" |
| [terms-of-service.md](terms-of-service.md) | `https://gennety.com/terms` | v2.0 — "Last Updated: 23 July 2026" |
| [cookie-policy.md](cookie-policy.md) | `https://gennety.com/cookies` | v1.0 — "Last Updated: 23 July 2026" |

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

## What changed in this rewrite (2026-07-23)

The previous drafts (Privacy 23 June, live site 18 July; Terms 23 June) predated
several shipped features. This rewrite brings them current with production:

- **Dual-track sign-up** (university email **or** phone; Twilio SMS + Telegram
  one-tap/Gateway) — previously the docs said email was mandatory for everyone.
- **Mandatory identity verification** — the old text said verification "may be
  skipped". It cannot; that section was rewritten.
- **Native iOS app** distributed via the App Store — added Apple as a processor,
  App Store payments/subscriptions, APNs/Live Activities, and the required
  **Apple EULA "Additional Terms"** (ToS §18) that App Review expects.
- **Payments** — replaced the "planned: Fondy" text with the live rails
  (**Telegram Stars** + **Apple In-App Purchase**), Ticket bundles, paid venue
  changes, and the **Gennety Premium** recurring subscription (with the
  cancellation/refund disclosures a subscription needs).
- **Venue intent** — added dietary / alcohol-free / step-free requirements as
  **special-category data** processed on explicit consent.
- **Internal operations / founder feed** — disclosed the new-profile, weekly-
  matches, date-locked, and anonymous freeze/delete notifications.
- **Onboarding funnel telemetry, usage metering, appearance tagging / type
  radar, map-tile proxy, session/push tokens** — newly disclosed.
- **Website onboarding removed (2026-07-19)** — the old "verify email on the
  website" bullet was corrected: the site now only records cookie consent.
- **New Cookie Policy** — the live site already runs a cookie banner + append-
  only consent record, but there was no dedicated policy. Added one, and the
  Privacy Policy now points to it instead of carrying a stub "Cookies" section.

## Discrepancies found while auditing (2026-07-23)

The task asked to check whether the hosted pages, the links the app points to,
and the website match. Findings:

1. **Privacy Policy version skew.** The backend draft was "23 June 2026" but the
   **live website** (`src/app/privacy/page.tsx`) was already a newer "18 July
   2026" revision (it had a reworked cookies section mentioning the Spotify
   embed and a shortened deletion paragraph). The two were out of sync. This
   rewrite supersedes **both**; publish v3.0 to the site.
2. **Terms links exist — the old README "code gap" is FIXED.** The old README
   warned the consent screens linked only the Privacy Policy. No longer true:
   both `apps/bot/src/handlers/onboarding/consent.ts` and
   `apps/webapp/src/onboarding.tsx` now define **both** `PRIVACY_POLICY_URL`
   (`/privacy`) and `TERMS_OF_SERVICE_URL` (`/terms`) and surface both.
3. **iOS consent screen has no policy links.** `App/Features/Onboarding/
   ConsentView.swift` shows consent copy but links to **neither** `/privacy`
   nor `/terms`. App Review generally requires reachable Privacy Policy + EULA
   links in the app. **Action:** add both links to the iOS consent screen (and
   the App Store Connect metadata). Tracked below.
4. **No `/cookies` route yet.** The website has a cookie banner and a consent
   API, but no standalone cookie policy page; the Privacy Policy footnoted
   cookies instead. **Action:** create `src/app/cookies/page.tsx` from
   `cookie-policy.md` and link it from the footer + the cookie banner.
5. **`POLICY_VERSION` on the website is stale.** `src/constants/consent.ts`
   defaults to `2026-04-01`. When the new Cookie Policy is published, bump
   `POLICY_VERSION` / `NEXT_PUBLIC_POLICY_VERSION` (e.g. `2026-07-23`) so the
   banner re-prompts under the new version.

## To confirm before publishing

- Full legal entity name, registration number, and registered address (drafts
  currently say "operated by Gleb Gosha, Kyiv, Ukraine").
- Whether an EU Article 27 representative is appointed.
- The Apple StoreKit product ids / display prices match what ships (Premium
  price: code default `$9.99`, prod `.env` still shows `$10` — reconcile).
- Governing law / jurisdiction wording (drafts use Ukraine / Kyiv — confirmed).
- The current sub-processor list (Privacy §12.4) — keep it in sync as providers
  change (e.g. FCM/Expo were removed; APNs direct + Twilio + CARTO were added).

## Follow-up code tasks (separate from these drafts)

- **iOS:** add Privacy Policy + Terms links to `ConsentView.swift` and the App
  Store Connect listing (finding #3).
- **Website:** add `/cookies` page + footer/banner link; bump `POLICY_VERSION`
  (findings #4, #5).
- **Website:** transcribe the three drafts into the `page.tsx` files (they are
  hand-written JSX mirrors of this Markdown, not rendered from it).
