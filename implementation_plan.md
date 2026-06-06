# Implementation Plan — Venue Change Feature (Смена места свидания)

> **Status:** IMPLEMENTED (2026-06-05) behind `VENUE_CHANGE_FEATURE_ENABLED`
> (default off). Tests green (services 19 / handler 11 / API 13 / lifecycle 20);
> all packages typecheck; shared + webapp build. Pending: `db:push` (dev+prod)
> and flipping the flag at launch.
> **Source spec:** [VENUE_CHANGE_PRODUCT_SPEC.md](VENUE_CHANGE_PRODUCT_SPEC.md)
> **Session notes:** Obsidian `Sessions/2026-06-04-venue-change-feature-design.md`,
> `Sessions/2026-06-05-venue-change-feature-implementation.md`

## Decisions (resolved)

1. **C1 cutoff = T-5h.** Propose-window closes at `agreedTime - DATE_ALERT_HOURS`
   (5h), not the spec's T-3h. The T-3h figure in VENUE_CHANGE_PRODUCT_SPEC §4 is a
   factual error vs the code and will be corrected when we update the spec.
2. **C2 = Option A.** The 3 km catalog is centered on the existing
   `Match.venueLat/venueLng` (the commute midpoint — already the fair center). No
   change to the venue finalize pipeline; no real-venue-coordinate columns.
3. **C3 = mirror coordination.** Hetero → female-only; F–F → first-tap-wins;
   M–M → feature unavailable.
4. **C4 = emergency-cancel semantics.** Male decline → no Elo penalty on him;
   female gets a small standby/priority comp boost; no `eloMatchesPlayed` increment.
5. **Photos = manual, curated-only.** No Places Photo API in v1. Add an optional
   `CuratedVenue.photoUrl` the operator fills by hand; catalog renders it when
   present, falls back to a category-badge placeholder for Places-fallback rows.

This plan covers the feature-flagged, female-exclusive, one-shot "Change Venue"
flow that lets the female participant propose an alternative within 3 km of the
auto-assigned venue, gated by a mandatory comment and the male partner's
accept / decline-cancel decision.

---

## 0. Conflicts & open decisions found while reading the code

These were found by reading the actual code (per AGENTS.md: code/Prisma/tests are
the source of truth, and mismatches must be reported before assumptions). **Items
marked 🔴 block a clean implementation and need your call before coding.**

### 🔴 C1 — The spec's "T-3h critical zone" is factually wrong against the code
The spec (§4, Развилка 4.2) says the emergency-cancel window and ice-breakers fire
at **T-3h**, and uses that as the venue-change cutoff. The code disagrees:
- `packages/shared/src/constants.ts` → `DATE_ALERT_HOURS = 5`.
- `apps/bot/src/services/date-lifecycle.ts:41` — ice-breakers **and** the emergency
  window both open at **T-5h** (`alertThreshold = now + DATE_ALERT_HOURS * 60*60*1000`).

Ice-breakers reference the locked venue, and the emergency window is the "critical
zone". So the real cutoff for *proposing* a venue change must be **T-5h, not T-3h** —
otherwise the female could change the venue after ice-breakers naming the old venue
have already been sent and after emergency cancellation is live.
**Recommendation:** define the cutoff as `T - DATE_ALERT_HOURS` (T-5h), pulled from
the shared constant, not a hardcoded 3h. **Decision needed: accept T-5h cutoff?**

### 🔴 C2 — We do not currently store the real venue coordinates
The "3 km radius around the **original venue**" filter needs the venue's lat/lng.
We don't have them:
- `Venue` (`services/venue.ts:41`) is `{ name, address, googleMapsUri }` — **no lat/lng**.
- `rowToVenue` (curated) and `placeToVenue` (Places) both drop coordinates.
- `tryFinalize` writes `venueLat/venueLng = midpoint`, **not** the chosen venue's
  location (`venue-negotiation.ts:396-398`).

So today `Match.venueLat/Lng` is the commute **midpoint**, which is *already a
balanced, fairness-aware center*. Two ways forward:
- **Option A (pragmatic, recommended):** center the 3 km catalog on the existing
  `venueLat/venueLng` (the midpoint). It's already the fair center the original
  pick was balanced around; 3 km from it keeps both commutes within ±10–15 min.
  Zero change to the finalize pipeline.
- **Option B (literal to spec):** extend `Venue` to carry `lat/lng`, thread it
  through `resolveVenue` → both finalize paths, and persist real venue coords in
  **new** columns (`venuePlaceLat/venuePlaceLng` — `venueLat/Lng` is taken by the
  midpoint). More accurate, but touches the core scheduling finalize path and the
  curated/Places mappers + their tests.

**Recommendation: Option A for v1** (midpoint center), with Option B noted as a
follow-up if QA shows the midpoint drifts too far from the actual venue.
**Decision needed: A or B?**

### 🔴 C3 — Same-sex pairs & "female-exclusive"
"Female-exclusive" assumes a hetero pair. `User.gender ∈ {male, female}`. The
existing pre-date coordination feature already solved this (PRODUCT_SPEC §Phase 4):
female gets the offer; same-sex pair with no clear female → first-tap-wins; no
female at all → feature unavailable.
**Recommendation (mirror coordination):**
- Hetero pair → button shown only to the female side.
- Female–female pair → show to both, first-tap-wins (the other then can't).
- Male–male pair → feature unavailable (no "Change Venue" button at all).
**Decision needed: accept this rule?**

### 🟡 C4 — Cancellation semantics (Elo) on male decline
Spec says match → `cancelled`. Existing precedents:
- Emergency cancel (`handlers/date/emergency.ts`): canceller **not** penalised,
  cancelled-on peer gets a tiny `EMERGENCY_CANCEL_PEER_ELO_BOOST = 5`, no
  `eloMatchesPlayed` increment.
- Decline of a proposal: counts as a real contest with Elo movement.
A venue-change rejection is closer to an emergency cancel (a logistics fallout, not
a "you're unattractive" verdict). **Recommendation:** treat like emergency cancel —
no penalty on the male decliner, optional small comp boost / standby boost for the
female so she re-enters the next batch with priority (she lost a real date through
no fault of matching). **Decision needed: confirm no-penalty + female comp boost.**

### 🟡 C5 — Mandatory comment vs "NO IN-APP CHAT" invariant
The ≥10-char comment is female→male free text shown verbatim. This is a **one-shot,
structured, non-reply relay**, directly analogous to the existing `emergencyReason`
carve-out (quoted verbatim as a blockquote). It does **not** open a reply channel.
**Plan:** store verbatim in a dedicated column, render as a Telegram blockquote like
the emergency reason, no AI rewrite. Document it as consistent with the existing
narrow carve-outs in PRODUCT_SPEC. No new general-chat surface is created.

### 🟡 C6 — Sub-state machine, not a new `MatchStatus` enum value
The spec calls the waiting state a "sub-status `venue_change_proposed`". Both prior
feature-flagged add-ons (Date Ticket `ticketStatus`, Coordination `coordMethod`)
are **string sub-states layered on an existing `MatchStatus`**, specifically so the
lifecycle/cron code that filters on `status = scheduled` is untouched.
**Recommendation:** implement as a string column `venueChangeStatus`, with the match
staying in `MatchStatus.scheduled` throughout. Do **not** add a `MatchStatus` enum
value (that would force edits across every `status` switch in the codebase).

### 🟡 C7 — Interaction with ice-breakers / coordination / timeout race
While a change is `proposed` and awaiting the male, the date-lifecycle tick keeps
running. If a proposal is still pending at T-5h, ice-breakers would fire on the
**old** venue. The timeout `min(12h, T-cutoff)` must therefore **force-resolve
(auto-cancel) the pending proposal before T-5h**, and the venue-change-pending
state must suppress nothing else (coordination is feature-flagged and also T-60m/-30m,
safely after the T-5h cutoff). **Plan:** the date-lifecycle tick (or a dedicated
sweep) auto-cancels any `proposed` change that has hit its TTL **or** crossed
`agreedTime - DATE_ALERT_HOURS`, *before* the ice-breaker step runs in that tick.

---

## 1. Database migration (Prisma)

`packages/db/prisma/schema.prisma`, `model Match`. All new columns nullable / with
defaults so existing rows parse. Follows the `ticketStatus` / `coord*` precedent
(string sub-state, no new enum). Deploy via `db:push` (no migrations dir in repo).

```prisma
/// --- Venue change (feature-flagged, female-exclusive one-shot) ---
/// Sub-state on a `scheduled` match. Inert when VENUE_CHANGE_FEATURE_ENABLED off.
///   null / "none"    — no change requested
///   "proposed"       — female proposed a new venue, awaiting male decision
///   "accepted"       — male accepted; venue fields below are now canonical
///   "rejected"       — male declined → match also flips status=cancelled
///   "expired"        — TTL / T-5h cutoff lapsed → match also flips cancelled
venueChangeStatus     String?   @map("venue_change_status")
/// The female initiator (defensive — derived from gender, but stored for audit
/// and to enforce the one-shot rule across reconnects).
venueChangeProposerId String?   @map("venue_change_proposer_id") @db.Uuid
/// One-shot guard: set the moment she submits; a non-null value blocks re-propose.
venueChangeProposedAt DateTime? @map("venue_change_proposed_at")
/// Male decision deadline = min(now+12h, agreedTime - DATE_ALERT_HOURS).
venueChangeExpiresAt  DateTime? @map("venue_change_expires_at")
venueChangeResolvedAt DateTime? @map("venue_change_resolved_at")
/// Proposed replacement venue (verbatim from catalog pick).
venueChangeName       String?   @map("venue_change_name")
venueChangeAddress    String?   @map("venue_change_address")
venueChangeLat        Float?    @map("venue_change_lat")
venueChangeLng        Float?    @map("venue_change_lng")
venueChangeMapsUri    String?   @map("venue_change_maps_uri")
venueChangePlaceId    String?   @map("venue_change_place_id")
/// Mandatory ≥10-char explanation, shown verbatim to the male (blockquote).
venueChangeComment    String?   @map("venue_change_comment")
```

Add an index to drive the TTL sweep:
```prisma
@@index([venueChangeStatus, venueChangeExpiresAt])
```

**C2 = Option A:** the catalog centers on the existing `Match.venueLat/venueLng`
(midpoint). No real-venue-coordinate columns and no change to `resolveVenue` / the
finalize pipeline.

**Manual photos (`model CuratedVenue`):** add one optional column so the operator can
attach a hand-picked photo to curated rows:
```prisma
/// Operator-supplied venue photo URL (Supabase Storage or any hosted image).
/// Null for seeded-but-not-yet-photographed rows and for Places-fallback
/// catalog entries — the Mini App falls back to a category-badge placeholder.
photoUrl String? @map("photo_url")
```

`db:generate` + `db:push` on dev, then production per `deploy.md` (schema step).

---

## 2. API surface (public `/v1/*`, Telegram `initData` HMAC auth)

New router `apps/bot/src/public/routes/venue-change.ts`, mounted in
`public/server.ts` **before** the JWT `matches` router (same pattern as
ticket/calendar/location). All endpoints auth via `Authorization: tma <initData>`.
Every endpoint re-validates: match exists, caller is the **female** participant,
`status = scheduled`, not past the T-5h cutoff, and `venueChangeProposedAt` is null
(one-shot).

| Method | Path | Purpose |
|---|---|---|
| `GET`  | `/v1/venue-change/state?match=<id>` | Mini App bootstrap: original venue, eligibility (gender/cutoff/one-shot), current `venueChangeStatus`, localized disclaimer copy. |
| `GET`  | `/v1/venue-change/catalog?match=<id>` | List of eligible alternatives within 3 km of the original venue center (see §2.1). |
| `POST` | `/v1/venue-change/propose` | Body `{ matchId, placeId?, name, address, lat, lng, mapsUri?, comment }`. Server re-validates eligibility + comment length ≥10 + that the pick is within 3 km + passes the quality gate; writes the sub-state; DMs the male (see §3). |

### 2.1 Catalog sourcing (reuses existing services, no new deps)
Center = original venue center (C2 Option A = `Match.venueLat/venueLng`). Radius
= **3 km** (new constant `VENUE_CHANGE_RADIUS_KM = 3`, lives next to
`CURATED_VENUE_MAX_COMMUTE_KM` in `curated-venue.ts`).

1. **Curated-first.** Query `CuratedVenue` for the pair's `universityDomain`,
   filter to `haversineDistanceKm(center, venue) <= 3` and open-at-`agreedTime`
   (reuse `isVenueOpenAt`). Reuse `curated-venue.ts`; add a `listCuratedVenues`
   sibling to `pickCuratedVenue` (returns the filtered list instead of top-1).
2. **Places fallback** (only if curated list is empty / too thin, per Развилка 1.1):
   `searchNearby` / `searchText` from `venue.ts` centered on the original venue,
   `radiusMeters = 3000`, run every candidate through the existing `gate()`
   (operational + type deny-list + rating ≥4.0 + ≥30 reviews + student price).
   Add a `listVenueCandidatesNearby(apiKey, {lat,lng,radiusMeters})` that returns
   the gated+scored list (the seed path's `searchVenueCandidates` is the template —
   it already gates+scores but is `searchNearby`-only; generalize or add a sibling).
3. Server returns a capped list (e.g. top 12) with `{ placeId?, name, address,
   lat, lng, mapsUri, category, distanceKm, photoUrl? }`. `photoUrl` comes from
   `CuratedVenue.photoUrl` (manual) for curated rows and is **null** for
   Places-fallback rows. **Server re-validates the chosen place on `propose`** —
   never trusts a client-supplied venue blindly (same defensive stance as
   `/v1/calendar/pick` validating against `proposedTimes`).

> **Photos = manual, curated-only (v1).** No Places Photo API. The catalog renders
> `photoUrl` when present; otherwise a category-badge placeholder. The operator
> fills `CuratedVenue.photoUrl` by hand for the venues we curate.

---

## 3. Telegram bot logic

### 3.1 Scheduled-confirmation message split (`venue-negotiation.ts` `tryFinalize`)
Today both sides get the same `matchScheduled` DM + "Open in Maps" button. Change:
- **Male** → unchanged (Maps button only).
- **Female** (when `VENUE_CHANGE_FEATURE_ENABLED` and she's the female side) →
  same card **plus** a second inline `web_app` button "Сменить место" opening
  `${WEBAPP_URL}/venue-change.html?match=<id>&lang=<lang>`, and a one-line hint that
  this is a one-time, partner-confirmed option.
- Gate the extra button on gender + flag; same-sex handling per **C3**.
- Keep it Telegram-only v1 (mobile finalize path schedules directly; no button).

### 3.2 New callbacks (register in `handlers/matching/router.ts`)
New handler module `handlers/matching/venue-change.ts`:
- `vchg:accept:<matchId>` — male accepts. Atomic CAS (`venueChangeStatus = proposed`
  → `accepted`); copy `venueChange*` into the canonical `venueName/Address/Lat/Lng/
  GoogleMapsUri`; DM female "partner agreed" + send male an updated date card with
  `date_time` entity (reuse `buildDateTimeEntity`).
- `vchg:decline:<matchId>` — male taps decline → bot replies with the
  **confirmation guard** message + two buttons:
  - `vchg:cancel_confirm:<matchId>` → match `status = cancelled`,
    `venueChangeStatus = rejected`, apply C4 semantics, DM female the annulment.
  - `vchg:cancel_back:<matchId>` → re-show the original accept/decline keyboard.

All callbacks idempotent (re-tap after resolution → "already decided" toast), CAS on
`venueChangeStatus` like the ticket/coordination handlers.

### 3.3 TTL / cutoff sweep (date-lifecycle tick)
In `services/date-lifecycle.ts` (or a small `services/venue-change.ts` called from
the tick, mirroring `coordination.ts`): **before** the ice-breaker step, auto-expire
any match with `venueChangeStatus = "proposed"` where
`now >= venueChangeExpiresAt`. Expiry → `status = cancelled`,
`venueChangeStatus = "expired"`, DM both (neutral copy). This closes **C7**.

---

## 4. Frontend Mini App (`apps/webapp`)

New entry mirroring the location Mini App (vanilla TS) — add `venue-change.html` to
`vite.config.ts` `input` and to `deploy.md` smoke-check list.

Files:
- `apps/webapp/venue-change.html` + `apps/webapp/src/venue-change.ts` + a small CSS.
- Extend `apps/webapp/src/api.ts` with `getVenueChangeState`, `getVenueChangeCatalog`,
  `proposeVenueChange` (reuse the `tma <initData>` auth header pattern already there).
- Extend `apps/webapp/src/i18n.ts` (`en/ru/uk` — and `de/pl` if those are live) with
  the disclaimer, catalog, and comment-form strings.

Screens (per spec §2.Б):
1. **Disclaimer screen** (mandatory, blocking): one-time / irreversible / male can
   cancel the match / 3 km radius. Single "Я понимаю, продолжить" button, enabled
   immediately.
2. **Catalog**: cards (name, address, category badge, distance, and `photoUrl`
   when present — else a category-badge placeholder, per §2.1). Tapping a card opens →
3. **Comment form**: textarea with the placeholder from the spec; Telegram MainButton
   "Подтвердить" **disabled until ≥10 chars**. Submit → `POST /propose` → success
   state → `Telegram.WebApp.close()`. Persist the draft comment to `DeviceStorage`
   (existing util) so a swipe-down dismiss doesn't wipe it (same pattern as feedback).

Eligibility errors from `/state` (not female / past cutoff / already used) render a
terminal explanation screen instead of the catalog.

---

## 5. Shared package

- `packages/shared/src/constants.ts`: `VENUE_CHANGE_RADIUS_KM = 3`,
  `VENUE_CHANGE_TTL_HOURS = 12`. (Cutoff reuses `DATE_ALERT_HOURS`.)
- `packages/shared/src/i18n.ts`: all new user-facing strings (bot DMs: female button
  label, hint, male proposal message, accept/decline confirmation guard, annulment,
  expiry; Mini App strings) in `en/ru/uk` (+`de/pl` if present), keeping the
  "no English enum words in non-English" rule.
- `config.ts` (`apps/bot/src`): `VENUE_CHANGE_FEATURE_ENABLED` (default `false`).

---

## 6. Test plan (Vitest, file-scoped per AGENTS.md)

**Unit / pure logic**
- `curated-venue` catalog filter: 3 km inclusion/exclusion, open-at-slot reuse,
  category fallback.
- Eligibility resolver: female-only; same-sex rules (C3); cutoff (C1, T-5h boundary);
  one-shot guard (re-propose rejected).
- TTL computation: `min(now+12h, agreedTime - DATE_ALERT_HOURS)`.

**API (`apps/bot/src/public/*.test.ts`, like `ticket-api.test.ts`)**
- `/state`, `/catalog`, `/propose`: auth (bad initData → 401), not-participant → 403,
  wrong state (not `scheduled`) → 400, male caller → 403, comment <10 → 400,
  past cutoff → 409, second propose → 409, happy path writes sub-state + DMs male.
- `/propose` rejects a venue **not** in catalog / outside 3 km / failing the gate
  (server re-validation, not client-trusting).

**Bot callbacks (`handlers/matching/venue-change.test.ts`)**
- accept → canonical venue fields updated, female notified, idempotent re-tap.
- decline → guard shown; `cancel_confirm` → `cancelled` + C4 Elo semantics + female
  notified; `cancel_back` → restores keyboard.

**Lifecycle (`date.test.ts` / new)**
- pending change auto-expires at TTL and at the T-5h cutoff **before** ice-breakers;
  ice-breakers never fire on a stale venue while a change is pending (C7).

**Feature-flag off**: no female button rendered, endpoints behave as
unavailable/no-op — proves zero behavior change when `VENUE_CHANGE_FEATURE_ENABLED`
is false (mirrors the ticket/coordination "inert when off" guarantee).

---

## 7. Docs impact (per AGENTS.md Documentation Impact Check)

This feature changes a major user flow, the public API surface, the Prisma schema,
and adds an env var, so on implementation we update:
- **PRODUCT_SPEC.md** §3.7 / Phase 4 — the female venue-change sub-flow + invariant
  carve-out note for the one-shot comment (C5).
- **ARCHITECTURE.md** — new `Match.venueChange*` columns, the `/v1/venue-change/*`
  endpoints, and the date-lifecycle TTL sweep.
- **deploy.md** — `VENUE_CHANGE_FEATURE_ENABLED` env key, `venue-change.html` smoke
  check, `db:push` of the new columns.
- **Obsidian** — Changelog entry on ship; ADR if C2 Option B (data-model change to
  persist real venue coords) is chosen.

---

## 8. Suggested build order (after approval)

1. Schema columns + `db:generate`/`db:push` (dev).
2. Shared constants + i18n + `config` flag.
3. Catalog/eligibility services (+ unit tests).
4. Public router `/v1/venue-change/*` (+ API tests).
5. Bot: female-button split, callbacks, TTL sweep (+ tests).
6. Mini App `venue-change.html` (+ vite entry, api.ts, i18n).
7. Full `pnpm test` / `typecheck` / `build`, docs, Obsidian, git handoff.

---

## ✅ Decisions locked
All five questions resolved — see "Decisions (resolved)" at the top. T-5h cutoff;
midpoint-centered catalog (Option A); coordination-style same-sex rule; emergency-
cancel Elo semantics; manual curated-only photos via `CuratedVenue.photoUrl`.
Build order in §8 is cleared to begin.
</content>
</invoke>
