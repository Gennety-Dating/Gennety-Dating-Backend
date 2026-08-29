# Gennety Referral — Product Specification

> Feature spec for the referral program ("Give a date, get a date").
> Product invariants live in [PRODUCT_SPEC.md](PRODUCT_SPEC.md); architecture in
> [ARCHITECTURE.md](ARCHITECTURE.md); deploy/runbook in [deploy.md](deploy.md).
> Code, tests, and Prisma remain the source of truth for local mechanics.

## Overview

A referral program layered on the existing Date Ticket wallet + Gennety Premium
entitlement. Gated by `REFERRAL_FEATURE_ENABLED` (default **off**); it pays
rewards in Date Tickets **and** complimentary Premium months, so it rides the
already-on `TICKET_FEATURE_ENABLED` + `PREMIUM_FEATURE_ENABLED`. Both surfaces:
Telegram (full auto-attributed flow) and iOS (referral code via `/v1/me/referral*`).

**Killer angle.** A ticket **is** a real date, and matching is same-city — so
every verified friend also grows the local pool that decides whether the
referrer themselves gets matched. The reward is framed as *"Give a date, get a
date."*

## Reward model

- **Trigger = verification.** The referrer is paid only when an invited friend
  reaches `verificationStatus='verified'` — the same anti-fraud gate (Persona
  liveness + `phone @unique`) that admits a user to matching. The reward
  condition IS the "this is a real, matchable human" condition; no separate
  anti-fraud is needed.
- **Invitee** — a fixed **1 month of Gennety Premium**
  (`REFERRAL_INVITEE_PREMIUM_MONTHS`), granted + active immediately at a wow
  screen shown as the **second-to-last screen** of the first onboarding Mini App
  (right before the AI-memory choice). Granting pre-verification is safe:
  Premium's only benefit (venue-change) needs a *scheduled date*, so it is
  practically worthless until the invitee verifies and matches.
- **Referrer** — a **milestone ladder** (`REFERRAL_LADDER`, default
  `1:1:1,3:1:1,5:1:1,10:2:2` = `count:ticketsDelta:monthsDelta`). Cumulative
  totals unlocked at each rung, with the dollar value shown in the Mini App
  (`$6.99`/ticket + `PREMIUM_PRICE_USD_DISPLAY`/month):

  | Verified friends | Total tickets | Total Premium months | ≈ $ value ($17.99 Premium) |
  |---|---|---|---|
  | 1 | 1 | 1 | $24.98 |
  | 3 | 2 | 2 | $49.96 |
  | 5 | 3 | 3 | $74.94 |
  | 10 | 5 | 5 | $124.90 |

## Mechanics

- **Attribution.** A referrer shares `t.me/<bot>?start=referral_<referrerUserId>`;
  the invitee's first-touch `User.referralSource` is canonicalized to
  `referral:<referrerUserId>` (`referralSourceFromParam`, in `handlers/start.ts`
  and the Mini-App `startapp` source, and `POST /v1/me/referral/claim` on iOS).
  First-touch only — never overwritten.
- **Settlement** (`services/referral.ts`). On `verified`, the verification
  pipeline calls `grantReferralRewardsForVerifiedInvitee` (best-effort, wired
  through `PipelineDeps.settleReferralReward` + the pull/rerun short-circuit, so
  it is exactly-once across every path and covers mobile invitees). It:
  1. resolves the referrer (`parseReferrer`), bails on self-referral (by id or
     shared verified phone) and banned/suspended/under-investigation referrers;
  2. counts the invitee once (CAS on `User.referralCountedAt`) and increments
     `User.referralVerifiedCount`;
  3. applies the **velocity guard** (`REFERRAL_DAILY_REWARD_CAP`, default 3): if
     the referrer had more than the cap of invitees counted in the last 24h,
     rewards are **held** (not denied) — self-healing rungs settle on the next
     under-cap event or a Mini-App reconcile;
  4. settles every reached-but-unpaid rung idempotently
     (`reconcileReferrerRungs`) — tickets via `grantTickets`
     (`reason: "referral_milestone"`), Premium via
     `grantComplimentaryPremiumMonths`, each exactly-once via a unique ledger
     `externalPaymentId` (`referral-rung:<ref>:<atCount>:{tickets,premium}`);
  5. DMs / APNs-pushes the referrer (`services/referral-notify.ts`) when
     something was newly credited (with the gift message-effect).
- **Complimentary Premium** (`grantComplimentaryPremiumMonths`, `services/premium.ts`).
  Additive (extends `premiumUntil` from `max(now, premiumUntil)`), and
  DELIBERATELY does **not** touch `premiumAutoRenew` / `premiumProvider` /
  `premiumExternalId` — a comp must never masquerade as a renewing subscription
  or clobber a real recurring anchor. Exactly-once via unique `externalPaymentId`.
- **Invitee gift** (`grantInviteePremium`). One-time Premium month for a
  genuinely-invited user, idempotent via `referral-invitee-premium:<inviteeId>`
  + the `User.referralInviteePremiumAt` once-marker (drives "show the wow screen
  once").

## Anti-fraud (velocity guard)

Launched while Persona is sandbox (`ALLOW_SANDBOX_PERSONA`), so a temporary
guard supplements the real moat (`phone @unique` + Persona `verified`):
self-referral block (by id + shared phone), a per-referrer 24h reward cap that
holds rather than denies, and structured logging of every grant. The `verified`
gate remains the primary throttle — farming rewards requires a real phone + a
real face passing liveness per invitee.

## Surfaces

- **Telegram.** Menu row "🎁 Invite a friend" opens the referral Mini App
  directly (feature-gated) — no title/tagline message first (2026-08-29):
  `referral.html` already renders the ladder itself, so a message repeating
  that one tap earlier bought nothing (the same reasoning §3.8 applies to
  Premium's own menu row). The callback path (`menu:referral` →
  `handleReferralHub`) still exists as the fallback when `WEBAPP_URL` isn't a
  real HTTPS host (dev without a tunnel), since Telegram rejects a non-HTTPS
  `web_app` button outright.
  Once open: the referral Mini App (`referral.html`) shows the milestone
  ladder with $ values,
  and a one-tap **share** (`POST /v1/referral/share-message` mints a
  `savePreparedInlineMessage` → `WebApp.shareMessage`) that forwards a branded
  invite card (`services/referral-card`, satori→resvg→JPEG; degrades to a rich
  text article if the render fails). The public HMAC-signed
  `GET /v1/referral/card` serves the card Telegram fetches.

  **The share hands Telegram bytes that already exist.** Telegram downloads
  `photo_url` on its own servers, under its own deadline, and keeps whatever
  arrived — so `/share-message` renders and caches the exact JPEG *before*
  minting the URL, and only offers the photo result once those bytes exist
  (otherwise the text-article fallback). The card is JPEG rather than PNG both
  because the Bot API requires it and because it is ~5× smaller, and the URL
  carries a content fingerprint (`v`) because Telegram caches media by URL.
  Until 2026-08-03 none of that held: the endpoint re-rendered per request
  (seconds, cold) and pushed a ~453 KB PNG down a stable URL, so a slow fetch
  delivered a *partially decoded* card — a PNG decodes top-down, so the
  recipient saw a strip of the top and blank beneath — and Telegram's per-URL
  cache made that permanent for that referrer.
- **iOS.** `GET /v1/me/referral` (ladder state) + `POST /v1/me/referral/claim`
  (enter a referral code), JWT-authed; `features.referral` in `GET /v1/app/config`.
  Reward-on-verify is platform-agnostic.

## Data (additive)

- `User.referralVerifiedCount` (referrer tally), `referralCountedAt`
  (invitee-side once-marker), `referralInviteePremiumAt` (invitee-gift marker).
- Rewards reuse `ticket_ledger` (`referral_milestone`) and `subscription_ledger`
  (`provider: "referral"`) — no new tables.

## Env

`REFERRAL_FEATURE_ENABLED` (default off), `REFERRAL_INVITEE_PREMIUM_MONTHS` (1),
`REFERRAL_LADDER` (`1:1:1,3:1:1,5:1:1,10:2:2`), `REFERRAL_DAILY_REWARD_CAP` (3).
Requires `db:push` of the three additive `User` columns and a redeployed Mini
App bundle (`referral.html`). Rides `BOT_USERNAME` (invite link) +
`PUBLIC_BASE_URL` (card URL). Rollback: flip the flag off; columns may stay.

## Invariants preserved

No user-to-user chat, blind-decision, mandatory verification, and the ticket /
Premium ledger exactly-once guarantees are all unaffected — referral only reads
attribution and writes idempotent reward rows through the existing wallet /
entitlement services.
