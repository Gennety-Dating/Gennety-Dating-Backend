<!-- WHEN_TO_READ: You are changing how matches are produced or decided: cadence, pool exhaustion, synthetic test profiles, scoring, the pitch & synergy, the blind decision invariant, nudges, or the date ticket gate (Phase 3.1-3.5c). -->
<!-- SOURCE: PRODUCT_SPEC.md (lines 3026-4570) — migrated 2026-09-01 -->

## Phase 3 — Matching Engine & Progressive Scheduling

### 3.1 Cadence

**The cadence itself is a swappable profile (`packages/shared/src/cadence.ts`),
not a scattering of hardcoded constants (2026-08-01).** `DropCadence` bundles
every timing knob the matching engine and its surrounding workers read — the
batch cron, the proposal-decision deadline strategy, the match cooldown, the
starvation-bonus rate, nudge offsets, the famine-notice interval, the Profiler
rush window, and Rematch's blackout/limits — into one object, selected once at
boot by the `DROP_CADENCE` env var (`weekly` | `daily`, default `weekly`).
Everything below in this section describes the **`weekly` profile, which is
what production runs today** — `DROP_CADENCE` is not set in `/opt/gennety/.env`
and flipping it to `daily` is a separate, later decision gated on pool size,
not on anything documented here. The `daily` profile exists in code (nightly
cron `"0 18 * * *"`, a 30-minute-before-next-drop decision deadline instead of
a flat 24h, a 6h cooldown, and the §D10 pool-exhaustion pause below) but is
inert until that env var changes.

**Match daily, apologise weekly (founder decision 2026-08-02).** The notice
cadence is deliberately NOT tied to the drop cadence: `famineNoticeIntervalMs`
is **7 days in both profiles**, so switching to `daily` changes how often we
*look*, not how often we *write*. A drop that finds nobody sends **nothing at
all** — the user simply doesn't hear from us that evening — and the empathetic
check-in keeps the weekly rhythm and the same tier ladder it has today, with
the discount still landing on the second notice. At small pool sizes most
evenings genuinely have nothing to report, and a nightly "sorry, still no one"
would turn a background search into a daily reminder of failure. Two
consequences follow, and both are load-bearing:

- **Tiers count notices, not batches.** `computeTier` is denominated in
  `famineNoticeIntervalMs`, so a tier is "which message in this streak is
  this" — which is exactly what the tier-2 copy ("second time in a row")
  claims, and what makes `famineDiscountMinTier = 2` mean the same thing under
  any cadence. Denominating it in the batch interval instead (the original
  `daily` draft) would have made the second notice a user ever received arrive
  as tier 7 and select the most apologetic tier-3 copy, skipping tier 2
  entirely.
- **The pinned banner drops its countdown** whenever drops outpace the notices
  explaining them (`dropOutpacesNotices`) — see §2.1 mode 5. A timer is only
  honest if reaching zero resolves into something; under `daily` it would hit
  zero into deliberate silence six evenings out of seven.

See
`DAILY_MATCHING_MIGRATION_AUDIT.md` / `DAILY_MATCHING_IMPLEMENTATION_PLAN.md`
for the full migration design. Internal names were deliberately NOT renamed to
track this (`standbyCount`, `Profile.missedWeeks`, `Match.source = "weekly"`,
`runDropBatch`'s log prefix `[drop-batch]`) — the `/v1/*` API and Prisma schema
are cadence-agnostic by construction, so a future cadence flip is an env
change, not a migration.

- **No pre-drop teaser (removed 2026-07-27).** There is no Wednesday "your match
  is coming tomorrow" DM, and no pre-drop notification of any kind — the pitch
  itself is the first thing a user hears about a given cycle. The retired worker
  ran the FULL matching engine a day early (`previewWeeklyBatch`) and DM'd only
  the users that dry run happened to pair, which made the message a promise the
  Thursday batch could not keep: nothing reserved the previewed pair, so 24 h of
  new registrations, status changes, profile edits, or a paid Rematch could
  re-route either side. The gap was structural rather than a rare race —
  `runWeeklyBatch` refreshes dirty embeddings and auto-unsuspends *before*
  pairing while the teaser did neither, so Thursday's pool was systematically
  larger than Wednesday's preview. A user could therefore be promised a match
  and then receive the no-match notice. Framing the teaser as a neutral
  "drop is tomorrow" line was considered and rejected as well: the pinned status
  banner (§2.1) already carries a live countdown to the exact drop time, so a
  second reminder would restate it while adding a weekly full-pool matching run.
  The agent's product playbook must not describe a teaser
  (`services/product-playbook.ts`).
- **Weekly batch** — Thursday 18:00 Europe/Kyiv (`MATCH_CRON_SCHEDULE = "0 18 * * 4"`).
- **No-match notice** — Thursday 18:15 Kyiv (`NO_MATCH_NOTICE_CRON_SCHEDULE = "15 18 * * 4"`).
  An empathetic DM goes to every eligible-but-unpaired user. Tier escalates
  with consecutive famine count (1 / 2 / 3+); idempotent via
  `NoMatchNotice@@unique([userId, dropDate])`. **The cron is not the throttle**
  — `CADENCE.famineNoticeIntervalMs` (7 days, both profiles) is a query-level
  filter, so the real guarantee is at most one notice a week per user however
  often this schedule fires. Under `weekly` the two coincide and every drop
  that leaves someone unpaired sends exactly one notice; under `daily` the cron
  ticks nightly and most evenings send nothing (§3.1). The DM is delivered through the
  native rich AI-compose draft stream (`streamDraftsToChat(..., { rich: true })`,
  the same primitive as the match pitch), so it reads as personally composed
  rather than a mass-blast template. It is a deliberately **short** 2-chunk
  stream — one "thinking" lead beat (`noMatchStreamStart`, a `<tg-thinking>`
  shimmer) then the full message as the plain final `sendMessage` — so bad news
  is never spelled out slowly. Degrades to the classic edited stream when a
  client can't render rich drafts.
  **Both rails since 2026-08-22.** The service used to skip anyone with
  `telegramId <= 0n` under a comment saying "push goes via the Expo path" — a
  rail removed 2026-07-18 and never built, so an app-only user simply never
  learned a drop had passed them by. Gender-free but the same shape as the
  §Phase 4 safety brief: the QUERY selects who was left unpaired, and
  `platform` selects the rail (`telegramReachable` / `pushReachable`), so a
  `both` account hears it twice and only an account reachable on neither rail
  is `skipped`. The push (`match.none`) is **one empathetic line and nothing
  else**: it names no partner, and it deliberately carries no famine discount —
  the discount's conditions are checked in the DM that grants it, so a push
  promising it could promise wrongly. The four DM branches (famine tier,
  market-pending with its city button, pool-exhaustion pause, discount) do not
  travel to the lock screen, but none of them cancels the push either.
  When `TICKET_FEATURE_ENABLED` and the famine streak reaches **tier ≥ 2**
  (2nd consecutive week+), the same DM also grants and announces a one-time
  **single-ticket discount** (see §3.5b — *Famine discount*).
  **One branch is not a famine message at all (2026-07-28):** an account whose
  city is not a launched market (§1.3) was never in the drop, so "no match this
  week" would misdescribe what happened and the escalating tiers would sell
  patience for a queue they are not in. Such a user gets
  `noMatchCityNotLaunched` — a plain `sendMessage` (not the "we really looked"
  rich stream, which would be a lie: nothing was searched) naming their city,
  saying we have not launched there, and carrying the one-tap switch to a
  launched market. The famine discount and the paid Rematch offer are both
  skipped — a paid re-run cannot find them anyone either. The `NoMatchNotice`
  row is still written, so the drop stays idempotent.

### 3.1b Pool exhaustion: honest pause + auto-resume (2026-08-01, code shipped, inert under `weekly`)

A famine-tier DM is honest about "no match yet" but says nothing once the
pool has genuinely run dry — under `weekly` cadence that's rare enough not to
matter, but a faster cadence makes "keep waiting" a promise the product
increasingly can't keep. Rather than escalate tiers forever, a user whose
`computeTier` day-count reaches `FAMINE_PAUSE_AFTER_DAYS` (28 —
`packages/shared/src/constants.ts`, a flat day-count deliberately independent
of `CADENCE`, chosen so it clears tier 3 under `weekly` before ever firing)
is transitioned `active → paused` by the SAME compare-and-set the menu's own
Pause button uses (`services/account-status-transitions.ts`), with
`Profile.starvationPausedAt` stamped to mark it as system-initiated (distinct
from an ordinary user-chosen pause, which never sets this column). The user
gets one honest DM (`poolExhaustedPauseNotice`, all 5 locales) instead of
another famine tier: the pool is empty right now, the account is paused (not
broken), and it resumes automatically or via the ordinary Resume button at
any time. A market-pending user (§1.3) is never a candidate for this — they
have their own city-switch messaging and were never really "in the pool".

Auto-resume (`services/pool-exhaustion.ts`, `autoResumeStarvedUsers`) runs in
the same cron tick as the famine-notice sweep: for every system-paused user it
probes `findCandidatesFor(userId, 1, { allowPausedSeeker: true })` — the exact
single-seeker check Rematch already uses, widened by one opt-in option so a
`paused` seeker can be probed without the ordinary `status === "active"` gate
rejecting it outright. A non-empty result CAS-resumes the account, clears
`starvationPausedAt`, and sends `poolExhaustedResumeNotice`. An ordinary
manual Resume (menu button, any reason) also clears the marker, so a user who
resumes themselves is never later swept up by the auto-resume probe as if
nothing had happened.

### 3.1c Synthetic test profiles (feature-flagged, temporary, Telegram-first)

A **friends-and-family production test** mechanism, gated by
`SYNTHETIC_FILL_ENABLED` (default **off** → nothing below exists). It is
scaffolding with an end date, not a product feature: it exists so a real
cohort can walk the real product on real clocks while the pool is still too
thin and too skewed to pair anyone. It must be removed before the product
opens past that cohort (`pnpm synthetic:remove -- --apply`).

**Why it exists.** Matching is same-city and strictly two-sided, so a market
with six men and one woman produces at most one pair per drop no matter how
good the engine is. Five people then get nothing — and under a daily cadence
they get nothing five nights running, which is not a test of the product, it
is a test of their patience.

A **synthetic profile** is an ordinary `User` + `Profile` carrying one marker,
`User.syntheticAt`. Everything that renders a person — the pitch generator,
the match card, the decision flow, the expiry card — reads it exactly as it
reads a human, because a test that special-cases the thing being tested is
worth nothing. Seeded from an operator manifest
(`scripts/synthetic-profiles.json`) by `scripts/seed-synthetic-profiles.mjs`;
nothing in the running product creates one.

**They are offered only when the real pool could not pair someone.** That is
structural, not a scoring bias: `runDropBatch` runs its ordinary pass over real
users alone, and only then hands the LEFTOVERS to a second pass
(`previewSyntheticFill`) whose one added rule is that a pair must have exactly
one synthetic side. So a real partner always wins by construction, and no
weight can be mistuned into preferring a stand-in. The second pass reuses the
same eligibility snapshot, lifetime pair ban, distances, scorer and greedy
allocator as the first — it is the same engine, over a smaller pool.

**They always decline**, `SYNTHETIC_DECLINE_DELAY_MS` (20 min) after dispatch
and never before the human has answered (`workers/synthetic-partner.ts`,
through the ordinary `applyMatchDecision`). Both halves are load-bearing:

- **Declining is the safety mechanism, not a limitation.** A mutual accept
  opens the §3.5b Date Ticket gate, and the product would then invite a real
  person to spend real Telegram Stars on a meeting that cannot happen.
- **Answering second** makes the §3.4 blind-decision invariant trivially safe
  — no outcome exists before the user has earned the right to see one — and it
  is the better test: someone who accepts sits in the genuine wait, sees the
  §3.6b peer-wait shimmer, and gets the real mixed-outcome reveal.

**The consequence to hold onto: a synthetic match cannot test anything past
`proposed`.** The ticket gate, the calendar, venue selection, the date card,
the venue-change board, pre-date coordination, the proxy chat and the post-date
feedback are all unreachable through one, even though every one of those flags
is on in production. That half is tested on `@gennetytestbot` with
`scripts/dev-e2e-full-flow.mjs`, and this mechanism is not a substitute for it.

**A synthetic match leaves no trace on the real user.** A partner that declines
100% of the time by construction carries no information, so its verdict is not
allowed to become data:

- **Elo** — `updateEloScores` no-ops when either side is synthetic. The guard
  is inside that function rather than at its three call sites, so a future
  caller inherits it. Without it a week of testing walks each participant down
  `V_league` on losses that were scripted, changing who they match with in the
  very test the profiles exist to enable.
- **`standbyCount`** — a synthetically-paired user is excluded from BOTH
  branches of the drop batch's starvation update: no reset (it was not a real
  partner) and no increment (they did not go hungry). This is what keeps
  `starvationBonus` and `scripts/normalize-standby-count.mjs` measuring real
  famine.
- **Silent ignore** — ghosting a synthetic increments nothing and costs
  nothing. The counter is skipped as well as the penalty, deliberately: it is a
  forgive-once ladder, so letting scripted matches consume a user's forgiveness
  would make their first genuine ghost cost them a penalty they had not earned.
  They still receive the real expiry card.
- **Priority boost** — `boostAcceptedSidePriority` is skipped for the same
  reason as `standbyCount`; it writes the same column.

**Money never touches them.** `buildCandidateSql` excludes synthetics
unconditionally, which is one line covering every single-seeker path at once —
the paid Rematch (§3.11) and the §3.1b auto-resume probe. A man who buys a
Rematch when only synthetics remain is honestly told nobody was found and
refunded. Separately, the post-cancellation Rematch **offer** is suppressed on
a synthetic pair: selling a paid consolation for a rejection the product itself
staged is not a trade this product makes. The pinned-banner entry (§2.1 mode 5)
still exists for a man who goes looking on his own — that one he arrives at.

**Reachability.** A synthetic carries `platform: "mobile"` with a negative
`telegramId` in a reserved band, which is the existing mechanism for a
participant the bot cannot DM (ARCHITECTURE.md → `users`), so the Profiler,
re-engagement, the pinned status banner and the famine notice skip them with no
new branch anywhere. Its contact rail is `registrationTrack: "general"` plus
`phoneVerifiedAt` with **`phone` left NULL** — the general branch of the gate
tests the timestamp, not the number, and inventing one would permanently block
the real person who eventually owns it, since `User.phone` is `@unique`.

**How many are needed, which is the operator's real constraint.** The lifetime
pair ban (§3.2 filter 6) applies to synthetics too — a deliberate founder
decision, not an oversight — so one profile is one showing per person. With `M`
real men and `N` synthetic women a drop covers `min(M, N)` of them, and full
coverage for `D` drops needs `N ≥ max(M, D)`. When they run out the user simply
falls back to the ordinary famine path, which needs no handling.

**Re-seeding has one hard precondition: the dispatch-disposal fix (§3.3) must be
live first.** A synthetic carries `platform: "mobile"`, so its side of a pitch
returns early without recording a `pitchMessageId` — which means a synthetic
pair has exactly ONE Telegram-reachable side, and a failure there (the user
blocked the bot, a 403 on the photo album) leaves *both* ids null. That is
precisely the shape that used to leave the row `proposed` with `dispatchedAt`
null: invisible to the expiry sweep, the countdown and both nudge cadences at
once, while holding both participants out of every drop for good. It is not a
hypothetical — it is what production ran into, and the tester on the other side
of it got nothing for five days. Seeding restarts match creation, so seeding
onto a deployment without `disposeUndeliveredMatch` re-arms that bug on the
same cohort it was found on. Check `pnpm audit:stuck-matches --prod` reads zero
stranded rows before and after.

**Pairs are stamped `Match.source = "synthetic"` and write no
`MatchScoreLog`** — the outcome says nothing about scoring quality, so it is
kept out of the algorithm A/B rather than filtered out of it later. The admin
health classifier files these accounts as `test`, so they stay out of every
conversion denominator.

**iOS:** no `/v1/*` change. Synthetics live at the pool level, so a native
client sees them exactly as Telegram does, which is correct.
**Demo mode:** inert. The drop cron is not scheduled under `DEMO_MODE_ENABLED`
at all, and the demo database has no rows carrying the marker.

### 3.2 Scoring (`services/match-engine.ts`)

Hybrid SQL + Node.js re-rank.

```
MatchScore = ((w₁·V_explicit) + (w₂·V_research)) · V_league · V_agePref · V_type · V_intent
                                                − (w₃·V_penalty) + starvationBonus
```

- `V_explicit` (cosine similarity of the 1536-dim profile embedding), weight
  0.65 (lowered from 0.80 on 2026-06-21). The embedding now carries only
  open-ended psychological prose: demographics (age/gender/height/city) that
  duplicate `V_research`/hard filters were stripped from the declined-profile
  fallback text, and the §1.3 vibe answers were folded in, so the embedding
  finally has real signal for users who skip the Magic Prompt.
- `V_research` (structured compatibility heuristics), weight 0.35 (raised from
  0.20). Sub-factors (weighted, renormalised over whichever are present):
  **vibe quadrant proximity** 0.40 (PRIMARY), age gradient 0.20, height norm
  0.20, educational homogamy 0.20. The quadrant factor scores *proximity*
  between the two users' `energyAxis`/`orientationAxis` (§1.3) — similar tempo
  lands in the same/adjacent quadrant, a big tempo gap is penalised harder than
  an orientation gap. This **replaces** the old keyword-scanned "social energy"
  factor (which was phantom — it scanned `psychologicalSummary` for the English
  words introvert/extrovert and almost never fired). `socialRole` complementarity
  is intentionally NOT scored yet (Phase 2 — needs accept/decline data).
- The explicit/research re-split is **inside** the positive bracket, so it does
  not change `V_league`'s role: beauty still multiplies the whole bracket
  identically. `V_league` is unchanged.
- `V_league` — universal Elo-distance multiplier and the **primary
  (assortative) match gate**. Elo is seeded from the AI vision attractiveness
  pass (0..100 → Elo 200..800, 6 Elo per attractiveness point), so this is in
  practice an *attractiveness-similarity* multiplier. Same league = 1.0,
  decays linearly past `LEAGUE_TOLERANCE = 60`, floors at `LEAGUE_FLOOR = 0.05`.
  Tightened 2026-06-06 so similar attractiveness decides *whether* a pair is
  viable, while psychology (embedding/research) ranks pairs *within* a tier:
  a ~10pt looks gap still gives 1.0, ~20pt → 0.70, ~30pt → 0.40, ~40pt → 0.10,
  and a "90 vs 30" pairing floors at 0.05 (effectively never matched unless the
  starvation bonus rescues a long-unpaired user). Example: an Elo gap of 180
  (≈ a 30-attractiveness-point difference) yields `V_league ≈ 0.40`, so a pair
  that is far apart on looks must have an exceptional psychological/embedding
  fit to outrank a same-tier pair.
  - **Male upward reach (hetero pairs only).** `V_league` is *asymmetric* for
    M/F pairs (`pairLeagueScore`): when the woman out-scores the man, the gap
    is discounted by `MALE_REACH_ELO` (env, default 36 Elo ≈ 6 attractiveness
    points) before the decay — so a less-attractive man is paired with a
    somewhat *more*-attractive woman without the league penalty crushing the
    match. With the default reach a man matches at full strength (1.0) with
    women from his level up to ~16 attractiveness points above him. Matching
    "down" (man already more attractive) is unchanged, and same-gender /
    unknown-gender pairs keep the symmetric `leagueScore(|Δ|)`. This stacks on
    top of the gender-calibrated vision scoring (§1.4), so the reach is kept
    deliberately small to avoid women systematically receiving visibly
    less-attractive partners.
- `V_agePref` — **stated preferred-partner age-band** multiplier
  (`ageRangePreferenceScore`, `Profile.ageRangeMin/Max`). Applied to the
  positive bracket alongside `V_league`. It is a **soft preference, not a hard
  filter**: a candidate whose *actual* age is inside the seeker's stated band
  scores `1.0` (neutral); outside, the bracket is damped by
  `1 − yearsOutside·AGE_RANGE_PREF_DECAY_PER_YEAR` (default 0.1/yr), floored at
  `AGE_RANGE_PREF_FLOOR` (default 0.6) so a far-out-of-band partner is dampened
  but never excluded — an exceptional embedding/league fit can still surface
  them, and a thin city pool is never starved. Symmetric: `scorePair` evaluates
  each side's band against the other's age and averages. **Neutral (1.0) when
  the user never set a band** — the band is not collected at onboarding, so the
  common path is unchanged; only users who explicitly edit the range opt into
  the dampening. Distinct from the `V_research` *age gradient* (which scores the
  closeness of the two real ages); both can apply at once. Tunable via env
  (`AGE_RANGE_PREF_FLOOR` / `AGE_RANGE_PREF_DECAY_PER_YEAR`); set the floor to
  `1.0` to disable.
- `V_intent` — **relationship-intent agreement**, the weakest multiplier in the
  formula and deliberately so (`intentMultiplier`, `packages/shared/src/relationship-intent.ts`).
  Both sides pick one or more points on a single ordered axis at the end of
  onboarding — `spark` → `open` → `falling` → `longterm`, i.e. how far ahead
  they are looking (§1.3) — and the factor scores their agreement:
  `1 − distance/3`, blended against `INTENT_FLOOR`. At the launch floor of 0.85
  that is a **×1.18 range** (identical 1.0, one step 0.95, two 0.90, opposite
  0.85), against `V_type`'s ×1.43 and `V_league`'s ×20. It reorders neighbours
  inside a league; it cannot outrank a real difference in league or psychology,
  and that ceiling is the whole design rather than a tuning accident.
  - **The distance between two SETS is the SMALLEST gap between them**, so any
    overlap scores 1.0. That is what makes multi-select safe (§1.3): the factor
    damps only where both sides are specific AND opposed, and a broad answer
    means "do not filter me on this" rather than "I am far from everyone".
    A user who picks all four is arithmetically indistinguishable from one who
    never answered — which is why the screen needs no cap, and also why **how
    many** options people pick is worth watching: a population that mostly picks
    three or four silences the axis without anything looking wrong.
  - **Exactly 1.0 whenever EITHER side has no intent on file** — legacy rows,
    the iOS rail before it ships the screen, anyone who registered earlier.
    Damping an absent answer would penalise users for our own rollout.
  - **Symmetric by construction** (it reads the minimum distance between two
    sets, which does not depend on which side is read first), which matters
    because
    `scorePair` averages the two one-directional multipliers: an asymmetric
    version would have half its effect averaged away. A directional penalty —
    the person looking long-term arguably loses more from the mismatch — was
    considered and rejected for v1 on exactly that ground.
  - **Never a hard filter.** A launched market can be thin (2 matchable men and
    1 woman in Kyiv when this shipped), and partitioning that pool by intent
    yields zero pairs. A soft multiplier is the only shape that cannot subtract
    a date from anybody.
  - **Never an embedding input.** Folded into `psychologicalSummary` it would
    arrive through `V_explicit` at weight 0.65 — the most influential term in
    the formula, i.e. the opposite of what it is for — and the About-me editor
    replaces that field wholesale, so it would also be silently wiped on a bio
    edit. Its own column, its own multiplier. Same reasoning as the §1.3b voice
    transcript.
  - `INTENT_FLOOR` defaults to **1.0**, which makes the factor a pure no-op, and
    that is how it ships: the screen collects answers while ranking is
    unchanged. There is no separate feature flag — the screen is an ordinary
    onboarding step, so the floor is the only thing worth gating.
- `V_penalty` — negative-constraint penalty (subtracted), weight 0.30.
- `starvationBonus` — α = `CADENCE.starvationAlpha` per missed batch (0.05 under
  `weekly`; `0.05/7` per missed day under `daily`, same ~35-day saturation
  point either way), capped at 0.25 (strictly below `V_penalty` so it never
  overrides a real negative-constraint hit).

Hard SQL filters (`buildCandidateSql`):
1. `status = 'active'` and `onboardingStep = 'completed'`.
2. Embedding present, `gender` and `preference` set.
3. Mutual gender compatibility (a's preference includes b's gender AND vice versa).
4. Track-valid contact rail present — `(registration_track = 'general' AND
   phone_verified_at IS NOT NULL) OR (registration_track IS DISTINCT FROM
   'general' AND is_email_verified AND email IS NOT NULL)`. The union is over
   valid student/legacy and general cohorts; one track cannot borrow the
   other's credential.
5. Same canonical dating city (`Profile.homeCityKey`) and saved city
   coordinates. Different university domains can match inside the same city.
   This exact-equality join is *why* registration is restricted to launched
   markets (§1.3): an unlaunched city can only ever be a pool of one. The
   engine itself is unchanged and deliberately carries no market list — an
   account left over from before that gate simply finds no candidate, exactly
   as it always did.
6. **Lifetime ban** — exclude any pair that EVER appeared in a `matches` row,
   regardless of terminal status. Backed by the canonical-pair functional
   index. A user never sees the same partner twice.
7. Cooldown — `Profile.lastMatchedAt < now − CADENCE.cooldownMs` (24h under
   `weekly`; 6h under `daily` — see §3.1). Strict `<`, so a candidate matched
   exactly at the cutoff is still excluded.
8. **Single-live-match invariant** — exclude anyone participating in
   `proposed`, `negotiating`, `negotiating_venue`, or `scheduled`. Match creation
   locks both user rows in canonical order and re-checks this invariant inside
   the transaction, so overlapping batch runs cannot allocate either user twice.

Score breakdown for every created pair is frozen into `match_score_logs`
for the dashboard's algorithm-quality view.

### 3.3 The Pitch & Synergy

**The pitch is FOUR messages per side (2026-08-22), and each one earns its
bubble:** the album (cards + the partner's motion) → the streamed pitch, whose
persisted message also carries the verified trust note → the voice prompt → the
decision question. It used to be six. Nothing was dropped to get there — the
video moved into the album it could always have shared, and the trust note into
the message it already sat under. The two optional beats (trust note, voice) are
folded in or skipped rather than adding bubbles, so a partner with neither still
produces a clean three-message pitch. Hiding media behind a Mini App button was
considered and refused: a media group cannot carry an inline button at all, a
Mini App has no `protect_content` (§3.7a), and a web `<audio>` element loses the
native voice player the product deliberately relies on (§1.3b).

- The orchestrator generates a personalised pitch + **Synergy Score**
  (clamped to a motivating 70..99 range) + a 1–2 sentence positive
  rationale. The score is pair-level (one number, taken from side A's
  generation); the **rationale is per side, each in that side's own
  language** (`synergyReason` = A's, `synergyReasonB` = B's — mirroring
  `pitchForA`/`pitchForB`), so the synergy header never renders a foreign
  sentence inside the localized message it heads. Corrected 2026-07-25:
  the reason used to be pair-level too, so a mixed-language pair saw side
  A's sentence spliced into side B's otherwise-localized pitch (Telegram
  header and the mobile `synergyReason` alike). Legacy rows with no side-B
  reason fall back to side A's text rather than dropping the header.
- **Match card set (feature-flagged, `MATCH_CARD_FEATURE_ENABLED`, default
  off).** When on, the partner photo media-group that leads the pitch is
  replaced by a rendered collage **card set** (`services/match-card`,
  satori/resvg/canvas — same stack as §3.7a): **two** tilted near-native-aspect
  photos per card, so ten profile photos become five cards. The opaque rounded
  panel (name/age, one vibe line + one short paragraph from a dedicated compact
  copy pass — NOT the streamed pitch) rides the FIRST card on an even photo
  count and the LAST one on an odd count, where the leftover solo photo leaves
  it room; branding beyond the panel is limited to butterfly accents. (Corrected
  2026-08-22: this section used to describe one photo per card with the panel
  always on card 1, which the code has never done — `match-card/index.ts`.) The
  "paper" set renders in the **recipient's `User.theme`** (light cream / dark
  near-black card + panel; the burgundy accent, white photo frames and wine
  halftone dots are theme-agnostic). Sent as one protected album with the same
  name/age/✓ caption; collage jitter is seeded by match id + side. Any copy /
  render / send failure falls back to the plain protected media group, so
  pitch dispatch never wedges. Telegram-only.
- **The partner's motion rides in that same album (2026-08-22).** The standalone
  profile video and the video part of each Live Photo are appended after the
  cards in ONE `sendMediaGroup`, sharing its `protect_content`. Static
  photos/poster frames are not sent a second time — they are already inside the
  rendered PNGs, which is what `motionOnlyProfileMedia` exists to express.
  Until this change the motion followed as its **own message**, which cost the
  pitch a bubble for no platform reason: a Telegram media group may mix photos
  and videos, and the classic fallback path has always relied on exactly that.
  **Accepted tradeoff** (founder decision): the card set is a designed
  composition and the video arrives as a raw frame with a play button in the
  last tile. A branded poster via `thumbnail` was declined — Telegram is not
  known to apply a custom thumbnail to a video referenced by `file_id`.
  **The 10-item group cap is Telegram's and is enforced rather than risked**:
  exceeding it fails the whole send, which would cost the user the photos as
  well as the video, so only `10 − cards` motion items join the album and any
  surplus follows as its own message exactly as before. That surplus is
  unreachable in every ordinary case (five cards at most, one video per
  profile) and exists for a profile made almost entirely of Live Photos.
- **The app rail gets a push, and until 2026-08-12 it got nothing at all**
  (`services/match-drop-push.ts`, iOS §5.3). `pitch.ts` skips anyone it cannot
  address as a Telegram chat, with a comment saying their pitch "goes via the
  push path"; that path was never built, so an app-only user learned about the
  most important event of their week whenever they next happened to open the
  app. The push carries deliberately little: the copy names nobody, because the
  lock screen is public — the same reason the decision Live Activity shows no
  name, no age and not even a silhouette — and the only thing about the partner
  is **one** photo, sent as a signed URL that the client's Notification Service
  Extension **blurs on the device** before it is ever drawn. Nothing is
  rendered server-side: the bytes leave untouched and come back blurred, since
  a blurred copy on our disk would be a second artifact to keep in step with
  the first. The picture is optional by construction (no photos, an expired
  signature, an unreachable device → a plain notification), because the words
  are the part that has to arrive. Its copy is **word for word the mock-up the
  iOS pre-permission screen shows during onboarding** — the app promises this
  notification, and the promise and the thing itself are one sentence living in
  two places.
- Pitches are queued through `services/dispatch-queue.ts` (rate-limited,
  default 2 s between sends ≈ 30/min). When a first-match welcome gift is
  actually delivered, the queue sends those gift pre-rolls first, waits
  `MATCH_PREROLL_DELAY_MS` (default 2 min), then reveals the match cards so the
  gift effect and pitch stream do not visually stack.
- **A dispatch attempt leaves the match either carrying a TTL or terminal —
  never live and un-stamped (2026-08-20).** `Match.dispatchedAt` is what the
  expiry sweep, the countdown worker and both nudge cadences all filter on
  (`dispatchedAt: { not: null }`), so a `proposed` row that keeps it null is
  invisible to every one of them at once — it never expires, never nudges,
  never counts down — while the single-live-match rule (§3.2 filter 8) keeps
  BOTH participants out of every drop. That is not a degraded match but a
  permanent silent hole, and production held one for **123 hours**: the user on
  the other side of it received nothing for five days while everyone else got a
  pitch every evening. `disposeUndeliveredMatch` closes it at the one place all
  three creation paths (drop batch, demo driver, paid Rematch) funnel through:
  a pitch on record for either side starts the TTL, and **a pitch that reached
  nobody retires the row**, freeing both slots.
  **The trigger is wider than "the user blocked the bot".** `pitchMessageIdA/B`
  is written only AFTER the partner photo album, so a 403 on the media leaves no
  trace on that side; and a `mobile` participant (a synthetic stand-in, an iOS
  account) returns early without one either. Hence the production shape —
  *"Pitch delivery failed for 1 side(s)"* with **both** ids null.
  **Stamping instead of retiring would be a different bug, not a safer one:**
  the expiry path classifies a non-answering side as *silent*, increments
  `silentIgnoreCount` and sends "24 hours passed with no answer", i.e. it
  penalises someone for ghosting a message that was never sent. Nobody is
  notified about a card they never saw. The retirement is a compare-and-set on
  `status = 'proposed'`, so a decision arriving from the app rail while Telegram
  was timing out wins rather than being clobbered; a `proposed` row can never
  hold a paid ticket (§3.5b), so nothing is refunded. The **lifetime pair ban
  (§3.2 filter 6) still applies** — the row survives, as it would under any
  disposal — so the two are not re-paired later.
- For Telegram users the pitch streams through the native rich AI-compose draft
  path (`streamDraftsToChat(..., { rich: true })` → `streamRichDraftsToChat`):
  the headline/deadline/pitch chunks render as growing rich-message drafts with a
  `<tg-thinking>` shimmer beat (`matchStreamStart`), then the FINAL chunk is
  persisted as a **plain `sendMessage`** carrying the pitch keyboard — it stays
  a normal text message so the countdown worker's `editMessageReplyMarkup` keeps
  re-rendering the live countdown button against the same `pitchMessageId{A,B}`.
  Degrades to the classic edited-message stream when a client can't render rich
  drafts.
- **That persisted message is formatted with `MessageEntity[]`, never
  `parse_mode` (2026-08-22).** It carries the synergy label in bold and, for a
  verified partner, the trust note as a trailing blockquote — the message that
  used to be its own bubble. Entities are a one-way door here and the right one:
  the body is model-written, so MarkdownV2 would need every special character in
  a generated pitch escaped, and a stray `_` or `[` would fail the send and cost
  the user the whole pitch. It also fixes a live defect — no `parse_mode` was
  ever set on this message, so the header's old `*…*` markers had always
  rendered as **literal asterisks** on the most-read message in the product, in
  all five languages. Hence `matchSynergyLabel` is its own i18n key: the
  composer needs the label's exact bounds, and parsing `*…*` back out of the
  interpolated string is unsafe because the reason is model-written and may
  contain an asterisk of its own. Offsets are UTF-16 code units (the header
  opens with `💎`, two of them) and a wrong offset raises no error — it silently
  highlights the wrong span — so they are covered by tests that slice the entity
  back out. If the note would push the body past Telegram's 4096-character
  ceiling it steps out into its own message instead; that is insurance against a
  future generator change rather than a reachable branch, because exceeding the
  limit throws and the throw costs the entire pitch.
- An explicit `matchDeadlineNotice` follows the headline: **24 h** to reply,
  decision is final once committed.
- **Conversational decision (no Accept button, 2026-07-05).** The pitch
  message itself carries only the `[Report]` affordance — there is NO permanent
  Accept/Decline keyboard. After the pitch (and the voice prompt, when the
  partner recorded one) the bot asks a
  natural question in the recipient's locale — "Want to go on a date with
  him/her? Just answer yes or no." (`matchDecisionQuestionM/F`, gendered by the
  partner) — and the
  user answers in their own words. `handlers/matching/decision-text.ts`
  classifies the reply (keyword fast-path across all five locales, small LLM
  fallback; unrelated messages fall through to the menu agent; active
  matchFlow/menuState sub-flows are never hijacked) and the styled
  confirmation button "flows out" of the answer as a reply to the user's own
  message:
  - yes-intent → confirm card with the native-`success` `[💫 Yes, I'm going]`
    button (`match:accept:` — the commit) over `[← Go back]`;
  - no-intent → the guarded decline confirmation card
    (`matchDeclineConfirmPrompt`, `[❌ Yes, pass]` `match:do:decline:` native
    `danger` over `[← Go back]` `match:keep:`) — a pass stays irreversible
    (lifetime-ban invariant §3.2), so it always needs the explicit red tap;
  - unsure → a no-rush nudge, no state change.
  Text alone NEVER commits a decision — the commit is always a button tap on
  the surfaced card. Replies are static copy revealing nothing about the
  partner's choice, so the §3.4 blind-decision invariant is untouched. The
  `match:accept:` / `match:decline:` callback handlers stay live for legacy
  in-flight pitches dispatched before this change. Telegram-only; the mobile
  `POST /v1/matches/:id/decision` path is unchanged (client-side confirmation
  is the app's concern).
- The `proposal-countdown` worker re-renders a live **reply-deadline button**
  on the pitch keyboard **every minute** via `editMessageReplyMarkup` (styled
  `primary`, and on the same cadence as the pinned status-banner countdown).
  The label shows hours+minutes ("⏳ Time left to reply: Xh Ym"), so it moves on every pass
  across the whole 24 h window rather than freezing between ticks — a markup
  edit sends no notification, so the cost is API calls, not user noise;
  tapping it (`match:countdown:`) answers an
  informational toast (the decision stays conversational). Because only the
  keyboard is edited, the pitch body (synergy header + streamed text) is never
  rewritten. Mobile users render their own countdown from the public API.

### 3.4 Blind Decision Invariant + Peer Nudge

A user MUST NOT learn what their partner picked until they themselves have
committed.

- **First commit** — row stays `proposed` (even on a single decline). The
  peer's keyboard is still live until both have decided or 24 h elapses.
  Peer receives a neutral nudge `matchPeerDecided` ("your match has answered,
  your turn") that is **identical** for accept and decline. A first decider who
  **accepted** keeps that card and gets the §3.6b waiting shimmer under it, held
  for the whole window — the countdown worker goes silent for a side that has
  already accepted, so this was the longest wait in the product with no live
  affordance at all.
- **Mutual accept** — atomic `proposed → negotiating`; both sides get
  `matchBothAccepted` with symmetric reveal. On Telegram, the **Date Ticket
  card** — the message that carries the "It's mutual 🤍" copy when the §3.5b
  gate is on — plays a **falling-hearts message effect**
  (`MESSAGE_EFFECT_MUTUAL_ID`, Bot API 7.6+, default ❤️
  `5159385139981059251`, empty disables). It rides that card and nothing else.
  Two deliberate exclusions: the individual "you accepted, waiting on them"
  receipt (separate `MESSAGE_EFFECT_MATCH_ID`) must stay quiet, since hearts
  there would hint at an outcome the user has not earned yet (blind-decision
  invariant); and the **celebratory Calendar card** on the ticket-off path
  carries no effect either (founder decision 2026-07-28) — that card's job is
  to get a time picked, and it is also the one card that gets *edited* in place
  from the waiting receipt, which Telegram cannot attach an effect to, so the
  animation would land for one side and not the other.
- **Mixed / both declined** — second decider gets their own
  `matchAccepted`/`matchDeclined` ack PLUS a follow-up
  `matchPeerWasAccepted`/`matchPeerWasDeclined` reveal; the first decider
  (who only saw their ack earlier) is also DM'd the outcome at this moment.
  Status flips to `cancelled`. In the mixed case, the user who accepted but
  whose peer declined receives a softer, accepted-side-specific reveal and
  gets a compensating priority boost for the next batch. The terminal
  `proposed → cancelled` compare-and-set is the ownership boundary: only its
  winner applies Elo, priority, and final reveal side effects, while each
  successfully claimed decision still records its own event/acknowledgement.
- **TTL expiry asymmetry** — if the silent side ghosted a partner who had
  *accepted*, the expiry message includes `matchExpiredYouMissedDate` ("you
  missed a real date") on top of the standard rating warning. If the
  partner declined or also ghosted, the message stays neutral — preserving
  the blind rule even at expiry. Match flips to `expired`.
- **Forgive-once on silence** — first `silentIgnoreCount` increment is a
  warning only; from the second onwards Elo decrements as if the user had
  declined, and a `EXPIRED_SILENT` `MatchEvent` is logged.

**Expiry card (always-on, Telegram-only, added 2026-08-01).** The expiry notice
is one of the few genuinely emotional beats in the product — you ghosted
someone who said yes, or someone ghosted you — and it was the driest surface
shipped: a bare `sendMessage`. It is now a square PNG
(`services/expiry-card.ts`, satori + resvg, same design system as the date,
time and match cards: recipient's `User.theme`, Gennety wordmark, tilted
butterfly, burgundy accent, film grain on dark only) with one vector motif per
branch of the asymmetry above — an hourglass mid-pour, falling bars under a
descending arrow, one closed circle beside one dashed and empty, and a heart
split in two.

- **The hourglass is drawn artwork, not primitives (2026-08-19).** It was two
  stroked triangles between two rounded bars, and beside the other three
  motifs it read as a wireframe rather than as a mark. It is now an imported
  vector (`services/expiry-card-hourglass.ts`): a looser hand-drawn line, sand
  textured with knocked-out specks, grains mid-fall through the waist. Two
  rules the import has to satisfy, both violated by the raw export and both
  failing at runtime rather than at build time, so both are pinned by tests.
  It takes `accent` and `bg` as **arguments** and bakes no palette of its own —
  the export painted every knockout literal `white`, which is invisible on the
  cream ground and glaring on the near-black, and those knockouts ARE the empty
  glass, so they are painted in the card's own background. And it carries **no
  background rect**, which the export also shipped and which would have covered
  the burgundy glow the motif is composited onto.
  **One thing it says that the copy does not:** the upper bulb is still part
  full and the grains are still falling, i.e. time is running out rather than
  already gone, while the headline reads "TIME'S UP". The mark is kept as the
  artist drew it; the settled-sand alternative is a mirror of the upper cone
  into the lower bulb and touches one function, so this is a live question
  rather than a closed one (DECISIONS.md 2026-08-19).

- **The card says WHAT HAPPENED; the caption adds only the consequence**
  (founder decision). Nothing is stated twice: the card carries "TIME'S UP /
  24 hours passed with no answer", the caption carries "next time we'll lower
  your rating". Same rule the §3.6 locked-time card follows when it refuses to
  repeat the date phrase its own caption already holds.
- **Which card**: `expired` (silent, first offence) / `penalty` (silent,
  repeat, Elo actually deducted) / `peer_ignored` (this side answered, the
  partner never did) / `missed_date` (silent AND the partner had accepted).
  The last one is a visual override that replaces either silent card — it is
  the fact worth a picture — while the **caption still follows the underlying
  outcome**, so a repeat offender who ghosted an accepting partner is still
  told their rating moved. The `penalty` card is drawn only when the Elo write
  actually landed, mirroring the existing text rule: never draw "RATING
  LOWERED" over a deduction that failed.
- **Blind-decision safe.** `missed_date` is reachable only from
  `peerAccepted === true`, which the user has already earned by the window
  closing; a peer who declined or also went silent produces the neutral card,
  exactly as the text did.
- **It claims no priority boost.** Unlike the decline path (§3.4 mixed) and the
  §3.5c stall chain, the expiry sweep does **not** call
  `boostAcceptedSidePriority`, so no surface here may promise one.
- **Photo-free by rule.** Partner photos are `protect_content` wherever they
  appear with a clear face (§3.7a); a terminal match is the wrong place to
  re-surface them, and it would put a network dependency on a path that must
  not fail. The motifs carry the emotion instead.
- **Never wedges.** The render is pure layout + rasterize (no network, no
  photos) and returns null rather than throwing; a null render — or a caption
  over Telegram's 1024-character ceiling — falls back to the plain-text notice
  that shipped before, which remains self-sufficient. No sentence exists on
  only one branch.
- **Headline typography is the full Unbounded, not the subsets the other cards
  load.** Those are the Google Fonts `latin` + `cyrillic` subsets and Polish is
  in neither, so `CZAS MINĄŁ` silently renders ĄŁ in Roboto mid-word. Satori
  reports no error for a missing glyph, which is why this went unnoticed — it
  is still live in the §3.6 time card's Polish dates (`WRZEŚNIA`,
  `PAŹDZIERNIKA`, `ŚR`), the match card and the referral card.

After a decline (and once the user has seen the partner's verdict, if any),
the bot asks why. The card carries four one-tap reasons — appearance, vibe,
interests, lifestyle — plus **Something else**, which opens the free-text /
voice path: that text falls through to the menu agent, which distils it via
`record_rejection_feedback` and appends the result to the *decliner's*
`Profile.negativeConstraints`.

**Only the free-text path reaches matching, and the copy now says so
(2026-08-07).** A preset tap records the canonical reason on the match row and
the `MatchEvent` with `updateNegativeConstraints: false` — deliberately, not
as an oversight. `V_penalty` is a **literal word-match of each stored trait
against the candidate's `psychologicalSummary`**, so it needs a trait with
content; a preset is a *category*, and "не мой тип" does not say which type.
Feeding it in yields one of two failures: the whole line becomes a single
trait that can never match any summary (dead weight), or the LLM distiller
manufactures a specific trait out of a content-free label and that invention
then penalises real candidates. The buttons are therefore analytics — read in
the admin dashboard — and the message no longer promises them a place in the
next drop. **Do not "fix" this by routing presets into `negativeConstraints`.**
If preset reasons are ever to influence matching, each button names a
*different* axis that already has a structured representation (appearance →
`typePrefTags`/`appearanceTags`, vibe → the energy/orientation quadrant,
interests → `hobbies`/`anchorTags`), a single decline is far too weak a signal
to mutate any of them, and learning appearance preference from rejections is a
consent question the Type Radar's opt-in calibration does not cover.

**The first button names appearance explicitly.** The four presets are four
axes, so the one meaning "looks" has to say it: "Не мой тип" alone reads just
as easily as personality and competed with the three buttons beside it.

### 3.5 Match nudges

`workers/match-nudge.ts` sends two cadence pairs plus a deadline heads-up
(`MATCH_NUDGE_CRON_SCHEDULE = "0 * * * *"`), all honouring quiet hours. The
offsets below are the `weekly` `DropCadence` profile's values
(`CADENCE.proposalNudgeOffsetsMs` / `schedNudgeOffsetsMs` — §3.1); the `daily`
profile halves the proposal/venue offsets and is inert in production:

- **Proposal phase** (status `proposed`, awaiting decision) — ≥3 h after
  `dispatchedAt`, then ≥10 h.
- **Scheduling phase** (status `negotiating`, both accepted, no agreed slot)
  — ≥6 h after the Calendar opened, then ≥12 h. It goes to **whichever side
  still owes the move**, and there are two ways to owe it (`schedulingOwedKind`,
  the same predicate §3.5c's check-in and cancellation read, so all three agree
  on whose turn it is):
  - **never opened the calendar** → the ordinary generated "pick a time" line.
  - **both picked and nothing overlaps** (added 2026-08-05) → static copy
    (`matchScheduleNoOverlapYet`) **plus the Calendar button**. A generated
    "pick a time" would be flatly wrong — this person did pick; what they need
    is to widen the selection or take one of the partner's slots, and the
    Calendar card scrolled away hours ago. This state used to match neither
    branch of the old "has this side marked anything" rule, so it received no
    reminder, no check-in and no cancellation at all — see §3.5c.

  Sent only to a side that has actually marked no availability *for the first
  case* (corrected 2026-07-29: it keyed off `pickedTimeA/B`, the deprecated
  pre-2026-05 columns nothing writes any more, so it nagged BOTH sides). A pair
  still inside the §3.5b Date Ticket gate is excluded, because `negotiating`
  also covers the gate and the Calendar has not been sent yet — "pick a time"
  pointed at a screen the user did not have. The discriminator is an empty
  `proposedTimes` (written by `startScheduling` when and only when the Calendar
  opens), **not** `ticketStatus`, which keeps its `pending` default even with
  tickets switched off entirely and so needed a flag-conditional filter to avoid
  suppressing every scheduling nudge. Same rule the stall chain already ran on.
- **Deadline nudge** (status `proposed`) — one final "your window closes in
  about Xh, decide now" DM fired **~2 h before the decision deadline
  (`services/proposal-deadline.ts` `deadlineFor` — a flat 24h TTL from dispatch
  under `weekly`; see §3.1)** (`PROPOSAL_DEADLINE_NUDGE_LEAD_MS`), anchored to
  the *deadline* rather than dispatch. Sent only to sides still genuinely
  undecided (`acceptedBy* IS NULL`
  — a side that already declined committed irreversibly and is never nagged),
  static i18n copy so the "Xh" stays accurate. Idempotent via
  `Match.proposalDeadlineNudgeSentAt`.

**All three cadences reach both rails since 2026-08-22.** Every one of them
picked recipients with `telegramId > 0n` and sent a DM and nothing else, so an
app-only user was reminded of nothing — the tenth instance of one mechanic
existing on one surface only, and the same defect §Phase 4's safety brief
records: **whose move it is and how to reach them are two different questions**,
and collapsing them into one filter is what dropped the app side. The
who-owes-the-move predicates are untouched (`sideOwesAction` /
`schedulingOwedKind`, shared with the §3.5c stall chain, so all three still
agree); only the rail is now `platform`-derived. Push types `match.nudge`,
`match.planning`, `match.deadline`, each carrying `{ type, matchId }`.

Three properties are worth stating because they are easy to break later:

- **The copy on the lock screen is static, and the model-written line stays in
  the DM.** Planning gets ONE push copy covering both branches of
  `schedulingOwedKind` — it must be true both when the calendar was never
  opened and when both sides picked and nothing lined up, so it does not say
  "pick a time".
- **The counters count PEOPLE, not messages.** A `both` recipient increments by
  one, and only when at least one rail actually landed; otherwise the numbers
  stop comparing with previous days, which is the only thing they are for.
- **Where the idempotency claim sits is unchanged, and it differs by cadence.**
  Decision and deadline claim ABOVE the recipient list, so the stamp is spent
  even when nobody is reachable (the row is not re-evaluated every tick, as in
  `pre-date-safety.ts`); planning builds `owing` first, so an empty list spends
  nothing. Moving a claim for the sake of symmetry is a separate decision and
  was not taken here.

Each cadence has its own timestamp column(s)
(`proposalNudge1/2SentAt`, `schedNudge1/2SentAt`, `proposalDeadlineNudgeSentAt`)
so a row that already got a proposal nudge cannot dead-letter the
scheduling-phase or deadline cadence.

### 3.5b Date Ticket Gate (feature-flagged monetization)

An optional premium step sits between mutual accept and the Calendar. It is
gated by `TICKET_FEATURE_ENABLED` (default **off** → the bot hands off straight
to the Calendar exactly as documented in §3.6).

**Gennety Premium covers a subscriber's OWN slot, and only that (2026-08-22).**
An active subscription (§3.8) settles that side's ticket at the moment the gate
arms, spending no money and — the part that is easy to get backwards — **no
wallet ticket**: routing Premium through `useTicketFromBalance` would make a
subscriber pay, out of their own wallet, for the one thing the subscription
promises. Bought tickets are left untouched and never expire into the
subscription.

**Covering the partner is deliberately NOT included.** It costs one ticket's
price, which is the already-existing `partner` scope rather than any new
pricing. The reason is not the arithmetic: the §3.5b goodwill loop — his
confirmation, her surprise reveal, the "she saw it ❤️" read-receipt — is built
on the fact that he SPENT something for her, so a free cover would make the
reveal a claim about a gesture that cost nothing, the same defect as an expiry
card announcing a rating drop that never happened. (Secondarily, at a daily
cadence one subscription would otherwise monetize away the entire female side
of that man's matches, and men paying while women are gifted is the revenue
model.)

Three consequences worth stating, because each is a place the obvious
implementation is wrong:

- **The card is still sent, always.** It carries the "It's mutual 🤍" reveal
  and its `message_effect_id`, so skipping it for a covered pair would delete
  the moment rather than the payment. What changes is only what it opens on: a
  covered woman lands on `waiting`, a covered man on `cover-partner` — the one
  screen where he still has a choice — and when BOTH subscribe it carries the
  reveal with **no keyboard at all** (`ticketCardCaptionPremium`), because a
  payment button pointing at a settled gate is the dead affordance §2.1
  forbids. The durable way back into that date is the My Date hub.
- **The Calendar never overtakes the reveal.** With both sides covered the gate
  completes only AFTER both cards are delivered — the same rule §2.1 states for
  the pinned banner, and the reason `settlePremiumSlots` deliberately does not
  complete the gate itself.
- **A settled slot is permanent.** `ticketPaid{A,B}` is a timestamp, not an
  entitlement check, so a subscription that lapses between the settle and the
  date revokes nothing and is never re-verified. The alternative would have the
  product cancelling dates two people had already agreed to.

**Self-healing for a subscription bought AFTER the gate opened.** Premium is
granted through four rails (Telegram Stars, App Store, and the referral and
promo comp grants), so instead of a hook on each, the gate's own state read
settles a premium caller's slot — the screen is polled, so it lands within
seconds whichever rail was used, and the claim is the same compare-and-set as
every other slot, so a read racing the offer settles nothing twice. The read
also completes the gate when that closed it; without that, a pair whose second
slot was closed by a late subscription would sit fully paid in `partial` until
the expiry sweep refunded them out of a date they had already secured.

**The gate carries the counterfactual, and only where it is true (founder
decision 2026-08-22).** A user without a subscription sees one quiet line under
the ticket card — "your ticket is free with Premium" — opening the Premium
screen rather than a payment sheet. This is the same in-flow device
`premiumWouldWaive` already runs at the venue board's pay step, at the moment
of maximum willingness to pay, and the founder's reasoning is that a per-date
charge is exactly the cost a user cannot feel in aggregate until something
names it.

Four rules keep it from becoming the marketing §3.5b otherwise forbids on this
screen:

- **The `offer` screen only.** On the cover screen the money buys the
  PARTNER's ticket, which Premium never covers, so the same line one screen
  later would be false about the button directly beneath it. Guarded against
  the source, because the failure is silent.
- **Never burgundy.** The venue board's counterfactual is a filled accent
  button because it is the loudest thing on its own screen; here the hero pay
  button sits a few pixels below, and this screen's rule is exactly one loud
  button. It is a glass row whose only accent is the padlock — one step above
  the referral chip, several below the pay button, so three tap targets in one
  column read in three plainly different weights.
- **Never in the action bar.** That footer is `flex: none`, so anything added
  there grows it and pushes up the button the user came to tap — the regression
  §3.9 records against the referral chip on the Premium screen.
- **Telegram-only, deliberately.** It is withheld from the `/v1/*` gate state
  entirely rather than shipped and hidden client-side: `premium_monthly` cannot
  currently be bought on iOS at all (the subscription group has never been
  submitted, see deploy.md), so an upsell there would point at a product with
  no purchase path. It is gated on `PREMIUM_FEATURE_ENABLED` — unlike
  `myPremiumActive`, which reports an entitlement the flag may not revoke,
  this opens a NEW purchase surface, which is what the flag exists to close.

**Every premium settle writes a zero-delta `premium_gate` row to
`ticket_ledger`.** Without it the admin purchase view cannot tell "Premium
covered this date" from "the gate lapsed and the Calendar opened for free" —
which is precisely the number that says whether the subscription is paying for
the dates it hands out.

**Both surfaces, since 2026-08-06.** This section used to say the gate was
Telegram-only and that the mobile mutual-accept path scheduled directly. The
second half had not been true for some time — `matches-service.ts` calls
`sendTicketOffer` whenever the flag is on, whichever client committed the
decision — so an iOS-only pair *did* enter the gate and then found nothing on
`/v1/*` able to read or settle it: the Mini App routes below are `initData`-
authed, and an app user has no Telegram session to sign with. They sat in
`negotiating` with no Calendar until the partial window lapsed and the expiry
cron opened scheduling for free. The native surface is
`/v1/matches/{id}/ticket-gate[/use|/seen]` (JWT), and
`SerializedMatch.ticketGate` is what tells the client to route there.

**On iOS the wallet is the only rail.** StoreKit credits it
(`POST /v1/tickets/appstore/transaction`, three consumables) and the gate spends
from it; there is no per-scope charge. An App Store consumable is a fixed-price
SKU, so charging per scope would need a product per scope and another per
discount state, each created by hand in App Store Connect and impossible to
re-price server-side. With the wallet in between, every gate action is
expressible with the products that already exist, and a settle that loses its
race refunds a ticket rather than a dollar. The famine single-ticket discount is
USD-only and so does not apply on iOS at all — the same rule Stars already
follows. The welcome gift, the store bundles and the wallet bonuses below stay
Telegram-only in v1.

When enabled, mutual accept creates one live **post-accept status/CTA** per
Telegram side (tracked in `Match.calendarMessageIdA/B`): accepted/waiting →
premium **Date Ticket** card → Calendar. The ticket card carries a `web_app`
button opening the Ticket Mini App (`apps/webapp/ticket.html`, React +
pure-CSS 3D). Each ticket is **$8.49** (mock) or **425 ⭐** (Telegram Stars).
**Payment (production): Telegram Stars (XTR).** With `TICKET_STARS_ENABLED` the
date gate and the store both pay natively in Telegram Stars — the Mini App opens
a server-issued invoice link (`createInvoiceLink`, empty provider token,
`currency: "XTR"`; no merchant account needed) via `WebApp.openInvoice`, and the
bot's `successful_payment` handler (`handlers/payments.ts`) is the trust boundary
that settles: `store:<count>` credits the wallet (exactly-once via the unique
`TicketLedger.externalPaymentId` = `telegram_payment_charge_id`), and
`gate:<matchId>:<scope>` settles the ticket slot(s) via `applyStarsTicketPayment`
(the charge id is first recorded as a zero-delta `TicketLedger` audit row; its
settlement outcome commits atomically with the slot CAS. The unique charge id
makes redelivery exactly-once and retains the provider key needed for a later
refund; a partial pay-for-both overpayment remains a durable pending wallet
credit until granted exactly once).
`pre_checkout_query` re-validates payload + Star amount within Telegram's 10 s
window. The famine single-ticket discount is **USD-only** and never applies to a
Stars purchase. Star prices are env-tunable (`TICKET_BUNDLE_STARS`, default
`1:425,3:1020,6:1650`; the gate derives its per-scope price from the 1-ticket
entry — self/partner 1×, both 2×).
**Payment (fallback): mock.** When `TICKET_STARS_ENABLED` is off, the legacy
mock (`TICKET_PAYMENT_MODE=mock`) fully simulates a Stripe-style flow that
updates the DB but moves no money; `mock`→`stripe` remains the alternate
production switch (`services/ticket-payment.ts`). Mock payment intents are
server-issued, expire after 15 minutes, are bound to the exact payer,
match/bundle, scope, and amount, and can be consumed only once. While Stars is
on, the mock `intent`/`confirm` routes 404 (PAY-1 guard) so Stars is the sole
purchase rail; the free wallet "Use a ticket" path is unaffected.

- **Pricing.** Male users get "Pay for us both — $16.98" (settles BOTH tickets,
  sets `paidForPartnerBy*`) plus "Pay only mine — $8.49". Female users get a
  single "Pay my ticket — $8.49". The server re-validates that pay-for-both is
  male-only.
  **The covering option is always the hero button** — the one burgundy rung of
  the Mini App's button ladder — at every wallet balance
  (corrected 2026-07-29; it also **shimmered** until 2026-08-08, when the
  travelling white bar was replaced by the house inner-edge sheen — see the
  ticket-card note below). It used to invert at exactly `balance === 1`, where
  "use my ticket for myself" became the hero and covering dropped to the quiet
  secondary. That is the single most common state a man reaches this screen in:
  the welcome gift (§3.5b) is exactly one ticket, so for most first-time payers
  the nudge pointed the wrong way. Covering is offered, never forced — see the
  decline path below.
- **After he settles only his own ticket: a result, then an offer** (reworked
  2026-07-29). A male who paid just his own slot lands on the "cover your date"
  screen, and that screen now **leads with his own outcome** ("Ticket secured 🎟️
  — waiting on {name}", plus her remaining window), with the cover proposal as a
  distinct card below it carrying her photo, and the hero button carrying her
  avatar. Declining is a **real bordered button** (`I'll let them grab it`) that
  moves him to the ordinary `waiting` screen — the same one a female sees — with
  a quiet text link back in case he changes his mind. Before this the screen was
  an upsell dead end: his payment was reframed as the headline of another request
  for money, the only alternative was a 14px ghost text link under a shimmering
  burgundy button, and tapping it just closed the Mini App. The `waiting` screen
  was literally unreachable for a male, so his own purchase never resolved into a
  state of its own. The decline is deliberately **not persisted** (session-only,
  no schema): being asked again on a later open is harmless now that the screen's
  first message is his status rather than the ask.
- **A self-only settle is announced in chat, on both sides** (added 2026-07-29).
  Paying just your own ticket used to leave **no chat trace at all** — the Mini
  App jumped straight to the cover offer, so closing it lost the fact that you
  had paid, and the peer learned nothing even though the settle silently resets
  *their* deadline to 24 h from that moment. The payer now gets
  `ticketGateWaiting`, and the peer gets `ticketPeerTookTheirs` ("{name} just
  grabbed their ticket — yours is the last one") with a button back to the ticket
  Mini App. Both ride the same CAS that claimed the slot, so each fires exactly
  once per real payment with no extra idempotency column. A **cover** payment is
  excluded: it completes the gate and would spoil the §3.5b surprise. The
  persistent chat card itself is still never edited.
- **Persistent ticket card + Calendar follows.** The ticket card is a
  **standalone, re-openable** message sent once per side and **never edited or
  deleted** — it is intentionally NOT tracked in `calendarMessageId*`. Tapping
  it always opens the Mini App, which re-derives the live state (offer →
  pay/use; or the "your match paid ❤️" surprise; or both-secured). Ticket
  progress (first paid, both paid) is reflected **inside the Mini App**, not by
  rewriting the chat card. Once both tickets settle, the Calendar arrives as a
  **separate** message that *follows* the ticket card, and the
  scheduling/venue/time-lock flows
  only ever touch that Calendar card — so the ticket entry survives to the end
  of the flow and the covered woman can always reopen it for the surprise. This
  is a deliberate, scoped exception to the one-live-post-accept-card rule
  (§3.6): the ticket card and the Calendar card are two distinct, coexisting
  buttons. It also carries the **mutual-match reveal** ("It's mutual 🤍"), so
  it is the message that plays the falling-hearts `message_effect_id`
  (`MESSAGE_EFFECT_MUTUAL_ID`, default ❤️) — see §3.4.
  **"Follows" means a new message, and that had to be made true (2026-08-12).**
  `startScheduling` reached for the tracked post-accept card and *edited* it —
  correct on the no-gate path, where that card is the newest thing in the chat
  and morphing it in place is the point (§3.6), and silent here: by then the
  standalone ticket card and the settle notice have landed **below** it, a
  Telegram edit raises no notification, and the Calendar button appears three
  messages up. So the whole flow died on screen at *"your ticket is ready,
  waiting on the other side"* while both tickets were in fact settled and the
  grid was written. Confirmed rather than inferred: a live run has
  `ticketStatus = completed`, 84 `proposedTimes`, and **zero** chat events after
  the second payment. The gate's three handoffs (completion, the free-Calendar
  fallback on expiry, and the one after a refund) now delete the stale card and
  send a fresh one, which is also what makes the deadline nudges that follow
  point at a card the user has seen. The resend is derived from
  `afterTicketGate` rather than passed beside it — the gate having run IS the
  reason the tracked card is stale, and a second flag could only disagree with
  the first. The **covered partner's deferred Calendar** (delivered when she
  opens the "he paid your ticket ❤️" reveal) resends for the same reason, one
  step worse: hers sits under the ticket card *and* the cover DM.
  Reached production undetected because no pair had ever cleared the gate
  there; found in demo mode, where every run does.
- **Welcome gift.** Every new user is gifted **one free Date Ticket** as a
  personal "your first date is on me" gesture, delivered as a **pre-roll before
  their first-ever match pitch** (`handlers/matching/pitch.ts` →
  `services/welcome-gift.ts`): an optional gender-specific Telegram **video
  note** (кружок, founder message) followed by the gift DM (the
  `welcomeGiftTicket` copy, $8.49 value anchor + optional
  `MESSAGE_EFFECT_GIFT_ID` effect). The `sendVideoNote` API carries no caption,
  so the text is a separate message; a missing video asset degrades gracefully
  to the DM only. The weekly dispatch queue intentionally waits before sending
  the match card after a delivered gift so the confetti/effect moment stays
  visually separate from the pitch stream. The grant is one-time/idempotent — a
  `welcome_gift`
  `TicketLedger` row is the claim marker, so the FIRST qualifying pitch becomes
  the gift moment automatically (no separate "first match" detection) and
  retries/subsequent pitches never re-gift. Telegram-only in v1 — the gift is a
  video note plus a DM, neither of which has a mobile surface — and inert unless
  `TICKET_FEATURE_ENABLED`. (The gate itself is NOT Telegram-only; see the head
  of this section.)
- **Ticket wallet (pre-purchase + bonuses).** Users carry a `User.ticketBalance`
  topped up by onboarding bonuses (§1.3: 6+ photos, adding a video;
  Registration v2: the one-time
  **student bonus** — `STUDENT_BONUS_TICKETS` (2) tickets granted at
  university-email verification via the idempotent `student_bonus` ledger
  claim, announced with the `ticketRewardStudent` DM — the student track's
  welcome perk; the general/phone track gets none), the welcome gift above, and by bundle
  purchases in the store
  Mini App (`tickets.html`, opened from the
  **My Tickets** menu): **1 / $8.49**, **3 / $20.37** ($6.79 ea, −20%), **6 / $33.12**
  ($5.52 ea, −35%). Every balance change is written atomically with an append-only
  `TicketLedger` audit row (`services/ticket-wallet.ts`). At the gate, a user
  with tickets sees **"Use a ticket"** instead of paying:
  - female / single-self → "Use my ticket" when `balance ≥ 1`;
  - male with `balance ≥ 2` → "Use 2 tickets (you + your date)" or "Use 1 (self)";
  - male with `balance = 1` → "Pay for both 🎟️ + $8.49" (his ticket on his own
    slot + one ticket's price for hers — never the doubled `both` price) as the
    hero, "Use 1 (self)" as the alternative; either way he may still
    **additionally** pay or use a ticket for his date afterwards (the post-self
    "cover your date" screen, scope `partner`).
  Spends are atomic and guarded against going negative; a spend whose match-slot
  claim doesn't apply is refunded to the ledger. New TMA endpoints:
  `POST /v1/matches/:id/ticket/use` (gate spend) and `/v1/tickets/*`
  (wallet + store). Store purchases and the gate share the mock/stripe
  abstraction in `services/ticket-payment.ts`.
- **Famine discount (single ticket).** A one-time loyalty perk for a user the
  weekly batch left unpaired for a **2nd consecutive week or more** (no-match
  `tier ≥ FAMINE_DISCOUNT_MIN_TIER`). The §3.1 no-match DM grants and announces
  a **`FAMINE_DISCOUNT_PCT` (77%) discount on one ticket**, valid
  `FAMINE_DISCOUNT_TTL_DAYS` (30) days. It applies to a **single** ticket
  purchase only — the date gate's `self` scope and the store's "1 ticket"
  bundle — and is **consumed on the first such purchase** in either surface
  (`services/ticket-discount.ts`; persisted on `User.ticketDiscount*`). The
  Mini Apps render a "−77%" badge + the reduced price; `both`/`partner` scopes,
  the 3/6 store bundles, and the free wallet "Use my ticket" path are
  unaffected. The server always re-derives the charged price (the mock intent is
  amount-bound, so a stale discount auto-fails verify) and consumes via a CAS so
  a double-confirm redeems exactly once. Re-granted/refreshed each later famine
  week until used. Inert unless `TICKET_FEATURE_ENABLED`; Telegram-only in v1.
- **The discount slot is ONE slot, shared with the post-event perk, and the
  collision rule is asymmetric on purpose.** A user who fills in the §11 form
  after a launch event is granted an `EVENT_FEEDBACK_DISCOUNT_PCT` (40%)
  discount on a single ticket for `EVENT_FEEDBACK_DISCOUNT_TTL_DAYS` (30) days
  — through the same mechanism, the same columns and the same
  consume-on-first-purchase CAS as the famine perk above, deliberately not a
  second one. Famine **replaces** whatever is in the slot; event feedback only
  ever fills an **empty** one, because it is the smaller perk and overwriting a
  live 77% famine discount with it would take something away from a user as a
  reward for helping us. There is deliberately no "keep the better one"
  arithmetic — comparing a percent against a deadline is a judgement two call
  sites would eventually make differently, and "never take anything away" needs
  no comparison at all. `User.ticketDiscountSource` records which mechanism
  filled the slot; it is **analytics and audit only** — pricing reads
  `ticketDiscountPct` and never the source. A zero configured percent grants
  nothing rather than occupying the slot with something that discounts nothing.
  Redemption is still reported as `famine_discount_redeemed`: the two are the
  same object at the point of sale, and splitting the redemption event would
  make the surfaces disagree about how many discounts exist. Inert unless BOTH
  `TICKET_FEATURE_ENABLED` and `EVENTS_FEATURE_ENABLED`.
- **Hard gate.** The Calendar is not sent until *both* tickets are paid
  (`ticketStatus = completed`), at which point `startScheduling` runs and sends
  the Calendar as a **separate** message that follows each side's persistent
  ticket card (it does not replace it).
- **Partner-paid surprise screen.** When a male covers both, the gate completes
  for both. Because the ticket card is a standalone, never-edited message (see
  *Persistent ticket card* above), the covered partner's "buy ticket" entry
  simply stays in chat — no spoiler — so she opens the Mini App still braced to
  pay and instead lands on a dedicated, softly-animated **"{name} already paid
  your ticket ❤️"** reveal (`partner-paid` screen, `PartnerPaidCard`, Lavender
  Glass: glowing covered ticket with a ❤ "PAID" seal, drifting hearts, minimal
  copy), whose single CTA continues her to the Calendar. The ticket card stays
  re-openable (every open re-derives the right screen) for both sides until the
  date is fully scheduled; the Calendar simply follows it as its own button.
- **Goodwill cover read-receipt (his dopamine loop).** So the man's gesture is
  not a silent settle, covering the partner drives a three-beat loop
  (`ticket-gate.ts`): (1) the instant he covers her — via pay/use `both` or
  `partner` — he gets a confirmation DM (`ticketCoveredHerConfirm`, with the
  `MESSAGE_EFFECT_TICKET_ID` heart when set) and his own Mini App success screen
  celebrates it (`iCoveredPartner` → *"you covered {name}'s ticket 💛"*) instead
  of the neutral both-secured copy; (2) the read-receipt — the first time she
  actually sees the reveal (her `GET /ticket/state` returning `partnerPaidForMe`)
  stamps `Match.partnerPaidSeenAt` once (CAS) and DMs him
  `ticketPartnerSawItDm` (*"{name} saw that you covered her ticket ❤️"*), his
  "she was notified" proof; (3) the guaranteed fallback — because she may never
  reopen the ticket card before the Calendar arrives, gate completion sends her a
  warm `ticketPartnerPaidDm` nudge (with a button back to the ticket card) and
  stamps `Match.partnerPaidNudgedAt`, so the notification always lands. The nudge
  deliberately does NOT stamp `partnerPaidSeenAt`, keeping his read-receipt honest
  (it still waits for a genuine open — e.g. tapping the nudge button). All three
  are idempotent and best-effort (a DM failure never blocks settlement).
- **The gate's deadline is armed by the transition, not by the card (2026-08-20).**
  `ticketExpiresAt` is written in the SAME compare-and-set that flips the match to
  `negotiating`, on both rails, not by `sendTicketOffer` a few statements later.
  It is the only column the hourly ticket-expiry sweep filters on
  (`{ not: null }`), and the §3.5c stall chain deliberately exempts a
  `negotiating` row with no `proposedTimes` on the grounds that "the gate has its
  own deadline" — so a row that reaches `negotiating` without one is invisible to
  **both** at once and strands both participants permanently, the same hole an
  un-stamped `dispatchedAt` opens one stage earlier (§3.3). Nothing between the
  two writes can throw today, but that is a property of `updateEloScores`
  catching its own errors rather than of anything local; arming it inside the CAS
  makes the hole unreachable by construction. `sendTicketOffer` re-stamps a fresh
  window, so the ordinary path is unchanged, and the write is conditional on
  `TICKET_FEATURE_ENABLED` — with the gate off there is no deadline to arm,
  `startScheduling` writes `proposedTimes`, and the stall chain owns the row.
- **`ticketStatus` lifecycle.** `pending` → `partial` (one paid; `ticketExpiresAt`
  is the second side's deadline) → `completed`; or `refund_pending` → `refunded`
  / `expired` on timeout. `refund_pending` is an internal retry state and renders
  as closed in the Mini App. **Refund/expiry policy:** the hourly `ticket-expiry`
  cron returns the original Telegram Stars charge (or restores the wallet
  ticket), durably retries provider failures, and only after a successful refund
  **opens the Calendar for free**. An already-accepted match is never killed by
  a payment stall, and a failed refund is never announced as successful.
- **The date didn't happen → the ticket comes back (2026-07-29).** One rule, no
  fault-finding: whenever a live match dies before the date, every ticket that
  was actually paid for returns to whoever paid for it. **The person who
  cancelled is refunded exactly like the person who was cancelled on.** The
  penalty for flaking already exists in Elo / `silentIgnoreCount`; taking the
  money on top would make an honest cancellation more expensive than a silent
  no-show, which is precisely backwards. Before this, a paid ticket burned in
  every one of these paths — a partner cancelling an hour before the meeting
  simply destroyed both tickets — and the ONLY refund in the product was the
  §3.5b expiry rail, which covers just the gate failing to close on time.
  - **The refund lands in the ticket WALLET** (`grantTickets`, reason `refund`),
    not as a reverse Telegram Stars transaction. A Stars reversal is a provider
    call that fails, and making it durable needs its own purchase table plus an
    hourly sweep (the `venue_change_purchases` / `rematch_purchases` pattern).
    A wallet credit is immediate, local, and exactly-once — the user keeps the
    value they paid for and spends it on the next date. Deliberately NOT a
    money-back path: this is scoped as "you don't lose what you paid for", not
    as a cash refund rail.
  - **Who gets what.** Slot A refunds to user A and slot B to user B, EXCEPT
    when `paidForPartnerBy*` records that one side covered the other — then the
    covered slot refunds to the coverer, who gets **two** tickets back. Without
    that exception the "I'm paying for us both" gesture (§3.5b) would quietly
    turn into gifting the partner a ticket she never bought.
  - **Every path that kills a live match** refunds: freeze, GDPR hard delete,
    and moderation suspend/ban/investigation (all four share
    `services/cancel-in-flight-matches.ts`), plus emergency cancellation of a
    `scheduled` date (§Phase 4) and the §3.5c 48-hour planning-stall end. The
    24 h proposal TTL needs no hook — every slot claim is guarded on
    `status = 'negotiating'` and the gate only opens after mutual accept, so a
    `proposed` row can never hold a paid slot.
  - **Exactly once, and never negative.** Idempotency is a synthetic unique
    `TicketLedger.externalPaymentId` (`refund:match:<matchId>:<userId>:<slot>`),
    so a re-run, a retry, or two paths firing on the same match credit nothing
    twice; each slot is its own transaction, so a partial failure is resumable
    rather than lost. A payer whose account no longer exists (hard delete) is
    skipped, and their partner is still refunded — which is why the plan is read
    inside the cancelling transaction, while the match row still exists, and
    applied after it commits.
  - **Not silent.** A refund nobody notices isn't a refund: the partner's
    cancellation notice carries the localized "your ticket is back in your
    wallet" line (all five languages), and a refunded user this rail sends
    nothing else to gets that line as its own short DM.
  - **The expiry rail keeps ownership of its own cases.** A `ticketStatus` of
    `refunded`, `refund_pending`, or `expired` means `ticket-expiry` has already
    returned the money, is mid-retry, or found nothing paid — this rail stands
    down on all three. `partial` (one side paid, the other never did) IS
    refunded here, since a cancelled match never reaches the expiry sweep's
    `negotiating` filter.
- **The ticket card, and what it may print (reworked 2026-08-08, Telegram-only).**
  One `Ticket3D` component renders the hero card on BOTH ticket screens — the
  gate and the store — so what follows is true of each. It carries the wordmark,
  the brand butterfly, and the wallet count under its own printed field name,
  and it deliberately carries nothing else.
  - **It is a portrait object, at a fixed proportion** (268 × 392, ~1:1.46 —
    revised the same day from 300 × content, which summed to roughly square).
    The height is a property of the CARD, not of its contents: `.ticket-main`
    flexes and the mark is centred in whatever is left. Before that, the gate's
    card (which prints a name row) and the store's (which does not) were
    literally different shapes, and any line added or removed silently changed
    the silhouette.
  - **"Admit two" / "На двоих" is gone from the header and the stub**, because
    it was false: one ticket admits ONE person, and a man paying $13.98 "for us
    both" is buying TWO. On the male's "pay only mine" path the card was telling
    him his partner was already covered.
  - **The names are the gate's alone.** The store used to print a fabricated
    pair ("Участник & Твоя пара") — the one place in the app where invented
    people were shown as issued. Its card now carries none; the gate keeps the
    real pair, small, under the mark (founder decision — the alternative was
    dropping them everywhere and making the ticket a pure object).
  - **The printed serial is gone** (removed the same day it was reseeded from
    the match id). It was the last small grey type on the card and it referred
    to nothing — no record carries it, so a user who reads it learns a hex
    string. Its space went to the mark, which is now **148px**: the card's one
    piece of art, stamped into the stock, rather than a logo sitting above a
    caption.
  - **The "curated date ticket" label and the marketing tagline are cut**
    (founder decision). The perforation, the real notch cutouts and the stub
    say what the object is; the screen's own headline says the rest.
  - **The barcode is gone, and the stub prints a field instead (2026-08-08).**
    It was the last purely decorative element on the card: seeded stripes that
    scan to no record, sitting opposite a number the card never explained. The
    stub now reads as a real ticket stub does — the field's name on the left
    (`balanceLabel`, one word, uppercased in CSS: БАЛАНС / BALANCE / GUTHABEN /
    SALDO), its value on the right — which is the same idiom doing an actual
    job: it says that the figure in the corner is how many Date Tickets the
    user holds. The number takes the weight the label gives up (17px near-white
    against a dim tracked 11px), because it is now a value in a field rather
    than a mark in a corner. Two consequences worth stating: the ticket's
    `seed` prop and its stripe generator are deleted with it, and the stub
    carries a **`min-height` floor** so a blank stub — the gate past the offer
    screen, where the balance is deliberately withheld — leaves the tear line
    exactly where a printed one does. Without that floor the perforation would
    sit at a different height per screen, which is the silhouette drift the
    fixed 268 × 392 card exists to end.
  - **The wallet count moved onto the stub**, replacing a glass pill under the
    card that on the light theme was grey-on-cream and barely legible — the
    always-dark stock gives it a ground to read against, so the theme problem
    disappears rather than being restyled. It stays hidden wherever it was
    hidden before (the gate shows it only on `offer` / `cover-partner`), and
    additionally at a **zero** balance: "× 0" printed on a ticket reads as a
    rendering fault, and in the store an empty wallet is what the bundles below
    are for.
  - **There is no specular highlight at all**, in either of the two forms it
    took — first a soft blob half the card wide, then a narrow raking band
    parked off-centre. The second was better and still wrong, and the reason is
    structural rather than a matter of tuning: a highlight is a reflection OF
    something, and this card sits on a flat page with no light source to
    reflect, so anything drawn is a guess the eye reads as paint on the surface.
    What survives is the **holographic film at 0.22** (down from 0.55), because
    foil is a genuine property of the stock and can shift with the angle
    honestly. The drag / gyro / inertia interaction is untouched — the card
    still turns, it just stops pretending to catch a lamp.
- **One light, everywhere (2026-08-08, Telegram-only).** The store's bundle rows
  and the gate's hero button carry the house **inner-edge sheen** — four inset
  shadows pulled back past the border by a negative spread, so the light reads
  as coming from the border inward (the same recipe as onboarding's action pill,
  referral's share button and the height drum's capsule). The one-time famine
  deal carries warm rose, so there the temperature IS the meaning. On the light
  theme the geometry
  survives but the polarity inverts (a white card cannot be lit whiter from its
  own edges, so the light becomes a shading inward) and a hairline is added, for
  the same reason `.ob-wheel-capsule` needed one. The hero button's travelling
  white bar is retired with it: a hard-edged rectangle sweeping a static button
  on a loop is the same "light doing what light does not" problem as the card's
  old glare. The saving badges are unchanged; the trailing `›` is dropped, since
  the whole row is the button and the chevron sat a few pixels from the badge.
  - **The recommended rung is a FILLED burgundy button carrying WHITE light**
    (founder decision, revised the same day). The first pass stripped its fill
    and gave it burgundy light on glass, arguing that a colour plus a
    temperature says "this one" twice. That held on the dark theme and failed on
    cream: burgundy light shading inward on a white card is a smudge, not an
    emphasis, so the strongest offer on the screen read as the weakest row. It
    is the same object as `.btn-hero` — the two-layer burgundy fill, white light
    held inside its own edges, white type (an outer burgundy glow was tried for
    separation and dropped: it haloed the row and re-created the washed
    look). This does not break "exactly one loud button per screen" — the store
    has no hero of its own, since its action bar appears only after a purchase.
    Applied in **both** themes deliberately: a rung that is a filled button on
    one and a glass row on the other is two components, and every later edit
    would have to be checked twice. Two consequences inside the row: the
    per-ticket line and the "best value" tag drop to translucent white rather
    than going grey (which turns muddy on this fill), and the saving pill
    inverts to near-white with burgundy type — it used to be a burgundy gradient
    on burgundy, i.e. the single best saving on the screen, invisible.
    **Its fill is one gradient, and its edge light differs by theme** (revised
    the same day). It shipped with a second layer on top — a 90° white wash
    bright at both ends — which was doing the job of edge light in the one place
    edge light must not land: the left end is where the count emblem sits (18px
    of padding plus a 52px tile falls inside the first ~19% of the row), so the
    layer washed out the very number the row is selling. That layer is gone, and
    the *horizontal* pair of the inset sheen is cut to a whisper for the same
    reason, while the vertical pair — which crosses only fill — is untouched.
    This is a real divergence from `.btn-hero` and it is structural rather than
    a matter of taste: the hero button is centred text on empty fill, so light
    hugging its sides lands on nothing, and it keeps the full recipe. On the
    **light** theme the row carries **no inner light at all**: on cream, a white
    rim held just inside a burgundy button does not read as light coming from
    the edge, it reads as a white FRAME drawn around the fill. What separates it
    from the page there is the page itself plus the shadow underneath.
  - **On the dark theme, light is a signal rather than a finish** (added the
    same day). The two ordinary rungs carry **no edge light**: they are lifted
    off the near-black page by being a step lighter than it (about `#1a1a1a` —
    black, but visibly grey) and by the shadow underneath, which is tint and
    elevation, exactly what the shared theme rules allow structure to use. The
    sheen then belongs only to the two rows that have something to say — the
    recommendation and the one-time deal — instead of being worn by every row,
    which is what made it read as a finish. On the cream page the sheen stays on
    all of them: there it is a shading inward, and without it a white row on a
    white page has no edge at all.
  - **The count emblem sets the number, not a formula.** It printed "×3" as one
    17px string, so the multiplication sign carried as much weight as the digit
    — and the digit is the only part anyone reads. The digit is now 26px with
    the "×" a small mark beside it, optically centred against the digit's
    x-height rather than sat on the baseline. On dark it is a properly saturated
    burgundy tile with no white halo inside its edges: `--accent-soft` is 0.18
    alpha, which over a near-black row resolves to roughly `#2b1017` — a tile
    that is technically burgundy and reads as dark grey — and once the row
    around it went flat, the tile was the only thing left carrying colour. A lit
    tile inside an unlit row is also one object saying two things about where
    the light comes from.
- **The action bar floats; it is an island, not a welded footer (2026-08-08,
  Telegram-only).** Both ticket screens pin their own buttons to the bottom —
  the store's **Готово** after a purchase, the gate's pay/use pair — and the bar
  used to sit in the page's flex flow. That made the scroll area end exactly at
  its top edge, so content was cut off against a hard horizontal line belonging
  to no object on screen: a panel edge the design system does not otherwise
  have (*depth from fills, inset light and shadow, never outlines*). The bar now
  paints **over** the scroll, and content dissolves under it through a scrim —
  opaque page colour beneath the buttons, fading to nothing above them. Same
  construction as the venue board's own CTA (`.vc-bar`, §3.7b), which is where
  the pattern already worked; that screen is untouched.
  Two details are load-bearing rather than styling. The fade is a fixed
  **72px length**, not the percentage `.vc-bar` uses, because this bar's height
  is not fixed — one button, two, three, more when a long RU/UK label wraps —
  and a percentage would make the softness a function of how many buttons
  happen to be on screen, giving the *shortest* bar the harshest edge. And the
  scroll reserves the bar's **measured** height at its end (`--bar-space`,
  `apps/webapp/src/ticket/action-bar.ts`) rather than a constant: too little
  hides the last row of content behind the buttons, too much leaves a dead
  strip at the end of a short list, and the right number is only knowable at
  runtime for the same wrapping reason. A screen with no bar (the store before
  a purchase) reserves nothing.
  **The ramp lives entirely ABOVE the buttons, outside the bar's own box
  (corrected 2026-08-08).** The first version ran one gradient across the whole
  bar — solid at the bottom, fading over the top 72px — but the buttons start
  only 16px below that top, so the first one sat almost wholly in the
  transparent end of the ramp. A glass secondary is `--fill`, **6% white**, so
  whatever the bar passed over was read straight *through* it: on the waiting
  screen the countdown line showed burgundy inside the grey Close button, which
  reads as two controls stacked on each other. The bar's own background is now
  plain `--bg` (invisible against the page, so still no panel — but genuinely
  opaque) and the 72px ramp is a `::before` sitting above it. Keeping the ramp
  out of the box is also what keeps `--bar-space` honest: it is `offsetHeight`,
  so folding the fade into padding would reserve 72px of dead strip at the end
  of every short list. Content is meant to dissolve under the ramp; it only has
  to clear the buttons.
- **The countdown moved into the header, and says whose it is (2026-08-08,
  Telegram-only).** The partner's remaining window used to be the LAST item in
  the gate's scroll, under a ticket that already fills the screen — i.e. inside
  the one band the floating bar passes over, which is how it ended up legible
  through the Close button. It now sits under `waitingSub`, the sentence that
  explains it, where it cannot be occluded and reads as one thought with the
  line above. Three things travel with the move. Its **subject is named**: the
  English line always said "They have {time} left", while the four translations
  had been cut to a bare «Осталось {time}» in the course of making them
  gender-neutral — a number on screen saying neither what was running out nor
  for whom. **The units are localized**: `formatCountdown` baked in `h`/`m`, so
  a Russian sentence carried English letters spliced into its middle
  («Осталось 23h 59m»); the units are now `{n}`-templates per locale. And it
  drops the burgundy for muted text at the sub's size — a countdown was the
  loudest thing on a screen whose whole message is "nothing to do, we'll tell
  you".
- **On the waiting screen the way back to the cover offer is the button, and
  Close is the text under it (2026-08-08, Telegram-only).** It shipped
  inverted: **Закрыть** held the full-width glass rung while "Всё-таки оплатить
  за пару" — the only thing on that screen that *does* anything — was a 14px
  grey link beneath it. That is the same inversion this section already
  corrected once on the cover screen itself, and Close is not an action in any
  case: Telegram renders its own ✕ in the chrome directly above. A user with
  nothing to reconsider (a woman, or a man whose partner already settled) sees
  Close alone and it keeps the rung, since the "exactly one loud button" rule is
  about which action is loudest, not about denying the only one a shape.
- **The store's heading carries no 🎟️, and gets its weight from size
  (2026-08-08, Telegram-only).** A rendered ticket is the largest thing on that
  screen, so an emoji of one above it restated the picture in a platform font we
  do not control — the same rule `marks.tsx` applies to the card itself — while
  competing with the heading at roughly equal optical weight. Both `title` and
  `successTitle` lose it in all five locales. "Heavier" then could not come from
  the weight axis: Space Grotesk's variable range stops at **700**, and asking
  for 800 gets a synthesised smear (the trap onboarding's headline already hit,
  §1.3). It comes from **31px and tighter tracking** instead, which thickens the
  strokes ~15% in absolute terms. The size is on the shared `.ticket-header h1`,
  so the gate's own heading grows with it — deliberate, since two header scales
  across one flow would be worse than one.
  **The gate's headings were cleared the same day, on the same reasoning**:
  `waitingTitle`, `successTitle` and the cover card's `coverPartnerTitle` all
  printed 🎟️ above the same rendered ticket. **Button** labels keep theirs —
  🎟️ there is what tells "use a wallet ticket" apart from "pay money", which is
  a job rather than decoration.
  **The mutual-match heading lost its 🤍 too (founder decision 2026-08-19),
  reversing the carve-out this bullet used to carry.** That carve-out held that
  the heart was the match rather than a restatement of the ticket below, which
  is true and turned out not to be the deciding question: this is the screen
  that asks for money, and a decorative glyph beside the headline is the one
  thing on it that reads as marketing rather than as a receipt. The warmth is
  not lost — it is carried by the chat card this Mini App opens from, whose
  falling-hearts `message_effect_id` (§3.4) is the moment for it. `closedTitle`'s
  📅 stays: that one names the calendar the screen is handing over to, so it is a
  label rather than an accent. Tests hold the four headings 🎟️-free and this one
  🤍-free in all five locales.
- **State machine.** The whole gate runs while `Match.status = negotiating`;
  `ticketStatus` is a sub-state so the scheduling/venue/lifecycle code is
  untouched. Blind-decision and all other invariants are unaffected.

### 3.5c Planning stall: the check-in and the 48h end (always-on, Telegram-only)

The decision deadline (§3.1/§3.5, a flat 24h TTL under `weekly`) covers only
the pitch decision. Once both sides accept, the scheduling (§3.6) and venue
(§3.7) steps had **no deadline of any kind** — a partner who went quiet left
the other person waiting indefinitely, with no chat to ask through and, before
this, no way to cancel either (the emergency button only exists once a date is
`scheduled` and within T-5 h).

**The cost was never the silence.** Both sides occupy a live match, and the
single-live-match invariant (§3.2 filter 8) excludes them from every drop
batch until it resolves. One ghost therefore cost the other person an entire
cycle — and nothing in the product could end it. Freeing both sides for the next
drop is what this section is actually for; the reminders are the polite part.

**The chain below is the `weekly` `DropCadence` profile's values
(`CADENCE.stallCheckInMs`/`stallTimeoutMs`/`venueNudgeOffsetsMs` — §3.1); the
`daily` profile halves the check-in to 12h and the end to 24h, and is inert in
production.** Per side, counted from when the phase opened:

| When | Who | What |
|---|---|---|
| 6 h / 12 h | the side that still owes an action | gentle nudge (the venue step's is new; scheduling already had this pair) |
| 24 h | same | **check-in: 🟢 "Still on" / "Plans changed"** — and the side that already did its part is told it happened |
| 48 h | — | the match is cancelled; both are freed |

- **The anchor is the phase, not the pitch.** Venue counts from
  `venuePromptAskedAt`; scheduling from the new `Match.schedulingOpenedAt`,
  written by `startScheduling`. The scheduling nudges used to count from
  `dispatchedAt`, which also covers the up-to-24 h decision window — a pair that
  accepted at hour 23 was already "6 h past dispatch", so the first "pick a time"
  nudge could land right behind the Calendar card. Rows predating the column keep
  the dispatch anchor.
- **`negotiating` with no `proposedTimes` is not a stall.** That state is the
  §3.5b Date Ticket gate, which has its own deadline, refund policy and expiry
  worker. `proposedTimes` is the honest discriminator because `startScheduling`
  writes it when (and only when) the Calendar opens; `ticketStatus` cannot be
  used — it defaults to `pending` even with tickets switched off entirely.
- **"Both picked, nothing overlaps" IS a stall, on both sides (2026-08-05).**
  `sideOwesAction` used to ask only whether a side had marked *anything*, so
  once both had, neither owed an action — and the whole chain keys off that
  predicate. The consequence was not a cosmetic gap: the pair got no 6 h/12 h
  reminder, were never asked "still on?", and **the 48 h cancellation never
  fired**, so two people whose calendars simply didn't line up sat in a live
  match indefinitely — held out of every drop by the single-live-match rule
  (§3.2 filter 8), which is the exact failure this whole section exists to
  prevent. The state was reachable in one ordinary move: pick a slot, have your
  partner counter with a different one. Both sides owe it now, because either
  of them can end it alone (widen, or take one of the other's slots — a shared
  slot auto-locks the date). It is also the reason §3.6b shows no status there.
- **🟢 commits instantly, 🔴 always confirms.** Green needs no confirmation:
  it changes nothing the user could regret, pushes that side's 48 h out from now,
  and re-arms the question **once** (gated on it being the first confirmation, so
  the chain is bounded at two questions and green cannot hold a match open
  forever). Each sent question can be confirmed exactly once — the write is a CAS
  on the confirmation timestamp and requires it to predate the question — so a
  tap on a stale button is a no-op rather than another 48 h. Red opens a
  confirmation card with a way back, like passing on a pitch: cancelling is
  irreversible under the lifetime pair ban (§3.2 filter 6).
- **Penalties are asymmetric on purpose.** An honest "plans changed" costs
  **nothing** — that is the behaviour the check-in exists to produce, and pricing
  it would make silence the cheaper move. Running the clock out is treated as a
  **silent ignore**: `silentIgnoreCount++` with the same forgive-once rule the
  pitch stage uses (§3.4), then the decline-grade Elo penalty. Either way the
  other side gets next-batch priority (`boostAcceptedSidePriority`), because
  their week is gone regardless.
- **A paid Date Ticket comes back on both endings** (§3.5b), and this is the
  stage where that matters most: the ticket gate sits inside `negotiating`, so a
  stall here is the likeliest way a paid ticket dies. The ghost is refunded too —
  their silence is already priced in Elo above, and charging a ticket on top
  would make going quiet cost money that the honest red button does not, which
  inverts the whole point of this chain. The line is appended to each side's
  existing notice / ack.
- **The notices say what actually happened**, and never guess. Someone who did
  their part hears that the partner never answered, framed as the save it is
  ("better now than on the day"). Someone whose partner cancelled hears that
  their plans changed, plus the existing "this isn't about you". The quiet side
  hears why it lapsed and — the part that matters next time — that telling us is
  a normal thing to do. The copy says **priority in the next drop**, never
  "rating": what moves is `standbyCount`, not attractiveness Elo.
- **Cancellation by text and voice, at every stage.** The agent's
  `propose_cancel_date` (§2.1, class **confirm**) used to filter on `scheduled`
  alone and told the model to "explain that instead", so a user who wrote *"I
  want to cancel"* mid-planning got a polite explanation and zero ways out. It
  now also resolves the two planning phases and hands over the same confirmation
  card. Text and voice still never commit anything — the irreversible step is
  always the user's own red tap on a real handler. When the message is ambiguous
  between *how does cancelling work* and *cancel it*, the agent asks one short
  clarifying question first. The agent also learns when a check-in is open, so
  someone who types "да, всё в силе" instead of tapping gets pointed at the green
  button rather than a blank stare.
- **Telegram-only, and fail-safe about it.** The check-in is an inline-keyboard
  question, so a mobile-only participant (synthetic negative `telegramId`) could
  never answer it. A stall whose owing side is unreachable is therefore left
  **completely alone** — never asked, never timed out. Cancelling on someone we
  never asked would be indefensible.
- Quiet hours (23:00–09:00 Kyiv) suppress the whole chain, cancellation
  included — that outcome is a real notification. A few hours of extra grace on a
  two-day deadline costs nothing. Runs on the existing hourly `match-nudge` cron;
  no new schedule.
