# City Expansion Playbook — Curated Date Venues

> **Purpose.** A repeatable, agent-runnable workflow for stocking the
> `curated_venues` base for a new city so the concierge proposes genuinely
> *cool, modern, student-loved* first-date spots — not just "operational + 4.0
> stars". Point Claude at this file in a new session:
> *"Follow scripts/CITY_EXPANSION_PLAYBOOK.md and add Berlin (universities:
> hu-berlin.de, fu-berlin.de)."* and it executes the steps below.

This sits on top of the curated-first venue system (PRODUCT_SPEC §3.7). The
Google Places quality gate already guarantees *not-a-gas-station* everywhere;
this playbook adds the *taste* layer that Places rating alone can't capture.

> **Read this first (updated 2026-07-30).** Venue Intent V2 changed the unit of
> expansion from **university domain** to **city**. Curated inventory is scoped
> by `cityKey`; `universityDomain` is now **affinity only** — a small ranking
> bump when *both* participants share the venue's domain
> (`services/venue-intent-v2.ts`). Two consequences run through every step
> below:
>
> 1. **`cityKey` is the load-bearing field.** Get it wrong and the venue is
>    invisible — no error, no log line, it simply never gets picked.
> 2. **A venue in the table is not a venue in the pool.** V2 applies four gates
>    (§0b) at selection time. A row that fails any of them is silently skipped,
>    so "537 rows imported" says nothing about how many are actually reachable.
>    Always finish with the effective-pool check in §7.

---

## 0. The quality bar (what "great" means here)

Audience: **university students, first date, no car, weekday evening slots
17:30–19:30, citywide or campus-local.** A venue earns a place in the base only
if it clears ALL of:

- **Public & safe** — open, walk-in, not private/intimate (deny-list handles the
  worst; use judgment for grey areas).
- **Affordable on a student budget** — cheap→moderate. No fine dining.
- **First-date appropriate** — easy to talk, not deafening, not a queue-only
  takeaway window, not a tourist trap you only visit once.
- **Actually cool / current** — the kind of place students *recommend to each
  other*: specialty coffee, trendy brunch spots, design-y cafes, buzzy casual
  restaurants, scenic parks, characterful museums, relaxed lounges. This is the
  signal that comes from **research (Step 1)**, not from Places rating.
- **Reachable** — within commuting reach of where students live/study (Step 2
  anchors). The runtime caps the worse commute at 8 km.

Categories (must be one of the whitelist — `isValidVenueCategory` enforces):
`cafe`, `coffee_shop`, `restaurant`, `park`, `museum`, `lounge`.

## 0b. The machine gate (what silently drops a venue)

Everything above is taste. These four are enforced in code at selection time
(`services/venue-intent-v2.ts` + `services/initial-venue-policy.ts`). A row that
fails any of them stays in the table looking healthy and is never proposed:

| Gate | Requirement | Bites hardest on |
|---|---|---|
| **Scope** | `cityKey` equals the pair's `Profile.homeCityKey` exactly | any new city (§1b) |
| **Hours** | `hoursConfidence ∈ {always_open, operator_confirmed}` **or** both `openingHours` and `utcOffsetMinutes` present | **parks** — Places rarely returns hours for them |
| **Quality** | `tier = base`, `rating ≥ 4.0`, `userRatingCount ≥ 30` | thin/new venues |
| **Price evidence** | `cafe`, `coffee_shop`, `restaurant`, `lounge`, **`museum`** need a known price of `free`/`inexpensive`/`moderate`. `expensive` is rejected. **`park` is exempt.** | **museums** — Places almost never returns `priceLevel` for them |

Two of these are counter-intuitive enough to call out separately, because both
produce a curated category that reads as fully stocked and contributes zero:

- **Parks need `"hoursConfidence": "always_open"` set by hand.** The pull leaves
  them `unknown` whenever Places returns no hours, and `unknown` is dropped.
- **Museums need a hand-added price tag** (`free` / `inexpensive` / `moderate`
  in `facetTags`). Without it every museum you approve is rejected as
  `unknown_price`.

Also note the selector reads `take: 60` ordered by `priority ASC` **before**
applying these gates, so a block of ineligible high-priority rows can crowd out
eligible ones. Keep `priority: 1` for venues you have actually verified pass the
gate.

---

## 1. Inputs (ask the user / confirm before starting)

- **City + country.**
- **University email domain(s)** in that city (e.g. `hu-berlin.de`). Each pair is
  matched within one domain, so venues are stored per domain. If several
  universities should share a venue pool, seed the same venue list under each
  domain.
- **(Optional) areas to favour** — neighbourhoods known for student life /
  nightlife / cafes.

If the user didn't give domains, find the official student-email domains first
(university IT pages) — the domain must match `ALLOWED_EMAIL_DOMAINS` shape.

### 1a. Resolve & whitelist the student email domain  (BLOCKING — DO THIS FIRST)

**This is the only step that can block the whole city, and it ships as code, not
data.** If a university's email domain doesn't end in a whitelisted suffix, its
students cannot register *at all* — no amount of curated venues changes that,
and the fix (`constants.ts` + rebuild + redeploy) is a deploy, not a data edit.
So resolve and merge the whitelist change **before** spending a day on venues.

> Scope note: this is the *student* track only. General-track users register by
> phone and never touch a university domain, so a city can launch for them with
> the whitelist untouched. Matching itself does not read `universityDomain` at
> all — it is not a filter and not a scoring factor. It matters here purely as
> the **student registration gate**, plus the small venue affinity bump.

There are **two different "domains"** and both matter:

- **`User.universityDomain`** — set to the **exact text after `@`** in the
  student's verified email (`onboarding-agent.ts`:
  `email.slice(email.indexOf("@")+1)`, lowercased). This is the partition key for
  matching AND for `curated_venues`. Curated venues MUST be seeded under this
  exact string (including any subdomain).
- **`ALLOWED_EMAIL_DOMAINS`** (`packages/shared/src/constants.ts`) — a list of
  **suffixes**; a student can only verify if their email `endsWith` one of them
  (`packages/shared/src/email.ts` `isAllowedEmail`). If the university's email
  domain doesn't end with a listed suffix, **those students cannot register at
  all** until you add it.

Procedure per university:

1. **Find the real student email domain.** Use `/browse`. Search engines often
   captcha headless — go straight to authoritative sources instead:
   - the university's own site → look for "Корпоративна пошта / Email / Webmail /
     Office 365 / Google Workspace" links (the mail host reveals the domain),
   - Wikipedia infobox "official website" (registrable domain ≈ email domain),
   - confirm the exact mailbox form (e.g. `name@uni.edu` vs `name@student.uni.edu`)
     from the IT/helpdesk page or a real student — subdomains change the
     `universityDomain` string.
2. **Check the suffix** against `ALLOWED_EMAIL_DOMAINS`.
   - Ends with a listed suffix (e.g. `.edu`, `.ac.uk`, `.edu.ua`) → works as-is.
   - Does NOT → add the domain (or its suffix) to `ALLOWED_EMAIL_DOMAINS` in
     `packages/shared/src/constants.ts`, then rebuild + redeploy. `isAllowedEmail`
     uses `endsWith`, so adding `"kpi.ua"` admits `@kpi.ua` and `@x.kpi.ua`.
3. **Record the exact domain string** — you'll seed venues under it in Step 5/6
   and pass it in the config in Step 2.

> Worked example — Kyiv (researched 2026-06-01):
> | University | Student email domain | Ends in allowed suffix? | Action |
> |---|---|---|---|
> | Kyiv-Mohyla (NaUKMA) | `ukma.edu.ua` | ✅ `.edu.ua` | works as-is |
> | KNEU | `kneu.edu.ua` | ✅ `.edu.ua` | works as-is |
> | National Aviation (NAU) | `nau.edu.ua` | ✅ `.edu.ua` | works as-is |
> | Igor Sikorsky KPI | `kpi.ua` (corporate mail `@kpi.ua`) | ❌ | add `kpi.ua` to whitelist |
> | Taras Shevchenko (KNU) | `knu.ua` / `univ.kiev.ua` | ❌ | confirm exact domain + add to whitelist |
>
> Takeaway: Ukrainian universities are split — many use `*.edu.ua` (fine), but
> big ones like KPI/KNU use bare `.ua` domains that the current whitelist blocks.
> Always verify; never assume the suffix.

### 1b. Resolve the `cityKey`  (the field that decides visibility)

`cityKey` is the primary scope the live selector filters curated inventory on.
It must equal, **as an exact lowercase string**, the `Profile.homeCityKey` that
real users in that city carry.

That value is built by `buildHomeCityKey()`
(`apps/bot/src/public/home-location.ts`) as `` `${countryCode}:${citySlug}` ``,
both lowercased — so Lviv is `ua:lviv`, Kraków is `pl:krakow`, Berlin is
`de:berlin`. Confirm rather than assume the slug for any city whose name
transliterates more than one way, by checking what the city picker actually
stores:

```sql
select home_city_key, count(*) from profiles group by 1 order by 2 desc;
```

`seed-venues` requires it explicitly — as a `"cityKey"` field on each config
entry, or `--city-key=ua:lviv` on the command line — and refuses to run without
one. It is deliberately **never inferred**: until 2026-07-30 the importer
guessed it from a regex over the input *file path*, defaulting to `ua:kyiv`,
which would have silently filed an entire new city's catalog under Kyiv.

---

## 2. Define anchor points

Students don't only meet next to campus, so we pull around **multiple anchors**,
not one. For each city pick **3–6 anchor points**:

1. Each campus / faculty cluster.
2. 2–4 trendy student / cafe / nightlife districts (e.g. Berlin →
   Kreuzberg, Neukölln, Prenzlauer Berg, Mitte).

Get each anchor's lat/lng from Google Maps (right-click → first numbers) or via
the research in Step 1. Radius per anchor: **2500–4000 m** (dense districts →
smaller; spread-out campuses → larger).

Write them into a per-city config file — `scripts/curated-venues.<city>.config.json`
(array; one entry per anchor — same `universityDomain` repeated is fine).
**Every entry carries `cityKey`** (§1b); the pull stamps it onto each candidate
so the import can't lose it:

```json
[
  {
    "_anchor": "Mitte — main campus",
    "universityDomain": "hu-berlin.de",
    "cityKey": "de:berlin",
    "lat": 52.5186, "lng": 13.3936,
    "radiusMeters": 3000,
    "categories": ["cafe", "coffee_shop", "restaurant", "park", "museum"],
    "defaultPriority": 2
  },
  {
    "_anchor": "Neukölln — student cafe belt",
    "universityDomain": "hu-berlin.de",
    "cityKey": "de:berlin",
    "lat": 52.4996, "lng": 13.4187,
    "radiusMeters": 3000,
    "categories": ["cafe", "coffee_shop", "restaurant", "lounge"],
    "defaultPriority": 2
  }
]
```

`_anchor` is a free-text note, ignored by the seeder — use it, the config is the
only record of *why* a coordinate was chosen.

---

## 3. Research the "cool" shortlist  (Claude: use the `/browse` skill)

Places rating finds *popular*; we need *cool + student-relevant*. Before/while
pulling, build an **editorial shortlist of venue names per district** from:

- "Best cafes / coffee / brunch / date spots in <city>" editorial lists
  (Time Out, local city mags, food blogs).
- Reddit: `r/<city>`, the local student subreddits — search "study cafe",
  "first date", "best coffee", "cheap eats".
- Google Maps curated lists / "popular with students" areas.
- The university's own student-life pages.

Output of this step: a per-category list of **named venues you'd personally
send a student on a date to**, with the district they're in. This list is the
ground truth you'll match the Places pull against in Step 5.

> Always use `/browse` for web research (per AGENTS.md). Never guess venue names
> from memory — they go stale and you'll invent closed places.

---

## 4. Pull Places-vetted candidates

```sh
pnpm seed-venues:pull --config=scripts/curated-venues.lviv.config.json \
                      --out=scripts/curated-venues.lviv.candidates.json
# optional: --per-category=12
```

This returns, per anchor × category, the top places that **pass the production
gate** (operational, type-clean, rating ≥ 4.0, ≥ 30 reviews, student-friendly
price) with `placeId`, coordinates, opening hours and UTC offset already filled
in — so anything you approve is automatically eligible for the re-validation
cron and the open-at-slot check.

---

## 5. Curate: approve, prioritise, tag  (the human/agent judgment step)

Open `scripts/curated-venues.candidates.json` and, for each candidate, decide
using the Step 1 bar and the Step 3 shortlist:

- **Approve** (`"approved": true`) only places that are genuinely cool *and* on
  or consistent with your research shortlist. Drop generic chains, mediocre
  "fine but forgettable" spots, tourist traps, and anything that feels off for a
  first date. Quality over quantity.
- **`priority`** (1 best … 3 acceptable):
  - `1` — iconic, students rave about it, you'd confidently send anyone here.
  - `2` — solid, pleasant, safe pick.
  - `3` — acceptable filler to ensure coverage in a thin area.
- **`vibeTags`** — lowercase tokens that match what users actually type as their
  vibe (the matcher does a lowercase exact-match against the user's parsed
  keywords, so use simple words): e.g. `cozy`, `quiet`, `vegan`, `brunch`,
  `specialty coffee` → use `coffee`, `outdoor`, `view`, `jazz`, `wine`,
  `dessert`, `study`. Keep 2–4 per venue.
- Leave `placeId` / `openingHours` / `utcOffsetMinutes` untouched (auto-filled).

**Two manual edits the pull cannot make for you** (both from §0b — skip them and
the category ships dead):

- On **every approved `park`** that came back without hours, add
  `"hoursConfidence": "always_open"`.
- On **every approved `museum`**, add a real price to `facetTags` — `free`,
  `inexpensive` or `moderate` — based on its actual admission. If you can't
  confirm it, drop the museum rather than guess: the tag feeds a hard policy
  gate, not a display string.

**Coverage targets per CITY** (not per domain — V2 scopes inventory by city):
- ~20–30 `cafe`/`coffee_shop` combined, ~15–25 `restaurant`, 4–8 `park`,
  3–6 `museum`, 4–8 `lounge`.
- These are targets for venues that **pass §0b**, not for approved rows. Expect
  to approve meaningfully more than this and lose some at the gate — verify with
  §7 and top up rather than assuming.
- Geographic spread: don't let one district dominate — students come from all
  over. Aim for picks near each anchor.
- Price mix skewed cheap; at least a few free options (parks are the reliable
  free tier — they're the one category exempt from price evidence).

### Adding a specific named venue that the pull missed
If a must-have spot isn't in the pull (outside radius / odd Places category),
either add an anchor near it and re-pull, or hand-add it to a separate file and
import (note: hand-added rows **without** a `placeId` are skipped by the
re-validation cron and treated as always-open):

```json
{ "approved": true, "universityDomain": "hu-berlin.de", "name": "...",
  "address": "...", "lat": 52.5, "lng": 13.4, "category": "cafe",
  "priority": 1, "vibeTags": ["cozy", "coffee"], "googleMapsUri": "https://..." }
```

### Expanding an approved chain

Approval is per physical Place, not per brand. Before adding more branches:

1. Enumerate current branches from the brand's official location page and
   Google Places text search.
2. Resolve each branch to a distinct `placeId`.
3. Apply the normal status, rating, review, price, hours, access, and
   first-date-suitability checks independently.
4. Do not inherit approval into temporarily closed, expensive, low-review,
   office-access-only, or otherwise unsuitable branches.
5. For Kyiv, record reviewed branches and rejected suggestions in
   `scripts/curated-venues.kyiv.expansion.json`, then run
   `pnpm sync-venues:kyiv --apply`.

Operator-blocked brands must be removed from the approved source and blocked in
the live Places gate so fallback search cannot reintroduce them.

---

## 6. Backfill V2 facet tags  (do this BEFORE importing)

`facetTags` is what makes the user's chosen ambience actually change the pick.
With it empty, every ambience chip (quiet / cozy_public / lively /
design_forward / scenic / romantic_public) scores **zero for every candidate** —
the vibe step runs, and silently decides nothing.

Part of it is worse than a soft signal: `indoor` / `outdoor` / `seated` /
`walking` feed the **hard** `VenueHardConstraints.setting` filter, so a park
without `outdoor`+`walking` is excluded outright when someone asks for a walk.

```sh
pnpm --filter @gennety/bot exec tsx ../../scripts/backfill-venue-facets.mjs \
  --in=scripts/curated-venues.lviv.approved.json          # dry run
pnpm --filter @gennety/bot exec tsx ../../scripts/backfill-venue-facets.mjs \
  --in=scripts/curated-venues.lviv.approved.json --apply  # writes the JSON in place
```

The script derives the hard setting facets deterministically from `category`
(never an LLM guess on a hard gate) and classifies the soft ambiences in small
LLM batches, leaving them empty when confidence is low. `hardCapabilities`
(dietary / alcohol_free / step_free) are deliberately untouched — those need
operator evidence.

---

## 7. Import

```sh
# dry-run first — prints the resolved cityKey and every row it would write:
pnpm seed-venues:import --in=scripts/curated-venues.lviv.approved.json
pnpm seed-venues:import --in=scripts/curated-venues.lviv.approved.json --apply
```

`cityKey` comes from the rows (stamped at pull). For a legacy catalog that
predates the field, pass it explicitly — `--city-key=ua:lviv`. The import
**refuses to run** rather than guess; check the `cityKey → …` line it echoes
before passing `--apply`.

Targets whichever DB `DATABASE_URL` points at: `.env.local` → dev,
**prod env (no `.env.local`) → production.** Seed prod with prod env.

---

## 8. Verify — count the EFFECTIVE pool, not the rows

Row count is not coverage. Reproduce the live gate and count what survives:

```sql
-- Rows the selector can actually reach, by category.
-- Mirrors services/venue-intent-v2.ts + initial-venue-policy.ts (§0b).
select category, count(*) as eligible
from curated_venues
where active
  and tier = 'base'
  and city_key = 'ua:lviv'                       -- the exact key from §1b
  and google_maps_uri is not null
  -- NB: `opening_hours` is a JSON column and empty rows hold the JSON literal
  -- `null`, which `is not null` treats as PRESENT while the code treats it as
  -- absent. Without the `::text <> 'null'` guard this query overcounts.
  and (hours_confidence in ('always_open','operator_confirmed')
       or (opening_hours is not null and opening_hours::text <> 'null'
           and utc_offset_minutes is not null))
  and rating >= 4.0
  and user_rating_count >= 30
  and (category = 'park'
       or price_level in ('PRICE_LEVEL_FREE','PRICE_LEVEL_INEXPENSIVE','PRICE_LEVEL_MODERATE')
       or facet_tags && array['free','inexpensive','moderate'])
group by category order by 2 desc;
```

Then check the three things that fail quietly:

```sql
-- 1. Nothing stranded outside the city scope (must be 0):
select count(*) from curated_venues where city_key is distinct from 'ua:lviv'
  and university_domain in ('lnu.edu.ua');       -- this city's domains

-- 2. Facets landed (should be ~all rows):
select count(*) filter (where facet_tags = '{}') as no_facets, count(*)
from curated_venues where city_key = 'ua:lviv';

-- 3. Parks are reachable (unknown hours = dropped):
select hours_confidence, count(*) from curated_venues
where city_key = 'ua:lviv' and category = 'park' group by 1;
```

- Spot-check 3–5 `googleMapsUri` links — right place, open evenings, looks cool.
- (Optional) `pnpm dev:trigger-test-match` with two test users in that city and
  walk the calendar → vibe/location flow to see a real pick.

---

## 9. Definition of done

- The §8 eligibility query returns venues across **≥4 categories**, at or near
  the §5 per-city targets. A category returning `0` there ships as "curated"
  and is dead — fix it before launching the city.
- `city_key` is correct on every row and nothing is stranded (§8 query 1).
- `facet_tags` populated (§8 query 2) — otherwise the vibe step decides nothing.
- Parks carry `always_open`; museums carry a real price tag.
- No mediocre/touristy/expensive entries slipped through (re-read the approved
  list once more before `--apply`).
- All seeded rows have `placeId` + hours (so the re-validation cron keeps them
  fresh).
- The student email domain(s) are whitelisted **and deployed** (§1a) — otherwise
  the student track for this city is closed regardless of venue coverage.

---

## Quick recipe (TL;DR for a new session)

1. Confirm city + university domains + districts.
2. **Whitelist the student email domains and ship it** (§1a) — blocking, it's a
   deploy. Resolve the `cityKey` (§1b) — everything below is scoped by it.
3. `/browse` → editorial + student shortlist per district/category.
4. Fill `curated-venues.<city>.config.json` with 3–6 anchors, each carrying
   `cityKey` → `pnpm seed-venues:pull --config=… --out=…`.
5. Curate the candidates: approve the cool ones, set `priority` + `vibeTags`,
   drop the rest. Add `always_open` to parks and a price tag to museums (§5).
6. `backfill-venue-facets.mjs --apply` on the approved file (§6).
7. `pnpm seed-venues:import --in=…` (dry-run) → `--apply` (prod env for prod).
8. Run the §8 **eligibility** query — not a row count. Any category at `0` is
   dead inventory; fix before launch.
