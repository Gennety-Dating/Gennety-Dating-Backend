<!-- WHEN_TO_READ: You need to know which module owns a cross-cutting concern: Venue Intent V2, launched-market gating, or purchases (revenue feed + admin ledger). Read before changing anything that spans venue selection, market rollout, or money. -->
<!-- SOURCE: ARCHITECTURE.md (lines 2140-2343) — migrated 2026-09-01 -->

# Venue Intent V2 ownership

`packages/shared/src/venue-intent.ts` owns canonical IDs, normalization, bridge
compatibility, hard filtering and deterministic scoring. Both clients are thin:
they collect origin/text/chip confirmation and consume the generated OpenAPI
contract; interpretation, evidence checks and ranking remain server-only.

`Match.venueIntentA/B` are versioned JSON snapshots. Interpret writes a durable
draft; confirm writes the final structure plus origin. Finalisation reads only
confirmed snapshots. `venueMidpointLat/Lng` records route geometry while
`venueLat/Lng` records the real selected venue for V2; null
`venueSelectionVersion` preserves legacy midpoint semantics. Curated inventory
is city-scoped (`cityKey`) and university domain is affinity only. Runtime
deduplicates legacy domain copies by stable place ID.

The V2 selector gathers city-curated candidates and canonical Places lanes,
applies operational/hours/hard/commute gates, ranks top-1, and records a
raw-text-free `VenueSelectionLog`. Provider retry state is durable on `Match`.

**`VenueSelectionLog` is also the engine's only observability surface.** The
engine's failure mode is silent — dates keep being scheduled, nothing throws,
and one venue can quietly take the city (the `.slice(0, 20)` that left 20 of
661 eligible Kyiv venues in the running was found by a hand-written query
against production, not by anything the product could see). Two additions make
that visible without a second table:

- **`topCandidates.poolSizes`** — the selection funnel per run
  (`curatedInBox` → `curatedEligible` → `placesAdded` → `ranked`), plus
  **`geoRung`** (1-based) naming which rung of the geo ladder produced `ranked`
  (PRODUCT_SPEC §3.7). Anything above 1 means the pair's departure points were
  too far apart for a normal pick and the selector had to widen — the state
  that used to fail outright, so its frequency is the signal for whether a
  city's catalog is thin. The column was already `Json`, so this is a shape
  change, not a migration.
  `curatedEligible` is read BEFORE the Places fallback appends to the same
  array, so "the curated catalog is thin here" stays distinguishable from
  "Places carried the run" — two states with completely different fixes. A
  FAILED run writes the funnel too: that is the case where it matters most,
  separating an empty geo box from hard filters eating a full one.
- **`cityKey`** — the pair's matching city, frozen at selection time so
  concentration analytics group without joining `matches → users → profiles`
  on every dashboard request, the same reason `match_score_logs` freezes its
  breakdown. Nullable, so rows predating it read as `unknown` rather than
  breaking the aggregation.

**Season and weather are a soft ranking multiplier, never a filter.** After the
ranker scores and before the diversity layer picks,
`venueContextMultiplier(exposure, ambiences, month, weather)`
(`packages/shared/src/venue-intent.ts`, pure) multiplies each candidate's score
and the list is re-sorted once — so both the diversity path and its argmax
fallback read the same adjusted order, rather than the multiplier being silently
lost on the runs where diversity bailed. `pairFit` is deliberately NOT adjusted:
it gates the vibe floor, and weather has no bearing on whether a venue matches
what the pair asked for. Exposure comes from `facets.setting`, falling back to
category **only for parks** (a park is outdoor by definition; a null setting on a
restaurant genuinely means unknown, and guessing would be inventing evidence).
The combined multiplier is clamped to `[0.8, 1.1]` by a code constant, not an
env knob — that clamp is the guarantee that context can never outrank fit or
quality (founder requirement T4), and without it a cold severe winter day would
compound to ~0.69, enough to push a genuinely better venue below a worse one.

`admin/utils/venue-concentration.ts` is the pure aggregation over those rows,
shared by `GET /admin/analytics/venue-concentration` and
`workers/venue-concentration-alert.ts` so the dashboard and the alarm can never
disagree about what "concentrated" means. `parsePoolSizes` returns **null**,
never zeros, for the pre-funnel array shape — a zeroed funnel would drag the
median down and fake a pool collapse that never happened. Shadow-mode rows are
excluded by both readers: they assign nothing and reach no user, so counting
them would dilute every share with dates that never existed.
Before ranking, `services/initial-venue-policy.ts` applies the product-owned
initial-assignment gate equally to curated and Places candidates: base tier,
rating/review floor and a known `FREE`/`INEXPENSIVE`/`MODERATE` price for
commercial/admission categories. Provider price outranks an operator tag;
public parks are the only category allowed without a commercial price. The
deprecated `VenueHardConstraints.maxPrice` field remains in the additive API
shape but is normalized to null and is not a participant control.
Per-side `venueFitBy*` and `venueFitReasonsBy*` fields feed suggestion quality
without exposing one participant's feedback to the other.
JWT routes live under `/v1/matches/{id}/venue-intent`; Telegram Mini App routes
under `/v1/location/venue-intent/*` authenticate with signed initData and call
the same service.

# Launched-market ownership

`packages/shared/src/markets.ts` owns `SUPPORTED_MARKETS` — the cities Gennety
operates in (Kyiv only today) — plus `findMarketByCityKey` /
`isSupportedCityKey` / `searchMarkets` / `marketForCoordinates`. It is shared
data, not a per-surface list: the bot menu, the Telegram Onboarding Mini App
(via `/v1/telegram-onboarding/state.supportedCities`) and the native client
(via `GET /v1/app/config.supportedCities`) all read the same array, so a new
market goes live with the server rather than a bundle redeploy.

Enforcement has exactly one choke point. `validateHomeLocationPayload`
(`apps/bot/src/public/home-location.ts`) is the only writer of
`Profile.homeCityKey`, so the single market check covers both
`POST /v1/telegram-onboarding/city/select` and `POST /v1/me/home-location`; it
also canonicalizes the stored city name and coordinates from the market entry,
because the client's role is to pick WHICH market, not to supply a centroid.
`apps/bot/src/public/city-search.ts` is the read side (search + the geometric
geolocation resolve) and makes no network calls at all.

The match engine deliberately knows nothing about markets: it still joins on an
exact `Profile.homeCityKey` equality (PRODUCT_SPEC §3.2 filter 5), which is
precisely why registration has to be gated. Accounts created before the gate
keep their city and are offered a one-tap move to a launched market
(`apps/bot/src/handlers/menu/city-switch.ts`, reused by the weekly no-match DM
and reflected in the pinned status banner).

**The DEPARTURE point is gated by a second choke point** (added 2026-08-05):
`apps/bot/src/services/venue-origin.ts`, the twin of `validateHomeLocationPayload`
for the venue step (PRODUCT_SPEC §3.7). Registration's city had a real gate while
the "where are you setting off from?" pin had only a coordinate-range check, so
any point on Earth could be written — after which the concierge could find no
venue and the match died 48 h later in the §3.5c stall chain.

Five write paths reach it, which is exactly why the check lives in one module
rather than at the routes: `POST /v1/location/select`, `interpretVenueIntent` +
`confirmVenueIntent` (shared by the Telegram Mini App and the iOS
`/v1/matches/:id/venue-intent*` pair), the legacy mobile
`POST /v1/matches/:id/vibe-location`, and `handleVenueLocation` (a raw Telegram
attach-menu pin — the one that previously had NO validation whatsoever). The
refusal is a value, not a throw (`VenueOriginRefusal`), because the two service
functions already signalled every problem as `null` and the routes turned that
into `409 wrong-state` — a lie about why the write failed.

`resolveDepartureMarket` returning `null` means **do not gate**, never refuse:
it covers an account with no dating city or an unlaunched one, where blocking
the user would punish them for a gap in our data. The same
`MarketView` it produces is served on the venue-intent state so both clients can
run the check live on their own screen; the server re-checks regardless, so a
stale bundle costs a worse error message and never a bad write.

# Purchase ownership (revenue feed + admin ledger)

`apps/bot/src/services/purchases.ts` owns the **unified purchase read model**:
one `PurchaseRow` shape over the four tables that already record money
exactly-once — `ticket_ledger` (store top-ups + the `gate_*` date-gate rows),
`subscription_ledger` (Premium charges and renewals), `rematch_purchases`, and
`venue_change_purchases`.

There is deliberately **no `purchases` table**. A fifth table dual-written
alongside those four would be a second source of truth that can drift from the
one the refund rails actually read and mutate — and every refund path in the
product (the hourly rematch/venue sweeps, the gate expiry worker, the App Store
revoke webhook) writes to the originals. So the founder DM, the admin list, and
the per-user card are all readers of the same four tables and cannot disagree
about a charge's status.

Two consumers:

- **Founder feed** (`services/founder-notify.ts` → `notifyFounderPurchase` /
  `notifyFounderPurchaseRefunded`, gated by `FOUNDER_NOTIFY_ENABLED`). Fired
  from the settlement point of each rail — the SAME write whose unique provider
  charge id makes the purchase exactly-once — so a redelivered
  `successful_payment` or a re-submitted App Store transaction returns on the
  duplicate branch before ever reaching the notifier, and the sale is never
  announced twice without a dedicated idempotency column. Call sites:
  `handlers/payments.ts` (Stars store + Rematch), `handlers/matching/ticket-gate.ts`
  (date gate + its refunds), `handlers/matching/venue-change.ts`,
  `services/premium.ts` (`activateOrExtendPremium`, which covers BOTH the Stars
  and App Store rails in one place), `services/appstore-tickets.ts`,
  `services/rematch-refund.ts`, `services/venue-change-refund.ts`, and the mock
  store confirm in `public/routes/tickets.ts`. Refunds are announced as well as
  purchases: a Rematch refund can follow its own purchase within seconds, so a
  purchase-only feed would carry sales that no longer exist.
- **Admin surface** — `GET /admin/purchases` (`admin/routes/purchases.ts`),
  plus `purchaseSummary` on every `/admin/users` row and `purchases[]` +
  `purchaseSummary` on `/admin/users/:id`.
- **Paying-user conversion** — `loadPayerIndex()` collapses the same rows into
  one entry per payer (non-refunded count, money, first/last charge, per-product
  totals), and `admin/utils/monetization.ts` divides that by a denominator.
  It is built on the SAME `loadPurchases` path rather than counting rows out of
  the four tables directly, because the "is this row actually a purchase" rules
  live there — `isPaidTicketRow` skipping free grants (welcome gift, student
  bonus, referral, promo), `isPaidSubscriptionRow` skipping comp'd Premium, and
  the App Store claw-back lookup. A second implementation of those would drift
  into quietly counting a welcome gift as a sale.

Two things a reader comparing the ledger with the conversion tab needs to know,
because otherwise the gap looks like a bug. **Test and synthetic accounts are
excluded from the conversion's numerator, denominator AND revenue** (the
verdict comes from `admin/utils/user-health.ts`, the same classification the
onboarding funnel divides by), while the ledger deliberately shows every
charge — the excluded amount is reported as `revenue.excludedTestUsdCents` so
the difference is stated rather than discovered. And **a user whose every
purchase was refunded is not a paying user** but is counted separately
(`refundedOnlyPayers`); `refund_failed` IS revenue, by the same rule
`summarizePurchases` already applies — the money is still with us, which is
exactly what makes that state an ops alarm.

`loadPayerIndex` is bounded by a fetch ceiling (20 000 rows per source) and
**reports hitting it** (`truncated`) rather than silently shortening a
conversion rate — a rate over a truncated set is wrong, not merely incomplete.

Two money rules the readers share. **Stars have no published USD rate**, so any
dollar figure derived from them is computed at the documented `STAR_USD_CENTS`
($0.02/⭐, the ticket rate) and is labelled an estimate everywhere it is shown;
App Store rows carry Apple's real price (`priceCents`, parsed defensively from
the transaction's milliunit `price`) and are never estimated. And **`refunded`
rows are excluded from revenue while `refund_failed` rows are counted** — that
state means a refund is owed and the provider call failed, so the money is
still with us, which is exactly what makes it an ops alarm rather than a
completed reversal.
