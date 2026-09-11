<!-- WHEN_TO_READ: You are changing frequently visited places — how a visit is detected (foreground fixes, dwell, dense streets), the category thresholds and the ranking, what the match sees, the opt-in, or the contract the iOS tracker runs on (`/v1/frequent-places/*`). -->

## Frequently visited places

A block of up to three catalog places a person keeps coming back to — on their
own profile, and in their match's view of them
(`SerializedMatch.partnerFrequentPlaces`). Founder brief of 2026-09-11; the
three forks the founder decided and every constructive call made on the way are
in the decision journal (2026-09-11 — «часто посещаемые места»).

### Invariants

1. **Zero per-call cost.** A position is only ever compared with our own
   catalog (`curated_venues`, one place per Google place id). No geocoder, no
   Places call, no LLM — on any path of this feature.
2. **Foreground only.** No background-location entitlement, no `Always`
   permission, no region or visit monitoring. The iOS app takes one fix when it
   becomes active and one every 10 minutes while it stays open.
3. **A single fix is never a visit.** A visit is two fixes at least 15 minutes
   apart that both land unambiguously on the same place, with no departure in
   between and no silence longer than the category allows — or a date the
   person attended there (`Match.dateAttendedA/B` + `venuePlaceId`, written by
   a verified Date Bump or by the person's own answer).
4. **What is stored is a place and a day.** `user_place_visits` holds a Google
   place id and a local calendar day. Coordinates are read and dropped; no time
   of day or duration exists anywhere. Swept after 180 days.
5. **The match sees a name and a category.** Never a count, a day or a
   position, and only through `partnerFrequentPlaces`.

### Detection

| Step | Rule |
|---|---|
| Client pre-filter | `GET /v1/frequent-places/fences` hands over the city's places as circles (`radiusM` is the server's own radius) and a `policy`: maximum accuracy 50 m, maximum fix age 60 s, probe interval 600 s. A fix is sent only when it is within `radiusM` + its accuracy of some fence; otherwise, if a stay may be open, `{ "away": true }` goes instead — with no position in it. |
| Fix freshness | The client sends `ageSeconds`, measured on its own clock; the server dates the fix as its own now minus that age. A stale fix, or a cached one sent again, is dropped by its age. |
| Reading a fix | `place` when the nearest catalog place is within its category's radius AND the runner-up — over EVERY place, not just those whose circle the fix is in — is at least 15 m further away. `unclear` when the fix is vaguer than 50 m, near a place but outside it, or ambiguous. `away` when it is clear of every place by radius plus its own accuracy. |
| Dwell | The open stay — place, first and latest instant, held in process memory only — extends on each `place` fix at the same place within the category's maximum gap. `unclear` neither extends nor breaks it; `away` or another place ends it. Once first-to-latest reaches 15 minutes, one visit is written for that local day (`ON CONFLICT DO NOTHING` on `(user, place, day)`). |

The numbers live in `packages/shared/src/frequent-places.ts`:

| Category | Radius | Max gap | Threshold (visit days in 180 d) | Weight |
|---|---|---|---|---|
| `cafe`, `coffee_shop` | 35 m | 90 min | 5 | 1.0 |
| `restaurant` | 40 m | 120 min | 5 | 1.0 |
| `lounge` | 40 m | 180 min | 5 | 1.0 |
| `museum` | 50 m | 180 min | 3 | 1.3 |

`park` is excluded: it is an area rather than a venue, and a park crossed every
day is a proxy for where someone lives. The brief's gyms (> 6), supermarkets
(> 6), niche boutiques (2–3) and cinemas (2–3) are not in the catalog; their
thresholds wait for a decision to extend it, which is paid Places seeding.

A dense street costs recall on purpose: between two places less than 15 m
apart a fix counts for neither, so a mall yields visits only from attended
dates. The product's "never offer" rules (`museum`, blocked brand names) are
NOT applied — they say what we propose for a first date, and this block says
where a person goes on their own.

### Ranking

    S = weight · Σ 2^(−age_days / 45) / threshold

over the visit days inside the window, for places at or above their threshold.
Dividing by the threshold puts categories on one scale (a museum at 3 and a café
at 5 both read as 1 × weight); the weight then tips a tie toward the less
routine category; the 45-day half-life makes this month's café outrank the
spring's. Best first; ties by the latest visit day, then place id. Hidden places
are removed BEFORE the limit, so the next one moves up. At most three shown, at
most two of one category.

### Visibility and control

- `users.frequentPlacesOptIn` defaults to **true** — a founder decision that
  departs from the rule `scratchMapOptIn` and `biometricConsentAt` keep. Off
  stops collection at once (the open stay is dropped, the fences go empty) and
  removes the block from the owner and the match; stored days are kept and age
  out, the Scratch Map's rule for a toggle.
- `PUT /v1/frequent-places/{placeId}/visibility` hides one place. It stops the
  showing, not the counting.
- The match's copy is built only by `partnerFrequentPlaces`, cached for 10
  minutes and dropped by every write that could change it (a visit, a hide, the
  toggle), so a hide reaches the match at once. It is shown for the whole of
  the current match; no stage gate was decided.

### Demo mode

No puppet branch: the feature is one-sided. The block stays empty in the demo —
the only dwell source is the iOS tracker, which a Telegram demo never runs; the
Date Bump cannot fire there; and one attended date is below every threshold.

### Not built

The Mini App tracker (the server is ready, on both rails); a manual check-in;
the block in the bot's Telegram pitch; place photos in the block (a paid Place
Photo request per cache miss); extending the catalog.

### Code

`packages/shared/src/frequent-places.ts` (numbers) ·
`apps/bot/src/services/frequent-places-rules.ts` (pure: reading a fix, dwell,
ranking) · `apps/bot/src/services/frequent-places.ts` (catalog cache, open
stays, reads, writes, the match's copy) ·
`apps/bot/src/public/routes/frequent-places.ts` ·
`apps/bot/src/public/matches-service.ts` (`partnerFrequentPlaces`) ·
`apps/bot/src/workers/retention.ts` (180-day sweep).
