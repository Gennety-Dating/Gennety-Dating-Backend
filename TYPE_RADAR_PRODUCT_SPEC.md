# Type Radar — "Choose Your Type" (visual preference calibration)

> **Status: IMPLEMENTED (2026-07-22), shipped dark behind `TYPE_RADAR_ENABLED`
> (default off).** As-built vs this design draft:
> - **Skippable step** (founder decision): the onboarding gate offers a Skip
>   button; a skip stamps `Profile.typeRadarCompletedAt` with empty
>   `typePrefTags`, so `V_type` stays neutral. Full skippable / mandatory /
>   soft-mandatory options were considered; skippable won for conversion.
> - **`typePrefTags` is stored per radar set** (`{ female?, male? }`) and the
>   engine selects the sub-vector by the *candidate's* gender (`setForGender`),
>   so a `both` viewer's male/female signal never conflates on shared attribute
>   values (athletic/sporty/edgy/tattoos).
> - **`V_type = TYPE_PREF_FLOOR + (1 − floor)·typeScore`**, neutral `1.0` on
>   shadow floor (≥1), no viewer signal, or zero tag overlap. `TYPE_PREF_FLOOR`
>   default `1.0` (no-op); launch ≈ `0.7`. Pure math + the multiplier live in
>   `packages/shared/src/type-radar.ts`.
> - **Candidate `appearanceTags` come from a dedicated ISOLATED vision pass**
>   (`services/vision/tag-appearance.ts`, cheap `visionFast` model) on the
>   verified branch — deliberately NOT piggybacked on the production Elo
>   attractiveness call, so a tagging regression can't perturb the live Elo seed.
> - **Routes:** `GET /v1/radar/deck` + `POST /v1/radar/submit` (Telegram
>   `initData` HMAC, feature-flag-gated 404). The onboarding gate lives in the
>   conversational agent (`typeRadarGatePending` at the request_context_dump /
>   request_photos boundary); the invite (web_app + Skip) and resume are in
>   `handlers/onboarding/type-radar.ts`. 24 band-A portraits ship at
>   `apps/webapp/public/radar/a/*.jpg`; the Mini App is `radar.html`.
> - **Schema (additive):** `Profile.typeRadarAnswers/typePrefTags/
>   typeRadarCompletedAt/typeRadarAgeBand/appearanceTags`,
>   `match_score_logs.scoreType`.
> - Band B/C portrait sets (ages 32/33, 42/43) are not generated yet — v1 runs
>   on band A only (`ageBandFor` still maps every viewer to a band; B/C reuse A's
>   ids until their images land).
>
> Deploy/rollout: see `deploy.md` → "Type Radar (feature-flagged …)".
>
> ---
>
> **Original design draft below (updated 2026-07-20).**
> Feature-flagged (`TYPE_RADAR_ENABLED`, default off), Telegram-only in v1
> (explicit decision — see Mobile parity). The AI-memory export (Magic Prompt)
> **stays**; the radar runs in the conversational phase immediately **before**
> the Magic Prompt is delivered — so `age`/`gender`/`preference` are already
> collected (age bands + gender set are read, not asked).
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

The radar is a Mini App **launched from the conversational onboarding flow**,
at the **AI-memory step boundary — right before the Magic Prompt is
delivered** (the moment the user paste-imports their ChatGPT memory). That is
where AI-memory import sits in the canonical collector order. For users who
declined AI-memory export, the same slot sits right before photos.

```
conversational collector:
name+age → gender → preference → height → hobbies → partner → nationality
        → vibe → [TYPE RADAR] → AI-memory import (Magic Prompt) → photos
```

**`age`, `gender`, and `preference` are ALL already collected by this point**
(they are the first three conversational fields), so the radar reads them
directly from the `User` row — **no intent screen, no age capture**.
Gender-of-interest picks the photo set; the user's own `age` picks the age
band (see *Age bands* under Dataset). `preference = both` serves an
interleaved 8+8 subset of both sets (marked lower-confidence). (This corrects
an earlier draft that placed the radar inside the onboarding Mini App before
the conversational phase, where age was not yet known — it isn't: the radar
runs after profile capture, right before the Magic Prompt.)

The bot opens the radar Mini App from chat ("before we go further, let's
calibrate your type"); on completion it proceeds to the Magic Prompt (or, for
decliners, to photos). The Mini App still authenticates with
`tma <initData>`.

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
| `Profile.typeRadarAgeBand String?` | Age band (`a`/`b`/`c`) shown to this user, derived from the already-collected `User.age` — audit + resume |
| `Profile.appearanceTags Json?` + `appearanceTagsAt DateTime?` | Candidate-side tags extracted from the user's own photos (vision) |
| `match_score_logs.scoreType Float @default(1)` | Frozen factor per created pair (precedent: `scoreAgePref`, default 1 = neutral for old rows) |

No enums; attribute whitelists live in `packages/shared` (app-code validated,
like `socialRole` / venue categories).

## API surface (Telegram `tma <initData>` auth, on the telegram-onboarding router)

| Method | Path | Purpose |
|---|---|---|
| GET | `/v1/telegram-onboarding/radar` | Dataset refs for this user's set — gender-of-interest × age band, both read from the `User` row (no intent/age input) — + progress (resume-safe). 404 while `TYPE_RADAR_ENABLED` off (pattern: `POST /track`) |
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
- **Age bands (founder decision 2026-07-20 — NOT one age for everyone):** the
  shown set is age-matched to the **viewer's own age band**, not a fixed
  24/26. A single young set is wrong twice — (1) UX: showing a 22-year-old to
  a 46-year-old promises a pool that won't deliver; (2) methodology: attributes
  read differently with age (build, graying vs "light hair", beard), so taste
  learned on young faces transfers poorly to an older candidate pool. The
  **attribute matrix / scene plan / balance is identical across bands** — a
  band changes ONLY the age descriptor in the prompt (a mechanical swap, like
  ethnicity/scene), so band B/C compile from the band-A prompts, not a rewrite.
  Bands (see `ageBands` in the dataset): **A 22–28** (this file's set, v1),
  **B 29–37**, **C 38–48**; architecture supports more, generation is scoped
  to the real pool. Anchor is the **viewer's age** — the already-collected
  `User.age` picks the band. Preferred-*partner* age (often skewed,
  e.g. men younger) is deliberately NOT baked into the radar default: that
  belongs to `V_agePref`/`ageRangeMin-Max`, keeping an age-gap assumption out
  of the product's defaults (same discipline as not scoring ethnicity).
- **Validity constraints (every photo):** the photos read as **amateur
  friend-shot smartphone snapshots** (founder decision 2026-07-19) — slightly
  imperfect framing, no professional lighting, no studio gloss — ecological
  validity: the user will judge real candid pitch photos, so taste must be
  calibrated in the same visual domain, and the scene primes the actual
  question ("do you want this person across the table?"). Front-camera
  selfies were considered and rejected: arm's-length framing crops at the
  chest and kills the build attribute. The scene is a **balanced nuisance
  factor** (founder decision 2026-07-19, replacing the earlier single-scene
  rule): exactly THREE fixed warm scenes — evening café / old-town street by
  a terrace / park at golden hour — 4 photos per scene per set, the
  assignment balanced so every attribute value appears in at least two
  scenes; scene effects therefore average out and cannot glue to any
  attribute. The per-photo `scene` field in the dataset is part of the
  design — never reassign it casually. Subject always standing/leaning
  (never seated, build must stay readable), softly blurred background with
  no other people. **Ethnicity is a held constant matched to the launch
  market** (Ukraine → Eastern European appearance on every frame): left
  unspecified, generators randomize it into the strongest uncontrolled
  visual confound of all; it is deliberately NOT a scored attribute (the
  existing text channel — the optional nationality/ethnicity onboarding
  question + `negativeConstraints` — owns that preference), and market
  expansion means a localized dataset per market. Per-photo constants:
  three-quarter mid-thigh-up
  framing, direct gaze + the same light genuine "greeting my date" smile
  across the set, constant natural makeup (style/vibe is expressed through
  clothing ONLY), bare/short-sleeved arms (tattoo attribute visible or
  verifiably absent), comparable "girl/guy-next-door" attractiveness level
  (level must not confound direction), age 23–26. **Aesthetic quality is a
  held constant too** (founder decision 2026-07-19): every photo is equally
  Pinterest-grade stylish (pleasing warm color grade, fashionably fitted
  clothes, nothing AI-rendered or sloppy), and each style archetype is an
  equally well-executed fashionable version of itself — a cheap-looking
  "sporty" against a chic "elegant" would measure taste for "well-dressed",
  not style direction; a frame that stands out for beauty *as a photo* is
  rejected. Varying the scene per photo
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
4. **Mini App** — radar Mini App launched from the conversational flow right
   before the Magic Prompt (reads gender/preference/age from the `User` row —
   no intent screen, no age capture): card stack with preload, reason-chip
   sheet, contrast-pair fallback screen; i18n for all five languages, theme-aware.
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
