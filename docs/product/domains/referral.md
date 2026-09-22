<!-- WHEN_TO_READ: You are working on the referral program ('Пригласи друга') — invite links, attribution, rewards, or where the invite CTA may appear. -->
<!-- SOURCE: REFERRAL_PRODUCT_SPEC.md (moved 2026-09-01); reward model rewritten 2026-09-22 (tickets only) -->

# Gennety Referral — Product Specification

> Feature spec for the referral program ("Give a date, get a date").
> Product invariants live in [PRODUCT_SPEC.md](../product-spec.md); architecture in
> [ARCHITECTURE.md](../../architecture/overview.md); deploy/runbook in [deploy.md](../../operations/deployment-runbook.md).
> Code, tests, and Prisma remain the source of truth for local mechanics.

## Overview

A referral program layered on the existing Date Ticket wallet. Gated by
`REFERRAL_FEATURE_ENABLED` (default **off**, and off in production — founder
decision 2026-07-25). It pays in **Date Tickets only** and rides the already-on
`TICKET_FEATURE_ENABLED`. Both surfaces: Telegram (full auto-attributed flow)
and iOS (`/v1/me/referral*`).

**Never Premium (founder decision 2026-09-22).** Until then the program also
granted complimentary Premium months (a welcome month to the invitee, a
tickets + months ladder to the referrer). That cannibalised recurring revenue —
a Premium subscriber stops needing tickets — and priced the program in money
(every rung showed a dollar value). Both are gone: the only unit of reward is a
ticket, no referral surface shows a price, and no referral code path may call
the Premium grant. The decision journal entry of 2026-09-22 has the full
reasoning.

**Killer angle.** A ticket **is** a real date, and matching is same-city — so
every verified friend also grows the local pool that decides whether the
referrer themselves gets matched. *"Give a date, get a date."*

## Reward model

- **Trigger = verification.** Nothing is paid until the invited friend is a
  member matching could serve: `verificationStatus='verified'`, onboarding
  finished, and a verified track contact (A13-M18). Neither account may be
  banned, suspended or under investigation.
- **Referrer** — `REFERRAL_TICKETS_PER_FRIEND` (default **1**) ticket per
  verified friend, for at most `REFERRAL_MAX_REWARDED_FRIENDS` (default **20**)
  friends in a lifetime. Friends past the cap still count toward the tally and
  still pay their own side — the referrer just earns nothing more.
- **Invitee** — `REFERRAL_INVITEE_TICKETS` (default **1**) ticket, credited at
  the same moment and in the same transaction as the referrer's. Not at
  onboarding: a pre-verification ticket would pay farmed accounts.
- **Daily velocity cap** — `REFERRAL_DAILY_REWARD_CAP` (default 3): the 4th
  friend counted for one referrer within 24h has the referrer's ticket **held**,
  not denied. It is released automatically once the window allows (see below).
  The invitee's own ticket is never held.

## Mechanics

- **Attribution.** A referrer shares `t.me/<bot>?start=referral_<referrerUserId>`;
  the invitee's first-touch `User.referralSource` is canonicalized to
  `referral:<referrerUserId>` (`referralSourceFromParam`, in `handlers/start.ts`
  and the Mini-App `startapp` source, and `POST /v1/me/referral/claim` on iOS).
  First-touch only — never overwritten.
- **Settlement** (`services/referral.ts`, `grantReferralRewardsForVerifiedInvitee`),
  called by the verification pipeline on `verified` (best-effort, wired through
  `PipelineDeps.settleReferralReward`, exactly-once across every path). After
  the eligibility and self-referral checks (by id and by shared verified
  phone), ONE transaction:
  1. counts the invitee once (CAS on `User.referralCountedAt`);
  2. looks the invitee's proven identities up in `referral_identities` — a hit
     means the same person was counted before under a deleted account, so the
     row is recorded as `duplicate`: nobody is paid and the tally does not move;
  3. otherwise bumps `User.referralVerifiedCount` (this takes the referrer's row
     lock, so concurrent friends of one referrer decide their slots in turn and
     the lifetime cap cannot be overshot) and decides the referrer side:
     `capped` (no slot left) → `held` (over the 24h cap) → `credited`;
  4. writes the `ReferralQualification` row and the identity hashes;
  5. credits the tickets through `grantTicketsInTx` — `reason: "referral_reward"`,
     unique `externalPaymentId` `referral:<qualificationId>:referrer|invitee`.
  After commit the referrer gets a DM / APNs push (`services/referral-notify.ts`)
  when their ticket actually landed, and a structured `referral_ticket_earned`
  log line records every credit.
- **Held rewards** (`releaseHeldReferralRewards`). Once the referrer is back under
  the cap, every `held` row is credited — a CAS on the row's status plus the
  unique ledger key make it exactly-once. Runs when the referrer opens the
  referral screen (both surfaces) and in the hourly sweep
  (`sweepHeldReferralRewards`) for referrers who never do.
- **Invite screen for the invitee.** The Telegram onboarding shows a screen
  (second-to-last, before the AI-memory choice) telling the invitee they get a
  ticket once they pass verification. `POST /v1/telegram-onboarding/referral-gift`
  only marks it seen (`User.referralGiftSeenAt`) — it grants nothing. Hidden
  when a promo code owns the attribution or `REFERRAL_INVITEE_TICKETS` is 0.

## Anti-fraud

- The `verified` + registered + proven-contact gate is the primary throttle:
  every rewarded friend needs a real phone or email and a real face passing
  liveness.
- **Identity tombstone** (`referral_identities`): HMAC-SHA256 of each proven
  identity (positive Telegram id, verified phone, verified email) under a key
  derived from `JWT_SECRET` with its own label (`keyedIdentitiesOf`,
  `services/safety-tombstone.ts`). Rows hang off `referral_qualifications`,
  whose account links are `SET NULL`, so they outlive account deletion — delete
  and re-register is recognised. Without `JWT_SECRET` (local runs) no identity
  is recorded or checked.
- Lifetime cap per referrer, 24h velocity cap that holds rather than denies,
  self-referral block, and blocked-status checks on both sides.
- **Not done, deliberately (decision 2026-09-22):** device fingerprinting
  (Telegram exposes no device id, and iOS has no invite-claim path yet — revisit
  DeviceCheck when it does) and cross-account face de-duplication (a Rekognition
  collection; privacy and cost).

## Where the invite may appear

Only at **ticket bottlenecks** and the program's own hub — **never on a Premium
funnel** (founder decision 2026-09-22; reverses the 2026-08-08 "five paying
surfaces" rule):

| Surface | Telegram | iOS |
|---|---|---|
| Ticket gate (after the mutual "yes") | chip "Invite a friend · earn a ticket", empty wallet only | chip on the gate when the wallet is short |
| Ticket store | chip, always while the program is on | chip, always while the program is on |
| Referral hub | menu row → `referral.html` | Settings row |
| Premium sales screen, venue board (locked venue, pay step) | **never** | **never** |

`VenueBoardState.referralEnabled` is kept in the contract (shipped iOS builds
require it) but is always `false`.

## Surfaces

- **Telegram.** Menu row "🎁 Invite a friend" opens the referral Mini App
  directly (feature-gated) — no title/tagline message first (2026-08-29). The
  callback path (`menu:referral` → `handleReferralHub`) still exists as the
  fallback when `WEBAPP_URL` isn't a real HTTPS host (dev without a tunnel).
  Once open: the referral Mini App (`referral.html`) shows the rule (+N for you,
  +N for your friend), friends verified, tickets earned, tickets on the way,
  and rewards left of the cap — no money anywhere — and a one-tap **share**
  (`POST /v1/referral/share-message` mints a `savePreparedInlineMessage` →
  `WebApp.shareMessage`) that forwards a branded invite card
  (`services/referral-card`, satori→resvg→JPEG; degrades to a rich text article
  if the render fails). The public HMAC-signed `GET /v1/referral/card` serves
  the card Telegram fetches; its gift line promises the invitee's ticket.

  **The share hands Telegram bytes that already exist.** Telegram downloads
  `photo_url` on its own servers, under its own deadline, and keeps whatever
  arrived — so `/share-message` renders and caches the exact JPEG *before*
  minting the URL, and only offers the photo result once those bytes exist
  (otherwise the text-article fallback). The card is JPEG rather than PNG both
  because the Bot API requires it and because it is ~5× smaller, and the URL
  carries a content fingerprint (`v`, including `CARD_REVISION`) because
  Telegram caches media by URL.
- **iOS.** `GET /v1/me/referral` (`ReferralState`) + `POST /v1/me/referral/claim`
  (attribute by code), JWT-authed; `features.referral` in `GET /v1/app/config`.
  Reward-on-verify is platform-agnostic.

## Data

- `User.referralVerifiedCount` (referrer tally), `referralCountedAt`
  (invitee-side once-marker), `referralGiftSeenAt` (invite screen seen; column
  `referral_invitee_premium_at`, kept from the retired welcome-Premium marker).
- `referral_qualifications` — one row per counted invitee (status, both sides'
  ticket amounts, `credited_at`); `referral_identities` — the tombstone hashes.
  Migration `20260922120000_referral_ticket_rewards` (additive).
- Tickets in `ticket_ledger` with `reason: "referral_reward"`. Legacy rows from
  before 2026-09-22 carry `referral_milestone` (tickets) or
  `subscription_ledger.provider = "referral"` (Premium) — none exist in
  production, where the program was never switched on.

## Env

`REFERRAL_FEATURE_ENABLED` (default off), `REFERRAL_TICKETS_PER_FRIEND` (1),
`REFERRAL_INVITEE_TICKETS` (1; 0 turns the invitee side and its screen off),
`REFERRAL_MAX_REWARDED_FRIENDS` (20; always ≥ 1), `REFERRAL_DAILY_REWARD_CAP`
(3; 0 turns the velocity cap off). `REFERRAL_LADDER` and
`REFERRAL_INVITEE_PREMIUM_MONTHS` are retired and ignored. Rides `BOT_USERNAME`
(invite link), `PUBLIC_BASE_URL` (card URL) and `JWT_SECRET` (identity
tombstone). Rollback: flip the flag off; the tables may stay.

## Invariants preserved

No user-to-user chat, blind-decision, mandatory verification, and the ticket
ledger exactly-once guarantee are all unaffected — referral only reads
attribution and writes idempotent reward rows through the wallet. Premium and
its subscription boundary are untouched by the program.
