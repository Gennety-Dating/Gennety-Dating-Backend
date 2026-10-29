<!-- WHEN_TO_READ: You are changing venue intent selection (V2, 2026-07-21). Pairs with docs/architecture/ownership.md -> Venue Intent V2 ownership. -->
<!-- SOURCE: PRODUCT_SPEC.md (lines 7584-7682) — migrated 2026-09-01 -->

# Venue Intent V2 (2026-07-21)

Venue negotiation is a concierge flow shared by Telegram and iOS: departure
origin → five photo scenes and/or free-text vibe → one Continue tap → waiting.
As of 2026-10-21 there is no intermediate chip review or second confirmation.
Continue interprets and confirms in sequence; the server still stores the
canonical intent, and finalisation only uses confirmed intents. Ordinary chat
cannot overwrite a confirmed intent or cause it to be re-parsed at selection.

On Telegram the flow runs in the Location Mini App (`location.html` and
`location.ts`) with the same five photos, localized titles, crop anchors and
scene facets as native `VenueScene.swift`: coffee, dinner, walk, wine, surprise.
Four cards form a two-column grid; surprise spans the bottom row. All five cards have the same height (at least 176 px), with large bold
titles over the blurred photo. Profile mood tags are not shown. Suggestions
reorder the first four. Selection shows a ruby check
and dims other cards; a free-text field below can supplement or replace the
photo choice. The native and Mini App clients retain their existing authenticated
interpret/confirm API shapes. A single busy guard covers both calls, and a
failure keeps the description and chosen photo available for retry.

Restored drafts open the chooser with the saved origin and words. A no-candidates
notice returns there to edit the description; commute relaxation is offered only
for `no_candidates:commute_12_km`. Only explicit submissions from the native and
Mini App interpret routes set `replaceConfirmed`; chat and background callers
keep the existing confirmed-intent guard. This allows a user to rewrite their
wish after failure without letting an ordinary chat message erase a decision.
The existing chat search and native waiting animation are unchanged. Demo uses
the same UI and submission path, with its existing isolated synthetic partner.

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
