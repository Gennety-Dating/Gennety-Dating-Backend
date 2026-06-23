# Legal documents

Source-of-truth **drafts** for Gennety's user-facing legal documents.

| File | Publish to | Currently live version |
|---|---|---|
| [privacy-policy.md](privacy-policy.md) | `https://gennety.com/privacy` | "Last Updated: 26 April 2026" |
| [terms-of-service.md](terms-of-service.md) | `https://gennety.com/terms` | "Last Updated: 12 April 2026" |

These documents live on the **marketing website** (`gennety.com`, hosted
separately — not in this backend repo). To go live, the text here must be
published to that site.

## ⚠️ Not legal advice

These drafts were written to be **technically accurate** to what the product
actually does (data flows, processors, biometrics, payments, the no-chat model,
freeze/delete). They are **not a substitute for legal review.** Have a qualified
lawyer review them before publishing — especially the biometric-data (GDPR
Art. 9), automated-decision (Art. 22), and payment/refund sections.

## To confirm before publishing

- Full legal entity name, registration number, and registered address (both docs
  currently say "operated by Gleb Gosha, Kyiv, Ukraine").
- Whether an EU Article 27 representative is appointed.
- Final payment processor names (drafts say "currently planned: Fondy and Telegram Payments / Telegram Stars").
- Governing law / jurisdiction wording (drafts use Ukraine / Kyiv — Confirmed).
- The current sub-processor list (Section 7 of the Privacy Policy) — keep it in
  sync as providers change.

## Code gap to fix (separate task)

The bot and Onboarding Mini App show a consent line that says *"I accept the
service terms and privacy policy"*, but **only the Privacy Policy is actually
linked** — there is no link to `/terms` anywhere:

- [apps/bot/src/handlers/onboarding/consent.ts](../apps/bot/src/handlers/onboarding/consent.ts) — only `PRIVACY_POLICY_URL` is defined.
- [apps/webapp/src/onboarding.tsx](../apps/webapp/src/onboarding.tsx) — same.

To properly record acceptance of the Terms, add a `TERMS_OF_SERVICE_URL`
(`https://gennety.com/terms`) and surface it alongside the Privacy Policy link in
both surfaces (and in the consent i18n copy).
