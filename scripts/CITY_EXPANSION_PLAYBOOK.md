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

### 1a. Resolve & whitelist the student email domain  (DO THIS FIRST)

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

Write them into `scripts/curated-venues.config.json` (array; one entry per
anchor — same `universityDomain` repeated is fine):

```json
[
  {
    "universityDomain": "hu-berlin.de",
    "lat": 52.5186, "lng": 13.3936,
    "radiusMeters": 3000,
    "categories": ["cafe", "coffee_shop", "restaurant", "park", "museum"],
    "defaultPriority": 2
  },
  {
    "universityDomain": "hu-berlin.de",
    "lat": 52.4996, "lng": 13.4187,
    "radiusMeters": 3000,
    "categories": ["cafe", "coffee_shop", "restaurant", "lounge"],
    "defaultPriority": 2
  }
]
```

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
pnpm seed-venues:pull            # reads config.json → writes candidates.json
# optional: --per-category=12  --config=PATH  --out=PATH
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

**Coverage targets per university domain** (rough, tune per city):
- ~10–15 `cafe`/`coffee_shop` total, ~8–12 `restaurant`, 2–4 `park`,
  2–4 `museum`, 1–3 `lounge`.
- Geographic spread: don't let one district dominate — students come from all
  over. Aim for picks near each anchor.
- Price mix skewed cheap; at least a few free options (parks/museums).

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

---

## 6. Import

```sh
pnpm seed-venues:import                 # dry-run: prints what WOULD be written
pnpm seed-venues:import --apply         # writes (idempotent upsert on domain+name+address)
# custom manual file:
pnpm seed-venues:import --in=scripts/manual-venues.json --apply
```

Targets whichever DB `DATABASE_URL` points at: `.env.local` → dev,
**prod env (no `.env.local`) → production.** Seed prod with prod env.

---

## 7. Verify

- `pnpm dev:db:studio` (or Supabase Table editor) → `curated_venues`: confirm
  counts, `active=true`, sensible `priority`, `last_verified_at` set.
- Quick SQL sanity:
  ```sql
  select category, count(*), min(priority), max(priority)
  from curated_venues where university_domain = 'hu-berlin.de' and active
  group by category;
  ```
- Spot-check 3–5 `googleMapsUri` links — right place, open evenings, looks cool.
- (Optional) `pnpm dev:trigger-test-match` with two test users on that domain
  and walk the calendar → vibe/location flow to see a real pick.

---

## 8. Definition of done

- Each university domain has venues across ≥3 categories with the coverage above.
- No mediocre/touristy/expensive entries slipped through (re-read the approved
  list once more before `--apply`).
- All seeded rows have `placeId` + hours (so the cron keeps them fresh).
- Verified a couple of real Maps links and, ideally, one test match.

---

## Quick recipe (TL;DR for a new session)

1. Confirm city + university domains + districts.
2. `/browse` → editorial + student shortlist per district/category.
3. Fill `curated-venues.config.json` with 3–6 anchors → `pnpm seed-venues:pull`.
4. Curate `candidates.json`: approve the cool ones, set `priority` + `vibeTags`,
   drop the rest.
5. `pnpm seed-venues:import` (dry-run) → `--apply` (prod env for prod).
6. Verify in Studio + spot-check links.
