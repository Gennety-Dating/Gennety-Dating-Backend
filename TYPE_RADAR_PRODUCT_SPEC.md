# Type Radar — "Choose Your Type" (visual preference calibration)

> **Status:** design draft, pre-implementation (2026-07-19). Feature-flagged
> (`TYPE_RADAR_ENABLED`, default off), Telegram-only in v1 (explicit decision —
> see Mobile parity). The AI-memory export (Magic Prompt) **stays**; the radar
> is an additional onboarding step placed immediately **before** it.
> Photo dataset briefs + generation prompts:
> [`scripts/type-radar.dataset.draft.json`](scripts/type-radar.dataset.draft.json).

## Product summary

A fast visual calibration of appearance-type preferences inside the Telegram
onboarding Mini App. The user sees 10–12 contrasting AI-generated portraits and
answers binary "My type" / "Not my type". The server decomposes each photo into
pre-authored attribute tags (build, hair color/length, style, tattoos, beard)
and learns a preference vector. Ambiguity is resolved by a one-tap
**reason-chip attribution layer** ("what caught you here?" — the Ditto
pattern); pre-authored contrast pairs remain a fallback only. The result feeds a new soft multiplier
`V_type` in the match engine — launched in **shadow mode** (logged, not
applied) until accept/decline data proves predictive power (precedent:
`socialRole` — stored, not scored in v1).

Appearance level (attractiveness) stays owned by Elo/`V_league`; the radar
adds appearance **direction** (type/taste). Tags are categorical only — the
radar never scores "how attractive", preventing double-counting with Elo.

## Placement in onboarding

New Mini App phase `typeRadar` in `apps/webapp/src/onboarding-route.ts`,
inserted in `postVisualPhaseFromRemote` after `theme` and **before**
`aiMemoryExport`:

```
… city → theme → visual scenes → [TYPE RADAR] → aiMemoryExport → loading/handoff
```

Because `gender`/`preference` are collected later (conversational phase), the
radar opens with a one-tap **intent screen** — "Who are you interested in?"
(men / women / both) — which persists `User.preference` server-side. The
onboarding collector already picks "the first actually missing field", so a
pre-seeded preference is simply skipped later (same pattern as the Mini App
city/theme gates). `preference = both` serves an interleaved 8+8 subset of both
sets (marked lower-confidence).

Flow: intent tap → 12 binary cards (preload next 2–3 images; tap or swipe),
with a one-tap **reason-chip** question after the first 2 verdicts and after
model-surprising verdicts (cap 4/session, always skippable) → optional
contrast-pair fallback ("Which is closer to your type?") only for a confound
chips failed to resolve → done → `aiMemoryExport` phase as today. Unresolved
ambiguity after the caps is recorded as "no expressed preference" (neutral
weight) — never re-asked.

## Data model (additive, non-destructive)

| Column | Purpose |
|---|---|
| `Profile.typeRadarAnswers Json[]` | Raw audit: `{photoId, verdict, at}` per tap (incl. clarifications) |
| `Profile.typePrefTags Json?` | Computed preference vector: per attribute value `{score, confidence}` |
| `Profile.typeRadarCompletedAt DateTime?` | Phase-machine gate + idempotency |
| `Profile.appearanceTags Json?` + `appearanceTagsAt DateTime?` | Candidate-side tags extracted from the user's own photos (vision) |
| `match_score_logs.scoreType Float @default(1)` | Frozen factor per created pair (precedent: `scoreAgePref`, default 1 = neutral for old rows) |

No enums; attribute whitelists live in `packages/shared` (app-code validated,
like `socialRole` / venue categories).

## API surface (Telegram `tma <initData>` auth, on the telegram-onboarding router)

| Method | Path | Purpose |
|---|---|---|
| GET | `/v1/telegram-onboarding/radar` | Dataset refs for the chosen intent + progress (resume-safe). 404 while `TYPE_RADAR_ENABLED` off (pattern: `POST /track`) |
| POST | `/v1/telegram-onboarding/radar/intent` | Persist the one-tap preference (men/women/both) |
| POST | `/v1/telegram-onboarding/radar/answer` | `{photoId, verdict}` → server persists, returns `continue` \| `askReason {chips}` \| `clarify {pairId}` \| `done` |
| POST | `/v1/telegram-onboarding/radar/reason` | `{photoId, chipId}` (or explicit skip) → per-card attribution reweight, returns next step |
| POST | `/v1/telegram-onboarding/radar/clarify` | Fallback contrast pair: `{pairId, chosenPhotoId}` (or explicit skip) → next step or `done` |

`/state` mirrors `typeRadarEnabled` + `typeRadarDone` (pattern:
`phoneAuthEnabled`). The phase machine gates on both, so the flag off ⇒ the
phase never renders and legacy flow is byte-identical.

The Mini App never sends tag data — photo ids only; the server resolves
attributes from the shared dataset (client data is never trusted — same rule as
the venue-change board).

## Preference math (`apps/bot/src/services/type-radar.ts`, pure + unit-tested)

- Per attribute value `v`: `score(v) = (likes − dislikes) / shown ∈ [−1,1]`,
  `confidence(v) = min(1, shown/4)`; weight `w(v) = score·confidence`.
- **Shrinkage:** a user with no consistent signal converges to `w ≈ 0`
  everywhere ⇒ the factor goes silent instead of noisy.
- **Attribution layer (reason chips, Ditto pattern):** after a verdict the
  Mini App may ask one one-tap "why?" — chips mapped to the attribute space
  (face / figure / hair / style / tattoo / beard / whole vibe / bad photo; see
  `reasonChips` in the dataset draft). A named attribute gets a boosted
  per-card weight and the other attributes are discounted for that card;
  `face`/`bad photo` **exclude the card** from attribute learning entirely —
  the explicit noise channel that neutralizes reaction-to-the-specific-face
  confounds; `whole vibe` = uniform update. Asked after the first 2 verdicts
  (teaching moment) and afterwards only on model-surprising verdicts; hard cap
  4 per session; always skippable. Self-reports reweight ONE card and never
  override set-level statistics (declared attribution is
  rationalization-biased; the statistical and declared layers cross-check each
  other). Lifestyle chips (e.g. "too flashy/party") are **logged, not scored**
  (precedent: `socialRole`) — v2 research input.
- **Ambiguity/confound fallback:** for an attribute pair whose values
  co-occurred in this user's answer trajectory (high co-occurrence
  correlation, both with moderate `|w|`) and which chips did not disambiguate,
  serve the pre-authored contrast pair that decorrelates exactly that pair.
  Hard cap 2; the pairs may not ship in v1 at all (chips are expected to cover
  ~90% of cases).
- Candidate scoring: `raw = mean over attributes of w(candidateValue)`;
  `typeScore = 0.5 + 0.5·raw ∈ [0,1]`. Pair score averages both directions;
  a side without radar data contributes neutral (1.0).

## Matching integration (`match-engine.ts`)

```
MatchScore = ((w₁·V_explicit) + (w₂·V_research)) · V_league · V_agePref · V_type − (w₃·V_penalty) + starvationBonus
V_type = TYPE_PREF_FLOOR + (1 − TYPE_PREF_FLOOR) · typeScore
```

- `TYPE_PREF_FLOOR` env, **default `1.0` = shadow mode**: `V_type` is computed
  and logged to `scoreType` but the applied multiplier is exactly 1. Launch
  value after validation: **0.7** (dynamic range ×1.43 — deliberately the
  weakest factor in the formula; weaker than `V_agePref` and far below
  `V_league`). Never below ~0.6 (structural-starvation guard).
- **No SQL filters, no dealbreakers in v1.** Appearance never excludes; the
  hard-filter list (gender, city, lifetime ban, contact rail, single live
  match) does not grow.
- Pool-aware damping (phase 2 knob): when a city's eligible pool is below
  `TYPE_PREF_SMALL_POOL_SIZE` (default 40), raise the effective floor toward
  1.0 — the factor is near-neutral exactly where inventory is scarce.
- Monitoring: per-user **incoming** mean `V_type` (a systematically dampened
  user = the factor became a discriminator → tune); correlation of `scoreType`
  with `scoreLeague` (double-count check) and with accept rate (the go/no-go
  for leaving shadow mode) — all via `match_score_logs` /
  `/admin/analytics/algorithm`.

## Candidate tags (`elo-seed.ts` piggyback)

The Elo vision seed already sends every profile photo to one AI vision request.
Extend that same request to also return categorical appearance attributes per
photo (whitelist-constrained); majority vote across photos →
`Profile.appearanceTags`. Zero extra OpenAI calls at seed time. On photo edits
after seeding, the verification-rerun path triggers a tags-only refresh (the
Elo score itself stays seeded-once). Users without tags (e.g. not yet
re-scanned legacy profiles) are neutral on the candidate side.

## Dataset

- Canonical draft (attribute matrix, per-photo Russian review briefs,
  generation prompts, contrast pairs):
  [`scripts/type-radar.dataset.draft.json`](scripts/type-radar.dataset.draft.json).
- Attribute space (5 dims per gender, deliberately small — 12 binary answers
  cannot support more):
  - **Female set:** hairColor {blonde, brunette, red}, hairLength {long,
    short}, build {slim, athletic, curvy}, style {elegant, sporty, edgy},
    tattoos {yes, no}.
  - **Male set:** hairColor {dark, light}, beard {clean, beard}, build {lean,
    athletic, big}, style {classic, sporty, edgy}, tattoos {yes, no}.
- 12 photos per set arranged as a balanced fractional-factorial plan (each
  value appears 4–6×, attribute pairs decorrelated by construction) + 5
  pre-authored contrast pairs per set for clarifications.
- **Validity constraints (every photo):** the photos read as **amateur
  friend-shot smartphone snapshots** (founder decision 2026-07-19) — slightly
  imperfect framing, no professional lighting, no studio gloss — ecological
  validity: the user will judge real candid pitch photos, so taste must be
  calibrated in the same visual domain, and the scene primes the actual
  question ("do you want this person across the table?"). Front-camera
  selfies were considered and rejected: arm's-length framing crops at the
  chest and kills the build attribute. The scene is a **held constant**: ONE
  shared
  setting for the whole set (cozy warmly-lit evening café/bar, subject
  standing/leaning at the counter — never seated, build must stay readable),
  softly blurred background with no other people (vibe without distraction or
  scene-driven noise). Per-photo constants: three-quarter mid-thigh-up
  framing, direct gaze + the same light genuine "greeting my date" smile
  across the set, constant natural makeup (style/vibe is expressed through
  clothing ONLY), bare/short-sleeved arms (tattoo attribute visible or
  verifiably absent), comparable "girl/guy-next-door" attractiveness level
  (level must not confound direction), age 23–26. Varying the scene per photo
  is forbidden — an uncontrolled setting becomes a confound (user likes the
  bar's vibe, algorithm records "likes redheads"). If one scene feels
  monotonous, the sanctioned alternative is exactly TWO scenes balanced
  across every attribute value (each value split evenly between scenes).
- Contrast pairs: generate both frames from the same prompt with a **fixed
  seed** (`--seed` / Flux seed, MJ `--cref` for identity hold), swapping only
  the tested attribute descriptor.
- Assets: `apps/webapp/public/radar/*.jpg` → rides `deploy-webapp.sh` to
  `/var/www/dating-app/radar/`. NOTE: the Caddy `@assets` immutable-cache
  matcher covers `*.png`/`*.svg`/… but **not `*.jpg`** — either export PNG or
  add `*.jpg *.webp` to the matcher (one-line Caddyfile change).
- Machine dataset shipped to prod: `packages/shared/src/type-radar.ts` (typed
  photo ids + attribute vectors + contrast-pair index), generated from the
  approved draft. Prompts/briefs stay in the draft JSON only.

## Implementation phases

1. **Dataset** — approve briefs → generate photos (Midjourney/Flux) → founder
   visual QA against each brief → export assets + `packages/shared` module.
2. **Schema** — additive `db:push` (Profile columns + `scoreType`).
3. **Backend** — `services/type-radar.ts` (math, unit-tested), radar routes on
   `telegram-onboarding.ts`, `/state` mirror, elo-seed tag extraction +
   rerun-path refresh.
4. **Mini App** — `typeRadar` phase in `onboarding.tsx` / `onboarding-route.ts`
   (intent screen, card stack with preload, contrast-pair screen), i18n for
   all five languages in `onboarding-i18n.ts`, theme-aware.
5. **Engine** — `V_type` in `scorePair` + `scoreType` logging (shadow).
6. **Tests** — pref-vector/ambiguity math; route gating (flag off ⇒ 404 +
   phase absent); phase-machine resume (`onboarding-route.test.ts`); scorePair
   with/without tags; serializer of `/state`.

## Rollout / rollback

1. `db:push` (additive) → deploy backend with `TYPE_RADAR_ENABLED=false` →
   deploy Mini App bundle + photos (+ Caddy jpg cache line if needed).
2. Flip `TYPE_RADAR_ENABLED=true`: collection live, scoring still shadow
   (`TYPE_PREF_FLOOR=1.0` default).
3. After 3–4 weekly batches: evaluate `scoreType` vs mutual-accept rate. If
   predictive → set `TYPE_PREF_FLOOR=0.7` (env-only, live restart). If not →
   the radar remains an engagement/data step; matching untouched.
4. Rollback at any stage = flip the flag / floor back; additive columns stay.

## Mobile parity (Two Clients, One Backend)

**Telegram-only in v1 — explicit decision.** The radar lives in the Telegram
onboarding Mini App; native iOS users simply have `typePrefTags = null` ⇒
neutral `V_type` on their direction (the symmetric average still uses the
Telegram side's data). No `/v1` JWT route changes ⇒ no OpenAPI change. When
iOS adopts the radar, add the task to `~/Desktop/Gennety-iOS/IMPLEMENTATION_PLAN.md`.

## Docs impact (on implementation, not now)

- PRODUCT_SPEC §1.3: new radar step before the AI-memory screen.
- ARCHITECTURE: Profile columns, `scoreType`, radar routes.
- deploy.md: flag block (`TYPE_RADAR_ENABLED`, `TYPE_PREF_FLOOR`, db:push
  prereq, webapp bundle + photo assets, Caddy jpg note).

## Open questions

1. Retroactive rollout to existing active users (menu entry point?) or new
   users only? (Recommend: new users first; retro entry is a later add.)
2. Disclaimer on AI-generated calibration photos ("these are generated
   examples, not real users")? (Recommend: yes, one line on the intent screen.)
3. `both`-preference UX: 8+8 interleave vs full 24 — confirm tap-count budget.
