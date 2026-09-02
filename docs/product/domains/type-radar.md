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
pre-authored attribute tags (archetype, hair color/length, tattoos, beard)
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

### Close → "thinking state" → next question

Between the Mini App closing and that next question the bot plays a **~10.7s
status sequence** in the chat (`services/radar-thinking.ts` +
`services/radar-scan-counter.ts`, rendered by the shared `runStatusSequence` —
PRODUCT_SPEC §1.3). Four scripted beats (900 / 1800 / 2500 / 1000 ms —
"checking your ratings", "reading your preferences", "looking for matches",
"running deep search") then a fifth whose profile counter climbs from 3–6 to a
target of 160–220 on a three-phase deceleration curve: small fast ticks
(+6…10 every 120–180 ms), then bigger slower ones (+11…19 / 280–380 ms,
+20…33 / 450–600 ms), landing exactly on the target and holding it 500 ms.
~16 frames, ~4.5 s.

Four things about it are load-bearing:

- **It is an explicit labor illusion** (founder decision, 2026-07-27). Nothing
  is being scanned: the verdicts were persisted before the sequence starts, and
  the matching it narrates does not run until the Thursday batch — days later,
  after photos and liveness. The copy ships as specified anyway; the accepted
  risk is a user reading "scanning profiles 187" as an imminent match.
- **Submit only, never Skip.** A skipper rated nothing, so "checking your
  ratings" would be a straight lie. `handleRadarSkip` resumes immediately as
  before.
- **First completion only.** A re-submit still resumes but never replays the
  animation.
- **It runs detached, after the HTTP response.** `POST /v1/radar/submit`
  answers immediately — the Mini App waits on that response to show its ✓ and
  close, so blocking it would strand the user on a spinner and then play the
  beats to a chat they only reach once it's over. The bot instead waits
  `RADAR_MINI_APP_CLOSE_LEAD_MS` (2200 ms, mirroring the Mini App's own
  2100 ms `CLOSE_DELAY`) before beat 1. Consequence: the session patch now
  lands ~13 s after submit instead of ~1 s, widening (not creating) the
  existing race with anything the user types in that window.

Kill switch: `RADAR_THINKING_ENABLED` (default on; also inert whenever
`TYPE_RADAR_ENABLED` is off, since the submit route 404s). Any failure in the
sequence is swallowed and the resume still happens — a cosmetic beat must never
cost the user their next onboarding step.

Flow: intent tap → 12 binary cards (preload next 2–3 images; tap or swipe),
with a one-tap **reason-chip** question after the first 2 verdicts and after
model-surprising verdicts (cap 4/session, always skippable) → optional
contrast-pair fallback ("Which is closer to your type?") only for a confound
chips failed to resolve → done → `aiMemoryExport` phase as today. Unresolved
ambiguity after the caps is recorded as "no expressed preference" (neutral
weight) — never re-asked.

**A card can be taken back (2026-08-30).** Until this the deck was one-way: a
verdict was appended and the deck advanced in the same step, with no inverse —
so a rushed tap, a misread photo, or the double-tap below wrote a permanent
answer into the preference vector, on a step reachable only during onboarding
and with no re-take surface anywhere. Nothing here forbade it; it was simply
never built.

An undo control sits over the card's top-LEFT corner, and each of the three
things about it is a constraint rather than a preference:

- **It is a 40px disc carrying the reason-chip's own treatment** — solid light
  fill, dark ink, the same double shadow. That is this screen's already-stated
  answer to "a control over an arbitrary portrait", so the back arrow adds no
  second idiom. The onboarding intro's graphite disc is deliberately not reused:
  at 3.5rem it would outweigh the two verdict buttons the screen is about, and
  it draws its glyph from an icon font `radar.html` does not load.
- **The header and the verdict row were both measured and rejected.** At 320px
  the RU title spans essentially the whole content box, so a control beside it
  either overlaps the words or forces them to wrap; and a third button in the
  verdict row shrinks two `flex: 1` buttons that German already fills, while
  putting an undo target inside the thumb's rating arc.
- **It is a sibling of the card, not a child**, so the chips phase's
  `radar-card-dim` brightness filter cannot dim the one control that gets a
  user out of that phase.

Two meanings, in this order: with the "why?" panel open, back cancels the
pending verdict and re-offers the same card (the likely intent there is the
other verdict, not leaving the card); from the rating phase it drops the
previous answer and re-asks the previous card, cleanly, so re-answering
REPLACES rather than appending a second entry for that photo. It walks back to
card 1 and then stops, and it is not rendered at all where it could not act.

**The last card cannot be undone**, and that is an accepted limit rather than an
oversight: recording the final verdict submits the deck in the same step. Adding
a confirmation to buy that back would put a step in front of every user to serve
the last card of twelve, on a funnel whose drop-off is measured.

**A double-tap can no longer answer a card the user never saw.** The next card
mounts under the same two buttons at the same coordinates, and the reason-chip
panel opens over that same foot of the card — so the second half of an
accidental double-tap landed a real verdict. Two committing taps closer together
than `TAP_LOCKOUT_MS` (350 ms) now count as one. That is above a double-tap
(iOS treats up to ~300 ms as one gesture) and far below any deliberate
look-at-a-face-and-decide, so the false-positive cost is one repeated tap.
**The back control is deliberately exempt** — the instant a user wants undo is
the instant after the tap that armed the lockout.

Client-side throughout: the deck answers all twelve cards locally and posts the
array once, so an undo touches no server state and needs no `/v1/*` change.

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

## API surface (Telegram `tma <initData>` auth, own `/v1/radar` router)

**Corrected 2026-08-30 — this table described four per-answer endpoints that
were never built.** The header block above has named the two real routes for
a while, so the stale part was the SHAPE, and the shape is the load-bearing
half: the server does not decide `continue` / `askReason` / `clarify` after
every tap — the Mini App owns the whole deck and posts the finished array
once. That is what makes "take a card back" a purely local edit with no
request to undo, and it is why anyone moving the write earlier turns undo
into a server concern.

| Method | Path | Purpose |
|---|---|---|
| GET | `/v1/radar/deck` | The cards for this user's set — gender-of-interest × age band, both read from the `User` row — with each card's reason chips. 404 while `TYPE_RADAR_ENABLED` off |
| POST | `/v1/radar/submit` | `{answers: [{photoId, verdict, chipId}]}` for the WHOLE deck → compiles `typePrefTags`, stamps `typeRadarCompletedAt`, resumes the chat. Rejects an empty array and caps the count at two full sets plus slack |

The contrast-pair fallback (`clarify`) is likewise unbuilt, exactly as
"the pairs may not ship in v1 at all" anticipated.

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
  (face / hair / style / tattoo / beard / whole vibe / bad photo — `style` credits
  the archetype, and `figure` was deleted with `build`; see
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

- Canonical brief (attribute matrix, per-card generation prompts, acceptance
  checklist): [`scripts/type-radar.deck-v2.md`](scripts/type-radar.deck-v2.md).
  The v1 artefacts (`type-radar.dataset.draft.json`,
  `type-radar.prompts.compiled.json`, `type-radar.band-a.final.md`) describe the
  RETIRED five-feature deck; each now carries a `retired` marker at the top.
  Nothing reads them, and a future age band compiles from the v2 brief, not from
  them.
- **Attribute space (v2, 2026-08-28 — one primary axis plus three secondaries).**
  A verdict now credits ONE cell rather than five:
  - **Both sets:** archetype {polished, sporty, urban, creative} — the primary
    axis, defined observably in `ARCHETYPE_DESCRIPTIONS` so the deck brief and
    the candidate-side tagger cannot drift apart; tattoos {yes, no}.
  - **Female:** hairColor {blonde, brunette, red}, hairLength {long, short}.
  - **Male:** hairColor {dark, light}, beard {clean, beard}.
  - `build` was REMOVED. The v1 space scored five independent features, so a
    like driven by one was recorded against all five, and the only channel that
    disentangled them — the reason chip — is asked on a minority of cards and is
    rationalization-biased. `build` in particular did not exist on screen: an
    audit of the v1 band-A renders (2026-08-20) found four female cards declared
    `curvy` and four `athletic` while all twelve read as slim, so eight of twelve
    taught a distinction nobody could see. It is also the attribute a VLM reads
    least reliably off a candidate's own photos, and ranking people by body type
    through an automated decision is the most exposed thing left after
    `ethnicity` was removed under Art. 9. Do not reintroduce it.
- **The archetype outweighs any single secondary** (`ATTR_WEIGHTS`, weight 2 vs
  1). This is not decoration: with 12 cards over 4 archetypes each value is shown
  exactly 3 times, so `confidence` caps at 0.75 while a hair value shown 6 times
  reaches 1.0 — the shrinkage would otherwise invert the intended ranking. The
  damping is correct on its own terms (3 observations IS thinner than 6), so the
  fix is the weight, not a looser floor.
- 12 photos per set, 3 per archetype, decorrelated by construction and enforced
  by `type-radar.test.ts`: no archetype carries a constant value on any secondary
  axis, exactly one card per archetype is tattooed, every value spans at least
  two locations, and at least one location is shared between archetypes.
- **Location is part of the construct since v2, not a nuisance factor.** v1 held
  it to three fixed scenes to keep the backdrop from becoming a hidden attribute;
  an archetype is partly *made of* where a person is photographed, so the deck
  now uses eleven locations and protects the same property differently — several
  locations per archetype, and three shared BETWEEN archetypes so the backdrop
  alone cannot identify one. `location` is still never scored and never sent to a
  client.
- **A measured bound on what the deck can separate (2026-08-28).** Face height as
  a fraction of the rendered card, measured with Vision across all 24 band-A
  frames, ranges 0.103 (`fs1`, full-body tennis) to 0.271 (`fa2`, tight
  portrait) — and the creative archetype is framed largest in BOTH sets, ~1.35x
  the smallest archetype mean. Closer framing reads as more intimate, so that is
  a confound on the primary axis. It is knowingly shipped rather than fixed:
  normalization is impossible from these sources (a tight portrait cannot be
  zoomed out, and zooming the full-body frames to the median would drop them
  below ~640px wide), and partial normalization does not close the gap because it
  lifts `fa3`, itself a creative card, in lockstep. Two things bound the damage —
  the within-archetype spread is ~2.2x, i.e. larger than the between-archetype
  signal, so it is not a cue a viewer could learn; and `V_type` is the weakest
  multiplier in the formula. The nine frames re-shot on the 2026-08-26 posing
  tail span 1.55x against 2.63x for the fifteen older ones, so the remaining
  spread lives entirely in frames predating that tail: re-shooting the four
  extremes (`fs1`, `fc3`, `mp1`, `fa2`) would bring the whole deck to ~1.55x.
- **Age bands (founder decision 2026-07-20 — NOT one age for everyone):** the
  shown set is age-matched to the **viewer's own age band**, not a fixed
  24/26. A single young set is wrong twice — (1) UX: showing a 22-year-old to
  a 46-year-old promises a pool that won't deliver; (2) methodology: attributes
  read differently with age (graying vs "light hair", beard), so taste
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
- **Validity constraints (every photo).** The register is **"heightened
  reality"** (founder decision 2026-08-22, superseding the 2026-07-19
  amateur-snapshot rule): a very good REAL photograph — an attractive place, warm
  light, clothes that fit — but never a magazine set-up. The earlier rule argued
  ecological validity (a user judges candid pitch photos, so calibrate in the
  same visual domain) and was dropped knowingly: the domain is broken anyway
  because the frames are generated, the deck's measurement value was near zero in
  practice, and the step's conversion is real. A frame that stands out by beauty
  **as a photograph** — light, composition, staging — is still rejected, or the
  deck measures taste in photography rather than in people.
  Since 2026-08-26 the subject **deliberately poses for their own feed**, which
  also fixed a failure the earlier tail caused: `caught mid-action` and
  `real eye contact` fought each other and the generator kept the action, so 7 of
  12 male frames came back in profile or with the face occluded.
  Subject standing or seated, softly blurred background, **no other people** —
  though the last of those is aspirational rather than achieved: roughly ten of
  the 24 shipped frames carry a soft out-of-focus person in the background, kept
  because cropping them out would tighten the framing the re-shoots existed to
  widen. **Ethnicity is a held constant matched to the launch
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

**The code did not honour that decision, and it dead-ended native onboarding
(fixed 2026-08-05).** The gate was written into `runAgentTurn` — shared by both
surfaces — while only the Telegram handler consumed its `typeRadarRequested`
result and attached the `web_app` + Skip buttons that clear it. So a native
caller received the invite copy as a bare question, on **every** turn, with
nothing to tap: the collector never advanced past `context_dump`/`photos`, and
the app's chat feed filled with the same message repeated. Since
`TYPE_RADAR_ENABLED=true` in production, this made iOS onboarding impassable
from the moment the flag was flipped — found by reading the simulator's chat
transcript, not by any test, because both existing gate tests exercised the
Telegram path.

The gate is now a property of the CALLER (`AgentDeps.canPresentTypeRadar`,
default true), not of the user: the public `/v1/onboarding/interview/{answer,
voice}` routes pass `false`. This is the right shape because the radar Mini App
authenticates with Telegram `initData` (`public/routes/radar.ts`) — a
mobile-only account (synthetic negative `telegramId`) cannot call it *at all*,
so the gate was unsatisfiable by construction rather than merely unimplemented.
Regression coverage: `onboarding-agent.test.ts` → "does not gate a caller that
cannot present the radar".

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
