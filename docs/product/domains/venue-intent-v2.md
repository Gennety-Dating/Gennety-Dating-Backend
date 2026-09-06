<!-- WHEN_TO_READ: You are changing venue intent selection (V2, 2026-07-21). Pairs with docs/architecture/ownership.md -> Venue Intent V2 ownership. -->
<!-- SOURCE: PRODUCT_SPEC.md (lines 7584-7682) — migrated 2026-09-01 -->

# Venue Intent V2 (2026-07-21)

Venue negotiation is a two-step concierge flow on Telegram and iOS: departure
origin → free-text vibe → editable canonical chips → one explicit confirmation.
The initial venue is always selected automatically; users never browse a venue
catalog in this flow. Confirmed V2 intent is stored per participant and is the
only input to finalisation; ordinary Telegram messages cannot overwrite it and
the server never re-parses it at selection time.

On **Telegram** the whole two-step flow runs inside the Location Mini App (a
branded **liquid-glass** screen — `apps/webapp` `location.html` + `location.ts`,
theme-aware via the shared `theme.css` tokens), not as chat buttons: step 1 marks
the departure origin on the map, then the SAME Mini App advances to step 2 — a
free-text vibe field plus the editable canonical chips grouped as Experience /
Atmosphere / Format / Must-haves (selection is the bright "self" signal, not a
faint ✓) — and one in-app Confirm. Confirm runs the V2 finalizer; when the
partner hasn't confirmed yet the bot DMs the classic "waiting for the other
side" cue (`venueWaitingPeer`), and when both have, finalisation delivers the
scheduled confirmation. The Mini App uses the initData-authed
`/v1/location/venue-intent/{state,interpret,confirm}` routes. (A short-lived
2026-07 variant presented the chips as **inline Telegram buttons in chat**
(`handlers/matching/venue-intent-chat.ts`); it was reverted 2026-07-23 —
inline buttons cannot carry the brand's liquid-glass design or a comfortable
text field, and origin capture already required the Mini App, so there was
nothing left to keep in chat.) The **iOS** client keeps its own native chip
screen via `/v1/matches/:id/venue-intent` (OpenAPI contract unchanged).
Finalisation of a
live-mode match delivers the FULL shared scheduled confirmation — the date-card
PNG (§3.7a), the tappable `date_time` entity, the Maps/Change-venue keyboard, the
grounded venue blurb, and the founder feed (`services/scheduled-confirmation.ts`,
shared with the legacy concierge path) — never a bare "venue ready + link" text.

Experience IDs: `conversation`, `coffee_treats`, `meal_discovery`, `walk_view`,
`art_culture`, `drinks_evening`, `playful_activity`, `surprise_me`. Ambience IDs:
`quiet`, `cozy_public`, `lively`, `design_forward`, `scenic`,
`romantic_public`. Format IDs: `seated`, `walking`, `interactive`, `indoor`,
`outdoor`. These are soft preferences. The only hard constraints are the
**required setting** (indoor/outdoor) and the **commute relaxation**.

**Dietary, alcohol-free and step-free were retired 2026-07-30** (founder
decision) — removed from the Mini App's Must-haves group and neutralized
server-side by `applyInitialVenueConstraintPolicy`, so a cached bundle or an
older native client resolves to the same state (the `/v1/*` fields stay in the
shape, marked `deprecated`, exactly like `maxPrice`). They were enforced as hard
filters requiring **positive** evidence on the venue — "unknown" counted as a
refusal — while the curated catalog carried that evidence for **0 of 1207
rows**, because Google publishes none of it and no operator pass had marked any.
Every one of those seven chips was therefore a guaranteed `no_candidates`, and
the failure copy then named the user's own requirement as the thing to relax:
a wheelchair user was told to drop step-free access, someone keeping halal was
told to drop halal. `minimalRelaxation` no longer has those branches. The
product's position is that needs this specific belong to the person rather than
to the matchmaker: if the assigned venue doesn't suit them, they change it on
the §3.7b board, or the couple simply agrees to walk somewhere else. The
enforcement code in `satisfiesVenueHardConstraints` is left intact and goes
inert on empty/false input, so re-enabling any of them is a one-line change once
the catalog can actually back it.

**Museums are not offered at all (founder decision 2026-07-31).** `museum` is
listed in `EXCLUDED_VENUE_CATEGORIES` (`services/curated-venue.ts`), which both
surfaces filter on: the automatic first assignment never picks one, and the
§3.7b venue-change board never lists one. A museum is a poor default for a
first meeting — timed, ticketed, quiet in the wrong way, and closing early
enough to rule out most of the evening slot grid. The catalog rows stay
`active` rather than being deleted, so the category is re-enabled by removing
one entry from that list. This does **not** empty the `art_culture` experience:
that facet is also carried through `vibeTags` by book cafes, art bars and
historic streets (7 Kyiv venues at the time of the decision), which are
arguably the better first-date answer anyway.

The automatic first assignment has a separate server-owned baseline policy:
only quality-eligible `base` inventory is considered; commercial venues need
positive price evidence at `FREE`, `INEXPENSIVE` or `MODERATE`; `EXPENSIVE`,
`VERY_EXPENSIVE`, `premium` and `exclusive` candidates are excluded before
ranking. Public parks may have no commercial price. (`museum` also sits outside
`PRICE_EVIDENCE_REQUIRED` — Google reports no `priceLevel` for museums at all —
but that is now moot while the category is excluded outright.) This is
not written as a participant preference and the initial clients show no price
chips. Price/exclusivity choice belongs to the post-assignment Venue Change.

Incompatible preferences use a deterministic bridge lane and max-min pair fit;
they never silently collapse to café. Every assigned V2 venue must be a real,
operational, open-at-slot public place with provenance, stable place/curated ID,
actual coordinates and Maps URI. Unknown evidence fails hard constraints and
unknown hours fail closed. If no candidate satisfies the pair, the match stays
`negotiating_venue` and the concierge identifies one constraint to relax. A
provider outage uses an eligible curated venue or durable 1/5/15-minute retries;
it never schedules a placeholder. The paid post-assignment Venue Change remains
unchanged.

Post-date feedback records `yes | partly | no` for whether the venue matched
the confirmed vibe, with optional structured reason chips. Only positive or
unrated historical intents can become future smart suggestions; historical
hard constraints are never reactivated.

Release is controlled by `VENUE_INTENT_V2_ENABLED`, deterministic live rollout
percentage and independent shadow percentage. Shadow ranking writes only the
append-only structured selection log and cannot mutate a match or notify users.
