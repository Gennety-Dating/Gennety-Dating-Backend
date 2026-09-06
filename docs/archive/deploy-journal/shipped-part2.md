<!-- WHEN_TO_READ: HISTORICAL. Only when you need the verification steps or rollback of an ALREADY SHIPPED deploy (entries 2026-08-10 .. 2026-08-07). Find it via INDEX.md first — never read this file whole. -->
<!-- SOURCE: deploy.md (lines 6179-9083) — migrated 2026-09-01 -->

# Shipped deploy journal — part 2 of 3

Index of every entry: [INDEX.md](../../operations/deploy-journal/INDEX.md). Order is preserved from the original file (newest first).

---

**Applied 2026-08-10 (env-only) — `DROP_CADENCE=daily`: matching runs every
evening (PRODUCT_SPEC §3.1, DECISIONS.md).** **No code change, no Prisma schema
change, no Mini App change** — the `daily` profile has shipped in code since
2026-08-02 and was inert. Two steps, in this order, and the order is the whole
risk:

```sh
# 1. FIRST — rescale the counters, BEFORE the env flip. The script's own guard
#    reads DROP_CADENCE as the statement of which scale the data is on, so it
#    refuses if you flip first.
pnpm cadence:normalize-standby -- --to=daily --prod          # dry run, read it
pnpm cadence:normalize-standby -- --to=daily --prod --apply
# 2. THEN the flip.
cd /opt/gennety && cp .env ".env.bak.$(date +%Y%m%d-%H%M%S)"
echo 'DROP_CADENCE=daily' >> .env
pm2 restart gennety-bot --update-env && pm2 save
```

Applied here: 38 profiles scanned, **3 rescaled** (1→7, 1→7, 2→14), which
preserves each user's starvation weight exactly — `alpha` moves 0.05 → 0.05/7,
so 7 daily cycles buy the same bonus 1 weekly cycle did. Backup
`.env.bak.20260810-181310`.

**Five things that change, verified live from the running process:**

- **The batch cron is `0 18 * * *`** (was `0 18 * * 4`) and the no-match cron
  `15 18 * * *`. Both confirmed in the startup log after restart.
- **Famine notices stay WEEKLY.** `famineNoticeIntervalMs` is 7 days in *both*
  profiles ("match daily, apologise weekly", §3.1), and it is a query-level
  filter, so most evenings that find nobody now send **nothing at all**. That
  silence is deliberate — do not read it as a broken cron.
- **The pinned banner drops its countdown** for everyone without a live match
  (`dropOutpacesNotices()` → `true`, verified). A timer is only honest if
  reaching zero resolves into something, and under `daily` it would hit zero
  into that deliberate silence six evenings out of seven. Mode 5 shows a steady
  "I'm looking — I check every evening" instead, plus the Rematch entry for a
  man who could buy one.
- **Planning deadlines halve**: cooldown 24h → **6h**, proposal nudges 3h/10h →
  **2h/8h**, scheduling nudges 6h/12h → **3h/6h**, stall check-in/cancel 24h/48h
  → **12h/24h**, Profiler rush window 48h → **4h**.
- **Rematch limits follow the profile** (`rematchLimits()`): **7 per 7 days**
  with the 24h cooldown as the real governor, and the pre-batch blackout 6h →
  **1h** (6h is 3.5% of a week and 25% of a day). `rematchGiftCapMs` stays **7
  days in both profiles** — every other knob describes what the BUYER may do,
  that one protects the woman he is buying his way to. A test pins it.

**Timing gotcha:** the flip landed at 21:14 Kyiv, i.e. after that day's 18:00
slot, so the first daily drop is the FOLLOWING evening — not the same night.

Post-flip verification (all green): restart count 58 → 59 with no loop, 0
errors from the new PID, `/v1/ping` ok, admin `401`, all 11 Mini App pages
`200`, `supportedCities` still Kyiv-only, and the loaded profile read back from
the process itself (cron string, famine interval, gift cap, banner predicate,
`starvationAlpha === 0.05/7`).

**Rollback:** remove the `DROP_CADENCE` line (or set `weekly`) and
`pm2 restart gennety-bot --update-env` — **but run
`pnpm cadence:normalize-standby -- --to=weekly --prod --apply` FIRST**, or every
accumulated counter is re-read at 7× its weight and pins the whole base at the
starvation cap, which deletes priority ordering rather than inflating it.

---

**Deployed 2026-08-09 (was PENDING) — post-date feedback reaches the app at all (PRODUCT_SPEC §Phase 4.3,
DECISIONS.md ×3).** Deployed 2026-08-09 in the 32-commit backlog release. **No Prisma schema change, no env change,
no flag change, no Mini App change** (`apps/webapp` untouched) — bot-side only,
so a full server code deploy carries it, plus `pnpm demo:deploy`. The client
half ships from the iOS repo separately.

Three holes in one feature, all closed together. The form existed only as an
`initData`-signed Mini App; the T+24h prompt that carries its link was a
Telegram DM guarded on `telegramId > 0`; and `/v1/matches/current` excludes
`completed`, so once the date closed out the match vanished from every surface
the client polls. An app user was never told a form existed and could not have
found it.

**Four things worth knowing before the restart:**

- **The T+24h DM changes who it reaches, on BOTH rails.** `telegramReachable`
  replaces `telegramId > 0`, so a Telegram-login account that never pressed
  Start stops being DM'd (it never saw the message anyway), and a new **push**
  leg is added for `mobile`/`both`. Expect one new push per completed date per
  app-side participant — the first push this event has ever sent. Ten new i18n
  keys (`feedbackPushTitle`/`feedbackPushBody` × 5 locales); additive.
- **`public/routes/feedback.ts` was rewritten**, though its behaviour is
  unchanged by design: same validation bounds, same five-language header table,
  same venue-fit write, now all from `services/post-date-feedback.ts`. The one
  observable difference is the error strings on a 400 — `bad-chemistry` /
  `bad-second-date` instead of the old prose (`"chemistry must be an integer
  1..10"`). The Mini App shows its own copy and never renders these, but a log
  grep for the old strings will come up empty after this.
- **`GET /v1/me/feedback/pending` answers `{"pending": null}`, not 404**, when
  nothing is owed. That is the ordinary state of the endpoint; a client polling
  it must not treat the common case as an error.
- **Nothing exercises it in production yet.** It needs a `completed` match, and
  production has had **0 dates ever** (2 matches, both terminal before a date).
  Verify on `@gennetytestbot` or the demo.

Preflight for this change: bot typecheck clean, `pnpm openapi:lint` valid (9
warnings, unchanged), **3552 bot tests** (0 failed, +22 new).

Post-deploy check — the routes answer 401 unauthenticated, which is the proof
they are mounted; the fan-out logs only on failure, so silence is the good case:

```sh
# 401 (mounted), never 404 (missing).
curl -s -o /dev/null -w '%{http_code}\n' https://dating-api.gennety.com/v1/me/feedback/pending
pm2 logs gennety-bot --lines 200 --nostream | grep 'feedback push failed'
psql "$DATABASE_URL" -c "select count(*) filter (where feedback_prompted_at is not null) prompted, count(*) filter (where feedback_by_a is not null or feedback_by_b is not null) answered from matches;"
```

**Rollback:** revert the code and restart. Nothing else to undo — no schema, no
env, no flag. The added i18n keys are inert once the caller is gone.

---

**Deployed 2026-08-09 (was PENDING) — synthetic test profiles for the
friends-and-family production run (PRODUCT_SPEC §3.1c, DECISIONS.md ×2).**
Deployed 2026-08-09: schema pushed, 30 profiles seeded (12 women / 18 men, 207
photos), `SYNTHETIC_FILL_ENABLED=true` and the auto-decline cron confirmed
registered. **No Mini App
change** (`apps/webapp` untouched), but it needs an **additive `db:push` BEFORE
the restart**, plus **one env line** and a **seeding step**, so the full
sequence is: Deploy Full Server Code → `db:push` → `pnpm db:drift-check` →
`pm2 restart` → seed profiles → flip the flag → `pm2 restart --update-env`.

One new column, `users.synthetic_at` (nullable), is SELECTED on every drop
batch, every decision and every expiry sweep, so a DB missing it throws `P2022`
on the first pitch after the restart — the PM2 crash-loop this file warns
about. Verify additive first (expect exactly one `ADD COLUMN`, zero `DROP`):

```sh
export DATABASE_URL="$(sed -n 's/^DATABASE_URL=//p' .env | tail -1 | tr -d '"')"
pnpm --filter @gennety/db exec prisma migrate diff \
  --from-schema-datasource prisma/schema.prisma \
  --to-schema-datamodel prisma/schema.prisma --script
pnpm --filter @gennety/db db:push
pnpm db:drift-check   # must exit 0 before pm2 restart
```

**The code ships INERT and that is the intended first state.** With
`SYNTHETIC_FILL_ENABLED` unset the second pass never runs, the auto-decline
cron is not registered, and — separately — no seeded row exists to be offered
anyway. Two independent conditions have to be true before a real user sees
anything, which is deliberate.

**Six things worth knowing before the restart:**

- **The arithmetic decides how many photos are needed, and it is the operator's
  real constraint.** The lifetime pair ban applies to synthetics too (founder
  decision), so one profile is one showing per person: `N` synthetic women
  cover `N` drops for each man. Production is **6 men / 1 woman in Kyiv**, so
  the shipped manifest (8 women + 6 men) is roughly 8 days of full coverage for
  the men and 6 for the woman. Top it up by appending to
  `scripts/synthetic-profiles.json` — **never reuse a `slot`**, it is the
  permanent `telegramId` and a duplicate overwrites another profile's account
  (the loader refuses one, but only if you run it).
- **Photos must go through the PRODUCTION bot.** `file_id`s are per-bot. The
  seeder sends each image to `FOUNDER_TELEGRAM_ID` (override with
  `SYNTHETIC_SEED_CHAT_ID`) to mint them, so expect a burst of photos in that
  chat — that is the mechanism, not a bug. Keep the source folder OUTSIDE the
  repo; the deploy rsyncs the working tree.
- **A profile with no photos is still `active` and matchable.** The seeder
  reports which slots are short of `MIN_PHOTOS` before writing anything —
  read that list rather than scrolling past it.
- **`Match.source` gains the value `synthetic`.** No migration (plain string
  column), and those pairs write no `MatchScoreLog`, so the algorithm A/B stays
  clean without a filter.
- **Rematch is protected two ways** and both matter now that
  `REMATCH_FEATURE_ENABLED=true`: synthetics are invisible to
  `findCandidatesFor`, so a paid run honestly refunds instead of selling a bot;
  and the post-cancellation Rematch DM is suppressed after a synthetic decline.
  The pinned-banner entry is unaffected — it only renders under `daily`.
- **Nothing here flips the cadence.** `DROP_CADENCE` stays unset; on weekly the
  fill runs once a week, on Thursday. Verify the mechanism there first, then
  flip daily as its own step (`normalize-standby-count.mjs` remains its
  precondition).

Preflight for this change: typecheck clean across all 5 projects, lint clean,
**4061 tests** (bot 3530 / shared 276 / webapp 255), 0 failed. The three guards
that carry the money-critical and data-integrity properties were each confirmed
to FAIL with the protection removed before being confirmed green: the
`synthetic_at IS NULL` exclusion, the "exactly one synthetic side" pairing rule,
and the `updateEloScores` no-op.

Post-deploy sequence and checks:

```sh
# 1. Dry run FIRST — prints the target DB host and what it would write.
pnpm synthetic:seed
# 2. Seed for real, with photos laid out as <dir>/<slot>/*.jpg
pnpm synthetic:seed -- --apply --photos=~/Desktop/_TO_GDRIVE/gennety-media/synthetic-photos
# 3. Confirm every profile got an embedding — without one it is silently
#    unmatchable, which looks exactly like "the fill does not work".
psql "$DATABASE_URL" -c "select u.first_name, u.gender, array_length(p.photos,1) photos, p.embedding_dirty from users u join profiles p on p.user_id=u.id where u.synthetic_at is not null order by u.telegram_id desc;"
# 4. Only now flip the flag.
#    SYNTHETIC_FILL_ENABLED=true in /opt/gennety/.env
pm2 restart gennety-bot --update-env && pm2 save
pm2 logs gennety-bot --lines 40 --nostream | grep 'Synthetic test partner'
```

After the Thursday drop, the two lines that tell the whole story:

```sh
pm2 logs gennety-bot --lines 200 --nostream | grep -E '\[drop-batch\]|\[synthetic-partner\]'
# syntheticFill=N on the batch line; declined=N ~20 min after a tester answers.
psql "$DATABASE_URL" -c "select source, status, count(*) from matches group by 1,2;"
```

**Rollback:** remove `SYNTHETIC_FILL_ENABLED` + `pm2 restart --update-env` —
the fill stops instantly and matches already in flight resolve through the
ordinary decline/expiry paths. To remove the accounts entirely,
`pnpm synthetic:remove -- --apply` (hard delete through the production
`deleteUserAccount`). **Run that before the product opens past the test
cohort** — this is scaffolding with an end date. The additive column can stay.

---

**Deployed 2026-08-09 (was PENDING) — daily Rematch groundwork: the cadence owns the limits, and two pull
entries (PRODUCT_SPEC §3.11 / §2.1 mode 5, REMATCH_PRODUCT_SPEC, DECISIONS.md
×3).** Deployed 2026-08-09 in the 32-commit backlog release. **No Prisma schema change, no env change, no flag
change, no Mini App change** (`apps/webapp` untouched) — bot-side only, so a
full server code deploy carries it, plus `pnpm demo:deploy`.

**Production behaviour is unchanged by this deploy, and that is checkable rather
than asserted.** `DROP_CADENCE` is unset (weekly), the four `REMATCH_*` limit
vars are unset, and a test asserts the weekly profile reproduces today's numbers
literally. What ships is the seam, not a behaviour change.

**Five things worth knowing before the restart:**

- **The banner block costs nothing today and is the one thing to watch if that
  ever changes.** Rematch eligibility is resolved once per `status-timer` tick
  (3 queries), but only when `dropOutpacesNotices()` is true — false under
  weekly, so **not a single extra query runs**. Under a future `daily` flip it
  becomes 3 queries a minute, which is why it is batched rather than per-user.
- **Four `REMATCH_*` env vars changed meaning from "default" to "override".**
  They are unset in `/opt/gennety/.env`, so nothing moves. If any is ever set,
  note that a literal `0` is now a real value (`REMATCH_PRE_BATCH_BLACKOUT_HOURS=0`
  still disables the blackout) while an empty string means "follow the profile".
- **The concierge gains one tool target** (`open_screen: rematch`). It is gated
  per user in code, so a woman or a rate-limited man gets nothing — and the
  refusal string names no feature, deliberately, because it is fed back to the
  model verbatim.
- **Ten i18n keys added** (`rematchOfferNeutral` + `statusButtonRematch` × 5
  locales). Additive; nothing existing changed.
- **`REMATCH_FEATURE_ENABLED=true` in production**, so the concierge entry is
  live on deploy. The banner entry is not reachable until a `daily` flip.

Preflight for this change: typecheck clean across all projects, lint clean,
**3509 bot tests + 276 shared** (0 failed). The new guard tests were each
confirmed to FAIL against the unwired code first — the `env ?? CADENCE` fallback
(3 failures), the batch-vs-single agreement (1), and the `open_screen` gate (3).

**Also ships `pnpm cadence:normalize-standby`** — the rollback precondition that
had been listed in the plan since 2026-07-30 and never written. It writes
nothing without `--apply` and refuses to run in the wrong direction; see
DECISIONS.md for why a dry run against production is what surfaced that guard.

Post-deploy check — nothing new is logged on the happy path, so verify the
absence of the failure path plus the concierge entry:

```sh
pm2 logs gennety-bot --lines 200 --nostream | grep 'rematch eligibility failed'
# Empty = the banner's lookup is not erroring (it should not even run: weekly).
# Then, on @gennetytestbot as an eligible male with no live match, write
# "найди мне кого-то ещё сейчас" — expect the offer CARD (terms + price), not a
# payment sheet. As a female account, expect no mention of the feature at all.
```

**Rollback:** revert the code and restart. Nothing else to undo — no schema, no
env, no flag, no Mini App state.

---

**Deployed 2026-08-09 (was PENDING) — the pinned banner push extends to accept/decline, first venue
assignment, TTL expiry and emergency cancellation (PRODUCT_SPEC §2.1,
DECISIONS.md).** Deployed 2026-08-09 in the 32-commit backlog release. **No Prisma schema change, no env change, no
flag change, no Mini App change** (`apps/webapp` untouched) — bot-side only.
Rides the same `services/status-banner-refresh.ts` the block below introduces,
so both blocks ship together in one restart, and `pnpm demo:deploy` after it.

Follow-up to the venue-change push below: once that gap was found, the obvious
question was where else the once-a-minute `status-timer` tick was the ONLY
thing keeping the pinned banner honest. Five more spots, all fixed the same
way — push the re-render the instant the write lands, instead of leaving it to
the tick:

- **A match's first venue assignment** (`services/scheduled-confirmation.ts`)
  — the moment `status` becomes `scheduled`, which is also the FIRST time the
  banner's countdown + venue name appear at all (flipping off the no-countdown
  "planning" mode shown throughout negotiation).
- **Every successfully claimed accept/decline** (`handlers/matching/
  decision.ts`) — mutual accept flips "decision" (24h countdown) → "planning";
  a mixed verdict or a second decline flips either mode back to the plain drop
  countdown.
- **The 24h reply-deadline TTL** (`services/match-expiry.ts`) — same
  drop-countdown fallback, for a match nobody answered in time.
- **Emergency cancellation of a scheduled date** (`services/
  emergency-cancel.ts`, shared by the Telegram flow and the native
  `/v1/matches/{id}/cancel` rail) — the banner was counting down to a date
  that no longer exists.

**Four things worth knowing before the restart:**

- **Two of the five have no `ctx.api` at all.** `match-expiry.ts` runs off an
  hourly cron tick and `emergency-cancel.ts` is a transport-agnostic service
  shared by two surfaces, so neither has a handler context to push through.
  Both read the process-wide bot handle via `getMainBotApi()`
  (`services/main-bot-api.ts`) — the same idiom `founder-notify.ts` and
  `proxy-chat.ts` already use for exactly this — and both no-op (never throw)
  before the bot has finished booting.
- **One of the five fires with the row's `status` still `proposed`.** A first
  decider's own accept or decline already changes THEIR OWN banner mode the
  instant `claimMatchDecision` writes `acceptedByA/B` — independent of whether
  `status` ever moves off `proposed` at all. `resolveBannerStage` reads that
  field directly, so this is real and was previously invisible to anyone
  watching only for a status transition. Only the actor is pushed there; the
  peer hasn't decided anything yet, so their own banner is unaffected.
- **The mixed-cancel branch in `handleAccept` pushes AFTER the `cancelled`
  transition, not right after the claim.** Pushing earlier would have
  rendered "planning" for a match whose real, imminent outcome is `cancelled`
  — smaller than the bug being fixed, but still a wrong state, so the ordering
  matters here specifically.
- **This adds at most one extra `editMessageText` call per side per event**,
  and only on events that were already rare per user (an accept/decline, a
  venue getting assigned, a 24h timeout, an emergency cancel) — nothing here
  runs on a hot path. Every push shares the render-cache from the block below,
  so a push that lands before the next tick simply satisfies it.

Preflight for this change: typecheck clean across all 5 projects, lint clean,
**3479 bot tests** (0 failed, +4 new — 2 in `match-expiry.test.ts`, 2 in
`emergency-cancel.test.ts`; the `decision.ts` and `scheduled-confirmation.ts`
call sites are asserted by extending the five existing scenarios in
`handlers/matching/matching.test.ts` that already cover them, plus the four
"lost the race" tests asserting the push does NOT fire for the loser).

Post-deploy check — none of these log on the happy path, so the assertion is
by eye on the demo or `@gennetytestbot` (production has 2 matches ever, both
terminal, so nothing here is exercised there yet):

```sh
pm2 logs gennety-bot  --lines 200 --nostream | grep 'push refresh failed'
pm2 logs gennety-demo --lines 200 --nostream | grep 'push refresh failed'
# Empty = nothing failing. Then: accept a pitch and watch the pinned banner
# flip off its 24h countdown within the second, not within a minute; let a
# pitch expire and watch it fall back to the drop countdown immediately.
```

**Rollback:** revert the code and restart. Nothing else to undo — no schema,
no env, no flag, no Mini App state. Reverting restores the ≤60s lag on these
five transitions (the venue-change push below is unaffected either way).

---

**Deployed 2026-08-09 (was PENDING) — the pinned banner updates the moment the venue changes (PRODUCT_SPEC
§2.1 / §3.7b, DECISIONS.md).** Deployed 2026-08-09 in the 32-commit backlog release. **No Prisma schema change, no
env change, no flag change, no Mini App change** (`apps/webapp` untouched) —
bot-side only. It touches the same two settle paths as the block below, so both
ship in one restart; that block's additive `db:push` covers the pair.
**The demo needs it as much as prod**: the free settle is the path every demo
visitor takes, so that is where it is easiest to actually see.

Reported as "the pinned message doesn't update when we change the venue — only
when you tap it". The banner was never broken: it prints the venue and its dedup
signature is the whole render. What was missing is that the once-a-minute
`status-timer` tick was its **only** writer, so the pin named the old place for
up to 60 seconds while the updated venue cards and the My Date hub were already
correct. Both settle paths now push the re-render immediately.

**Four things worth knowing before the restart:**

- **This adds up to 2 `editMessageText` calls per settled venue change**, and
  nothing else. It is not a new periodic cost: the push writes the shared render
  cache, so the next tick sees the banner as `unchanged` rather than re-sending
  it. Expect the `[status-timer]` heartbeat's `edited` counts to look exactly as
  they do today.
- **Two modules moved, no behaviour of theirs changed.** `resolveBannerStage` +
  `loadBannerStages` → `services/status-banner-stage.ts` (a service must not
  import from a worker); the render cache → `services/status-banner.ts`. The
  worker keeps its `renderCache` test option. Worth knowing only because a
  stale-file rsync of `status-timer.ts` alone would now be missing an import —
  the crash-loop this file warns about. Deploy the tree, not a file.
- **It cannot fail a settled change.** The push swallows its own errors AND both
  call sites carry a `.catch`; recovery for a missing message or an unreachable
  chat is still the worker's, within a minute. A test forces a rejection and
  asserts the settle still returns `ok`.
- **Nothing exercises it in production yet.** It needs a pair at `scheduled`
  with `VENUE_CHANGE_FEATURE_ENABLED` on, and production has had 2 matches ever
  and 0 dates. Verify on the demo, or on `@gennetytestbot`.

Preflight for this change: typecheck clean across all 5 projects, lint clean,
**3475 bot tests** (0 failed, +9 new). The test that guards the shared cache was
confirmed to FAIL with the cache un-shared before being confirmed green.

Post-deploy check — the push logs nothing on the happy path, so the assertion is
by eye plus the absence of a warning:

```sh
pm2 logs gennety-bot  --lines 200 --nostream | grep 'push refresh failed'
pm2 logs gennety-demo --lines 200 --nostream | grep 'push refresh failed'
# Empty = nothing failing. Then, on the demo: walk a run to a scheduled date,
# open "Change venue", settle a change, and watch the pinned message at the top
# — the 📍 line must name the new place within a second or two, not a minute.
```

**Rollback:** revert the code and restart. Nothing else to undo — no schema, no
env, no flag, no Mini App state. Reverting restores the ≤60s lag.

---

**Deployed 2026-08-09 (was PENDING) — the venue can be changed twice (PRODUCT_SPEC §3.7b, DECISIONS.md).**
Deployed 2026-08-09 in the 32-commit backlog release. **No env change, no flag change** — but it needs an **additive
`db:push` BEFORE the restart**, and it is half client, so the full sequence is:
Deploy Full Server Code → `db:push` → `pnpm db:drift-check` → `pm2 restart` →
`./scripts/deploy-webapp.sh` → `pnpm demo:deploy`.

One new column, `matches.venue_change_count` (`Int @default(0)`), is SELECTED on
every board open and WRITTEN by both settle paths, so a DB missing it throws
`P2022` the first time anyone opens the venue board after the restart — the PM2
crash-loop this file warns about. Verify additive first (expect exactly one
`ADD COLUMN`, zero `DROP`):

```sh
export DATABASE_URL="$(sed -n 's/^DATABASE_URL=//p' .env | tail -1 | tr -d '"')"
pnpm --filter @gennety/db exec prisma migrate diff \
  --from-schema-datasource prisma/schema.prisma \
  --to-schema-datamodel prisma/schema.prisma --script
pnpm --filter @gennety/db db:push
pnpm db:drift-check   # must exit 0 before pm2 restart
```

**Server first, and the order matters.** `restartable` / `changesUsed` are new
fields on `GET /v1/venue-change/state`; a cached older bundle ignores them and
keeps today's dead-end behaviour, which is safe. The reverse order ships a
client offering "change again" against a server that answers `already-changed`.

**Five things worth knowing before the restart:**

- **The cap is 2 and it is a code constant** (`VENUE_CHANGE_MAX_PER_DATE`), not
  env — it is the only thing bounding a pair whose changes are FREE (a Premium
  subscriber, and every demo visitor, since demo settles the board free). For
  everyone else the price is a second bound and the T−5h cutoff a third.
  Historical rows read 0, so a date that already had a change would get two
  more — moot in production, which has had **0 dates ever**.
- **A `lapsed` session now reopens too**, and costs no allowance. If any match
  is sitting in `lapsed` at deploy time its board comes back to life; production
  has none (no date has ever reached the board).
- **A finished board now reports EMPTY like arrays.** A settle leaves both
  sides' hearts in the columns and a lapse does not clear them; the state view
  zeroes them so a restart cannot open showing marks the next tap deletes. The
  columns themselves are untouched until someone actually restarts.
- **Demo needs no code and is the best place to test this**, because it settles
  every change free: `pnpm demo:deploy`, walk to a scheduled date, change the
  venue, then change it again — and confirm the third attempt is refused.
- **Nothing exercises it in production** until a pair reaches `scheduled` with
  `VENUE_CHANGE_FEATURE_ENABLED`. Verify on `@gennetytestbot` or the demo. The
  Mini App's own dev previews cover both ends without a match:
  `venue-change.html?preview=settled` (the "change again" link) and
  `?preview=settled-final` (the dead end once the cap is spent).

Preflight for this change: typecheck clean across all 5 projects, lint clean,
**3994 tests** (bot 3466 / shared 273 / webapp 255), 0 failed. The stale-peer-
likes regression test was confirmed to FAIL against the unguarded code before
being confirmed green.

Post-deploy check — the counter is the whole story, and it should only ever move
when a change actually settles:

```sh
psql "$DATABASE_URL" -c "select venue_change_status, venue_change_count, count(*) from matches group by 1,2;"
# Every row 0 until a real change settles. A row at 2 is a date whose venue is
# final — the board correctly refuses it with 409 budget-spent.
pm2 logs gennety-bot --lines 200 --nostream | grep '\[venue-change\]'
```

**Rollback:** revert the code, restart, redeploy the Mini App and the demo. The
additive column can stay (nothing reads it once the code is reverted), and a
`venue_change_count` of 1 left behind is harmless — the old code closed the
board on `settled` regardless.

---

**Applied 2026-08-09 (data) / PENDING (code) — the Kyiv catalog is imported into
both databases, and the parks the concierge could never pick now work
(PRODUCT_SPEC §3.7, DECISIONS.md ×4).** **No Prisma schema change, no env
change, no flag change, no Mini App change** (`apps/webapp` untouched).

**Read the split before doing anything: the user-visible half is ALREADY LIVE
and needed no deploy.** `curated_venues` is data, and `hoursConfidence` is read
off the row on every selection, so the import below took effect the moment it
ran — no rsync, **no `pm2 restart`**, and the production bot was not touched.
The code diff is a behaviour-preserving refactor plus tests and rides the next
ordinary full deploy; nothing waits on it.

**What ran, and against what:**

```sh
# demo first, then prod — same command, different DATABASE_URL
pnpm seed-venues:import --in=scripts/curated-venues.kyiv.approved.json \
  --city-key=ua:kyiv --apply
```

| | demo | prod |
|---|---|---|
| result | 15 created, 1208 updated | **710 created, 513 updated** |
| unique active Kyiv | 261 → 264 | **127 → 269** |
| premium | 39 → 44 | 18 → 45 |
| assignable parks | 15 → 20 of 21 | **15 → 19 of 21** |

Prod took the whole 141-venue expansion in one go, which is why its numbers move
so much more — it had been sitting on the pre-expansion catalog since before
2026-08-07. `--city-key=ua:kyiv` is **required**: the approved rows carry no
`cityKey` and the importer refuses without it.

**Five things worth knowing:**

- **A pre-import backup of all 972 prod rows** is at
  `~/Desktop/gennety-backups/curated-venues-prod-2026-08-09T14-54-49-313Z.json`
  — outside the repo on purpose, so no deploy rsync can ship or delete it.
- **`active` is never written on an update** (the D10 fix), so an import cannot
  resurrect a venue the nightly revalidation deactivated. That is also why prod
  shows 269 unique venues against 266 in the file — pre-existing rows the
  manifest does not own are retained.
- **Two Kyiv parks are still unassignable, both deliberately.** Ботанічний сад
  ім. Фоміна is gated and ticketed and stays at `hoursConfidence: "unknown"`
  (founder decision, with the reason on the row); `Міст закоханих` fails the
  quality floor at 3.8★/4 reviews, which is a misresolved `placeId` rather than
  a policy problem. Do not "fix" either by marking it `always_open`.
- **`GARAGE` is a third dead row**, surfaced by the new `--check` warning on its
  first run: Google resolves it to a `grocery_store` with no hours and no price
  level while the catalog lists it as a `cafe`. Needs re-resolving, not marking.
- **The next `pnpm sync-venues:kyiv --apply` is now safe**, and was not before:
  it rebuilds rows from Places and used to drop `hoursConfidence` and
  `reviewNote`, silently reverting every mark. Both are carried from the
  manifest now, and `--check` fails when a row and its manifest entry disagree.

Preflight for the code half: typecheck clean across all 5 projects, lint clean,
**3976 tests** (bot 3448 / shared 273 / webapp 255), 0 failed. The new
`hoursEvidenceAdmits` tests were confirmed to FAIL with the `always_open` branch
removed before being confirmed green with it.

Post-check — the honest assertion is the gate simulation, not a log line, since
nothing new is logged on the happy path:

```sh
pnpm sync-venues:kyiv --check   # expect OK + the GARAGE warning, nothing else
```
```sql
-- prod: parks the selector can actually reach
select count(*) filter (where hours_confidence in ('always_open','operator_confirmed')
                           or (opening_hours is not null and utc_offset_minutes is not null))
     , count(*)
  from curated_venues where active and city_key = 'ua:kyiv' and category = 'park';
-- and the two tier moves the founder asked for
select distinct name, tier from curated_venues
 where name in ('Cafe Marko','Très Branché');
```

**Rollback:** the data half is restored from the backup JSON above (it holds
every column of all 972 pre-import rows); there is nothing else to undo — no
schema, no env, no flag. Reverting the code half restores the inline conditions
and changes no behaviour.

---

**Deployed 2026-08-09 (was PENDING) — the venue board stops being a wall of tables (PRODUCT_SPEC §3.7b,
DECISIONS.md).** Deployed 2026-08-09 in the 32-commit backlog release. **No Prisma schema change, no env change, no
flag change, no Mini App change** (`apps/webapp` untouched) — bot-side only, so
a full server code deploy carries it, plus `pnpm demo:deploy`. The whole diff is
`capCatalog` in `services/venue-change.ts` plus its tests and docs.

Three of the board's twelve slots are now held for the nearest outdoor walking
spots (`park` — parks, embankments, Andriivskyi descent, Volodymyrska Hirka).
Before this the order was pure proximity, which in a city centre means cafés.

**Four things worth knowing before the restart:**

- **Measured against the live Kyiv catalog, not estimated.** Boards carrying at
  least one walking spot go **62% → 93%**, the average goes **0.98 → 2.79**
  cards, and board size does not change (111/113 centres still fill all twelve;
  the two that don't have fewer than twelve venues in range and always did).
  The remaining 7% are centres with no park inside the radius at all — they
  degrade to today's behaviour rather than losing a slot.
- **The radius is deliberately untouched.** The parks were never out of reach:
  the median board centre already has ten inside the existing 3 km. Do not
  "fix" this later by widening the radius; DECISIONS.md records why.
- **`museum` stays excluded on both surfaces.** The reservation is walking
  spots only and is not a back door for ticketed venues — a test holds that.
- **Nothing exercises it in production yet.** It needs a pair at `scheduled`
  with `VENUE_CHANGE_FEATURE_ENABLED` on, and production has had 2 matches ever
  and 0 dates. Verify on the demo (walk a run to a scheduled date, open
  "Change venue") or on `@gennetytestbot`. The Mini App's `?preview=board` route
  serves its own mock catalog and will NOT show this rule.

Preflight for this change: bot typecheck clean, lint clean across all 5
projects, **3442 bot tests** (0 failed, +6 new). The two tests that carry the
guarantee were confirmed to FAIL with the reservation set to 0 before being
confirmed green with it.

Post-deploy check — the board logs nothing on the happy path, so this is by eye
on the demo. What you are looking for is a board that is not all cafés: at a
central venue expect roughly three of the twelve cards to be parks/promenades,
mixed through the list rather than grouped, with the three premium cards still
leading. A board with none is only correct if that venue genuinely has no park
within 3 km.

**Rollback:** revert the code and restart. Nothing else to undo — no schema, no
env, no flag, no Mini App state. Setting `VENUE_CHANGE_WALK_RESERVED = 0`
restores the previous ordering exactly, if a code-level toggle is ever wanted
without a full revert.

---

**Deployed 2026-08-09 (was PENDING) — the departure-point search returns results again (PRODUCT_SPEC §3.7,
DECISIONS.md).** Deployed 2026-08-09 in the 32-commit backlog release. **No Prisma schema change, no env change, no
flag change, no Mini App change** (`apps/webapp` untouched) — bot-side only, so
a full server code deploy carries it, plus `pnpm demo:deploy`. **The demo needs
it as much as prod**: the demo is where the venue step is actually reachable
today, so that is where this is verifiable.

Typing anything into the "where are you setting off from?" search returned an
empty list for **every** user in a launched market — i.e. everyone — from
2026-08-05 (`d83b019`, the departure-point gate) until now. We sent Places
`locationRestriction: { circle }`; `searchText` accepts a circle only for
`locationBias` and answers `400 INVALID_ARGUMENT` for this, which the route's
catch reported as `200 {ok:true, results:[]}`. Now sent as a rectangle, with
the existing circular per-result filter trimming its corners.

**Four things worth knowing before the restart:**

- **Reproduced live on demo-api before the fix**, with a real Kyiv account:
  `HTTP 200 {"ok":true,"results":[]}`, and the corresponding
  `[location/search] Places searchText failed: Error: … 400` appeared in
  `gennety-demo-out.log` only after that probe — i.e. that log line had **never
  been written before**, which is how a four-day outage stayed invisible.
  Production has had 0 dates ever, so no real user has hit it.
- **The fix was verified against the live Places API**, not just against a
  mock: the exact bounding box the code computes for Kyiv
  (`49.9111,29.6769 → 50.9891,31.3699`) returns real results for the centre
  («Лукьяновская», «Хрещатик 14») and for the far suburbs (Vyshneve,
  Троєщина) that the old 50 km-clamped circle was trying to cover.
- **The 50 km clamp is gone**, so search now covers Kyiv's full 60 km market
  rather than a clipped circle. `PLACES_MAX_RESTRICTION_KM` is deleted —
  `rectangle` has no such cap. The gate itself is unchanged and still circular;
  `checkDepartureOrigin` cuts the box's corners back.
- **`services/venue.ts` is NOT affected and was checked.** Its
  `locationRestriction: { circle }` at line 567 is on `searchNearby`, where a
  circle is the required shape. The two Places endpoints disagree on this, so
  do not "fix" that one to match.

Preflight for this change: bot typecheck clean, lint clean across all 5
projects, **3436 bot tests** (0 failed, +6 new). The new guard test was
confirmed to FAIL against the old `circle` payload before being confirmed green
against the rectangle.

Post-deploy check — the healthy state is that the warning stops appearing, so
grep for its absence and then actually search:

```sh
pm2 logs gennety-bot  --lines 200 --nostream | grep 'location/search'
pm2 logs gennety-demo --lines 200 --nostream | grep 'location/search'
# Empty = nothing failing. Any `Places searchText failed: … 400` after the
# restart means the payload is still wrong.
# Then, on the demo: walk a run to `negotiating_venue`, open the map Mini App
# and type "Лукь" — results must appear. That is the only end-to-end proof.
```

**Rollback:** revert the code and restart. Nothing else to undo — no schema, no
env, no flag, no Mini App state. Reverting restores the broken search.

---

**Deployed 2026-08-09 (was PENDING) — the calendar's time list opens at the evening (PRODUCT_SPEC §3.6,
DECISIONS.md).** Deployed 2026-08-09 in the 32-commit backlog release. **No Prisma schema change, no env change, no
flag change, and NO SERVER CODE CHANGE AT ALL** — the diff is
`apps/webapp/src/main.ts` plus docs. **Deploy Mini App Only**
(`./scripts/deploy-webapp.sh`); nothing to rsync to `/opt/gennety`, **no
`pm2 restart`**. Run `pnpm demo:deploy` too — the demo builds its own bundle
from the same source, and it is the only place the sheet is easy to reach
without a live match. **It ships in the same Mini App build as the ticket and
referral blocks below** — one `deploy-webapp.sh` carries all of them.

Tapping a date used to open the slot sheet at 13:00, the top of a list that is
taller than the sheet on every phone. It now opens at 19:30, so the evening
needs no scroll and a half-cut row at the top edge says an earlier time exists.

**Two things worth knowing before the redeploy:**

- **A poll-driven rebuild now preserves scroll, which is a second behaviour
  change.** The sheet wipes and re-appends every row when the peer marks a
  slot, and that reset scrollTop to 0 — so before this, a peer's move mid-pick
  yanked the user back to 13:00. It keeps their position now. Without it the
  new default would have been undone by the first poll that mattered.
- **The anchor is measured, not assumed.** `anchorSheetToLatest()` runs inside
  `openSheet()` *after* the `hidden` attribute comes off, because a
  `display: none` element reports `scrollHeight = 0` and the assignment
  silently no-ops. If the sheet ever opens at the top again, that ordering is
  the first thing to check.

Post-deploy check — the sheet is transient and logs nothing, so verify by eye.
It needs a `negotiating` match with the Calendar open, which production has
never had (0 dates ever), so walk it on `@gennetytestbot` via
`scripts/dev-calendar-solo-demo.mjs` (run with `TZ=Europe/Kyiv`, and clear any
existing pair match first — the lifetime ban blocks a re-pair):

```sh
./scripts/deploy-webapp.sh
pnpm demo:deploy
curl -sI https://dating-calendar.gennety.com/ | head -1
# Then open the Calendar from the dev bot, tap any date, and confirm the sheet
# lands on 19:30 with a row cut in half at the TOP edge (not a full row flush
# against it). Scroll up to 13:00, then have the other side mark a slot — your
# position must not jump.
```

**Rollback:** redeploy the Mini App from the previous checkout, and
`pnpm demo:deploy` from it as well. Nothing else to undo — no schema, no env,
no flag, no server state.

---

**Deployed 2026-08-09 (was PENDING) — the gate's waiting screen: the countdown stops hiding behind the
Close button, and says whose it is (PRODUCT_SPEC §3.5b, DECISIONS.md ×3).** Not
deployed yet. **No Prisma schema change, no env change, no flag change, and NO
SERVER CODE CHANGE AT ALL** — the diff is `apps/webapp/**` plus docs. **Deploy
Mini App Only** (`./scripts/deploy-webapp.sh`); nothing to rsync to
`/opt/gennety`, **no `pm2 restart`**. Run `pnpm demo:deploy` too — the demo
builds its own bundle from the same source, and the waiting screen is far easier
to reach there (it runs the mock rail). **It ships in the same Mini App build as
the three ticket blocks below** — one `deploy-webapp.sh` carries all of them.

Reported as "the Закрыть button overlaps some other button". There is no second
button: the countdown was being read *through* Close. Three fixes, one screen.

**Four things worth knowing before the redeploy:**

- **The action bar's scrim changes shape, on BOTH ticket screens and the store.**
  Its background becomes plain `--bg` (opaque, invisible against the page) and
  the 72px fade moves into a `::before` above the bar. It looks identical where
  nothing scrolls under the buttons and fixes it where something does — this is
  a property of the pattern, not of the waiting screen, so check the store's
  post-purchase **Готово** bar too. `--bar-space` is unchanged by design (see
  DECISIONS.md for why the fade must stay out of the bar's box).
- **The countdown moves into the header** and loses its burgundy for muted text
  at the sub's size. It can no longer be occluded, and it now names the partner.
- **Fifteen i18n strings change**, and one is not cosmetic: `waitingTimer` gains
  a subject in ru/uk/de/pl, and three NEW keys per locale (`timeHours`,
  `timeMinutes`, `timeSoon`) localize the unit letters — «23h 59m» inside a
  Russian sentence was half-English. Three headings lose 🎟️ in all five
  locales; **button** labels keep theirs on purpose. A stale bundle cannot
  half-apply any of it — it is one build or the other.
- **The waiting screen's buttons swap rungs**: "Всё-таки оплатить за пару"
  becomes the real button, Закрыть becomes the text link under it. A user with
  nothing to reconsider still sees Закрыть as a full button.

Preflight for this change: webapp typecheck clean, lint clean, **255 webapp
tests** (0 failed), `vite build` clean. Four new assertions guard the copy
invariants (no 🎟️ in the four headings; `waitingTimer` longer than its
placeholder plus a word; every unit string carries `{n}`).

Post-deploy check — these screens are transient and log nothing, so verify by
eye. `scripts/dev-stage-all-screens.mjs` stands up all six gate states in both
themes as `web_app` buttons in the dev-bot chat, and the founder's exact path is
reachable from screen 3:

```sh
./scripts/deploy-webapp.sh
pnpm demo:deploy
curl -sI https://dating-calendar.gennety.com/ticket.html | head -1
# Then, on @gennetytestbot:
#   pnpm --filter @gennety/bot exec tsx ../../scripts/dev-stage-all-screens.mjs --apply
# Open "3 · Cover-partner", tap «Пусть берёт сам(а)» → the waiting screen must
# show: the countdown under the sub in muted grey (NOT burgundy, NOT at the
# bottom), «У собеседника осталось 23 ч 59 мин» in Russian units, no 🎟️ in the
# heading, and «Всё-таки оплатить за пару» as the button with Закрыть as text
# beneath it. Then SCROLL: nothing may be legible through any button.
# Open "2 · Waiting" directly for the female/alone case — Закрыть must be a
# full button there, with no text link under it.
```

**Rollback:** redeploy the Mini App from the previous checkout, and
`pnpm demo:deploy` from it as well. Nothing else to undo — no schema, no env, no
flag, no server state.

---

**Deployed 2026-08-09 (was PENDING) — a forgotten menu edit stops owning the chat, and About me shows what
it replaces (PRODUCT_SPEC §2.1, DECISIONS.md).** Deployed 2026-08-09 in the 32-commit backlog release. **No Prisma
schema change, no env change, no flag change, no Mini App change**
(`apps/webapp` untouched) — bot-side only, so a full server code deploy carries
all of it, plus `pnpm demo:deploy`.

Found by a full-codebase audit rather than a report. `services/match-flow-claim.ts`
bounded the three match flows that read the next plain message as their answer;
the five `menuState` values that do the same thing were never bounded. Worst
case is `edit_bio`, which writes its message verbatim into
`Profile.psychologicalSummary` — the dominant embedding input — so a user who
tapped **About me** and walked away had their next message, weeks later, replace
their whole profile analysis while their actual question went unanswered.

**Three things worth knowing before the restart:**

- **`SessionData` gains one nullable field** (`menuClaimUntil`). Additive, no
  schema change — `bot_sessions` stores the blob as JSON and the storage adapter
  merges defaults. **It fails closed on purpose:** every session written before
  this deploy reads `null`, so the handful of users sitting in an open editor at
  restart have that edit dropped and their next message answered by the
  concierge instead. That is the safe direction (the agent hands the editor
  straight back); the alternative trusts a stale state and overwrites a profile.
- **The About me prompt is now two messages, not one** — the second carries the
  current text so the replacement is an informed act. It is skipped entirely for
  a user with no bio yet, and the lookup is best-effort, so a DB blip costs the
  preview and never the editor.
- **The windows are short on purpose** (30 min for About me / Who I want, 60 for
  the rest). Expiring is soft — the message goes to the agent — so if anyone
  reports "it forgot my bio edit", the fix is a longer TTL in
  `MENU_CLAIM_TTL_MS`, not removing the deadline.

Preflight for this change: typecheck clean across all 5 projects, lint clean,
**3955 tests** (bot 3430 / shared 273 / webapp 252), 0 failed. The two
router-level regression tests were confirmed to FAIL with the guard neutralised
(`prisma.profile.update` called on a three-week-stale claim) before being
confirmed green with it.

Post-deploy check — nothing new is logged on the happy path, so verify on
`@gennetytestbot`: tap **My Profile → About me**, confirm the current text is
shown beneath the prompt, then send a bio and confirm it saves. The expiry is
only observable by waiting, so check it in the database instead:

```sh
# Sessions holding an open text-capture claim. A row whose menu_state is one of
# the five but whose blob has no live menuClaimUntil is the pre-deploy backlog —
# it fails closed and self-heals on the user's next message.
psql "$DATABASE_URL" -c "select count(*) from bot_sessions where value::jsonb->>'menuState' in ('edit_bio','edit_major','edit_partner_preferences','edit_age_range','awaiting_premium_cancel_reason');"
```

**Rollback:** revert the code and restart. Nothing else to undo — no schema, no
env, no flag. The extra session field is ignored by the old code.

---

**Deployed 2026-08-09 (was PENDING) — venue-change photos are retried instead of dropped, and a failed
one is no longer silent (PRODUCT_SPEC §3.7b, DECISIONS.md).** Deployed 2026-08-09 in the 32-commit backlog release.
**No Prisma schema change, no env change, no flag change.** Half server, half
client, so it needs BOTH: Deploy Full Server Code → `pnpm db:drift-check` →
`pm2 restart` → `./scripts/deploy-webapp.sh` → `pnpm demo:deploy`.

**The two halves are independent — there is no ordering constraint**, which is
unusual enough to state. The new client works against today's server and the
new server works against today's bundle; each is a strict improvement on its own
hop. If the Mini App build fails (see below), the server half still ships.

Reported against the demo — no photos on the venue-change board, neither in the
card previews nor in the opened gallery. It is **not** a demo bug: the
venue-change handler is md5-identical between the two deployments, the
`PLACES_API_KEY` line is md5-identical, and it is the same droplet. Production
simply has never had a date reach that board (0 dates ever), so nobody had seen
it. Reproduced in **production** with the prod bot token: 1 of 6 proxied photos
came back 502, logged as `ETIMEDOUT` connecting to Google's photo CDN.

**Four things worth knowing before the restart:**

- **The 10s photo budget now covers up to 3 attempts** (≤4s each, 150ms apart)
  rather than one long wait, so a proxied photo can never take *longer* than it
  could before — only fail less often. Only transient outcomes retry: a thrown
  fetch, 5xx, 429, 408. A 4xx, a non-image body and an over-ceiling file are
  permanent and answer on the first attempt, so a genuinely broken ref costs one
  request, not three.
- **Expect new log lines, and treat a burst of them as the signal they are.**
  `photo proxy failed after N attempt(s): <reason>` on every 502 (previously two
  of the three failure branches returned in complete silence — that is why the
  original report left almost nothing to go on), and
  `photo recovered on attempt N` when a retry rescues a blip. The second is
  rare by design; if it becomes frequent, the droplet's path to Google's CDN is
  degrading and that is worth acting on before users lose photos again.
- **Upstream request volume can rise on a bad day**, bounded at 3× for the
  photos that fail. Google Places photo requests are billed, so a sustained
  outage now costs somewhat more than it did — capped, and only while failing.
- **Nothing in production exercises this** until a pair reaches `scheduled`
  with `VENUE_CHANGE_FEATURE_ENABLED` on. Verify on the demo (walk a run to a
  scheduled date, open "Change venue") or on `@gennetytestbot`. Note the demo's
  own match had already gone `completed` during diagnosis, so it needs a fresh
  run — `/restart`, or the "show me another profile" button.

Preflight for this change: typecheck clean across all 5 projects, lint clean,
**3935 tests** (bot 3410 / shared 273 / webapp 252), 0 failed.

Post-deploy check — the healthy state is silence, so grep for the absence:

```sh
./scripts/deploy-webapp.sh && pnpm demo:deploy
pm2 logs gennety-bot  --lines 200 --nostream | grep '\[venue-change\] photo'
pm2 logs gennety-demo --lines 200 --nostream | grep '\[venue-change\] photo'
# Empty = nothing failing. `photo recovered on attempt N` = a blip the retry
# caught (fine, but watch the rate). `failed after 3 attempt(s)` = a real
# upstream problem — read the reason, it now names one.
```

**Rollback:** revert the code, restart, redeploy the Mini App and the demo.
Nothing else to undo — no schema, no env, no flag, no server state.

---

**Deployed 2026-08-09 (was PENDING) — security audit remediation: the demo stops holding production's JWT
secret and stops being able to send real SMS (DECISIONS.md ×3, DEMO_MODE.md →
The isolation invariant).** Deployed 2026-08-09 in the 32-commit backlog release. **No Prisma schema change, no flag
change, no Mini App change** (`apps/webapp` untouched) — bot-side only, so a full
server code deploy carries all of it, plus `pnpm demo:deploy`. **One env change,
demo-side only**, and it must land BEFORE the demo redeploy or the new gate will
(correctly) refuse to deploy.

From a full demo↔production isolation audit. Four fixes; the first two are the
ones that matter.

- **`JWT_SECRET` was identical in both deployments.** Same secret, same
  hardcoded issuer/audience, and `requireAuth` verifies a signature without
  looking the user up — so a token minted by the demo API was cryptographically
  valid on production, with only "does this UUID exist in the prod database?"
  left between it and an authenticated request. Cause is structural: the demo
  `.env` is production's plus the overrides in `.env.demo`, so every key
  `.env.demo` omits is inherited (the same mechanism that leaked `SUPABASE_URL`
  on day one). Fixed by giving the demo its own secret, and by a **gate in
  `deploy-demo.sh`** that compares both `.env` files on the server and refuses
  to deploy on a shared secret. `assertDemoIsolation()` cannot do this — from
  inside the process, production's values are unknowable.
- **The demo could send real SMS billed to production's Twilio account.**
  `phone-verification.ts` had no dev/demo short-circuit while `/v1/auth/phone`
  is mounted unconditionally and `PHONE_AUTH_ENABLED` is on there. A console
  rail gated on `OTP_LOG_TO_CONSOLE` now prints the code and calls no provider,
  mirroring `email.ts`. **That gate also covers local dev**, which inherits the
  same `TWILIO_*` keys — gating on `DEMO_MODE_ENABLED` would have fixed one of
  the two affected deployments.
- **`retention` gains a fifth target:** `bot_sessions` rows whose chat id
  matches no user and that nothing has touched for 7 days. `deleteUserAccount`
  erases the session directly as of `981ef04`, but forward-only — production
  carried five orphans from before it.
- **The demo can no longer park itself permanently** (`failure-tracker.ts`): a
  given-up action releases one probe every 2 minutes. See DECISIONS.md for why
  this is complementary to, not a duplicate of, the decline-reason fix in
  `8055c03`.

**Three things worth knowing before the restart:**

- **The env step is not optional and comes first.** Generate a fresh secret
  (≥32 bytes; the public API refuses to start on a shorter one) into
  `/opt/gennety-demo/.env` **and** into `.env.demo`, or the next hand-built demo
  env inherits production's again — which is the entire failure this fixes.
  Rotating the DEMO secret only invalidates demo tokens; production's is
  untouched, so no iOS client is affected either way.
- **`phone_otps.provider` gains a third value, `console`.** No schema change
  (plain string column). Verification now branches on
  `provider === "twilio_verify"` and treats everything else as locally
  hash-verified — deliberately that way round, so an unrecognised rail is
  refused rather than handed to a provider that never issued it.
- **The new orphan sweep is raw SQL with an age floor**, and the floor is
  load-bearing: `sessionMiddleware` runs before the handler that creates the
  `User` row, so a chat mid-`/start` legitimately has a session and no user.
  Without it the sweep would race registration.

Post-deploy check — the gate proves itself by refusing when it should, and the
console rail by making no outbound call:

```sh
# 1. The gate must PASS after the env change (it failed on JWT_SECRET before it):
pnpm demo:deploy          # first line: "OK — bot, database, storage and JWT secret are all demo-owned"

# 2. The demo must no longer reach Twilio. On the demo, request a code and watch:
ssh root@167.172.178.229 'pm2 logs gennety-demo --lines 50 --nostream | grep "console rail"'
#    A "[phone-verification] console rail — code for +…" line and NO twilio line.

# 3. Orphan sweep (runs 03:45 Kyiv; the count should go to zero and stay there):
psql "$DATABASE_URL" -c "select count(*) from bot_sessions b left join users u on u.telegram_id::text = b.key where u.id is null;"
```

**Rollback:** revert the code and restart. The demo's new `JWT_SECRET` can stay
(nothing depends on it matching anything) — reverting it would restore the
vulnerability. The `console` provider rows expire on their own within 7 days.

---

**Deployed 2026-08-09 (was PENDING) — the ticket becomes a portrait object, the recommended bundle becomes
a burgundy button (PRODUCT_SPEC §3.5b).** Deployed 2026-08-09 in the 32-commit backlog release. **No Prisma schema
change, no env change, no flag change, and NO SERVER CODE CHANGE AT ALL** — the
diff is `apps/webapp/**` plus docs. **Deploy Mini App Only**
(`./scripts/deploy-webapp.sh`); nothing to rsync to `/opt/gennety`, **no
`pm2 restart`**. Run `pnpm demo:deploy` too — the demo builds its own bundle from
the same source, and the mock/USD branch is only reachable there.

A second, third and fourth pass over the two ticket screens, each from founder
review of the one before (the first is in the block further down, still
undeployed — **all of it is one Mini App build**, so whichever redeploy happens
first carries everything).

**Seven things worth knowing before the redeploy:**

- **The ticket card loses its barcode; the stub prints БАЛАНС ▸ 🎟 × N.** One
  new i18n key (`balanceLabel`, all five locales) and one prop deleted
  (`Ticket3D.seed`, with its stripe generator) — so nothing on the card is
  derived from the match id any more. Watch the tear line rather than the text:
  the stub carries a `min-height` floor so the gate's screens that print no
  balance keep the perforation at the same height as the ones that do. If the
  card's silhouette ever differs between the offer screen and the waiting
  screen, that floor is what broke.
- **The pinned button bar stops being a footer and starts floating**, on both
  screens: content now scrolls *under* it and dissolves through a 72px scrim
  instead of being cut against its top edge. The only behaviour worth watching
  is the space at the end of the scroll — it is now the bar's **measured**
  height (`--bar-space`, written by a ResizeObserver in
  `apps/webapp/src/ticket/action-bar.ts`), so a screen with no bar reserves
  nothing and a wrapped RU label reserves more. If a last row of content ever
  sits stuck behind the buttons, that hook is where to look, not the CSS. The
  venue board's own CTA — the pattern this copies — is deliberately untouched.

- **The recommended bundle gets its burgundy fill BACK**, in both themes,
  reversing the earlier block's "no fill, burgundy light on glass". That earlier
  call was made on the dark theme and failed on cream — see DECISIONS.md. **The
  dark theme changes too**, which the founder did not ask for; a rung that is a
  filled button on one theme and a glass row on the other is two components.
  Its **edge light now diverges from `.btn-hero`** and that is deliberate: the
  white 90° wash layer is gone (it painted over the count emblem, which sits in
  the first ~19% of the row), the side insets are a whisper on dark, and on
  light there is no inner light at all — a white rim inside a burgundy button
  reads as a frame on cream. `.btn-hero` itself is untouched and keeps the full
  recipe; the two are never on screen together.
- **On dark, the two ordinary bundle rows lose the sheen entirely** and are
  lifted by tint instead (≈`#1a1a1a` over the `#030303` page, plus the existing
  drop shadow), and their count tiles become a saturated burgundy with no white
  halo. The famine row keeps its rose light — that temperature is its meaning,
  and it only renders on the mock rail. So production's Stars store is two flat
  rows and one lit burgundy button; the demo shows the rose one between them.
  Light theme is unchanged here.
- **The ticket card's geometry is now fixed, not content-derived** (268 × 392).
  Before, the gate's card and the store's card were different shapes because one
  prints a name row. If a future line is added to the card, it eats into the
  centred field rather than making the card taller — check it at 392 before
  raising `min-height`.
- **The specular highlight is deleted, not retuned.** Do not add a third
  version; DECISIONS.md records why the failure is structural. The holographic
  film stays.
- **Fifteen i18n strings change**, not just styling: `title` and `successTitle`
  lose their 🎟️ in all five store locales, and `balanceLabel` is added in all
  five ticket ones. Nothing reads them but the heading and the stub, and a stale
  bundle cannot half-apply either — it is one build or the other.

Post-deploy check — these screens are transient and log nothing, so verify by
eye. `scripts/dev-stage-all-screens.mjs` stands up all six gate states plus the
store, in both themes, as `web_app` buttons in the dev-bot chat:

```sh
./scripts/deploy-webapp.sh
pnpm demo:deploy
for p in ticket tickets; do curl -sI "https://dating-calendar.gennety.com/$p.html" | head -1; done
# Then, on @gennetytestbot:
#   pnpm --filter @gennety/bot exec tsx ../../scripts/dev-stage-all-screens.mjs --apply
# Look for: a clearly PORTRAIT card with no serial, no barcode and no moving
# highlight, its stub reading БАЛАНС on the left and 🎟 × N on the right; the
# notch cutouts landing exactly on the dashed tear line; the ×6 row reading as
# burgundy-deep rather than pink-washed on BOTH themes, with its "6" clean and
# not washed pale at the left edge; and, on dark only, the ×1/×3 rows reading as
# flat lifted grey with no glow inside their edges.
# Then SCROLL both screens: content must fade out under the bottom buttons with
# no horizontal edge anywhere, and scrolling to the very end must leave the last
# row fully clear of them (not tucked behind).
```

**Rollback:** redeploy the Mini App from the previous checkout, and
`pnpm demo:deploy` from it as well. Nothing else to undo — no schema, no env, no
flag, no server state.

---

**Deployed 2026-08-08 — a decline reason stops blocking the next match, and the
demo's redo button answers (`8055c03`, PRODUCT_SPEC → Embedding freshness (M-2),
DEMO_MODE.md → Recovery).** Full server code + demo. **No Prisma schema change**
(`db:drift-check` **OK**, nothing to push), no env change, no flag change, no
Mini App change (`apps/webapp` untouched). Deployed from an isolated
`git worktree` at `8055c03` — a parallel session was mid-way through the ticket
screens in the shared tree, and it landed `47a5352` on `main` while this was
being verified, so **production is deliberately at `8055c03`, not at HEAD**;
that commit is `apps/webapp` only and carries its own PENDING block below.

Found from a founder report against the demo: tapping «Показати анкету знову»
after a pass produced **nothing** — no profile, no message — for 44 seconds.
Reconstructed exactly from `chat_events` in the demo DB rather than guessed:
reason given by voice 17:45:52 → recorded 17:45:57 → button tapped 17:46:05 →
`createProposedMatch refused … visitor embeddingDirty (no vector yet)` → three
more silent driver attempts → the give-up line at 17:46:49.

**The root cause is production, not the demo.** `appendNegativeConstraint`
marked `embeddingDirty` and stopped there, while every other embedding-feeding
writer has always attempted an immediate user-scoped refresh — and
`findCandidatesFor` fail-closes on the **seeker's own** dirty flag, so recording
a decline reason withheld that user from matching until the 5-minute cron.
ARCHITECTURE.md has described the fixed behaviour since M-2 shipped; the code
only did it for bio and partner-preferences.

**Three things worth knowing before the restart:**

- **This is reachable in production today, via Rematch.** The §3.11 offer is
  sent on the decline path — its primary case — and `REMATCH_FEATURE_ENABLED`
  has been on since 2026-07-27. Inside the window a buyer was told the engine
  found nobody and refunded, when it had refused to look. The refund rail worked,
  so nothing was lost but the purchase and the truth of the message. Nobody has
  hit it yet: production has had **2 matches ever, both terminal**, and
  `rematch_purchases` is empty.
- **Report and post-date-feedback paths now pay for one embeddings call.**
  They already awaited an OpenAI JSON call inside the same function, so this
  roughly doubles a sub-second step; it is bounded by the existing 30s deadline
  and is best-effort, so a failure leaves the row dirty for the cron exactly as
  before. Post-date feedback appends several constraints and deliberately
  refreshes **once at the end** rather than per line.
- **The demo half changes a button's behaviour.** The redo keyboard is retired
  only once a profile is actually dispatched, double-tap protection moved to the
  driver's single-flight guard, and a refused tap now answers immediately
  (`retrying`, ru/uk/en) and counts into the same failure ladder the driver uses.

Preflight for this change: typecheck clean, **3908 tests** (bot 3390 /
shared 273 / webapp 245), lint clean.

Post-deploy check — the production half logs nothing on the happy path, so the
assertion is the absence of the window rather than a new line:

```sh
# Should stay empty; it only prints when the immediate refresh fails.
pm2 logs gennety-bot --lines 200 --nostream | grep 'immediate embedding refresh failed'
# A profile dirtied by a decline reason should clear within a second, not five
# minutes — this is a snapshot, so run it right after a decline reason lands.
psql "$DATABASE_URL" -c "select count(*) from profiles where embedding_dirty;"
```

**Post-deploy verified (measured):** the founder's own stuck demo visitor healed
itself the moment the demo came back — the driver pitched at 18:19:04 and
`[dispatch] 1/1 matchId=315ca7d9… OK`, where every attempt in the previous hour
had answered `createProposedMatch refused … visitor embeddingDirty`. Their
profile's flag reads `embeddingDirty: false` with the constraint still on the
row, which is the whole change in one line. Both changed files md5-match the
deployed worktree; production restart count 54 → **55** (one increment, no
loop), **zero** errors from the new PID (the error log's last write is dated
2026-08-07), `/v1/ping` ok, admin `401`, **all 11 Mini App pages 200**. Demo
re-verified from its own banner: `@gennety_demo_bot`, database
`aws-1-eu-west-1` (production is `aws-0-`), both demo-only cron suppressions
logged, restart count 16, `demo-api` ping ok.

**⚠️ `deploy-demo.sh` again exits after failing its Mini App build step on a
worktree run** — no `node_modules`, so `vite: command not found`. Harmless here
for the same reason as 2026-08-08's coordination release: `apps/webapp` is
untouched, the existing `/var/www/demo-app` bundle stays correct, and the
failure comes after the rsync, the schema check and the restart have all
succeeded. Read the restart count and the banner, not the exit code.

**Still owed** (needs a human in the chat, on the demo): pass on a profile, give
a free-text reason, tap «Показати анкету знову» — a profile must arrive. And the
negative case, which is the actual regression guard: if it ever refuses, the tap
must answer within a second and the button must still be there.

**Rollback:** revert the code and restart. Nothing else to undo — no schema, no
env, no flag. Constraints already written stay written; their embeddings are
correct either way.

---

**Deployed 2026-08-08 — deleting an account erases its chat session, and
photo-stage "Continue" stops finalizing early (`981ef04`, PRODUCT_SPEC §1.3 /
§GDPR, ARCHITECTURE → `bot_sessions`).** **No Prisma schema change, no env
change, no flag change, no Mini App change** (`apps/webapp` untouched) —
bot-side only,
so a full server code deploy carries all of it, and `pnpm demo:deploy` after it.

Found from a founder-reported dead end in the demo: after uploading photos the
chat printed **"Cannot finalize — missing required data: partner_preferences.
Please collect these before calling finalize_onboarding."** and nothing moved
the flow on. Reconstructed exactly from `chat_events` rather than guessed — the
hobbies question at 15:47:29, three photos at 15:47:53, a Continue button at
15:47:55, the tap, the error; then the same error again 85 minutes later on a
second tap.

Three defects, one chain:

- **Root cause: `bot_sessions` survives account deletion.** It is keyed by
  Telegram CHAT id with no relation to `users`, so no cascade reaches it. The
  demo `/restart` deleted the account and left the session, and the NEXT
  account inherited `expectingPhoto: true` — which put a brand-new user into
  the photo stage while the collector was still at `hobbies`.
- **`photos_continue` called finalize directly**, bypassing the collector's own
  question order. The guard refused, changed no state, and left the stage open:
  a permanent dead end with no path back to the missing question.
- **The guard's message went straight into the chat.** It is written for the
  model — English, internal field keys — and now goes to the log while the user
  gets localized copy.

**Three things worth knowing before the restart:**

- **The session delete is a GDPR fix as much as a state fix**, and it is NOT
  demo-only: `DELETE /v1/me` and Telegram Settings → Delete run the same
  service. `SessionData` holds `pendingPhotos` (file_ids of the erased
  profile), `contextDumpBuffer` (a pasted AI-memory export) and `activeMatchId`.
  It rides the same transaction as `user.delete`, so a storage-cleanup failure
  still leaves both the account and its session intact for a safe retry.
- **Telegram Settings → Delete was already correct** — it resets `ctx.session`
  itself. Only the demo `/restart` was missing that half, and grammY writes the
  live session back after the handler, so the row delete alone would have been
  undone.
- **One divergence remains reachable and is deliberately not "fixed" here:**
  `home_city` is required by the finalize guard and is not a collector question
  at all, so a missing city can still refuse a `complete` state. It now
  produces localized copy plus `[onboarding] finalize refused a complete
  collector state` in the log instead of a raw dump. Watch for that line: it is
  the only signal that the two notions of "done" have drifted.

Preflight for this change: typecheck clean, **3902 tests** (bot 3384 / shared
273 / webapp 245), lint clean. Two existing test harnesses needed a
`botSession` mock added (`account-deletion.test.ts`, `public-api.test.ts`) —
without it the mobile delete path 500s, which is exactly the failure the change
prevents in production.

Post-deploy check — nothing new is logged on the happy path, so verify on
`@gennetytestbot` (or the demo): send photos BEFORE answering every profile
question, tap Continue, and confirm the bot asks the pending question instead
of an English error. The session erasure is checkable directly:

```sh
# Delete an account (Settings → Delete, or /restart on the demo), then:
psql "$DATABASE_URL" -c "select count(*) from bot_sessions where key = '<telegram id>';"
# 0 is the fix. A surviving row is what the next account would inherit.
pm2 logs gennety-bot --lines 200 --nostream | grep 'finalize refused'
# Empty is the good case.
```

**Rollback:** revert the code and restart. Nothing else to undo — no schema, no
env, no flag. Sessions already erased stay erased, which is the correct state.

---

**Deployed 2026-08-09 (was PENDING) — "invite a friend instead" becomes one chip instead of five rows
(PRODUCT_SPEC §3.9).** Deployed 2026-08-09 in the 32-commit backlog release. **No Prisma schema change, no env
change, no flag change, and NO SERVER CODE CHANGE AT ALL** — the diff is
`apps/webapp/**` plus docs, so this is the **Deploy Mini App Only** path
(`./scripts/deploy-webapp.sh`), nothing to rsync to `/opt/gennety`, **no
`pm2 restart`**. Run `pnpm demo:deploy` as well. **It ships in the same Mini App
build as the ticket-screen block below** — one `deploy-webapp.sh` carries both.

The referral cross-promo existed as five hand-copied full-width rows across four
Mini Apps, four identical CSS blocks under four class names. It is now one
module (`apps/webapp/src/referral-hint.ts` + its React twin) rendering a 30px
auto-width chip, and the four old classes are deleted.

**Three things worth knowing before the redeploy:**

- **The Premium footer changes shape, and that is the actual fix.** The hint was
  the only one of the five living inside `.pm-action`, which is `flex: none` —
  so it grew that footer by ~39px (~57px once its 59-character copy wrapped,
  which it did on every phone) and pushed the subscribe CTA and the price line
  up the screen. The footer now holds the CTA and the price alone and cannot
  move. Verified by eye at 390×844 in both themes via `?preview=offer`.
- **Nine i18n keys are DELETED, not blanked** — `referralHint` across all five
  locales in `premium.ts`, `venue-change.ts`, `ticket/i18n.ts` and
  `tickets/i18n.ts`, plus the four interface declarations. One string now lives
  in `referral-hint.ts`, ≤31 characters per language, guarded by
  `referral-hint.test.ts` (that bound is what keeps the chip one line — a
  longer translation turns it back into the block this replaced). A stale bundle
  cannot half-apply it: it is one build or the other.
- **`REFERRAL_FEATURE_ENABLED=false` in production**, so none of this is
  reachable by a real user on any of the five surfaces. Verify on
  `@gennetytestbot`, or on the dev previews, which need no Telegram and no
  account — `venue-change.html?preview=board` now sets `referralEnabled` in its
  mock for exactly this reason (dev-only, `import.meta.env.DEV`-gated).

Post-deploy check — the chip is static and logs nothing, so verify by eye:

```sh
./scripts/deploy-webapp.sh
pnpm demo:deploy
for p in premium venue-change ticket tickets; do
  curl -sI "https://dating-calendar.gennety.com/$p.html" | head -1
done
# Dev previews (vite dev server), both themes:
#   /premium.html?preview=offer&lang=ru&theme=dark      → chip under "Дальше
#     будет больше", footer = CTA + price only
#   /venue-change.html?preview=agreed&lang=ru           → chip 8px under the
#     burgundy Premium row, visibly smaller
#   /venue-change.html?preview=board → tap a locked premium card → chip at the
#     tail of the detail, full 18px gap
```

**Rollback:** redeploy the Mini App from the previous checkout, and
`pnpm demo:deploy` from it too. Nothing else to undo — no schema, no env, no
flag, no server state.

---

**Deployed 2026-08-09 (was PENDING) — the two ticket screens get one light, and the card stops lying
(PRODUCT_SPEC §3.5b).** Deployed 2026-08-09 in the 32-commit backlog release. **No Prisma schema change, no env
change, no flag change, and NO SERVER CODE CHANGE AT ALL** — the diff is
`apps/webapp/**` plus docs. So this is the **Deploy Mini App Only** path
(`./scripts/deploy-webapp.sh`); there is nothing to rsync to `/opt/gennety` and
**no `pm2 restart`**. Run `pnpm demo:deploy` too — the demo builds its own
bundle from the same source and will otherwise keep the old one, and the demo
is where half of this is actually reachable (below).

Covers both ticket surfaces, which share one component and one stylesheet: the
store (`tickets.html`, the **My Tickets** menu row) and the §3.5b gate
(`ticket.html`, reached while planning a date).

**Three things worth knowing before the redeploy:**

- **The mock/USD branch only renders in DEMO.** Production runs
  `TICKET_STARS_ENABLED=true`, so the Stars bundle rows are what real users see
  and the rose "famine" bundle is unreachable there. The demo bot runs
  `TICKET_PAYMENT_MODE=mock`, so it gets the other branch. Both were restyled
  and both were screenshotted; if you only check one deployment you have only
  checked half of it.
- **Six i18n keys are DELETED, not blanked** — `ticketHolders` + `ticketStub`
  (the "На двоих" falsehood), `ticketLabel`, `ticketTagline`, and the store's
  `anonHolderA/B` + `balance`, across all five locales. `TicketStrings` /
  `StoreStrings` shrank with them, so a stale bundle cannot half-apply this: it
  is one build or the other.
- **`ticket/i18n.test.ts` changed its assertion** from `ticketStub` to
  `balanceNote` containing `{n}` — that string is now an accessible name only
  (the visible text on the stub is the vector mark plus "× N"), which is also
  why its emoji was removed from all five locales.

Post-deploy check — these screens are transient and log nothing, so verify by
eye. `scripts/dev-stage-all-screens.mjs` already stands up all six gate states
plus the store, in both themes, as `web_app` buttons in the dev-bot chat:

```sh
./scripts/deploy-webapp.sh
pnpm demo:deploy
for p in ticket tickets; do curl -sI "https://dating-calendar.gennety.com/$p.html" | head -1; done
# Then, on @gennetytestbot:
#   pnpm --filter @gennety/bot exec tsx ../../scripts/dev-stage-all-screens.mjs --apply
# Look for: no "На двоих" anywhere on the card; the store's card carries NO
# names while the gate's does; the wallet count on the stub (and absent at 0);
# three distinguishable bundle rows in BOTH themes.
```

**Rollback:** redeploy the Mini App from the previous checkout, and
`pnpm demo:deploy` from it as well. Nothing else to undo — no schema, no env,
no flag, no server state.

---

**Deployed 2026-08-08 — the pre-date coordination flow becomes walkable in the
demo (`7c67fd2`, DEMO_MODE.md).** **Demo only** — the diff is
`apps/bot/src/demo/**` plus docs, so **nothing was rsynced to `/opt/gennety` and
production was not restarted** (`gennety-bot` held restart count 53, PID
2344409). `pnpm demo:deploy` was the whole deploy, run from an isolated
`git worktree` at `7c67fd2` because the shared tree carried a parallel session's
in-progress ticket-screen work. No Prisma schema change (`db:drift-check` **OK**,
nothing to push), no env change, no flag change, no Mini App change.

Builds directly on the replay fix two blocks down (`23c8ea1`, deployed earlier
today) and **supersedes one bullet of it**: `defaultCoordMethodToProxy` is
deleted, because the choice is now the visitor's. That block carries a note in
place.

Three defects, one flow. Even with the replay live, the hour before the date was
not something a visitor could actually walk:

1. **The coordination fork was never shown.** The puppet is `platform: "mobile"`
   with a negative `telegramId`, so `resolveCoordRecipients` returns nobody and
   production silently selects the anonymous chat instead of asking — the
   three-way question never appeared on screen at all.
2. **The chat window lived ~4 seconds.** The replay ran all four gates with a 4s
   sleep between them, so `closeProxies` (T+25h) shut the relay almost
   immediately after `openProxies` (T-30m) opened it: the "Enter chat" button was
   dead by the time anyone reached it.
3. **The puppet could not answer.** No chat, no push token, no branch in
   `decide.ts` — a visitor who got in wrote into silence.

Now: the demo sends production's own offer card with **all three** buttons; the
two contact-exchange variants are explained rather than performed (founder
decision — DECISIONS.md) and deliberately write nothing, so the fork stays open
and both can be read; the anonymous chat is locked in by the visitor's own tap;
the replay is split into three stretches that stop at each real decision; and the
puppet talks in the relay through one small LLM call per turn, in character, with
the real venue and time.

**Five things worth knowing before the restart:**

- **The demo now spends OpenAI on the relay** (`MODELS.fast`, roughly one call
  per message the visitor sends, capped at 8 per match). Small, not zero. With no
  `OPENAI_API_KEY` — or on any failure, or on a generation that breaks character
  — it falls back to a scripted ladder, so the chat still works.
- **A new give-up line to grep for:** `giving up on partner_proxy_reply` means
  the relay refused three times running. `proxy-relay:closed` as the reason means
  the injected clock (`agreedTime − 15m`) and the window derived from
  `agreedTime` have drifted apart — that pairing is the one fragile join in this
  change.
- **Two floor timers, 5 and 7 minutes.** A visitor who walks away leaves the demo
  holding a screen for that long before continuing by itself. Deliberate (the
  buttons are the intended path), but longer than any previous demo pause — so a
  demo that looks stalled at the fork or in the chat probably is not.
- **Production coordination behaviour is untouched.** Nothing under
  `apps/bot/src/services/` or `handlers/` changed, and the guarded-branch count
  in production code stays at **8** — the fork card is sent from
  `apps/bot/src/demo/` with its own callback data precisely so no ninth branch is
  needed. DEMO_MODE.md explains why routing variant C through production's
  `handleCoordMethod` was rejected.
- **One test assertion changed rather than a behaviour:** `decide.test.ts` had
  two cases asserting `{ kind: "none" }` on a `scheduled` fixture past the T-2h
  gate. That state is no longer idle — it is the coordination stretch — so both
  now assert the thing they were actually about.

Preflight green: typecheck clean, **3380 bot tests** (85 under `src/demo/`, 32 of
them new), lint clean across all five projects.

**⚠️ `deploy-demo.sh` exits non-zero when run from a worktree, AFTER the bot is
already live.** Its last step builds the demo Mini App bundle, and a fresh
`git worktree` has no `node_modules`, so `vite build` dies with
`vite: command not found`. Harmless here — `apps/webapp` is untouched by this
change, the existing `/var/www/demo-app` bundle stays correct, and the failure
comes after the rsync, the schema check, the restart and `pm2 save` have all
succeeded. But it means **the script's exit code cannot be trusted as the
verification** on a worktree run: read the restart count and the banner instead.
It also means the script will NOT rebuild `dist/` back to the production API
base — safe only because it never built a demo-pointed one either. For a release
that does touch the Mini App, either `pnpm install` in the worktree first or
deploy from the main tree.

**Post-deploy verified (measured):** `driver.ts` on the droplet md5-matches local
(`e8f66c2c`), `proxy-partner.ts` present (10,959 bytes), banner names
`@gennety_demo_bot` + the demo database (`aws-1-eu-west-1`; production is
`aws-0-`), both demo-only cron suppressions logged, `:3102` listening,
`/v1/ping` ok, `demo-app/ticket.html` 200, restart count 13 → 14 with a stable
PID, and **zero errors from the new PID**. The driver is correctly idle: 0
actions across 10 consecutive ticks with the one visitor mid-onboarding (the
`[demo] scanned=…` line only prints when something was acted on, so silence is
the healthy state — do not read a run of `acted=1` at startup as a loop).

**Pre-existing and unrelated, seen while checking:** 8 historical `P2003
chat_events_user_id_fkey` lines in the demo error log — the outbound recorder
writing a chat event for an account `/restart` has just deleted. Fire-and-forget
and swallowed; nothing to do with coordination.

**Post-deploy walk still owed** (needs a human in the chat): a fresh run —
`/restart`, or «показать ещё одну анкету» — through to a scheduled date, then
«Что происходит дальше», then press **A**, press **B**, then the anonymous chat,
write two messages, press «Дальше».

```sh
pnpm demo:deploy
ssh root@167.172.178.229 'pm2 describe gennety-demo | grep -E "uptime|restarts"'
# uptime in seconds, restarts +1 — the bot runs from source, so the restart IS
# the deploy. A stale uptime means the code on disk is not the code running.
ssh root@167.172.178.229 'pm2 logs gennety-demo --lines 60 --nostream | grep -E "giving up|acted=0"'
# empty = nothing is stuck.
```

In the demo database afterwards:

```sql
select coord_method, proxy_opened_at is not null, proxy_closed_at is not null, status
  from matches order by created_at desc limit 1;
select sender_id, left(body, 60) from proxy_messages order by created_at;
```

Expect `coord_method = 'proxy'`, both stamps set, `status = 'completed'`, and
`proxy_messages` alternating between the puppet and the visitor — the puppet's
own line **first**, which is what makes a visitor open the chat.

**Variants A and B stay explanations, by design.** They exchange `t.me/` links
and the puppet has no account; giving it a fake `@username` would put a dead link
in front of an investor. The full three-variant flow with a live partner is
`@gennetytestbot` plus `scripts/dev-coord-offer-demo.mjs` (it has `--reset`, so A,
then B, then C on one match).

**Rollback:** revert and `pnpm demo:deploy`. Production is untouched. Nothing
else to undo — no schema, no env, no flag.

---

**Deployed 2026-08-08 — the two fixes production was still missing (`f66949a`).**
Full server code + Mini App + demo, bringing prod from `d5405f6` to
**`f66949a` plus `e04ffec`** (the dependency-override commit made during the
release). **No Prisma schema change** — `db:drift-check` **OK**, nothing to
push. No env change, no flag change.

It carried both PENDING blocks below — the venue-change current-venue card
photo, and the "free text that isn't an answer" fix (`087e7e4`) — which had sat
undeployed because the two releases in between were **demo-only** and never
restarted `gennety-bot`. Worth stating plainly, because it is the failure this
file keeps warning about in a new shape: a demo deploy touches
`/opt/gennety-demo`, so a production-relevant commit that happens to be an
ancestor of a demo release ships to the DEMO and nowhere else. `087e7e4` was in
the demo since 2026-08-07 and in production only now. **Check the prod restart
count after any demo deploy**: it not moving is the whole point, and it is also
what hides an unshipped fix.

**⚠️ `security:audit` failed preflight again — the third release running.**
`nanoid` <3.3.17 (GHSA-2v37-7h3g-55p8), reached through
`apps/video > @remotion/cli > @remotion/bundler > css-loader > postcss`. Not in
the bot runtime, so no user was exposed, but the gate is pass/fail. Fixed by
adding `"nanoid": "3.3.17"` to `pnpm.overrides` (`e04ffec`), which also sorted
the block so the next entry lands somewhere obvious. Re-audit: **No known
vulnerabilities found.** This is now a standing tax, not an incident — read the
Preflight note about overrides rotting.

**⚠️ A worktree deploy leaves a stray `.git` FILE on the droplet.** `git
worktree` writes `.git` as a file containing `gitdir: /Users/pro/…`, and the
documented `--exclude '.git/'` matches directories only — so yesterday's
worktree deploy rsynced that pointer to `/opt/gennety/.git`, where it sat as a
dangling reference to a Mac path. This release's `--delete` removed it, which is
correct and self-healing. Do **not** "fix" the exclude to `.git` without a
slash: an excluded path is protected from `--delete`, so that would pin the junk
there permanently. Either leave it to the next full deploy or
`rm -f /opt/gennety/.git` after a worktree run.

Preflight green: typecheck clean across all 5 projects, **3867 tests**
(bot 3353 / shared 273 / webapp 241, 261 files, 0 failed), `pnpm build`,
`security:secrets` (1016 files), `security:audit` 0 advisories after the
override.

rsync dry-run listed exactly **3** deletions, all reviewed: two gitignored
`apps/video/build` Remotion artifacts and the stray `.git` file above. Both
droplet-only DB backups and both `keys/*.p8` verified present afterwards.

**Post-deploy verified (measured, not inferred):** the three files that
distinguish the two undeployed commits now md5-match local HEAD
(`onboarding-photo-stage.ts` `4983080a`, `venue-change.ts` `9fd9e243`,
`i18n.ts` `359cb5e6` — before the deploy they matched `d5405f6`);
`services/profiler-intent.ts` present on the droplet (it did not exist there);
`originalPhotoRefs` appears 4× in the venue-change handler (0× before);
`Bot @gennetybot started` with all 16 crons + the peer-wait worker; restart
count 52 → **53** (one increment, no loop); **zero** P2022 / P2023 /
`ERR_MODULE_NOT_FOUND` / unhandled from the new PID; `/v1/ping` ok; admin
`401`; **all 11 Mini App pages 200**. Demo redeployed from the same source and
isolation re-confirmed from its own banner (`@gennety_demo_bot`, database
`aws-1-eu-west-1` — production is `aws-0-`), both demo-only cron suppressions
still logged.

**Rollback:** re-sync a checkout at `d5405f6` and redeploy the Mini App and the
demo from it. No schema to undo, no env, no flag.

---

**Deployed 2026-08-08 (was PENDING) — the venue-change board's current-venue card gets its photo
(PRODUCT_SPEC §3.7b).** Deployed 2026-08-08 in the release at the top of this
file. **No Prisma schema change, no env
change, no flag change** — but it is half client, so it **DOES need a Mini App
redeploy**: Deploy Full Server Code → `pnpm db:drift-check` → `pm2 restart` →
`./scripts/deploy-webapp.sh` → `pnpm demo:deploy`.

**Server first, and the order matters.** The photo refs are new on
`GET /v1/venue-change/state`; a cached older bundle ignores the field and keeps
today's photo-less card. The reverse order ships a client reading a field the
server does not send yet — no picture, and the badge has already moved.

The pinned "keep this place" card was the one card on the board with no
picture, because the assigned venue is deliberately excluded from the catalog
(2026-08-03) and the card had no row to inherit pictures from. The board was
asking the pair to compare places while showing them everything except the
place they already had.

**Three things worth knowing before the restart:**

- **The data was already there.** `Match.venuePhotoName` is written at
  assignment by both selectors and is the same image the date card renders —
  the state endpoint just never sent it. The common path costs nothing; a row
  with no stored cover falls back to ONE Place Details lookup from
  `venuePlaceId`, cached for a day in the same map the catalog fills (5 min on
  failure). This endpoint is polled every ~4 s, which is why the stored cover
  comes first rather than always querying for the fuller gallery.
- **The card's badge moved to its own line**, which is a visible layout change
  beyond "add a photo". A 68px photo takes 82px out of a ~350px card, leaving
  the badge 176px against 203px of "Obecne miejsce spotkania" — measured, not
  guessed: it wrapped into a two-line pill and pushed the venue's own name into
  an ellipsis. Verified at 390px and 320px in ru/uk/pl, light and dark, plain
  and burgundy-marked. The venue name on this card now wraps instead of
  truncating; the twelve alternatives are untouched.
- **Nothing exercises it until a pair reaches `scheduled`.** Production has
  **2 matches ever, both terminal**, and `VENUE_CHANGE_FEATURE_ENABLED` gates
  the entry button, so verify on `@gennetytestbot` — or, with no match at all,
  on the dev preview, which now ships a photo for the pinned card:
  `http://localhost:5173/venue-change.html?preview=board&lang=ru&theme=dark`.

Demo picks it up from the same source with `pnpm demo:deploy` (its matches are
assigned through the real path, so they carry a cover). No gate, no paid step,
no negotiation branch — `apps/bot/src/demo/decide.ts` is untouched.

Post-deploy check — the photo either renders or it doesn't, so verify by eye;
the one thing worth querying is that the covers exist at all:

```sh
psql "$DATABASE_URL" -c "select count(*) filter (where venue_photo_name is not null) as with_cover, count(*) as scheduled from matches where status='scheduled';"
# A scheduled row with no cover takes the fallback-lookup path — not a bug.
pm2 logs gennety-bot --lines 200 --nostream | grep '\[venue\] photo lookup'
# Empty is the good case: that line only prints when a lookup fails.
```

**Rollback:** revert the code, restart, and redeploy the Mini App from the
previous checkout. Nothing else to undo — no schema, no env, no flag.

---

**Deployed 2026-08-08 — the demo replays the hour before the date, which it never
did (DEMO_MODE.md).** Demo only (`23c8ea1`) — `apps/bot/src/demo/**` plus docs,
so **nothing was rsynced to `/opt/gennety` and production was not restarted**
(`gennety-bot` held restart count 52). Deployed from an isolated `git worktree`,
the shared tree again carrying a parallel session's work. No schema, no env, no
flag change. Demo banner re-verified: `@gennety_demo_bot`, database
`aws-1-eu-west-1` (production is `aws-0-`).

Found by the first demo run ever to reach a scheduled date. It finished
correctly (`status: completed`, real venue, date card rendered,
`venue_selection_logs` 0 → 1) but `coordOfferSentAt` and `proxyOpenedAt` were
both still null: `runCoordinationTick` is a **separate sweep** from
`runDateLifecycleTick`, called from `index.ts` on the real clock, and the demo
replayed only the lifecycle. So the T-60m "how do we find each other" offer, the
T-30m anonymous chat and all five coordination cards were invisible in the demo
— with the flag on the whole time. Both take an injected clock, so the replay now
calls both, at gates `−2h / −45m / −30m / +25h` (the extra gate keeps the offer
and the chat opening as two separate beats).

**⚠️ Related correction, no action needed:** two blocks below claimed
`COORDINATION_FEATURE_ENABLED` is **off** in production. It is **on**, and has
been — `GET /v1/app/config` reports `features.coordination: true`. Both blocks
now carry a note in place. Nothing has exercised it because production has had
0 dates ever.

**Two things worth knowing:**

- **One demo-only branch:** an unanswered coordination offer resolves to the
  anonymous chat. `openProxies` needs `coordMethod`, which in the product comes
  from a tap, and a demo cannot depend on a tap landing inside a four-second
  beat. Guarded on `coordMethod: null`, so a visitor who did tap keeps theirs.
  **⚠️ Superseded by the PENDING block at the top of this file:** the four-second
  beat is gone (the replay now stops at the fork and waits), so this branch was
  deleted and the visitor makes the choice themselves. The floor timer that
  replaces it is five minutes.
- **A same-sex pair still cannot show everything.** The safety brief goes to the
  female participant, so a male visitor will correctly never see it — same for
  the hetero-only cover gesture, wish card and express venue change. That needs
  a second run from the other side, not a code change.

**Post-deploy check still owed:** the previous run's match is already
`completed`, so this needs a fresh walk — `/restart`, or «показать ещё одну
анкету» — through to a scheduled date, then «Что происходит дальше». The two
columns that were null are the assertion:

```sh
# In the demo DB: coord_offer_sent_at and proxy_opened_at must both be set,
# and coord_method should read 'proxy' for an untapped offer.
```

**Rollback:** revert and `pnpm demo:deploy`. Production is untouched.

---

**Deployed 2026-08-08 (was PENDING) — free text that isn't an answer stops being recorded as one
(PRODUCT_SPEC §1.3, §Phase 1b, §3.4).** Deployed 2026-08-08 in the release at
the top of this file — **note it reached the DEMO a day earlier**, on
2026-08-07, because `087e7e4` is an ancestor of the demo-only release `23c8ea1`
and `deploy-demo.sh` syncs the whole tree. **No Prisma schema
change, no env change, no flag change, no Mini App change** (`apps/webapp`
untouched) — bot-side only, so a full server code deploy carries all of it.
Demo picks it up from the same source with `pnpm demo:deploy`; no gate, no paid
step, no negotiation branch, so `apps/bot/src/demo/decide.ts` is untouched.

Three flows, one root cause: a prompt read the next message as its answer with
no check that it *was* one. See DECISIONS.md for the rule this establishes.

- **Profiler.** "не хочу отвечать" was stored verbatim as the ANSWER to the
  live question with `skipped: false` — burning it permanently (answered
  questions are never re-asked) and feeding it to the ice-breaker / wingman
  generators. It is now recorded as a skip and **ends the batch**, deferring to
  the user's next local window. Expect `profiler_answers` rows that previously
  would have carried refusal text to arrive as `skipped: true` with a null
  `answerText` instead; that is the fix, not data loss.
- **Onboarding photo stage, at or above `MIN_PHOTOS`.** The continue matcher
  took bare words only, and every unmatched message got the progress card
  without the agent being called. Now it matches phrases ("мне хватит", "не
  хочу больше", "это всё") and hands **question-shaped** text to the agent.
  Only questions — an ordinary message there would advance the collector to
  `complete` and finalize onboarding, which §1.3 forbids.
- **Decline reasons.** The four preset buttons record analytics and explicitly
  do NOT write `negativeConstraints`; the message promised the opposite. Copy
  fixed in all 5 locales, and the first button now names appearance explicitly
  ("Не мой тип" alone read as personality). **No behaviour change** — read
  DECISIONS.md before ever "fixing" the presets by routing them into matching.

Preflight for this change: typecheck clean, **3347 bot tests + 273 shared**,
lint clean. One existing assertion was updated (`matching.test.ts` pinned the
old button label — that test doing its job is how the copy change was caught).

Post-deploy check — nothing new is logged and production has 2 matches ever, so
verify on `@gennetytestbot` rather than from prod logs: answer a Profiler
question with "не хочу" (expect the ack + no further question until the next
window), and at 3 photos type "мне хватит" (expect the stage to close) and then
"а кто увидит мои фото?" (expect an answer, not the progress card).

```sh
psql "$DATABASE_URL" -c "select skipped, count(*) from profiler_answers group by 1;"
```

**Rollback:** revert the code and restart. Nothing else to undo — no schema, no
env, no flag, no Mini App state.

---

**Deployed 2026-08-07 — a stuck demo says so instead of retrying forever
(DEMO_MODE.md).** Demo only (`263e9b9`) — the diff is `apps/bot/src/demo/**` plus
docs, so **nothing was rsynced to `/opt/gennety` and production was not
restarted** (`gennety-bot` held restart count 52 across the whole rollout).
`pnpm demo:deploy` was the whole deploy, run from an isolated `git worktree` at
`263e9b9` because the shared tree carried a parallel session's in-progress
Profiler work. No Prisma schema change, no flag change.

Groundwork for the full demo walkthrough: before hunting for more dead-ends, make
a dead-end impossible to miss. Every branch of `performAction` now returns an
outcome instead of `void`, a refusal (or a throw) is counted per (visitor,
action), and at three in a row the demo tells the visitor it is stuck and stops
retrying. Seven branches had the same shape as the ticket-gate stall; one of them
(`partner_accept`) was not even checking `applyMatchDecision`'s `null`.

**One env change, applied separately and already live:** the demo was quoting a
**stale Premium price** — `PREMIUM_STARS=500` / `$11.99` against production's
`750` / `$17.99` as of today. An investor was being shown the wrong number.
Fixed in `/opt/gennety-demo/.env` (backup `.env.bak.20260807-214909`); it takes
effect on the redeploy's restart.

**Two things worth knowing before the restart:**

- **The tick summary changes meaning.** `acted` used to count refusals;
  `errors` was effectively always 0. After this, `[demo] scanned=1 acted=0
  errors=1` is a real signal, and `giving up on <action> …` is the line to grep
  for. Historical log lines are not comparable.
- **`DEMO_MAX_ACTION_FAILURES = 3` is a code constant, not env.** At
  `DEMO_STEP_WAIT_MS` (12s) apart that is ~36 seconds before the demo gives up.
  Lower it and a provider hiccup ends a demo; raise it and the audience is back
  to watching silence.

**Post-deploy verified:** demo banner names `@gennety_demo_bot` and the demo
database (`aws-1-eu-west-1`; production is `aws-0-`), both demo-only cron
suppressions logged, `failure-tracker.ts` present on the droplet, `demo-api`
ping ok, `demo-app/ticket.html` 200, and **zero** `giving up on` / `acted=0`
lines since the restart — i.e. nothing is currently stuck. The Premium price was
read back off the surface an investor actually sees: `GET /v1/premium/state`
now answers `priceStars: 750, priceDisplay: "$17.99"`, matching production.

To confirm the give-up path itself, make a stall on purpose — zero the puppet's
wallet and remove the top-up. It is safe: `/restart` clears the tracker and the
top-up refills the wallet on the next real run.

```sh
ssh root@167.172.178.229 'pm2 logs gennety-demo --lines 100 --nostream | grep -E "giving up on|acted=0"'
# Empty in the healthy case. A `giving up on <action>` line is the feature
# working, and it must appear ONCE per streak — not once per tick.
```

**Rollback:** revert the code and `pnpm demo:deploy`. Production is untouched by
this block. To put the Premium price back, restore
`/opt/gennety-demo/.env.bak.20260807-214909` and restart `gennety-demo`.

---

**Deployed 2026-08-07 — ticket-gate avatars stop being half a megabyte each, and
two demo dead-ends (DEMO_MODE.md).** Server + Mini App + demo, brought prod from
`c25adbc`+`01c32b8` to **`d5405f6`**. **No Prisma schema change, no env change,
no flag change** (`db:drift-check` **OK**, nothing to push). Deployed from an
isolated `git worktree` at `d5405f6`.

**This release also carried every other PENDING block** — the three below (the
preference screen, the onboarding name field, the native proxy-chat server half)
plus the two photo-shimmer commits `27f426b` / `d75b518`, which had no block of
their own (PRODUCT_SPEC §1.3 / §2.1 carry the behaviour). All four blocks are
marked deployed in place.

Three fixes from one founder report. **Only the first reaches production**; the
other two are `apps/bot/src/demo/` and inert without `DEMO_MODE_ENABLED`.

- **Date Ticket avatars (production + demo).** The Mini App draws two 44px
  circles on the "pay for us both" button and the route streamed the
  participants' FULL profile photos to fill them — measured on the live demo at
  **517 KB + 355 KB for one button**, over mobile data, inside a Telegram
  WebView, against the client's 6-second preload budget. `GET
  /v1/matches/:id/ticket/photo/:side` now shrinks to a 256px ceiling
  (`services/avatar-thumbnail.ts`, `@napi-rs/canvas` — already a dependency, no
  new install) and caches the result in-process by storage ref. `Avatar` also
  falls back to the monogram on a load error, so a failure reads as an initial
  rather than a broken-image glyph.
- **The puppet could not pay its own ticket (demo).** A visitor who chose "pay
  only mine" hit a hard stop: `useTicketFromBalance` refuses at a zero balance,
  which is where every seeded puppet starts, so the gate never completed and the
  Calendar was never sent — `[demo] puppet ticket settle failed:
  insufficient-balance` every 12s, forever. Reproduced live before the fix. Only
  the "pay for both" path avoided it, which is why earlier walkthroughs missed it.
- **The product was explained twice (demo).** `spokenBeats` is in memory and the
  demo restarts on every release, so a visitor who came back from a pass got the
  whole "you're in the system, here is how matchmaking works" message again. The
  deleted match rows are durable proof it was already said.

**Three things worth knowing before the restart:**

- **The avatar change is NOT demo-only** even though it was reported against the
  demo. `TICKET_FEATURE_ENABLED=true` in production, so this is the paid gate's
  own screen. It is strictly less data and the same picture.
- **The in-process cache holds image bytes.** Bounded to 200 entries with a 6h
  TTL and swept on insert; at ~25 KB an entry that is a few megabytes worst case
  on a 2 GB droplet. Keyed by `file_id`/Supabase path, both of which change when
  the photo does, so a cached avatar can never outlive its photo.
- **A stuck demo heals itself on the restart.** The match currently sitting in
  `ticketStatus: partial` will complete on the next 3-second tick once the demo
  is redeployed — no manual DB edit.

**Post-deploy verified (measured, not inferred):**

- **Avatar bytes, against the same live gate that produced the "before"
  numbers:** self **517,591 → 17,073 B**, partner **354,963 → 12,703 B**. One
  button went from ~850 KB to **~30 KB (3.5%)**. Downloaded and decoded: a valid
  144×256 JPEG, aspect ratio intact. The cache shows up as a second fetch at
  0.35s against 0.88s cold.
- **The stuck demo healed itself on the first tick**, with no manual DB edit:
  the match that had been logging `insufficient-balance` every 12s since 14:53Z
  went `ticketStatus: partial → completed`, both slots paid, and
  `proposedTimes` filled with 84 slots — i.e. the Calendar finally opened. The
  ledger reads `+1 store_purchase` then `-1 spend_match`, which is the top-up
  and the settle.
- Production: `Bot @gennetybot started`, all 16 crons + the peer-wait worker,
  restart count 51 → **52** (one increment, no loop), **zero** P2022 / P2023 /
  `ERR_MODULE_NOT_FOUND` / unhandled from the new PID, `/v1/ping` ok, admin
  `401`, **all 11 Mini App pages 200**.
- Demo re-verified after `pnpm demo:deploy`: `demo-api` ping ok,
  `demo-app/ticket.html` 200, driver ticking `scanned=1 acted=1 errors=0`.
- rsync dry-run listed **80** deletions, all reviewed: 72 gitignored
  `apps/video/build|out` Remotion artifacts (same class as the last release) and
  8 files of the deliberately-deleted second preference design. Both droplet-only
  DB backups and both `keys/*.p8` survived.

**Rollback:** revert the code, restart, redeploy the Mini App and the demo.
Nothing else to undo — no schema, no env, no flag. The cache is in-process and
disappears with the restart.

---

**Deployed 2026-08-07 (was PENDING) — the preference screen is one design now,
and the photos and the word both changed (PRODUCT_SPEC §1.3).** Deployed
2026-08-07 in the release at the top of this file. **No Prisma schema
change, no env change, no flag change, and NO SERVER CODE CHANGE AT ALL** — the
diff is `apps/webapp/**` plus docs. **Deploy Mini App Only**
(`./scripts/deploy-webapp.sh`); nothing to rsync to `/opt/gennety`, **no
`pm2 restart`**. Run `pnpm demo:deploy` too — the demo builds its own bundle
from the same source and will otherwise keep the old one.

Three commits, one bundle: the photo tiles lost their white frames and the dark
hairlines the frames were causing; «Парней» / «Девушек» went to Inter 800 and
larger; and the second design plus its `?v=` switch, review page and artwork
were deleted after the founder settled on the photo scatter. Full detail is in
the profile-screens block below (the four bullets under "So does the preference
photo fork") — that block is labelled *Deployed*, which is true of the screens
themselves and **not** of these three changes.

**Two things worth knowing before the redeploy:**

- **The bundle gets ~335 KB SMALLER**: `apps/webapp/src/preference/cutout/`
  (two group images) is deleted along with the code that read it. Nothing else
  referenced those files, so this is dead weight leaving, not an asset going
  missing.
- **`onboarding.html` must keep `;800` in its Google Fonts URL.** It was added
  for the deleted design, so the obvious tidy-up after removing that design is
  to drop it again — that would silently downgrade the two labels to a
  synthesised bold. An earlier revision of the bullet below actively told you to
  drop it; it now says the opposite.

Post-deploy check — the screen is transient and logs nothing, so verify by eye
on `@gennetytestbot` (or the dev preview, which needs no Telegram):

```sh
./scripts/deploy-webapp.sh
curl -sI https://dating-calendar.gennety.com/onboarding.html | head -1
# Dev preview of the exact screen, both themes:
#   http://localhost:5173/onboarding.html?preview=basics:preference&lang=ru&theme=light
# `?v=1`, `?v=2`, `?v=both` must now all render the same single design.
```

**Rollback:** redeploy the Mini App from the previous checkout. Nothing else to
undo — no schema, no env, no flag, no server state.

---

**Deployed 2026-08-07 (was PENDING) — the onboarding name field stops shrinking
under the keyboard (PRODUCT_SPEC §1.1).** Deployed 2026-08-07 in the release at
the top of this file. **No Prisma schema change, no env
change, no flag change, and NO SERVER CODE CHANGE AT ALL** — the diff is
`apps/webapp/src/onboarding.css` plus docs. So this is the **Deploy Mini App
Only** path (`./scripts/deploy-webapp.sh`); there is nothing to rsync to
`/opt/gennety` and **no `pm2 restart`**. Also run `pnpm demo:deploy` — the demo
builds its own bundle from the same source and will otherwise keep the old one.

The name screen's font size was measured in `dvh`, so opening the keyboard
shrank the letters the user was typing and closing it snapped them back (the
"blink" on Continue). It is width-measured now, which the keyboard cannot
touch. One thing worth knowing: on a 390px phone the unfocused size moves
48px → 46.8px — a deliberate 2.5% trade for a constant size, and narrower
phones scale down further, which is what a long name wanted anyway.

Post-deploy check — this is a transient visual state, so verify by eye rather
than from logs. The dev-only preview needs no Telegram and no account:

```sh
./scripts/deploy-webapp.sh
curl -sI https://dating-calendar.gennety.com/onboarding.html | head -1
# Then, on the dev server: tap the field and confirm the name holds its size.
#   http://localhost:5173/onboarding.html?preview=basics:name&lang=ru&theme=dark
```

**Rollback:** redeploy the Mini App from the previous checkout. Nothing else to
undo — no schema, no env, no flag, no server state.

---

**Deployed 2026-08-07 (was PENDING) — the anonymous pre-date chat reaches the
native client, and opens at all for a pair with an app participant
(PRODUCT_SPEC §Phase 4).** Deployed 2026-08-07 in the release at the top of this
file. **No Prisma schema change, no env change, no flag change, no Mini App
change** (`apps/webapp` untouched) — half of it is client, so the iOS app ships
with it (separate repo).

**⚠️ This block said "inert in production — the flag is off". That was wrong**
(corrected 2026-08-08). `COORDINATION_FEATURE_ENABLED=true` has been in
`/opt/gennety/.env` (line 70) for some time, and the running process confirms
it: `GET /v1/app/config` answers `features.coordination: true`. So these routes
are **live**, and the T-60m offer plus the anonymous chat are real behaviour for
real users. What made the error invisible is that production has had **0 dates
ever**, so nothing has ever reached T-60m to exercise them. Read the flag off
`/v1/app/config`, never off a sentence in this file — an older block one screen
down states the opposite, and only one of them could be right.

New: `GET/POST /v1/matches/{id}/chat` (JWT), plus `services/proxy-chat.ts` —
the window, the `proxy_messages` write and delivery, shared with the Telegram
relay.

**Four things worth knowing before the restart:**

- **The gap was not a missing endpoint, it was a missing initiation.** The
  offer requires both sides in a bot chat, and `openProxies` only opens a
  window for a match whose `coordMethod` a tap set — so a pair with an app
  participant never got the offer, a method, or a window. Such a pair now has
  variant C selected for them at T-60m. Once the flag is on, expect
  `coordMethod: "proxy"` rows nobody chose; that is the fix, not drift.
- **The window moved off the cron's columns.** Derived from `agreedTime`
  (T-30m…T+2h). `proxyOpenedAt`/`proxyClosesAt` are still written and still
  mean "the pair was told"; `proxyClosedAt` still force-closes. Effect on
  Telegram: the chat becomes enterable up to two minutes earlier, which is the
  point.
- **`resolveCoordRecipients` now checks `platform`, not `telegramId > 0`** —
  the same fix already applied to the Profiler and re-engagement workers.
  Nobody is in that state until `TELEGRAM_LOGIN_CLIENT_ID` is live.
- **A mobile partner now gets pushes that did not exist**: one when the window
  opens, one per relayed message, and the message push CARRIES the text (see
  DECISIONS.md for why this differs from the emergency-cancellation push). It
  also fires the `chat_open` stage of the date-day Live Activity, declared in
  §4.2 and deliberately never sent until now.

Post-deploy check — the flag is off and production has **0 dates ever**, so
nothing exercises this; verify mountedness, then walk it on `@gennetytestbot`
with the flag on:

```sh
# 404 while the flag is off = mounted and correctly inert.
curl -s -o /dev/null -w '%{http_code}\n' \
  https://dating-api.gennety.com/v1/matches/00000000-0000-4000-8000-000000000000/chat
pnpm openapi:lint
```

**Rollback:** revert the code and restart. Nothing else to undo — no schema, no
env, no flag. `SerializedMatch.proxyChatOpensAt`/`ClosesAt` simply stop being
sent, and the iOS build treats their absence as "no window".

---

**Deployed 2026-08-07 — the 84-commit backlog: every block below that was marked
PENDING above the 2026-08-02 catch-up marker shipped in one release, plus the
misfiled account-health block.** Full server code + Mini App + demo + two `.env`
lines. Brought prod from `7f19a72` (2026-08-02) to `c25adbc` plus one
dependency-override commit made during the release.

**No Prisma schema change at all.** The droplet's `schema.prisma` was already
byte-identical to the target, so there was no `db:push`, no `migrate diff` plan
to read, and no additive-step conflict to sequence around — which is why 19
blocks could group into a single release. `db:drift-check` still ran as the
mandatory gate and returned **OK**.

**Deployed from an isolated `git worktree`, not the working tree.** A parallel
session was writing the `/v1/*` proxy-chat server half in the same checkout, and
rsync copies the working tree. `git worktree add /tmp/gennety-deploy c25adbc`
gave a clean source; preflight ran **there**, so the test numbers describe what
shipped rather than someone's half-written module. Do this whenever the tree is
not yours alone — it also means the sync deletes accumulated build junk, which
is where most of the deletion lines below came from.

**⚠️ `security:audit` failed preflight, and three existing overrides were the
cause.** `postcss`, `fast-uri` and `brace-expansion` were each pinned in
`pnpm.overrides` at exactly one patch below their advisory's fix — the precise
trap this file's Preflight section warns about ("never pin an override BELOW the
patched version"). They were correct when written; advisories published since
moved the bar. 7 advisories (4 high / 3 moderate). Only the `ip-address` chain
(`apps/bot > express-rate-limit`) reaches the droplet runtime — the other four
are `apps/video` build-time or `eslint` dev tooling. Fixed by raising three
overrides and adding two:

```
postcss         8.5.18 -> 8.5.23      fast-uri   3.1.4 -> 3.1.5
brace-expansion 5.0.8  -> 5.0.9       js-yaml    (new) -> 4.3.1
ip-address      (new)  -> 10.3.1
```

Re-audit: **No known vulnerabilities found.** These advisories were already live
in prod (the lockfile was unchanged since 2026-08-02), so the release did not
introduce them — but the gate is mandatory and shipping past it silently would
have carried them another release. **Re-check the pinned versions against
`pnpm audit` every deploy**; an override rots the moment a new advisory lands.

Preflight green (in the worktree): typecheck clean across all 5 projects,
**3776 tests** (bot 3256 / shared 273 / webapp 247, 257 files, 0 failed),
`pnpm build`, `security:secrets` (1012 files), `security:audit` 0 advisories,
`openapi:lint` valid.

rsync dry-run listed **189 deletions, every one reviewed**: 11 docs/scripts
retired by `1e6db50` + `27ef241`, 1 stale `apps/bot/src/admin/server.ts.bak.*`
(snapshotted to `/root/` first), and 176 gitignored `apps/video/{build,out}`
artifacts — Remotion output that is not in the bot runtime, all but 2 also
present on the Mac, and only on the droplet because the documented exclude list
covers `dist/` but not `build/` or `out/`.

**Two droplet-only DB backups would have been destroyed by `--delete`, not
one.** This file already said to add `--exclude '*-backup-*.json'` for the
ethnicity backup; it does **not** mention the second file, which is 3.3 MB:

```
/opt/gennety/ethnicity-backup-2026-08-02T08-26-08-301Z.json   (1 KB)
/opt/gennety/prod-backup-2026-07-27T14-08-06-066Z.json        (3.3 MB)
```

One pattern covers both. Verified present after the sync, along with both
`keys/*.p8`.

**Two `.env` changes**, both applied before the single restart:
`ADMIN_TEST_TELEGRAM_IDS=-153639032722566` (was missing entirely — the
account-health block's own check fails without it) and the Premium price
`PREMIUM_STARS` 500 → **750**, `PREMIUM_PRICE_USD_DISPLAY` $11.99 → **$17.99**
(founder decision this session; 0 purchases ever, so no cohort is grandfathered).

**✅ App Store Connect closed the same day (2026-08-07, founder-driven).**
`premium_monthly` was raised $9.99 → **$17.99/mo** on the US storefront; Apple
auto-generated the other **175** storefronts (CA $24.99, UK £17.99, AT €19.99,
AU $29.99, …), none hand-edited. Verified by reloading the product page rather
than from the confirmation dialog: US shows 17,99 $ under "current price for new
subscribers" with **"upcoming changes (0)"** — i.e. it is the live price, not a
scheduled future one. No existing-subscriber prompt and no start-date picker
appeared, which is consistent with zero subscribers and no prior price history.
`ticket_1` / `ticket_3` / `ticket_6` were not touched. The two rails now quote
the same number.

**Post-deploy verified (measured, not inferred):**

- Prod tree is **byte-identical to the deployed worktree across all 728 files**
  (`.ts/.tsx/.prisma/.json` under `apps/` + `packages/`), by md5 sweep.
- `pm2`: PID held, restart count 50 → 51 (one increment, no loop), **zero
  `P2022` / `P2023` / unhandled / `ERR_MODULE_NOT_FOUND` from the new PID**.
- All 16 crons + `[worker] Peer-wait shimmer every 20000ms` registered.
  `venue-concentration-alert` correctly absent — its flag is unset.
- `/v1/app/config` now serves **`features.telegramAuth: true`** and
  **`ticketProducts`** (3 products) — both new, both previously missing.
- `POST /v1/auth/telegram` → **400 `{"error":"Missing idToken"}`** (was 404).
  It is live rather than 503 because `TELEGRAM_LOGIN_CLIENT_ID` was already set
  on the droplet, ahead of its code.
- All 10 new modules present on the droplet (`emergency-cancel`,
  `date-day-activity`, `venue-origin`, `telegram-login`, `outcome-gate`,
  `calendar-native`, `ticket-gate`, `telegram-auth`, `user-health` ×2).
- `/admin/stats` → **`userHealth.byClass.test = 1`**, which is this file's own
  stated proof that `ADMIN_TEST_TELEGRAM_IDS` landed.
- Loaded config re-read from the running process: `PREMIUM_STARS = 750`,
  `PREMIUM_PRICE_USD_DISPLAY = $17.99`.
- All **11 Mini App pages 200**; assets 57 → 76; `verification.html` carries the
  hand-inlined butterfly mark; the 12 preference photos shipped (~516 KB, inside
  the ~530 KB budget) and the onboarding chunk is 124.5 KB as documented.
- Demo redeployed and **isolation re-confirmed from its own banner**:
  `@gennety_demo_bot`, database `aws-1-eu-west-1.pooler…` (prod is `aws-0-…`,
  a different Supabase project), drop matching not scheduled.
- `api-admin` unauthenticated → 401; `/v1/ping` ok.

**Not verified, and deliberately so:** every flow needing a live match. Nothing
has reached `negotiating_venue` or `scheduled`, so `venue_selection_logs` is
**0 rows** and `live_activity_tokens` is **empty** — the geo-ladder `geoRung`
query, the Live Activity `date_day/start` row and the date-card path have no
data to check and remain unexercised in production. Walk them on
`@gennetytestbot`.

**A note this file kept getting wrong: production does NOT have "0 matches
ever".** It has had **2**, both from the real Thursday drop —
`2026-07-30 15:00Z` (expired) and `2026-08-06 15:00Z` (cancelled), both
`source = weekly`, neither reaching a date. The claim was true when first
written and was then copied forward into every new block. Corrected in the
blocks below; older blocks keep it as the historical record they are.

**Rollback:** re-sync a clean worktree at `7f19a72` and redeploy the Mini App
from it. No schema to undo. Restore `.env` from the `.env.bak.*` snapshot taken
during this deploy to return the Premium price and drop
`ADMIN_TEST_TELEGRAM_IDS`.

---

**Deployed 2026-08-07 (was PENDING) — emergency cancellation reaches the native client, and the partner
finally gets a push (PRODUCT_SPEC §Phase 4 → Emergency Protocol).** Deployed 2026-08-07. **No Prisma schema change, no env change, no flag change, no Mini
App change** (`apps/webapp` untouched) — half of it is client, so the iOS app
ships with it (separate repo).

Cancelling a scheduled date existed only as a Telegram callback flow. An
iOS-only user could not call off a date at all. New:
`POST /v1/matches/{id}/cancel` (JWT), with everything irreversible moved into
`services/emergency-cancel.ts` and shared by both rails.

**Three things worth knowing before the restart:**

- **A mobile partner now gets a push, and did not before.** The Telegram
  handler carried a comment claiming one was "dispatched separately"; nothing
  sent it. A mobile-only partner learned their date was off only by opening the
  app. Expect one new push per cancellation — localized, and deliberately
  **without the reason**, which is someone else's free text and does not belong
  on a lock screen.
- **The Telegram path now writes with `updateMany` (a CAS), not `update`.**
  Same outcome, but two clients racing — the partner cancelling from Telegram
  at the same moment — produce one cancellation and one refusal instead of two
  sets of refunds.
- **The client owns the two-step guard, the server does not.** That is
  deliberate and worth knowing before someone reads the route as under-
  validated: a confirmation the caller can skip is not a confirmation, and the
  irreversible step here is the request itself. The reason IS enforced (400 on
  empty), because forwarding it verbatim is the product rule.

Post-deploy check — production has **0 dates ever** (2 matches, neither reached `scheduled`), so nothing exercises this
until a pair schedules; verify on `@gennetytestbot`. Mounted-ness is checkable
without one:

```sh
# 401 (mounted), never 404 (missing).
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  https://dating-api.gennety.com/v1/matches/00000000-0000-4000-8000-000000000000/cancel
pnpm openapi:lint
```

**Rollback:** revert the code and restart. Nothing else to undo — no schema, no
env, no flag. The Telegram flow returns to its own copy of the logic.

---

**Deployed 2026-08-07 (was PENDING) — the «date day» Live Activity gets driven from the server
(PRODUCT_SPEC §Phase 4).** Deployed 2026-08-07. **No Prisma schema change, no env
change, no flag change, no Mini App change** (`apps/webapp` untouched) — it is
half client, so the iOS app must ship with it (separate repo).

`live_activity_tokens` and `sendLiveActivityUpdateToUser` have existed since
Stage 0 with **no production caller at all**: the transport was built and never
wired, so `date_day` was a row shape and nothing more. Now the date lifecycle
drives it — push-to-start at T-5h alongside the ice-breakers, a `wingman` stage
update at T-1.5h, and an end sweep at T+2h.

**Four things worth knowing before the restart:**

- **`APNS_KEY_PATH` must actually resolve.** This is the first feature whose
  value is *entirely* in reaching a phone that is not being looked at, so an
  unloadable key degrades it to nothing rather than to less. The 2026-07-25
  rsync deleted `/opt/gennety/keys/` once and APNs was silently dead for nine
  days; re-check `ls -l /opt/gennety/keys/` before believing this shipped.
- **Push-to-start is a new payload shape**, not a new endpoint:
  `buildLiveActivityStartPayload` adds `event: "start"` with `attributes-type`,
  `attributes` and a required `alert`. `attributes-type` must equal the Swift
  struct name **verbatim** (`DateDayActivity`) — ActivityKit drops an
  unresolvable start push in complete silence, so a client-side rename is a
  breaking change with no error anywhere.
- **The alert is user-visible.** A start push necessarily raises a
  notification, so a mobile user now gets one more push on date day than
  before — localized, once, at T-5h.
- **The `chat_open` stage is defined and deliberately never sent.** The
  pre-date proxy chat is Telegram-only until the native chat screen lands, and
  announcing an open chat on a lock screen the app cannot follow is the
  dead-button anti-pattern.

Post-deploy check — production has **0 dates ever** (2 matches, neither reached `scheduled`), so nothing exercises this
until a pair schedules; verify on `@gennetytestbot`. The lifecycle logs only on
failure, so silence is the good case:

```sh
pm2 logs gennety-bot --lines 200 --nostream | grep 'date-day activity'
psql "$DATABASE_URL" -c "select activity_type, kind, count(*) from live_activity_tokens group by 1,2;"
```

A `date_day / start` row appearing is the proof the client half landed.

**Rollback:** revert the code and restart. Nothing else to undo — no schema, no
env, no flag; the card simply never starts and the Telegram beats are unchanged.

---

**Deployed 2026-08-07 (was PENDING) — the Mini App loading screens become the brand mark: butterflies in
the stomach (PRODUCT_SPEC → Cross-Cutting Concerns).** Deployed 2026-08-07.
**No Prisma schema change, no env change, no flag change, and NO SERVER CODE
CHANGE AT ALL** — the diff is `apps/webapp/**` plus this file and
PRODUCT_SPEC.md. So this is the **Deploy Mini App Only** path
(`./scripts/deploy-webapp.sh`); there is nothing to rsync to `/opt/gennety` and
**no `pm2 restart`**. Running the full server deploy for it would only risk
shipping whatever else is in the working tree.

The generic spinning ring is replaced on the seven full-screen waits that had
one — Verification, the Date Ticket gate, the Ticket Store, Premium, Referral,
Venue Change, and the Type Radar submit — by a faint line-drawn waist with three
of the logo's own butterflies flying inside it. The contextual boot screens that
already say something the generic mark cannot are deliberately untouched (the
Location map pin, the radar card-stack skeleton, the onboarding orb), as are the
16px in-button spinners.

**Three things worth knowing before the redeploy:**

- **`verification.html` carries a hand-inlined COPY of the mark** (markup + the
  animation CSS), because that shell paints before the bundle exists and
  verification.ts renders the identical mark once it loads — otherwise the
  handover is a visible ring→butterfly swap on the one screen a user is already
  nervous on. `butterfly-loader.test.ts` fails if the two drift, including if a
  keyframe or custom property is added to the module and not to the shell.
- **That same file was missing `--text-faint`.** Its theme tokens are inlined by
  hand and are supposed to mirror theme.css; the gap was invisible until the
  belly stroke resolved through it, and an unresolvable `var()` on `stroke`
  means NO stroke, so the torso vanished and left three butterflies floating on
  a blank screen. Found by screenshotting the real `?screen=loading` preview.
  Both the token and a themed fallback in the shared CSS are in.
- **Demo mode needs `pnpm demo:deploy`** to pick it up (it builds its own bundle
  from the same source). No gate, no paid step, no negotiation step, so
  `apps/bot/src/demo/decide.ts` is untouched.

Post-deploy check — the loading states are transient, so verify through the
dev-only preview and by eye rather than from logs:

```sh
./scripts/deploy-webapp.sh
for p in verification premium referral radar ticket tickets venue-change; do
  curl -sI "https://dating-calendar.gennety.com/$p.html" | head -1
done
# The real loading screen, both themes (this route is import.meta.env.DEV-gated
# in verification.ts, so use the dev server / dev bot for it):
#   http://localhost:5173/verification.html?screen=loading&lang=ru&theme=dark
```

**Rollback:** redeploy the Mini App from the previous checkout. Nothing else to
undo — no schema, no env, no flag, no server state.


**Deployed 2026-08-07 (was PENDING) — two contract fields the native client could not see
(PRODUCT_SPEC §3.7 / §3.8).** Deployed 2026-08-07. **No Prisma schema change, no
env change, no flag change, no Mini App change** (`apps/webapp` untouched) — it
is half client, so the iOS app must ship with it (separate repo, `a2b1b38`).

Both halves of `SerializedMatch`/`VenueIntentState` are read-only additions; the
server-side behaviour they describe already ships.

**Two things worth knowing before the restart:**

- **`VenueIntentState.market` is a schema fix, not a new field.** It was added
  on 2026-08-05 with the departure-point gate and declared
  `oneOf: [$ref Market, "null"]` — the shape swift-openapi-generator SKIPS
  silently — so it never reached the generated Swift client and the live gate
  existed on Telegram only. The wire format is unchanged: it is now a bare
  `$ref`, and the server still sends an explicit `null`, which an optional
  property decodes to absent. The Mini App reads `state.market` and is
  unaffected either way.
- **`SerializedMatch.timeZone` is genuinely new** — the CALLER's own city zone,
  from `Profile.timeZone`. `agreedTime` is an instant and the native date card
  has to draw it on a wall clock; the device's is wrong for a traveller. Same
  reason `CalendarState.timeZone` exists (block above). One extra `profile`
  select on `/v1/matches/current`, no new query.

Post-deploy check — `/v1/matches/current` needs a real match and production has
**2 matches ever, both terminal**, so verify the shape on `@gennetytestbot` via
`scripts/dev-e2e-full-flow.mjs`. The spec itself is checkable without one:

```sh
curl -s https://dating-api.gennety.com/v1/app/config >/dev/null && echo mounted
pnpm openapi:lint
```

**Rollback:** revert the code and restart. Nothing else to undo — no schema, no
env, no flag. `timeZone` simply stops being sent and the iOS card falls back to
the device zone; `market` reverts to the shape iOS cannot read, i.e. the state
this fixes.

---

**Deployed 2026-08-07 (was PENDING) — the slot calendar becomes reachable from the native client
(PRODUCT_SPEC §3.6).** Deployed 2026-08-07. **No Prisma schema change, no env
change, no flag change, no Mini App change** (`apps/webapp` untouched) — it is
half client, so the iOS app must ship with it (separate repo, `d345bca`).

Ships alongside the ticket-gate block below and has the same shape: the server
has always written `proposedTimes` for every `negotiating` match whichever
client accepted, but the only way to read or answer that grid was
`/v1/calendar/*`, which is `initData`-authed. An iOS pair reached scheduling
and had no calendar at all. New: `GET`/`POST /v1/matches/{id}/calendar` (JWT).

**Three things worth knowing before the restart:**

- **No new scheduling logic.** Both verbs delegate to `getCalendarState` /
  `processCalendarSlotsUpdate` unchanged, so auto-lock, `overlapCandidates`,
  the first-mover DM and the peer's live card behave identically to the Mini
  App. Nothing about the Telegram path moves.
- **The response carries the pair's `Profile.timeZone`.** Read-only, additive.
  It exists because the grid is a set of instants and the client has to pick a
  wall clock; the device's is the wrong one, since the date happens in the
  pair's city.
- **A closed calendar answers 409**, matching how the native ticket gate
  reports the same class of state. The Mini App routes are untouched and keep
  their existing codes.

Post-deploy check — the route needs a real `negotiating` match to answer
anything but 401, and production has **2 matches ever, both terminal**, so verify on
`@gennetytestbot` via `scripts/dev-e2e-full-flow.mjs`:

```sh
# Unauthenticated must be 401 (mounted), never 404 (missing).
curl -s -o /dev/null -w '%{http_code}\n' \
  https://dating-api.gennety.com/v1/matches/00000000-0000-4000-8000-000000000000/calendar
```

**Rollback:** revert the code and restart. Nothing else to undo — no schema, no
env, no flag; the Mini App calendar is unaffected either way.

---

**Deployed 2026-08-07 (was PENDING) — the Date Ticket gate becomes reachable from the native client
(PRODUCT_SPEC §3.5b).** Deployed 2026-08-07. **No Prisma schema change, no env
change, no flag change, no Mini App change** (`apps/webapp` untouched) — but it
is half client, so the iOS app must ship with it (separate repo, `368918b`).

The gate has been arming on the mobile mutual-accept path for a while:
`matches-service.ts` calls `sendTicketOffer` whenever `TICKET_FEATURE_ENABLED`,
whichever client committed the decision. What did not exist was any way to
*read* or *settle* it from `/v1/*` — the Mini App's `/v1/matches/:id/ticket`
routes are `initData`-authed, and an app user has no Telegram session to sign
with. So an iOS-only pair sat in a `negotiating` match with no Calendar and no
way to pay until the partial window lapsed and the expiry cron opened
scheduling for free. **Inert in production today** (`TICKET_FEATURE_ENABLED` is
the gate on all of it), which is why this shipped as a hole rather than as an
outage.

**Four things worth knowing before the restart:**

- **`SerializedMatch` grows one field, and it is deliberately NOT `ticketStatus`.**
  That column defaults to `"pending"` on every row the table has ever held, so a
  match from before the feature existed is indistinguishable from an open gate.
  `ticketGate` (`none|open|reveal`) is derived from `ticketExpiresAt`, which is
  what `sendTicketOffer` actually stamps and what both completion and expiry
  clear. `reveal` is load-bearing: the server holds the covered side's Calendar
  back until she opens the surprise, so a client routing her to planning would
  strand her on an empty screen.
- **`/v1/app/config` now serves `ticketProducts`** (from
  `APPSTORE_TICKET_PRODUCTS`, empty while tickets are off) and `/v1/me` serves
  `ticketBalance`. Both additive. The product list is served rather than
  hard-coded because a StoreKit id the app knows and this server does not is a
  purchase that takes money and then 422s on report.
- **On iOS the wallet is the only rail.** StoreKit credits it through the
  already-deployed `/v1/tickets/appstore/transaction`; the gate only spends from
  it. No new payment path, no new provider, no new refund surface — a settle
  that loses its race returns a ticket to the wallet exactly as the Stars gate
  already does. The famine discount is USD-only and does not apply.
- **Demo mode is unaffected.** The demo bot walks the gate on the shipped mock
  rail through the Telegram Mini App; the new routes are JWT-only and
  unreachable from a bot chat, and the puppet still settles its half with
  `useTicketFromBalance`. No branch needed in `demo/decide.ts`.

Post-deploy check — the routes 404 while tickets are off, which is the correct
answer and also the proof they are mounted (an unmounted path answers 404 from
the JWT `matches` router with a different body):

```sh
curl -s https://dating-api.gennety.com/v1/app/config | python3 -m json.tool | grep -A4 ticketProducts
# With TICKET_FEATURE_ENABLED off: [] — and the gate route is unreachable.
curl -s -o /dev/null -w '%{http_code}\n' https://dating-api.gennety.com/v1/matches/00000000-0000-4000-8000-000000000000/ticket-gate
```

**Rollback:** revert the code and restart. Nothing else to undo — no schema, no
env, no flag. `SerializedMatch.ticketGate` simply stops being sent; the iOS
build treats a missing gate as `none`, which is what it already does with
tickets switched off.

---

**Deployed 2026-08-07 (was PENDING) — the departure point must be in a launched city, and the venue
engine stops failing on geometry (PRODUCT_SPEC §3.7).** Deployed 2026-08-07. **No
Prisma schema change, no env change, no flag change** — but it is half client,
so it **DOES need a Mini App redeploy**: Deploy Full Server Code →
`pnpm db:drift-check` → `pm2 restart` → `./scripts/deploy-webapp.sh` →
`pnpm demo:deploy`.

The venue step asked "where are you setting off from?" and accepted **any point
on Earth** — the only check was that the coordinates were numbers. Registration's
city has had a real gate since the Kyiv-only launch; this one had none, on the
same data. Nothing fake was ever assigned (the ranker discards anything past the
commute cap), which is exactly why it was invisible: the run found nothing, the
pair sat in `negotiating_venue`, and 48 h later the §3.5c chain cancelled them
with a lifetime pair ban. The one message they got told them to "relax the
suggested condition" — a condition they never set, on a screen with nothing to
relax, and with no button to reopen it.

**Server first is safe and the order matters.** The gate lives in
`services/venue-origin.ts` and every write path goes through it, so a cached
older bundle keeps working — it just discovers the refusal as a `400` instead of
on-screen. The reverse order would ship a client gating against a `market` field
the server does not yet send, which degrades to no gate at all.

**Four things worth knowing before the restart:**

- **`GET /v1/location/search` now resolves the DB user** (it restricts Places to
  the caller's own market instead of merely biasing toward it, so "Berlin
  Hauptbahnhof" is not in the list at all). A caller with no `User` row now gets
  `404` where it used to search. Unreachable in practice — the route is
  initData-authed from inside a match — but it is a real contract change.
- **The engine now retries with wider geometry instead of failing.** Rung 1 is
  today's behaviour and covers the ordinary case; rungs 2 (12 km) and 3 (the
  market radius) exist because two people at opposite ends of Kyiv — Troieshchyna
  ↔ Vyshneve is ~30 km — could not be served at all. **Only the two distance caps
  move**; quality, hours, price policy and hard constraints are identical on
  every rung. Watch how often it fires: a rung above 1 is normal occasionally and
  means a thin catalog if it is routine.
- **The no-candidates failure now also DMs the founder ops feed** (it schedules
  no retry, so it is a live match about to be lost) and carries a button back
  into the venue screen. Expect ops-feed traffic that did not exist before —
  `FOUNDER_NOTIFY_ENABLED` is on in production.
- **Nothing exercises any of this until a pair reaches `negotiating_venue`.**
  Production has **2 matches ever, both terminal**, so verify on `@gennetytestbot` (needs an
  HTTPS tunnel and `WEBAPP_URL` pointed at it) via
  `scripts/dev-e2e-full-flow.mjs`.

Post-deploy check — the gate refuses server-side even with the client bypassed,
and the ladder names itself in the selection reason when it fires:

```sh
# Berlin coordinates from a Kyiv account must be refused, not saved.
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$PUBLIC_BASE_URL/v1/location/select" \
  -H 'content-type: application/json' \
  -d '{"matchId":"<uuid>","lat":52.525,"lng":13.369}'   # expect 400
pm2 logs gennety-bot --lines 200 --nostream | grep 'widened to rung'
psql "$DATABASE_URL" -c "select top_candidates->'poolSizes'->>'geoRung' rung, count(*) from venue_selection_logs group by 1;"
```

`rung = 1` for essentially every row is the healthy state.

**Rollback:** revert the code, restart, and redeploy the Mini App from the
previous checkout. Nothing else to undo — no schema, no env, no flag. Departure
points already saved stay valid; they are the same columns as before.

---

**Deployed 2026-08-07 (was PENDING) — Premium is $17.99/mo = 750⭐ (PRODUCT_SPEC §3.8).** Deployed 2026-08-07. **No Prisma schema change, no flag change** — but it needs a **two-line
`.env` edit** and a **Mini App redeploy**, and one step of it is not in this
repo at all (App Store Connect). Sequence: `.env` → Deploy Full Server Code →
`pnpm db:drift-check` → `pm2 restart gennety-bot --update-env` →
`./scripts/deploy-webapp.sh`.

The charge is Stars, and the dollar figure is only ever a description of what
those Stars cost: **750⭐ is exactly what Telegram's own Star store bills
$17.99 for**. That is why the two values are edited together and why the code
comment now says so — a label cheaper than the Stars it spends is the one kind
of wrong price that takes money from a user who was told otherwise.

**⚠️ The code defaults are NOT what production runs.** `/opt/gennety/.env`
carries explicit `PREMIUM_STARS=500` / `PREMIUM_PRICE_USD_DISPLAY=$11.99`,
which override them, so deploying the code alone changes nothing a user sees:

```sh
ssh root@167.172.178.229
cd /opt/gennety
cp .env ".env.bak.$(date +%Y%m%d-%H%M%S)"
sed -i 's/^PREMIUM_STARS=.*/PREMIUM_STARS=750/;
        s/^PREMIUM_PRICE_USD_DISPLAY=.*/PREMIUM_PRICE_USD_DISPLAY=$17.99/' .env
grep -n '^PREMIUM_' .env    # expect 750 and $17.99
pm2 restart gennety-bot --update-env && pm2 save
```

**Three things worth knowing before the restart:**

- **The iOS price is Apple's, and nothing here can set it.** The native app
  renders StoreKit's `displayPrice` for `premium_monthly`. It was **$9.99** in
  App Store Connect and was raised to **$17.99** by the founder on 2026-08-07,
  so the two rails now agree — but note the shape of the dependency, because it
  is permanent: `/v1/app/config` exposes only `features.premium`, a boolean.
  There is no server-side price for iOS to read, so **no code change and no
  deploy can ever move the App Store price** — every future change to
  `PREMIUM_PRICE_USD_DISPLAY` needs a matching manual edit in App Store Connect,
  or the two surfaces silently diverge again with nothing in this repo showing
  it.
- **Existing subscribers keep their old price until they resubscribe.** A
  Telegram Stars subscription's amount is fixed on the invoice that created it,
  and `pre_checkout_query` validates against the *current* `PREMIUM_STARS`
  (`handlers/payments.ts`), so an already-recurring 500⭐ subscription keeps
  renewing at 500⭐ while any new invoice is 750⭐. Production has had **0
  purchases ever**, so today that cohort is empty — verify before assuming it
  stays that way.
- **Referral rung values move with it.** `referralUsdValue` parses
  `PREMIUM_PRICE_USD_DISPLAY`, so the ladder's "≈ $ value" column rises
  (1 friend: $18.98 → $24.98). Inert in production —
  `REFERRAL_FEATURE_ENABLED=false`.

Post-deploy check — the state endpoint is the single source both surfaces read:

```sh
# Needs initData, so verify from the Premium Mini App itself; the button must
# read "Оформить — $17.99/мес" and the Stars sheet must say 750.
pm2 logs gennety-bot --lines 50 --nostream | grep -i premium
```

**Rollback:** restore the `.env.bak.*` snapshot and
`pm2 restart gennety-bot --update-env`. The code defaults are then overridden
back to the old price with no redeploy; revert the commit at leisure.

---

**Deployed 2026-08-07 (was PENDING) — the first five profile questions move from the chat into the Mini
App (PRODUCT_SPEC §1.1 / §1.3).** Deployed 2026-08-07. **No Prisma schema change,
no env change, no flag change** — every column it writes (`users.first_name`,
`age`, `gender`, `preference`, `profiles.height`) already exists. But it is
half client, so it **DOES need a Mini App redeploy**, and the order matters:
Deploy Full Server Code → `pnpm db:drift-check` → `pm2 restart` →
`./scripts/deploy-webapp.sh`.

Name, age, gender, who-you're-looking-for and height now have their own screens
in the onboarding Mini App — a text field, an age slider, tinted choice buttons
and a scroll-snap height drum — sitting between the welcome-gift screen and the
AI-memory choice. The chat then opens on `hobbies` instead of "как тебя зовут?".
These are the five questions with exactly one correct answer out of a finite
set, which a Telegram chat cannot ask for: the bot asked in prose and recovered
the value with a regex or an LLM. iOS already had the right controls here
(`ui-hints.ts`); its `/v1/*` contract is untouched.

**Server first is safe, and that is the point.** The new
`POST /v1/telegram-onboarding/profile` simply has no callers until the bundle
ships, and a cached older bundle keeps working on the old path: `/complete`
deliberately does NOT require the five fields, so anything the Mini App did not
deliver is asked for in the chat exactly as it is today. There is no version of
this change where a user gets stuck at the handoff.

**Three things worth knowing before the restart:**

- **It writes through the collector, not through Prisma.** `applyOnboardingFacts`
  reuses `collectOnboardingInput`'s save block, so `onboarding_progress`
  advances under the same revision compare-and-set and the funnel keeps getting
  one `onboarding_step_events` row per real transition. Expect the funnel's
  `first_name_age` / `gender` / `preference` / `height` rows to start arriving
  with `platform: "telegram"` seconds after the Mini App opens rather than
  minutes into a chat — the numbers move, the meaning does not.
- **`MIN_HEIGHT_CM` / `MAX_HEIGHT_CM` moved into `@gennety/shared`.** They were
  literals in the collector and a private copy in `ui-hints.ts`; both now read
  the shared constant, and `/state.profileLimits` serves the same values to the
  Mini App. Values are unchanged (140/220), so nothing shifts — this only
  removes the second place a bound could drift.
- **Nothing exercises the drum until someone registers.** Production onboarding
  is low-volume, so verify on `@gennetytestbot` first (needs an HTTPS tunnel and
  `WEBAPP_URL` pointed at it). For design review alone there is now a preview
  that needs no Telegram and no account:
  `http://localhost:5173/onboarding.html?preview=basics:height&lang=ru&theme=light`
  — `import.meta.env.DEV`-gated, so it does not exist in the production bundle.
- **The tap burst rides along, and it is client-only** (added 2026-08-06,
  PRODUCT_SPEC §1.3). Tapping an option on the gender / preference screens
  throws a themed particle burst from the touch point. No server change, no env,
  no schema — it lives entirely in the Mini App bundle, so the
  `./scripts/deploy-webapp.sh` step above is the whole deploy for it, and
  skipping that step is what would ship the screens without it. Review it with
  `?preview=basics:gender` (or `basics:preference`) on the same dev-only route.
- **So does the preference photo fork** (added 2026-08-06, PRODUCT_SPEC §1.3).
  "Who do you want to meet?" becomes two tall photo columns over a smaller,
  quieter "both". Also client-only — no server change, no env, no schema — but
  it carries three things the burst did not:
  - **Photos ship inside the bundle**, and they are the one thing here with a
    real user cost. They live in `apps/webapp/src/preference/photo/{men,women}/`,
    enumerated by `import.meta.glob`. The screen downloads **~530 KB** (12
    photos, six per side) against a 124 KB onboarding chunk, over mobile data,
    inside Telegram. That is the budget; check it if the set ever changes. It
    grew from 440 KB with the sixth photo per side. (The dropped second design
    held one group image per side in a `cutout/` folder — ~330 KB; that folder
    is gone, see the last bullet.)
    **Never copy originals in by hand.** They are 2–6 MB PNGs, ~40 MB across the
    set. `~/Desktop/_TO_GDRIVE/gennety-media/gennety-preference-photos/prepare.mjs` is what resizes,
    re-encodes and trims them into the repo; the naive `sync.sh` that preceded
    it was deleted precisely because running it shipped the originals. **Run it
    with no flags.** It still writes a `cutout/` folder the app no longer reads,
    and its `--tight` flag only ever narrowed that artwork — both are dead
    weight now, harmless because nothing globs that path.
  - **`onboarding.html` requests Inter 800**, and **must keep doing so** (the
    Google Fonts URL previously stopped at 700). It was added for the dropped
    design's heavy word, and an earlier revision of this bullet said to drop
    `;800` again if the other design won — **that is now wrong**: «Парней» /
    «Девушек» were made 800 on 2026-08-07 and would fall back to a synthesised
    bold. One extra font file for every onboarding user.
  - **One design, no switch (2026-08-07).** `preference-variant.ts`, the `?v=`
    override, the on-screen V1/V2/both toggle, the stacked review page, the
    variant-2 CSS and the `cutout/` artwork are **deleted** — the founder
    settled on the photo scatter. `?v=` is now inert rather than removed-and-
    erroring: it is simply read by nothing. The deleted design is recoverable
    from git history (`git show 8190fea:apps/webapp/src/preference-variant.ts`
    and the paths beside it); it is not recoverable from a flag, on purpose.
  - **The photo scatter was tidied 2026-08-07** — the
    white frames and the dark hairlines inside them are gone (the frame's
    `border-box` shrank the tile's content box below the photo's own ratio, so
    `object-fit: contain` letterboxed all twelve), and the bottom band no longer
    runs under «Парней» / «Девушек». Still client-only. Two things worth
    knowing: the tiles are now `object-fit: cover`, so **the folder must stay
    9:16** or a photo gets cropped instead of showing a margin (`prepare.mjs`
    already preserves the source ratio, so this only bites a hand-copied file);
    and the label's strip is reserved in CSS (`--pref-label-zone`) while the
    bottom slots are authored against the **tightest** column, so a slot's `y`
    is bounded by `maxCentreY` and a test enforces it — verify on a short
    viewport (320×568), not only on 390×844, if those numbers are ever touched.
    Byte cost unchanged. The same pass made «Парней» / «Девушек» heavier (Inter
    800, larger) — which is why the strip and `TIGHTEST_AREA_RATIO` moved with
    it: the reservation is sized to the label, so the two are edited together or
    the photos land on the word again. Inter 800 was already being loaded, so no
    new font request.
- **And so does the height drum's per-row tick** (added 2026-08-06,
  PRODUCT_SPEC §1.3). The drum pulses `HapticFeedback.selectionChanged` as each
  value passes under the capsule instead of once when the scroll stops, and its
  row height drops 56px → 38px, which is the drum's gearing: a native scroll is
  1:1 with the finger, so one swipe now crosses ~47% more values and a flick
  genuinely spins. Client-only — no server change, no env, no schema — so
  `./scripts/deploy-webapp.sh` is again the whole deploy, and **skipping that
  step ships the drum unchanged**. Three things worth knowing:
  - **The row height is duplicated by construction.** `WHEEL_ITEM_H`
    (`onboarding-wheel.ts`) and `.ob-wheel-item` / `.ob-wheel-capsule` /
    `.ob-wheel-pad` in `onboarding.css` must agree, and nothing enforces it —
    the pad is `(280 − row) / 2`, so a change in one place alone silently
    stops the first and last values from reaching the centre. Verified on the
    dev preview after this change: row 38, capsule 38, pad 121, active row
    centred on the capsule to within a pixel, ~7 rows in frame, in both themes.
  - **38px is near the floor, not a midpoint.** It is about where a native iOS
    picker row sits, and the numerals are 28px, so there are only a few px of
    air left. A further increase in sensitivity has to come from somewhere
    other than this number — and there is nowhere honest: the scroll is
    native and 1:1 by design. Dropping `scroll-snap-type` to `proximity`
    would lengthen flings but let one land between two values, which the
    settle handler does not re-centre.
  - **Haptics are not gated on `prefers-reduced-motion`.** That setting is
    about motion; iOS and Telegram honour their own haptic settings below us.
  Review with `?preview=basics:height` on the same dev-only route.
- **Demo mode picks all of it up for free.** The screens are the same source
  behind the same Mini App build, so `pnpm demo:deploy` (which builds its own
  bundle) is the whole story — no gate, no paid step, no negotiation branch, so
  `apps/bot/src/demo/decide.ts` is untouched.

Post-deploy check — the route logs its own line on every screen, so one walk
through onboarding on the dev bot should print five of them:

```sh
pm2 logs gennety-bot --lines 200 --nostream | grep 'profile-saved'
# And the state the chat reads from, for one test account:
psql "$DATABASE_URL" -c "select first_name, age, gender, preference from users order by created_at desc limit 3;"
psql "$DATABASE_URL" -c "select current_question from onboarding_progress order by updated_at desc limit 3;"
```

`current_question = 'hobbies'` on a fresh account is the proof the handoff
landed where it should.

**Rollback:** revert the code, restart, and redeploy the Mini App from the
previous checkout. Nothing else to undo — no schema, no env, no flag. Any
profile data already written by the screens stays valid; it is the same columns
the chat writes.

---

**Deployed 2026-08-07 (was PENDING) — the Type Radar stops gating a client that cannot open it.** Deployed 2026-08-07. **No Prisma schema change, no env change, no flag change** —
code-only, and Telegram behaviour is unchanged by construction
(`AgentDeps.canPresentTypeRadar` defaults to true).

**Read this one before deciding the deploy order.** `TYPE_RADAR_ENABLED=true` is
live, and the gate was written into `runAgentTurn`, which BOTH surfaces share —
while only the Telegram handler consumes `typeRadarRequested` and attaches the
buttons that clear it. So on the native rail the invite came back as a bare
question on every turn with nothing to tap, and the collector never advanced
past `context_dump`/`photos`. **iOS onboarding has been impassable in production
since that flag was flipped**, which also means the founder's pending live runs
(4 real photos through Rekognition, the end-to-end liveness pass) cannot be done
until this ships. Nothing else in the backlog blocks them.

Telegram is unaffected either way, so this changes no behaviour a current user
sees — but it was the one PENDING block whose absence was actively blocking work.
Commit `e0079df`; regression test `onboarding-agent.test.ts` → "does not gate a
caller that cannot present the radar". Full reasoning: TYPE_RADAR_PRODUCT_SPEC.md
→ «Mobile parity».

**Shipped ahead of the rest of the backlog, as a targeted two-file hotfix
(2026-08-07 12:24 UTC).** It was the only blocking block, so it did not wait for
the 84-commit release below. The hotfix was safe *specifically* because both
files it touches — `services/onboarding-agent.ts` and
`public/routes/onboarding.ts` — are changed by **exactly one commit** in the
whole `7f19a72..c25adbc` range (verified with `git log -- <path>`), so prod's
version plus `e0079df` IS the target version and the change pulls in no module
prod did not already have. That is the condition the 2026-08-01 incident note
above is really about; check it with `git log` before ever repeating this,
because a file touched by two commits does not satisfy it.

Procedure actually used: `pnpm --filter @gennety/bot exec vitest run
src/services/onboarding-agent.test.ts src/public/public-api.test.ts` (148
passed) → `scp` both files to the droplet under a **`.hotfix.ts`** name (not
`.ts.new` — tsx refuses an unknown extension, so the import test cannot run) →
`tsx` import-test in place, both OK → `mv` over the live files → restart.

Post-deploy verified: both files md5-match the target, PID 2298196 held, restart
count 49 → 50 with no loop, **zero errors in the error log from the new PID**,
all 16 crons + the peer-wait worker registered, and
`grep canPresentTypeRadar public/routes/onboarding.ts` shows `false` passed at
both call sites (lines 89 and 196) — which is the actual proof the native rail
is no longer gated. Superseded an hour later by the full release below, which
re-synced the same content.

**Deployed 2026-08-05 — demo mode: a second, isolated bot that walks one person
through the whole product (DEMO_MODE.md).** **No Prisma schema change, no
production env change, no production flag change** — production behaviour is
byte-identical with `DEMO_MODE_ENABLED` unset, which is how it ships. What it
adds is a SECOND deployment of the same source tree. Production was NOT
restarted: `gennety-bot` held PID 2174947 and restart count 49 across the whole
rollout.

For an investor or a friend, the only way to see the product end to end today is
to actually register, wait for a Thursday drop, and hope someone matches — i.e.
there is no way. `scripts/dev-e2e-full-flow.mjs` drives both sides from a
terminal, which is useful for engineering and useless as a demo. This is the
demo: same screens, same cards, same Mini Apps, but the partner is a puppet, the
gates wave you through, and twelve seconds stands in for two days.

**The safety property worth reading before anything else.** `DEMO_MODE_ENABLED`
makes `identityTrustConfigurationErrors` treat the process as non-production, so
it stops enforcing the liveness gate. That is why the flag is not
self-certifying: `assertDemoIsolation()` runs first at boot and refuses a
demo-flagged process that still carries production's own settings (founder
notifications on, Stars on, an admin key present). **So setting
`DEMO_MODE_ENABLED=true` in `/opt/gennety/.env` does not silently disable
verification for real users — it stops the bot from booting**, naming the
setting that gave it away. Production is unaffected either way; there is nothing
to undo on the production side.

One-time setup, all of it done on 2026-08-05 and all outside `/opt/gennety`:

1. BotFather: demo bot `@gennety_demo_bot` (id `8845048941`), `/setdomain
   demo-app.gennety.com` — without it the liveness Mini App cannot ask for
   camera permission. ✓
2. A **second Supabase project** — ref `amwalpnalqkhyiaqpqre`, distinct from
   production's `ophztqjrabwemkqwidkq`. pgvector is created by `db:push`
   because the datasource declares the extension. ✓
3. Hostinger DNS: `demo-app` and `demo-api` A records → `167.172.178.229`. ✓
4. Two Caddy blocks appended to `/etc/caddy/Caddyfile` (backup taken first) —
   `demo-api.gennety.com` → `localhost:3102`, `demo-app.gennety.com` serving
   `/var/www/demo-app`. TLS auto-provisioned. ✓
5. `/opt/gennety-demo/.env` — generated as production's `.env` **minus every
   key `.env.demo` defines, minus `FOUNDER_BOT_TOKEN`/`FOUNDER_TELEGRAM_ID`**,
   with `.env.demo` appended. Dropping the founder keys is deliberate:
   `assertDemoIsolation` only checks the FLAG, so removing the token means no
   route to the real ops chat exists even if the flag were flipped. ✓
6. Seed: `db:push` + `db:drift-check` OK; Kyiv catalog imported — **1208
   venues** (913 base / 195 premium / 100 alternative). ✓
7. `pm2 start bash --name gennety-demo --max-memory-restart 300M -- -c "cd /opt/gennety-demo && ./apps/bot/node_modules/.bin/tsx apps/bot/src/index.ts"` then `pm2 save`. ✓

**The 300 MB cap is not decoration.** The droplet has 2 GB and the demo is the
process that must die first if memory gets tight — it has no users to lose.
Production carries no such cap.

**Two things this rollout uncovered, both fixed in code:**

- `scripts/seed-venues.mjs` loaded `.env.local` with `override: true`, so
  `DATABASE_URL=… pnpm seed-venues:import --apply` **silently wrote to the dev
  database and reported success**. It surfaced as "1208 updated" against a
  database holding zero rows. This runbook tells you to run that script against
  production, and DEMO_MODE.md against the demo DB; both were unfollowable. An
  exported variable now beats every dotenv file (`.env.local` still beats
  `.env`).
- The demo photo seeder fell back to `FOUNDER_TELEGRAM_ID` for its upload chat —
  a **production**-bot chat. It failed with "chat not found", and had it
  resolved it would have posted fictional profiles into the real founder ops
  feed. It now resolves the chat from the demo DB, falling back to `getUpdates`.

**Storage isolation — closed 2026-08-06.** For the first day the demo's
`SUPABASE_URL` pointed at the **production** Supabase project (the demo
project's service-role key had not been supplied yet), with `…-demo` bucket
names. Nothing leaked, and it is worth recording why rather than just that: the
only storage write on the Telegram demo path — the liveness reference selfie —
is stubbed by `demo/verification.ts`; Telegram profile photos are `file_id`s
that never reach Supabase; the mobile/chat upload routes are JWT-only and
unreachable from a bot chat; and `/restart` calls the real `deleteUserAccount`,
whose `collectOwnedPaths` keeps only paths prefixed `${userId}/`, so the stub
selfie path was filtered out and no storage call was made at all. A write that
did slip through would have hit a bucket that does not exist in the production
project — a loud failure, not a silent object beside real user media.

What it actually cost was the credential: the demo process held **production's
`service_role` key** for no reason. Now closed — `/opt/gennety-demo/.env`
carries the demo project's own `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`,
the three `…-demo` buckets exist there as **private**, and a real
upload → download → delete round-trip was verified against `selfies-demo`.
`SUPABASE_ANON_KEY` is read by nothing in this codebase and was blanked rather
than left holding production's value.

**Both keys belong in `.env.demo`, not only on the droplet.** The droplet's env
is generated as production's `.env` plus that file, so any key it does not name
silently inherits production's value — which is exactly how `SUPABASE_URL`
became production's in the first place.

Thereafter it is one command per release, run **after** production is verified:

```sh
./scripts/deploy-demo.sh      # or: pnpm demo:deploy
```

It syncs the same working tree to `/opt/gennety-demo`, installs, builds, pushes
the schema to the demo database with a `db:drift-check` gate, restarts
`gennety-demo`, and builds a second Mini App bundle pointed at `demo-api` into
`/var/www/demo-app` — then rebuilds `dist/` back to the production API base so a
later `deploy-webapp.sh` can never ship a demo-pointed bundle to the real host.

**Three things worth knowing before the first run:**

- **A schema change now needs `db:push` against TWO databases.** The demo deploy
  script does it and fails on drift; skipping it surfaces as a `P2022` crash
  loop on `gennety-demo` exactly as it would in production.
- **Memory.** The droplet has 2 GB with ~1.4 GB free and `gennety-bot` sits at
  ~45 MB RSS, so a second process fits — but the demo is the one to kill first
  if memory ever gets tight. It has no users to lose.
- **The demo spends real OpenAI, Places and AWS budget** (a liveness session is
  still minted, ~$0.015, even though its verdict is ignored). Small, not zero.

Post-deploy check — the banner is the proof the right process came up:

```sh
ssh root@167.172.178.229 'pm2 logs gennety-demo --lines 40 --nostream' | head -20
# Must name the DEMO bot and the DEMO database. If it names production, stop.
curl -s https://demo-api.gennety.com/v1/ping
curl -sI https://demo-app.gennety.com/onboarding.html | head -1
```

Verified on the 2026-08-05 rollout: `Bot @gennety_demo_bot started`, banner
naming the demo bot + `aws-1-eu-west-1` database, `[worker] Demo driver every
3000ms`, **`[cron] Drop matching NOT scheduled (demo mode owns matching)`** and
`[cron] No-match notice NOT scheduled` (the two that would otherwise pair two
visitors with each other), `:3102` listening, `/v1/ping` ok, **all 11 Mini App
pages 200**, no admin API (empty key), restart count 0, error log empty.

**Still outstanding at hand-off:** nobody had pressed Start on the demo bot, so
the partner photos are not uploaded yet — `pnpm demo:seed -- --photos=<dir>`
needs one real chat to mint per-bot `file_id`s. The profiles themselves (Артём
29, Ева 25) are seeded and the demo runs; the pitch just has no images until
that step.

**Follow-up 2026-08-06 — the scheduled date gets minutes, and the demo stops
looping (`apps/bot/src/demo/` only, DEMO_MODE.md).** Ships with
`pnpm demo:deploy`; **production is not restarted for it** and nothing outside
`apps/bot/src/demo/` changed. Three defects from one walkthrough, all in the
same stretch of the flow:

- The pre-date replay fired **12 s** after the date locked in, burying the date
  card — the venue-change board, Open in Maps, the blurred share copy — under
  five more messages. It now hands the card over with a note plus a **«Что
  происходит дальше»** button and continues on the tap, or after 7 minutes.
- The post-date feedback flips `scheduled` to `completed`, which is terminal
  exactly like a pass — so finishing the demo produced the **decline** copy
  ("a pass is final, this pair will never be shown again"). The two endings now
  have their own copy.
- The "show me the profile again" button was decorative: the offer deleted the
  finished rows to make itself one-shot, the next tick could not tell that from
  "the demo has not started", and a fresh profile arrived 12 s later whether or
  not anyone tapped. The rows now stay until the tap.

Post-deploy check: walk one demo to a scheduled date and confirm the card sits
alone until the button, and that finishing the feedback form ends with the
🎬 closing message and nothing else.

**Follow-up 2026-08-07 — the photo note stops firing under the Type Radar
invite (`apps/bot/src/demo/` only, DEMO_MODE.md).** Same shape: ships with
`pnpm demo:deploy`, **production is not restarted**, nothing outside
`apps/bot/src/demo/` changed, no schema, no env, no Mini App.

Reported as "the note before photos isn't there in demo mode". It was — in the
wrong place. `TYPE_RADAR_ENABLED=true` on the demo box, so the radar gate
intercepts the photos question *before* it is asked: the collector writes
`currentQuestion = "photos"`, the chat gets the radar invite, and the demo's
note (which the beat fired on that column) landed underneath it. The visitor
then spent several minutes inside the radar Mini App, sat through the ~13s
thinking sequence, and got the photo request — by which point the note was four
screens up. The trigger is now the session's `expectingPhoto`, so it lands
directly under the photo request on every path.

Two things worth knowing before the redeploy:

- **`Profile.typeRadarCompletedAt` is the trap, not the fix.** It is stamped
  *before* the radar thinking sequence runs, so keying on it would drop the note
  into the middle of that sequence — and a real message collapses a rich draft
  (PRODUCT_SPEC §3.6b), so the ~10.7s shimmer would visibly die mid-beat.
- **The driver now reads `bot_sessions`** once per visitor per 3s tick — one
  indexed `findUnique` on a table the bot writes on every update anyway. Demo
  scans at most 100 visitors, so this is noise, but it is the first time the
  driver reads the session store at all.

Post-deploy check: walk one demo onboarding to the radar step and confirm the
note arrives immediately below the "send me 3 photos" request — not above the
radar invite — on both the submit and the Skip path.

**Rollback:** `pm2 delete gennety-demo`. Production is untouched by anything in
this block — no shared database, no shared token, no shared port, no shared
bundle.
