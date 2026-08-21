# Gennety Rematch — Product Specification

> **Version:** 1.1 (2026-07-26 — implemented; reconciled with the shipped code).
> Feature-flagged (`REMATCH_FEATURE_ENABLED`, default **off**). Telegram-only in
> v1 (explicit, recorded decision — see *Two clients*). Product invariants live in
> [PRODUCT_SPEC.md](PRODUCT_SPEC.md) §3.11; architecture in
> [ARCHITECTURE.md](ARCHITECTURE.md); deploy in [deploy.md](deploy.md).
>
> **Implementation map:** `services/rematch.ts` (eligibility, candidate, framing,
> run), `services/rematch-refund.ts` (refunds + hourly sweep),
> `handlers/matching/rematch.ts` (offer card + invoice mint),
> `handlers/payments.ts` (`rematch:v1` pre-checkout + settle trust boundary).

## Overview

**Rematch** is a paid, on-demand re-run of the matching engine for **one man**,
priced at **$2.99** (Telegram Stars). It answers the two moments where the
weekly cadence hurts most:

- the Thursday batch left him unpaired ("no match this week"), or
- he got a match and it went nowhere (he declined, she declined, both ghosted,
  the pair never agreed on a time).

Rather than waiting another week, he pays once and the matchmaker runs again
for him alone.

**The core asymmetry.** Rematch is *bought* only by men. Women never buy it,
never see a price, and never opt in — a woman simply becomes the **candidate**
of a man's rematch run and receives an ordinary match pitch wrapped in **gift
framing**: the agent worked harder for her this week. This is what makes the
feature a monetization lever on one side and a retention gift on the other,
from a single code path.

**Rematch is not a new algorithm.** `findCandidatesFor()`
([match-engine.ts:955](apps/bot/src/services/match-engine.ts#L955)) is already a
single-seeker rematch engine: same candidate SQL, same multi-factor re-rank as
the weekly batch. Rematch is *orchestration* around it — payment, eligibility,
limits, framing — not new matching logic. Everything below inherits the existing
invariants for free.

## Founder decisions (2026-07-25)

| # | Decision | Consequence |
|---|---|---|
| **D1** | **Refund only when the engine finds nobody.** Payment buys an introduction, not a date. | A decline, a ghost, or a failed negotiation is **not** refunded. Stated in the offer copy *before* payment. |
| **D2** | **Rematch ≠ Date Ticket.** | The $6.99 §3.5b ticket gate still applies normally after mutual accept. `ticket-gate.ts` is untouched. |
| **D3** | **2 paid rematches per rolling week, 24 h cooldown between them.** | Caps pool burn and revenue-per-man alike. |
| **D4** | **Pain-triggered CTA only — no permanent main-menu row.** | The button appears in the no-match DM and after a terminal failed match. The product never looks like a shop. |

## Eligibility — who may buy

All of these are re-validated **server-side at `successful_payment`**, not just
at button-render time:

1. `REMATCH_FEATURE_ENABLED` is on.
2. `User.gender = male` (v1 is male-only by design).
3. `User.status = 'active'`, `onboardingStep = 'completed'`,
   `verificationStatus` admits matching (§1.4 cohort rules).
4. **No live match** — nothing in `proposed` / `negotiating` /
   `negotiating_venue` / `scheduled`. This preserves the single-live-match
   invariant (§3.2) and the blind-decision invariant: he can never run two
   women in parallel.
5. Limits (D3): `< REMATCH_MAX_PER_WEEK` settled purchases in the trailing 7
   days, and `>= REMATCH_COOLDOWN_HOURS` since his last settled rematch.
6. **Not inside the pre-batch blackout** — see *Risks → batch cannibalization*.

A woman is never eligible to buy; the entry points are simply not rendered for
her, and the payment handler refuses + refunds if one is somehow reached.

## Which pairs we actually analyze

`findRematchCandidate(userId)` wraps `findCandidatesFor(userId, 1)` and takes
its **top-1**. That inherited filter set is the whole safety story:

| Inherited from the engine | Why it matters for rematch |
|---|---|
| **Lifetime pair ban** (§3.2 rule 6) | He can **never** be re-shown a woman he already saw — including the one he just declined. This is what makes "rematch" mean *someone new*, automatically. |
| **Single-live-match** (§3.2 rule 8) | Candidates currently in a live match are excluded, so a rematch cannot poach a woman mid-date-planning. |
| **24 h candidate cooldown** (`MATCH_COOLDOWN_MS`) | Deliberately **kept** for rematch. It has a happy side effect: right after the Thursday batch the only available women are exactly the **unpaired** ones — precisely the cohort the famine gift is meant for. Relaxing it would let a rematch grab a woman who was matched an hour ago. |
| Same `homeCityKey`, verified contact rail, `embeddingDirty = false`, active + verified | Rematch users get the same quality floor as the weekly batch; no "we lowered the bar because he paid". |

**Rematch-specific filter added on top:** exclude any candidate who already
received a rematch-sourced pitch within `REMATCH_GIFT_CAP_DAYS` (default 7) —
see *Risks → woman burnout*.

Ranking is unchanged: `V_explicit`, `V_research`, `V_league` (with
`MALE_REACH_ELO`), `V_agePref`, `V_type`, minus `V_penalty`, plus
`starvationBonus`. **No score boost is bought.** A paid rematch buys *a run*,
not a better league.

## The gift framing (her side)

She receives an ordinary `proposed` match — same pitch stream, same match/photo
cards, same conversational decision (§3.3), same 24 h TTL. Only the **lead-in
sentence** differs, chosen by `pickGiftFraming(womanId)` from her own recent
state:

| Framing | Condition | Message intent (her language, 5 locales) |
|---|---|---|
| `famine` | She has a `NoMatchNotice` for the current drop cycle, or was eligible-but-unpaired in the latest batch | "We kept looking after this week's round — and found someone genuinely interesting for you." |
| `failed` | Her most recent match (within `REMATCH_FAILED_LOOKBACK_DAYS`) ended `cancelled` / `expired` | "We saw the last one didn't work out. We'd like to introduce someone we think fits you well." |
| `neutral` | Neither applies | A warm "our matchmaker kept working this week" line. |

**Hard copy rules** (these are trust boundaries, not style preferences):

- Never state or imply that anyone **paid** for this introduction.
- Never reveal the man's decision state (blind-decision invariant, §3.4).
- Never use the word "rematch" or expose that this came from a purchase flow.
- Never promise more than the ordinary weekly cadence promises.

The framing is a **prefix on her pitch**, not a separate DM, so the pitch stream
and the decision question stay exactly as they are today.

## Payment flow — the ordering problem

The one genuinely dangerous failure is *taking money and delivering nothing*.
The flow is therefore **check → pay → re-check → deliver-or-refund**:

1. **Render-time pre-check.** The CTA button is only shown if a dry run of
   `findRematchCandidate()` returns a candidate **and** limits pass. This makes
   "paid into an empty pool" rare rather than routine.
2. **Invoice.** `createInvoiceLink` with `currency: "XTR"`,
   `REMATCH_STARS` (default **150** ⭐ ≈ $2.99, consistent with the existing
   150⭐ venue-change price), payload **`rematch:v1`**. The payer is taken from
   `ctx.from` — the same shape as `sub:premium`, which also carries no per-user
   data in the payload.
3. **`pre_checkout_query`** re-validates payload shape + Star amount inside
   Telegram's 10 s window (it deliberately does **not** re-run the engine — too
   slow for the window).
4. **`successful_payment` is the trust boundary.** In order:
   a. Insert `RematchPurchase` as `processing`, keyed by unique
      `externalPaymentId` = `telegram_payment_charge_id`. A unique violation
      means Telegram redelivered → no-op (exactly-once, same pattern as
      `TicketLedger`). Writing **before** the run means a crash mid-run still
      leaves a durable record that money moved — the hourly sweep refunds rows
      left in `processing` past `REMATCH_PROCESSING_STALE_MS` (5 min), mirroring
      how an abandoned `gate_payment` ticket row is swept.
   b. Re-validate **every** eligibility rule from above (a reusable invoice link
      can be opened twice, and state can change between steps).
   c. Run `findRematchCandidate()`.
   d. **Found** → `createProposedMatch(man, woman, breakdown)` → stamp
      `Match.source = 'rematch'` → `dispatchMatches(api, [matchId])` → mark the
      purchase `settled` with `resultMatchId`.
   e. **Not found / no longer eligible** → `api.refundStarPayment(...)` → mark
      `refunded_no_candidate` / `refunded_ineligible` → honest DM: we could not
      find anyone right now, your Stars were returned.
   f. **Refund call itself failed** → mark `refund_failed` and leave it to the
      durable retry sweep (below). We never announce a refund that did not
      happen — the same rule `ticket-expiry` already follows.
   g. **Found, but the pitch reached NEITHER side** (added 2026-08-21) →
      `dispatchMatches` reports the match in `undelivered` (its
      `disposeUndeliveredMatch` has already retired the pair, §3.3) → refund →
      mark `refunded_undelivered`. He paid for an introduction nobody was shown,
      which is a stronger refund claim than an empty pool. **One side reached is
      NOT this case** — that is a delivered pitch and is never refunded, even
      though the dispatch reports `failed`. Nor is a queue that *threw*: delivery
      is then unknown, and reversing a charge for a card the partner may be
      reading is the one error this rail must not make.

**Refund retry.** A small hourly worker (`workers/rematch-refund-retry.ts`,
registered only when `REMATCH_FEATURE_ENABLED`, mirroring how `ticket-expiry` is
registered only under `TICKET_FEATURE_ENABLED`) retries `refund_failed` rows and
DMs the user once the refund actually lands.

## Data model (additive)

**`Match`** — two new columns:

- `source String @default("weekly") @map("source")` — `weekly` | `rematch`,
  whitelist-validated in app code (repo convention: string sub-states, not
  Prisma enums — like `ticketStatus`, `venueChangeStatus`, `coordMethod`).
  Rematch matches are excluded from algorithm-quality analytics so the weekly
  scoring A/B is not polluted by on-demand runs.
- `rematchPaidById String? @map("rematch_paid_by_id")` — the buyer, for support
  and founder-feed context.

**`rematch_purchases`** — new append-only audit model (the `ticket_ledger`
pattern):

| Column | Purpose |
|---|---|
| `id`, `userId`, `createdAt` | Buyer + when. `@@index([userId, createdAt])` backs the D3 limit query. |
| `externalPaymentId` **unique** | `telegram_payment_charge_id` — exactly-once settle **and** the key `refundStarPayment` needs later. |
| `status` | `processing` \| `settled` \| `refunded_no_candidate` \| `refunded_ineligible` \| `refunded_undelivered` \| `refund_failed`. `@@index([status, createdAt])` backs the sweep. Only `settled` consumes D3 quota — a refunded run delivered nothing, so it must not cost an attempt, and that falls out for free: flipping off `settled` frees the weekly cap in the same write that returns the Stars. |
| `amountStars`, `amountCents` | Frozen price at purchase time (prices are env-tunable). |
| `resultMatchId` | The delivered match, when settled. |
| `framing` | Which gift framing her pitch used — for copy A/B later. |
| `resolvedAt`, `refundError` | Retry bookkeeping. |

`onDelete: Cascade` from `users`. **No `User` columns are added** — limits are
derived from these rows, so there is no counter to drift.

## Surfaces (D4 — pain-triggered PUSH, plus two pull entries)

> **Amended 2026-08-09.** D4 said "pain-triggered CTA only — no permanent
> main-menu row", and the second half is still true: there is no menu row, and
> the product still never looks like a shop. What the rule accidentally also
> forbade was *asking*. With the DM as the only surface, a man who wanted a
> rematch and had let the message scroll away had no way to reach it — the
> honest answer the playbook told the agent to give was "wait for it to appear
> again", i.e. wait to be disappointed. Entries 3 and 4 close that without
> reopening the shop: neither is a menu row, neither is permanent, and both are
> gated on him actually being able to buy right now.
>
> **Both land on the offer card, never the invoice.** He arrived under his own
> steam and has not seen a price, so the card — which states the terms and the
> price — is the step that introduces one. Only its button mints the invoice.
> Same rule §3.8 applies to the Premium hub.

> **Amended 2026-08-20 — the offer is a rendered card, and the search is
> visible.** Two additions, neither of which changes who is offered what:
>
> - The offer DM leads with a PNG (`services/rematch-card.ts`) carrying the
>   existing copy as its caption and the same buy button. One card for all three
>   variants: the caption says what HAPPENED, the card says what is OFFERED, and
>   the motif is abstract because at offer time nobody has been picked yet. It
>   carries no price (env-owned, and a PNG goes stale silently) and no
>   `protect_content` (no face on it). Every failure — an over-long caption, a
>   null render, a rejected `sendPhoto` — degrades to the exact plain text that
>   shipped before, because this DM is the only way the feature is reached at
>   all.
> - Settlement plays a ≥10s `<tg-thinking>` search animation over the engine
>   run (`rematchSearchSteps`, `NEVER_CUT_SHORT`), including before a refund.
>   Full reasoning in PRODUCT_SPEC §3.11.

1. **No-match DM** (Thursday 18:15, `no-match-notifier.ts`) — the offer follows
   as its **own** short DM rather than being folded into the no-match message.
   That message is a deliberately short, empathetic rich stream (§3.1); bolting a
   price onto it would undercut the empathy and complicate a carefully-tuned
   primitive. Variant: `famine`.
2. **Terminal failed match** — variant `failed`, fired from
   `offerRematchAfterCancellation` at every point a match dies without a date:
   - **an explicit decline** (`handlers/matching/decision.ts`) — his pass, hers
     after he accepted, or both. **This is the primary rematch moment**: an
     explicit decline is far more common than silence, and it is the exact
     frustration the feature answers.
   - **the mobile twin** (`public/matches-service.ts`) — a decision taken in the
     iOS app still frees a *Telegram* participant, who would otherwise lose the
     offer purely because their partner used the other client.
   - **TTL expiry** (`expiry-notify.ts`) — nobody answered within 24 h.

   Fired only after the `proposed → cancelled` CAS is won (so a concurrent
   decision cannot double-send) and only after the outcome reveals have landed,
   so the user learns what happened before being offered a next step. Never on
   the first-decider path, where the row stays `proposed` and both users still
   have a live match. Sent to both sides; the sender self-gates on male-only +
   D3 limits, and the copy is static and identical for both, so it discloses
   nothing about who decided what.
3. **The pinned status banner**, silent-drops mode only (§2.1 mode 5, callback
   `rematch:open`, variant `neutral`). That mode renders when drops run more
   often than the notices explaining them — i.e. exactly when an evening can
   pass in deliberate silence — and it is the one surface where a way in costs
   nothing: it is already on screen, already says "still looking", and is
   **edited** rather than sent, so it raises no notification and needs no quiet
   hours.
   - **No price on the button.** A pinned message sits above every conversation;
     a permanent price there is a standing sales pitch. The body is unchanged —
     only the button moves.
   - **Eligibility is batched per tick**, not per user (`filterRematchEligible`).
     The worker touches every active account every minute, so the single-user
     check would be ~3 queries per user per minute; the batch is 3 per tick
     whatever the pool size. It is a twin, not an approximation — a drifting
     batch would render a button that fails on tap, which this product treats as
     worse than no button, so tests hold the two to the same verdict on every
     gate. Under `weekly` the whole thing is short-circuited and never queries.
   - A live match, an unlaunched city, and the ordinary drop countdown all
     outrank it.
4. **The concierge** (`open_screen: rematch`) — so it is reachable by asking, in
   text or by voice, without hunting for a card that scrolled away.
   **The per-user gate is enforced in `execOpenScreen`, not in the playbook.**
   The asymmetry below (a woman never learns the feature exists) is the product,
   and a prompt rule is not a boundary; the gate happens to cover her case for
   free, since Rematch is male-only. Its refusal string deliberately names no
   feature at all, because the tool result is fed back to the model verbatim and
   an error mentioning a paid re-run is precisely how the asymmetry would leak.
5. **STILL not a main-menu row** (D4 stands) and **not** in the My Date hub (by
   definition there is no live date).

**Two taps by design** (`handlers/matching/rematch.ts`). The DM carries the full
terms and a callback button; tapping mints the Stars invoice and swaps the same
card's button for the pay button. That ordering keeps the honest terms on screen
immediately before payment, and it means an invoice is only minted for someone
who actually wants one. Both the render and the tap re-check eligibility, so a
durable card sitting in the chat past a cooldown refuses with a real reason
instead of charging and refunding.

**The offer card** states, before payment: the price, that it buys **a new
introduction — not a guaranteed date**, and that Stars are returned only if we
cannot find anyone. Copy in all five locales, per §Languages.

## Risks and mitigations

| Risk | Why it bites | Mitigation |
|---|---|---|
| **Pool burn via lifetime ban** | Every rematch permanently consumes one woman from his city pool. A heavy user runs out of *anyone* he has not seen. | D3 limits; the CTA disappears when the engine finds nobody; honest "we could not find anyone" copy instead of an error. |
| **Paid shopping / swipe-ification** | Buy → look → decline → buy again turns Gennety into a paid swipe app *and* lifetime-bans dozens of women for every other man. | D1 (no refund on decline) + D3 (2/week, 24 h cooldown). The 24 h cooldown specifically prevents decline-and-instantly-retry, preserving the weight of a decision. |
| **Woman burnout** | A popular woman could be the top-1 candidate for many men and get serially gift-pitched. `single-live-match` prevents *simultaneous* matches but not a *series*. | `REMATCH_GIFT_CAP_DAYS` (default 7): exclude candidates who already received a rematch-sourced pitch in the window. |
| **Cannibalizing the weekly batch** | The Thursday batch is globally greedy-optimal; a rematch an hour earlier can take a woman the optimal Thursday pairing needed. | `REMATCH_PRE_BATCH_BLACKOUT_HOURS` (default 6) — no rematch in the run-up to `MATCH_CRON_SCHEDULE`. Between cycles the impact is negligible. |
| **Paid-into-nothing** | Money taken, no match, no refund. | The check → pay → re-check → deliver-or-refund flow, plus the durable `refund_failed` retry. |
| **Famine accounting drift** | `standbyCount` / `missedWeeks` reset lives in the weekly diff; a rematch pairing outside it would leave her accruing a false famine bonus. | Reset both sides' starvation counters on a rematch pairing, exactly as the weekly batch does. |
| **Analytics pollution** | Rematch pairs are not drawn from the same optimization as weekly pairs; mixing them corrupts `match_score_logs` quality readings. | `Match.source` filter in algorithm analytics and the founder weekly report. |
| **Chargeback / trust** | "I paid and she said no." | D1 is stated in the offer copy pre-payment, and `RematchPurchase` is a full audit trail per charge. |

## Two clients (Telegram + iOS)

**v1 is Telegram-only — an explicit, recorded decision**, matching how tickets,
venue-change, and Premium launched. Reasons: Stars is a Telegram rail, and both
entry points (no-match DM, post-failure DM) are Telegram surfaces.

iOS parity requires a StoreKit 2 **consumable** (or reuse of the existing ticket
StoreKit rail) plus native entry points. Per AGENTS.md → *Two Clients, One
Backend*, the client-side work is recorded as a task in
`~/Desktop/Gennety-iOS/IMPLEMENTATION_PLAN.md`; **no `/v1/*` route shapes and no
`openapi/gennety-v1.yaml` changes are made in v1**, so the iOS contract is
untouched.

## Invariants preserved

- **No in-app chat** — untouched; rematch produces an ordinary match.
- **Blind decision** (§3.4) — a rematch match is a normal `proposed` row; she
  learns nothing about his state, and the gift framing is forbidden from hinting
  at it.
- **Lifetime pair ban** (§3.2) — inherited, and it is what defines "rematch".
- **Single live match** (§3.2) — enforced both as a buy-eligibility rule and by
  `createProposedMatch`'s in-transaction re-check.
- **Verification / contact-rail gates** — inherited from `findCandidatesFor`; a
  paid run never lowers the admission bar.
- **Ledger exactly-once** — unique `externalPaymentId`, same as tickets, venue
  change, and Premium.

## Env

**`MESSAGE_EFFECT_REMATCH_ID`** (added 2026-08-20, optional, **empty by
default**) — Bot API 7.6+ message effect on the "found someone" DM, the payoff
at the end of the search animation. Ships inert like `MESSAGE_EFFECT_MATCH_ID` /
`_TICKET_ID` / `_FEEDBACK_ID`: pick an id and set it in `/opt/gennety/.env`.
Never put it on the offer card instead — PRODUCT_SPEC §3.5b records why a
flourish beside a request for money reads as marketing rather than as a receipt.

**Cadence note (rewritten 2026-08-09 — the previous version is now wrong).**
Every D3 limit resolves as **`env ?? CADENCE`** through `rematchLimits()`
(`services/rematch.ts`): the active `DropCadence` profile
(`packages/shared/src/cadence.ts`) is the source of truth, and the four env vars
below are ops **overrides** on top of it. An unset var therefore follows
`DROP_CADENCE` automatically; `weekly` reproduces today's numbers exactly, which
a test asserts literally.

This replaces the note that stood here until 2026-08-09, which said these knobs
"stay plain env reads" and "need a deliberate, manual re-tune". That described
a real gap rather than a design: `rematchBlackoutMs`, `rematchMaxPerInterval`,
`rematchCooldownMs` and `rematchGiftCapMs` were declared on `DropCadence`,
pinned by `cadence.test.ts`, and **read by nothing** — only `rematchWindowMs`
was live. The abstraction looked complete for Rematch and was not.

Two consequences worth holding onto:

- **The resolution lives at the READ site, not in `config.ts`.** That file must
  stay the first module evaluated (dotenv ordering) and can never safely import
  `@gennety/shared` — which is exactly why the original wiring was skipped.
- **A literal `0` is a real value, not "unset".**
  `REMATCH_PRE_BATCH_BLACKOUT_HOURS=0` is the documented way to disable the
  blackout and must not fall through to the profile's 6h, so the env vars are
  nullable rather than defaulted.

`daily` values and why they differ: **7 purchases per 7 days** (2 bound on day
two and left the 24h cooldown decorative; at 7 the cooldown is the real
governor and already means "at most once a day") and a **1h** blackout (6h is
~3.5% of a week and **25% of a day** — 12:00–18:00 Kyiv dead, every day).
`rematchCooldownMs` and `rematchGiftCapMs` are unchanged.

**`rematchGiftCapMs` must stay identical in both profiles.** Every other knob
here describes what the BUYER may do; that one protects the woman he is buying
his way to. Loosen `rematchMaxPerInterval` freely — in a thin pool a gift cap
that tracks his purchase rate turns a single candidate into everyone's punching
bag. A test pins it, and it must outlast his cooldown by a wide margin or
"protected for a week" degrades to "protected until he can buy again".

This supersedes **D8** (`DAILY_MATCHING_IMPLEMENTATION_PLAN.md`, "turn Rematch
off for the daily pilot"), which was never adopted and never recorded as a
decision: the limits move with the cadence instead, so a `DROP_CADENCE` flip no
longer needs the feature switched off to stay sane.
`REMATCH_FEATURE_ENABLED` is unaffected by any of this and remains the sole
master switch.

| Key | Default | Purpose |
|---|---|---|
| `REMATCH_FEATURE_ENABLED` | `false` | Master switch; everything inert when off. |
| `REMATCH_STARS` | `150` | Telegram Stars price (≈ $2.99). |
| `REMATCH_PRICE_USD_DISPLAY` | `$2.99` | Display-only. |
| `REMATCH_MAX_PER_WEEK` | `2` | D3 limit, rolling 7 days. |
| `REMATCH_COOLDOWN_HOURS` | `24` | D3 minimum gap between purchases. |
| `REMATCH_GIFT_CAP_DAYS` | `7` | Candidate protection window. |
| `REMATCH_PRE_BATCH_BLACKOUT_HOURS` | `6` | Blackout before the weekly batch. |
| `REMATCH_FAILED_LOOKBACK_DAYS` | `14` | Window for the `failed` gift framing. |
| `REMATCH_REFUND_CRON_SCHEDULE` | `0 * * * *` | Refund retry / abandoned-purchase sweep. Registered only when the feature is on. |

**Pricing note.** 150⭐ follows the ticket rate ($6.99 / 350⭐ = $0.02/⭐ → 150⭐ ≈
$3.00 ≈ the $2.99 label). `PREMIUM_STARS` documents a more conservative
$0.024/⭐ small-pack rate, at which 150⭐ bills nearer $3.59. If we want the strict
"never under-promise the charge" convention Premium follows, either drop
`REMATCH_STARS` to `125` or raise `REMATCH_PRICE_USD_DISPLAY` — both env-only,
no redeploy.

## Implementation phases

**Phase 0 — schema + config (inert).** Additive `Match.source` /
`rematchPaidById` + the `rematch_purchases` model; `db:push`; env keys in
`config.ts`. Nothing reads them yet. *Gate: `db:drift-check` clean.*

**Phase 1 — shared + core service.** `buildRematchInvoicePayload` /
`parseRematchInvoicePayload` in `packages/shared/src/stars.ts` (mirroring the
`sub:` parser); `services/rematch.ts` with `checkRematchEligibility()`,
`findRematchCandidate()`, `pickGiftFraming()`, `runRematch()`.

**Phase 2 — payments.** `rematch:v1` branch in
[payments.ts](apps/bot/src/handlers/payments.ts) (`pre_checkout` + settle),
invoice minting, refund + `refund_failed` bookkeeping, and the hourly retry
worker.

**Phase 3 — surfaces + i18n.** Offer card + CTA in the no-match DM and the
terminal-failure DMs; gift-framing prefixes and all offer/refund copy across
`en`/`ru`/`uk`/`de`/`pl`.

**Phase 4 — analytics hygiene.** Exclude `source = 'rematch'` from the
algorithm-quality view; surface rematch pairs distinctly in the founder feed.

**Phase 5 — tests.** Below.

**Phase 6 — deploy.** Ship with the flag **off**, `db:push` first (the new
columns are read unconditionally once code lands — a missing column is a `P2022`
crash-loop, per deploy.md), verify inertness, then flip.

## Test coverage (the ones that actually matter)

- **Money safety:** empty pool → refund + no match; refund API failure →
  `refund_failed`, no success DM, retried; duplicate `successful_payment`
  (Telegram redelivery) → exactly one match, one charge row.
- **Race:** two invoice opens paid back-to-back → second is refunded as
  `refunded_ineligible` (limit / live-match), never a second live match.
- **Invariants:** rematch never returns a previously-seen partner; never returns
  a woman in a live match; refuses when the buyer has a live match; refuses for
  a female buyer.
- **Limits:** 3rd purchase in a week refused; purchase inside the 24 h cooldown
  refused; candidate gift-capped within 7 days excluded; pre-batch blackout.
- **Framing:** `famine` / `failed` / `neutral` selected correctly; copy contains
  no payment or partner-decision leak.
- **Accounting:** starvation counters reset for both sides on a rematch pairing.

## Non-goals (v1)

- No woman-side purchase, and no way for a woman to *request* a rematch.
- **No candidate choice.** One candidate, like the weekly batch — showing a list
  would turn the product into the swipe app it exists to replace.
- No score/league boost bought with money.
- No refund for a declined or ghosted match (D1).
- No Premium bundling (rematch is not free for subscribers in v1 — revisit once
  purchase data exists).
