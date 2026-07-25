# Gennety Dating — Promo Codes (independent campaign links)

> Product-invariants + implementation contract for the **independent promo-code**
> program. A sibling of the Referral program (`services/referral.ts`) but with a
> campaign-owned reusable code and a richer, visually distinct welcome gift.
> Feature-flagged by `PROMO_FEATURE_ENABLED` (default **off** → every path is a
> no-op). Code, tests, and Prisma remain the source of truth for local mechanics.

## What it is

A promo link carries an **independent promo code** (not tied to any referrer) so
ad bulletins, promo materials, and campaigns can hand a new user a bonus:

- **1 free Date Ticket** + **3 months of Gennety Premium** (both per-code
  configurable; these are the launch defaults).

The bonus is confirmed to the user on a **distinct, richer wow screen** (the
onboarding Mini App's second-to-last screen on Telegram; a native confirmation
screen on iOS) — "Status confirmed · Promo active · Subscription activated",
plus an explicit "🎟 1 free Date Ticket" and "✨ 3 months Premium" line. It is
deliberately *more* than the referral welcome screen (which grants only 1 month
and no ticket), so it renders differently.

## Locked product decisions

| Dimension | Decision |
|---|---|
| Code shape | **One reusable code per campaign** (`maxRedemptions` cap + `expiresAt`) |
| Grant timing | **Immediately at the onboarding wow screen** (mirrors invitee-Premium) |
| Audience | **New users only** — first-touch attribution, never existing users |
| iOS delivery | **Custom Apple-native deferred deep link** (clipboard + coarse server-side fingerprint); no external attribution SDK |
| Manual fallback | **None (auto only)** — behind an emergency `PROMO_MANUAL_ENTRY_ENABLED` seam, default off |
| Code management | **CLI / seed script** (`scripts/promo-codes.mjs`) |

### iOS attribution reliability caveat

Apple does not pass a parameter through App Store install. The custom
clipboard + fingerprint mechanism is **best-effort** (a real miss rate exists).
With no manual fallback, a new iOS user whose attribution misses **silently
loses** the bonus. `PROMO_MANUAL_ENTRY_ENABLED` (default `false`) is a
pre-wired escape hatch that surfaces a tiny "Have a promo code?" field in
onboarding (both clients) if the miss rate proves painful — flip one flag, no
rewrite.

## Core invariants

- **First-touch, new users only.** A promo code is recorded as
  `User.referralSource = "promo:<CODE>"` on the user's creating touch (Telegram
  `start`/`startapp` param, or the iOS deferred-attribution claim at consent).
  It never applies to an already-created user.
- **Mutually exclusive with Referral.** `referralSource` holds a single
  first-touch value. `parseReferrer()` returns null for `promo:*`, so referral
  rewards no-op for a promo-attributed user; `parsePromoCode()` returns null for
  `referral:*`. Whichever link the user arrived through wins.
- **Exactly-once.** Ticket + Premium are each granted once per (code, user) via
  unique ledger `externalPaymentId`s (`promo:<codeId>:<userId>`); a
  `PromoRedemption` row (unique `userId`) plus a `redeemedCount++` commit in one
  transaction, so replays and races can neither double-grant nor overrun the
  cap.
- **Grant is contact-gated for free.** The wow screen runs *after* the
  onboarding contact gate (unique verified phone / verified email), so farming
  the reward needs fresh phone numbers — the same barrier the referral program
  relies on. Codes additionally carry `active`, `expiresAt`, and
  `maxRedemptions`.
- **No-op when off.** Everything is inert unless `PROMO_FEATURE_ENABLED`.

## Data model (Prisma, additive)

- `PromoCode` — `code` (unique, uppercase), `ticketReward` (default 1),
  `premiumMonths` (default 3), `maxRedemptions` (nullable = unlimited),
  `redeemedCount` (materialized), `expiresAt`, `active`, `note`.
- `PromoRedemption` — `promoCodeId`, `userId` (unique — one code per human),
  `redeemedAt`, `ticketsApplied`, `monthsApplied`; `@@unique([promoCodeId, userId])`.
- `User.promoRedeemedAt` — show-once wow-screen marker + guard.

Rewards land in the existing ledgers: `ticket_ledger` (reason `promo`) and
`subscription_ledger` (provider `promo`).

## Services

`services/promo.ts` (sibling of `services/referral.ts`):

- `parsePromoCode(referralSource)` — `promo:<CODE>` (+ legacy `tg:promo_<CODE>`,
  `tg-mini:promo_<CODE>`).
- `promoSourceFromParam(param, channelPrefix)` — `promo_<CODE>` → `promo:<CODE>`;
  anything else keeps ordinary channel attribution.
- `resolvePromoCode(code)` — load + validate (active, not expired, capacity left).
- `grantPromoRewardsForUser(userId)` — the wow-screen grant. Idempotent,
  no-op when off / not a valid promo attribution / already redeemed. Transaction
  claims the redemption (unique + counter), then grants ticket + Premium months
  each exactly-once, then stamps `promoRedeemedAt`.

## Surfaces

- **Telegram.** `t.me/<bot>?start=promo_<CODE>` (+ `startapp`) → attribution at
  user creation. Wow screen at onboarding step 2-from-last via
  `POST /v1/telegram-onboarding/promo-gift`; `serializeState` exposes
  `promoActive` / `promoGiftSeen` / `promoCode` / `promoTickets` / `promoMonths`
  (takes precedence over the referral welcome screen).
- **iOS.** Landing `GET /promo/:code` copies `GENNETY:<CODE>` to the clipboard
  and records a coarse-fingerprint `PromoAttribution` (TTL
  `PROMO_ATTRIBUTION_TTL_MIN`), then redirects to the App Store. First launch
  reads the clipboard and/or calls `POST /v1/promo/claim-deferred` (fingerprint
  match) → attribution at consent. Native wow screen calls
  `POST /v1/me/promo/claim` (JWT, idempotent) → `grantPromoRewardsForUser`.
  `openapi/gennety-v1.yaml` + `Gennety-iOS/IMPLEMENTATION_PLAN.md` updated in the
  same change.

## Management

`scripts/promo-codes.mjs` (writes to `DATABASE_URL`, mirrors
`scripts/seed-venues.mjs`):

```
pnpm promo:create  --code=SUMMER3M --tickets=1 --months=3 --max=500 --expires=2026-09-01 --note="IG campaign"
pnpm promo:disable --code=SUMMER3M
pnpm promo:stats   --code=SUMMER3M
```

The model is already admin-API-shaped, so a dashboard tab is a later,
non-breaking phase.

## Config

`PROMO_FEATURE_ENABLED` (master, default off), `PROMO_DEFAULT_TICKETS` (1),
`PROMO_DEFAULT_PREMIUM_MONTHS` (3), `PROMO_ATTRIBUTION_TTL_MIN` (60),
`PROMO_MANUAL_ENTRY_ENABLED` (default off — emergency manual-entry seam).

## Rollout

Additive `db:push` (new tables + `users.promo_redeemed_at`) → deploy code →
deploy Mini App (`onboarding.html` with the new screen) → create the first code
via CLI → flip `PROMO_FEATURE_ENABLED=true`. Rollback = flag off; additive
tables/columns may stay.
