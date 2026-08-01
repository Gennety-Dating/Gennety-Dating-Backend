# Gennety Dating Deploy

**PENDING — purchase notifications + admin revenue ledger.** Not deployed yet.
**No env change, no flag change, no Mini App change** (`apps/webapp`
untouched) — but it needs an **additive `db:push` BEFORE the restart**, and it
requires a **dashboard redeploy** (separate repo,
`~/Desktop/gennety-admin-dashboard`, auto-deploys to Vercel on push).

One new nullable `ticket_ledger` column (`amount_stars`) is WRITTEN on every
Stars store purchase and every date-gate charge, and SELECTED by the admin
purchase list, so a DB missing it throws `P2022` on the first purchase after
the restart — the PM2 crash-loop this file warns about. Verify additive first
(expect one `ADD COLUMN`, zero `DROP`):

```sh
export DATABASE_URL="$(sed -n 's/^DATABASE_URL=//p' .env | tail -1 | tr -d '"')"
pnpm --filter @gennety/db exec prisma migrate diff \
  --from-schema-datasource prisma/schema.prisma \
  --to-schema-datamodel prisma/schema.prisma --script
pnpm --filter @gennety/db db:push
pnpm db:drift-check   # must exit 0 before pm2 restart
```

What ships:

- **Every real purchase now DMs the founder ops feed** (ticket store, the
  §3.5b date-ticket gate, Premium, Rematch, venue change — Telegram Stars AND
  App Store), carrying who paid (`@username`, or the phone number on the
  mobile rail where a synthetic negative `telegramId` and no username is
  normal), what they bought, and how much. **Refunds are announced too**: a
  Rematch refund can follow its own purchase within seconds, so a
  purchase-only feed would leave sales in the DM that no longer exist.
- **`GET /admin/purchases`** — the revenue ledger with filters, pagination and
  totals; plus a spend column on `/admin/users` and a full purchase block on
  `/admin/users/:id`. New **Purchases** tab in the dashboard.
- `ticket_ledger.amount_stars` freezes what was actually charged. Star prices
  are env-tunable, so a reader must never re-derive a historical price from
  `bundleSize`; before this a Stars purchase recorded no money figure at all.

**Three things worth knowing before the restart:**

- **The founder DMs ride `FOUNDER_NOTIFY_ENABLED`** (on in production) and the
  same production-only runtime guard as the rest of the feed, so a local dev
  purchase can never reach the real ops DM. Nothing new to configure.
- **Notifications fire from each rail's settlement write** — the same one whose
  unique provider charge id already makes the purchase exactly-once — so a
  redelivered `successful_payment` returns on the duplicate branch before the
  notifier runs. No new idempotency column, and no risk of double-announcing.
- **Dollar figures derived from Stars are estimates and say so.** Telegram
  publishes no Stars→USD rate; the code uses the documented $0.02/⭐ ticket
  rate and marks every such number `≈`. App Store rows carry Apple's real
  price. Expect the two to disagree slightly with a Telegram payout statement.

Post-deploy check — production has had **0 purchases ever**, so the list will
legitimately be empty until someone actually pays; the endpoint answering `200`
with zero totals is the correct result:

```sh
curl -s -H "Authorization: Bearer $ADMIN_API_KEY" \
  'https://api-admin.gennety.com/admin/purchases?limit=5' | head -c 400
psql "$DATABASE_URL" -c "select count(*) from ticket_ledger where amount_stars is not null;"
```

**Rollback:** revert the code in both repos and restart; the additive column
can stay (nothing reads it if the code is reverted). There is no flag — the
notifications follow `FOUNDER_NOTIFY_ENABLED`, which also silences them.

---

**PENDING — audit fixes, 2026-08-01 (NOMATCH-2 + chat-queue + card fonts).**
Not deployed yet. **Code-only: no Prisma schema change, no env change, no flag
change, no Mini App change.** Ships with whatever restart carries the blocks
below. Three independent fixes from a full-codebase audit:

- **NOMATCH-2 — the D10 pool-exhaustion pause is now always reversible**
  (`services/no-match-notifier.ts`). The status CAS and the
  `starvationPausedAt` marker were two separate writes. That mattered because
  `autoResumeStarvedUsers` selects `paused AND starvationPausedAt != null` while
  the notifier itself only ever selects `active` — so a pause that committed
  without its marker was invisible to BOTH sweeps: silently and permanently out
  of the matching pool, with nothing in the product able to bring the user back.
  They now commit in one `$transaction`. Separately, a pause whose DM failed to
  send left the user paused **and never told**; that path now resumes the
  account so the next run re-evaluates and re-sends. Inert in production today —
  `FAMINE_PAUSE_AFTER_DAYS` is 28 days and no account is near it — which is
  exactly why it was worth fixing before the mechanism starts firing.
- **The chat queue no longer manufactures unhandled rejections**
  (`chat-queue.ts`). Its cleanup hook was a promise derived from the one handed
  to the caller, with no rejection handler of its own, so **every** handler
  error raised a spurious `unhandledRejection` on top of the real error that was
  already caught. `index.ts` installs a non-fatal listener so nothing ever
  crashed — but "zero unhandled rejections" is a post-deploy health signal used
  further down this file, and it could not mean anything while ordinary errors
  fabricated them. Expect that log line to get materially quieter after this
  restart; if it does not, the remaining ones are real.
- **Card headline fonts** — see the expiry-card block below.

No post-deploy check beyond the standard checklist. **Rollback:** revert the
code and restart; nothing else to undo.

---

**PENDING — expiry card (PRODUCT_SPEC §3.4).** Not deployed yet. **No Prisma
schema change, no env change, no flag change, no Mini App change**
(`apps/webapp` untouched). Always-on — there is no feature flag, because the
card degrades to the exact plain text that ships today rather than to nothing.

What ships: the 24h-decision-deadline expiry DM becomes a PNG card plus a short
caption, instead of the bare `sendMessage` it has always been. Four variants
(silent-warning / silent-penalty / partner-ghosted-you / you-ghosted-an-accept),
each with its own vector motif, rendered in the recipient's `User.theme` and
language.

**One new asset rides the ordinary code rsync:**
`apps/bot/src/assets/fonts/unbounded-700.woff` (144 KB). It is the FULL
Unbounded, added because the two subset files (`latin` + `cyrillic`) do not
cover Polish — Ą Ł Ż Ś Ć Ź Ń Ę are in Google's separate `latin-ext` subset. The
time card and match card now load this same file too (see the third bullet
below), so it serves three renderers. Nothing is removed: the subsets stay, and
the referral + coordination cards still use `unbounded-cyr-700.woff` for their
Cyrillic-only headline variant.

**Three things worth knowing before the restart:**

- **Send volume per expiry is unchanged** — still one message per side, now a
  photo instead of text. The render is pure layout + rasterize with no network
  call and no photo download (deliberately: partner photos are `protect_content`
  and a terminal match must not depend on a download), and takes ~0.4 s. It runs
  inside the existing 2 s-per-side pacing loop, so it adds no new rate-limit
  pressure.
- **The sibling font bugs ARE now fixed too (2026-08-01 audit), and one of them
  was worse than this file previously described.** The §3.6 locked-time card
  printed Polish months and weekdays (`WRZEŚNIA`, `PAŹDZIERNIKA`, `ŚR`) with
  those letters dropping into Roboto mid-word — invisible today, since
  production has **zero** `pl` users. The **match card** was the real one: it
  registered BOTH Unbounded subsets under the single family name `"Unbounded"`,
  and satori resolves a family to its first registered font rather than falling
  through per glyph, so the cyrillic subset owned it and every **Latin** glyph —
  the `Gennety` wordmark on every card, plus any Latin partner name — rendered
  in Roboto. That affected `en`/`de`/`pl` recipients on the most prominent card
  in the product, under a flag that is ON. Both now load the same
  `unbounded-700.woff` this deploy already ships, so the asset carries three
  renderers rather than one and no new file is needed.
  `apps/bot/src/services/card-headline-fonts.test.ts` is the regression guard.
  The **referral and coordination cards were never affected** — they switch to
  Archivo Black for non-Cyrillic locales, which covers Latin, Polish and German.
- **Nothing exercises this until a match actually expires.** Production has 0
  matches ever, so the first real card renders only after a drop pairs someone
  and one side lets the 24h window close. Verify on `@gennetytestbot` first —
  `scripts/dev-expiry-cards-demo.mjs` renders and sends all four variants in
  both themes without touching the database.

Post-deploy check — the notify sweep already logs its own totals:

```sh
pm2 logs gennety-bot --lines 200 --nostream | grep '\[expiry-notify\]'
```

**Rollback:** revert the code and restart. Nothing else to undo — no schema, no
env, no flag, no Mini App state. The added font file can stay either way.

---

**PENDING — pre-date coordination PNG cards (PRODUCT_SPEC §Phase 4).** Not
deployed yet. **Code-only: no Prisma schema change, no env change, no flag
change, no Mini App change** (`apps/webapp` untouched). Ships with whatever
restart carries the blocks below.

What ships: the five coordination DMs stop being bare text. Each becomes ONE
message — a rendered PNG, the SAME localized copy as its caption, the same
inline keyboard — mirroring the date card and the venue wish card. Uses the
already-deployed satori/resvg/canvas stack and the already-bundled fonts, so
`pnpm install` pulls nothing new and there is no system dependency to add.

**Three things worth knowing before the restart:**

- **It is inert in production today.** `COORDINATION_FEATURE_ENABLED` gates the
  cron sweep that sends the T-60m offer and opens the T-30m window, and it is
  **off** in `/opt/gennety/.env`. The Variant A/B callback handlers are
  registered unconditionally, but they can only be reached from an offer that
  the disabled sweep never sends. Nothing changes for users until that flag is
  a separate decision.
- **Fail-open is the load-bearing property, not the cards.** A null render, a
  caption over Telegram's 1024-char photo limit, or a rejected `sendPhoto` each
  fall through to the exact plain-text DM the flow sends today. This DM lands
  ~1h before a date and is the only way the pair can find each other, so a
  render hiccup must cost a picture, not the message. Watch for the fallback
  ever firing in production:

```sh
pm2 logs gennety-bot --lines 200 --nostream | grep '\[coordination-card\]'
```

- **Verify on the dev bot, not in prod.** Production has 0 dates ever, so
  nothing will exercise this until a Thursday batch pairs someone AND that pair
  reaches `scheduled` AND the flag is on. `scripts/dev-coord-cards-demo.mjs`
  renders and DMs every variant without touching the database, and
  `scripts/dev-coord-offer-demo.mjs` plays the real flow end to end.

**Rollback:** revert the code and restart. Nothing else to undo — no schema, no
env, no flag, no Mini App state.

---

**PENDING — daily-cadence matching migration groundwork (PRODUCT_SPEC §3.1 /
§3.1b, `DAILY_MATCHING_MIGRATION_AUDIT.md`, `DAILY_MATCHING_IMPLEMENTATION_PLAN.md`).**
Not deployed yet. **Code + one additive schema column, no env change required
to keep current behavior, no Mini App change.** `DROP_CADENCE` is unset in
`/opt/gennety/.env` today and this deploy does not add it — production keeps
running the `weekly` profile byte-for-byte identical to today (pinned by
`packages/shared/src/cadence.test.ts`). Ships **inert**: a `daily` profile
exists in code but nothing switches to it as part of this deploy.

What ships: an internal `DropCadence` abstraction
(`packages/shared/src/cadence.ts`) that every cadence-dependent constant in
the matching engine, proposal deadlines, nudges, the famine notifier, the
Profiler, and Rematch now reads from, selected once at boot by `DROP_CADENCE`
(`weekly` default | `daily`). Plus a genuinely new mechanism, D10 — an honest
pause instead of an endless famine-tier ladder: a user whose `computeTier`
day-count reaches `FAMINE_PAUSE_AFTER_DAYS` (28, a flat code constant —
`packages/shared/src/constants.ts`) is paused via the same CAS the menu's own
Pause button uses, gets one honest DM instead of another tier notice, and is
auto-resumed the moment `findCandidatesFor` would find them a candidate again
(`services/pool-exhaustion.ts`, `autoResumeStarvedUsers`, same cron tick as the
famine notifier).

**⚠️ Requires an additive `db:push` before restart.** One new nullable column,
`profiles.starvation_paused_at`, is read by `services/account-status-transitions.ts`
on every resume and by `services/pool-exhaustion.ts` on every famine-notice
tick, so a DB missing it throws `P2022` on the first no-match-notice cron after
restart — the PM2 crash-loop this file warns about elsewhere. Verify additive
first (expect one `ADD COLUMN`, zero `DROP`):

```sh
export DATABASE_URL="$(sed -n 's/^DATABASE_URL=//p' .env | tail -1 | tr -d '"')"
pnpm --filter @gennety/db exec prisma migrate diff \
  --from-schema-datasource prisma/schema.prisma \
  --to-schema-datamodel prisma/schema.prisma --script
pnpm --filter @gennety/db db:push
pnpm db:drift-check   # must exit 0 before pm2 restart
```

**Three things worth knowing before the restart:**

- **`FAMINE_PAUSE_AFTER_DAYS = 28`, not 14.** `computeTier` is denominated in
  `CADENCE.intervalMs` units, so under `weekly` (7 days/unit) tier 2 already
  lands at day 14 — a 14-day pause threshold would fire at the exact same
  moment as the famine discount and make tier 3 structurally unreachable.  28
  lets the existing tier 1→2→3 ladder (days 7/14/21) play out before the pause
  takes over.
- **Nothing in this deploy changes what any user currently experiences.**
  Every cadence-dependent constant's `weekly` value is asserted byte-for-byte
  identical to what it replaces (`cadence.test.ts`); the only genuinely new
  user-visible surface (D10's pause/resume) is reachable but, per the same
  tier-2-at-day-14 math above, essentially never fires under `weekly` in
  practice at current pool sizes — it exists so the mechanism is proven before
  `daily` cadence (where it fires routinely) is ever turned on.
- **Rematch's env-backed knobs were deliberately left untouched.**
  `REMATCH_MAX_PER_WEEK` / `REMATCH_COOLDOWN_HOURS` /
  `REMATCH_PRE_BATCH_BLACKOUT_HOURS` still read plain `env.*` in `config.ts`,
  not `CADENCE` — moving them would require `config.ts` to import
  `@gennety/shared`, which breaks the dotenv-loading order guarantee
  (`config.ts` must stay the first module evaluated). They need manual review
  before Rematch is ever enabled under `daily`; `REMATCH_FEATURE_ENABLED`
  itself is untouched by this deploy and stays whatever it already is in prod.

**Flipping `DROP_CADENCE=daily` in production is explicitly NOT part of this
deploy** — it is a separate, later decision gated on the founder's judgment
about pool size, not on anything shipped here. When that day comes: set
`DROP_CADENCE=daily` in `.env`, `pm2 restart gennety-bot --update-env`, no
further schema or code change needed (the `daily` profile ships in this
deploy, dormant).

Post-deploy check — the drop-batch log prefix confirms the new code is live
without needing to wait for Thursday:

```sh
pm2 logs gennety-bot --lines 200 --nostream | grep '\[drop-batch\]\|\[pool-exhaustion\]'
psql "$DATABASE_URL" -c "select count(*) from profiles where starvation_paused_at is not null;"
```

**Rollback:** revert the code and restart; the additive column can stay
(nothing reads it if the code is reverted). There is no flag to unset — this
deploy adds no env var.

---

**PENDING — season + weather venue ranking (PRODUCT_SPEC §3.7,
VENUE_ENGINE_IMPROVEMENT_PLAN 5.3).** Not deployed yet. **No Prisma schema
change, no Mini App change** (`apps/webapp` untouched) — but it ships alongside
the observability block below, which DOES need an additive `db:push`, so follow
that block's schema step. One new external dependency, one new flag, ships
**off**.

What it does: a park in a January downpour ranks below a comparable indoor spot.
It is a **soft multiplier, never a filter** — the venue stays fully selectable,
because a wrong forecast or a dead provider must not be able to withhold a venue
from a couple. The combined season × weather factor is clamped to `[0.8, 1.1]`
by a code constant, so it can reorder near-ties and nothing more.

**New external dependency: Open-Meteo** (`api.open-meteo.com`). **No API key, no
account, no quota, nothing to configure** — that is why it was picked over a
credentialed provider for a signal worth a few positions of reordering. One
request per venue selection (not per candidate), cached in-process by city +
hour. If the droplet's egress is ever firewalled, allow `api.open-meteo.com:443`;
otherwise there is no setup step at all.

New env (all optional):

| Key | Default | Effect |
|---|---|---|
| `VENUE_SEASON_WEATHER_ENABLED` | `false` | Master flag. Off → multiplier is a constant 1.0 and **no forecast is ever requested**. |
| `VENUE_WEATHER_TIMEOUT_MS` | `2500` | Upper bound on the forecast wait. Past it the run continues weather-blind rather than making the pair wait. |
| `VENUE_WEATHER_CACHE_TTL_MS` | `3600000` | In-process cache TTL. Failures are cached too, so an outage cannot become a retry storm. |

**Three things worth knowing before flipping the flag:**

- **Every failure is fail-open, by construction.** Network error, timeout,
  non-200, unparseable body, a date past Open-Meteo's ~16-day horizon — all
  return null, and null scores exactly like *perfect* weather, never like bad
  weather. The forecast can only ever make an exposed venue rank slightly
  better or slightly worse; it can never remove one.
- **Most of the catalog is unaffected.** Indoor venues score exactly 1.0 in
  every condition, as does any venue whose exposure the catalog does not
  record. In practice this moves parks and a handful of scenic/outdoor rows.
- **It runs on the selection path**, so the flag is safe to flip live with
  `pm2 restart gennety-bot --update-env`, but production currently has **0
  matches ever** — nothing will exercise it until the first Thursday batch
  pairs someone and that pair reaches `negotiating_venue`.

Post-deploy check — the multiplier is named in `venueSelectionReason` only when
it actually moved a winner, so its absence on indoor picks is correct:

```sh
psql "$DATABASE_URL" -c "select venue_name, venue_selection_reason from matches where venue_selection_reason like '%context%' order by updated_at desc limit 5;"
```

**Rollback:** `VENUE_SEASON_WEATHER_ENABLED=false` +
`pm2 restart gennety-bot --update-env`. No schema, no data, nothing to undo.

---

**PENDING — venue observability (VENUE_ENGINE_IMPROVEMENT_PLAN part 6).** Not
deployed yet. **No Mini App change** (`apps/webapp` untouched) — but it needs an
**additive `db:push` BEFORE the restart**, and it ships alongside the blocks
below, which need their own schema steps. Do every schema step, then one
restart. A **dashboard redeploy** (separate repo, `~/Desktop/gennety-admin-dashboard`)
is only needed to *render* the new endpoint; the API works without it.

One new nullable `venue_selection_logs` column (`city_key`) plus one index is
WRITTEN on every venue selection and SELECTED by the new admin route and the
weekly alert worker, so a DB missing it throws `P2022` on the first date that
gets a venue after the restart — the PM2 crash-loop this file warns about.
Verify additive first (expect one `ADD COLUMN` + one `CREATE INDEX`, zero
`DROP`):

```sh
export DATABASE_URL="$(sed -n 's/^DATABASE_URL=//p' .env | tail -1 | tr -d '"')"
pnpm --filter @gennety/db exec prisma migrate diff \
  --from-schema-datasource prisma/schema.prisma \
  --to-schema-datamodel prisma/schema.prisma --script
pnpm --filter @gennety/db db:push
pnpm db:drift-check   # must exit 0 before pm2 restart
```

What ships, and why:

- **The selection funnel is recorded.** `topCandidates` now holds
  `{candidates, poolSizes}` instead of a bare array — `poolSizes` is how many
  venues survived each stage (`curatedInBox` → `curatedEligible` →
  `placesAdded` → `ranked`). The engine fails silently (dates keep being
  scheduled), so the `.slice(0, 20)` that left 20 of 661 eligible Kyiv venues
  in the running could only ever be found by a hand-written production query.
- **`GET /admin/analytics/venue-concentration?days=7`** — per city: the funnel,
  top venues by share, a concentration index, and `failureReason` counts.
  Cached 15 min, honours `?fresh=1`, emits `X-Data-Generated-At`.
- **Weekly alarm into the founder ops DM**, Friday 10:00 Kyiv.

New env (all optional, all default to the safe value):

| Key | Default | Effect |
|---|---|---|
| `VENUE_CONCENTRATION_ALERT_ENABLED` | `false` | Registers the weekly cron. Also inert unless `FOUNDER_NOTIFY_ENABLED` (the only delivery channel). |
| `VENUE_CONCENTRATION_ALERT_THRESHOLD_PCT` | `15` | Share of a city's dates one venue may take before it is worth a message. |
| `VENUE_CONCENTRATION_ALERT_WINDOW_DAYS` | `7` | Lookback window. |
| `VENUE_CONCENTRATION_ALERT_CRON_SCHEDULE` | `0 10 * * 5` | Friday morning, so the window always contains a full Thursday drop. |

**Three things worth knowing before the restart:**

- **The funnel and `cityKey` are NOT gated by the alert flag.** They are data,
  useful whether or not anyone is being paged, and they start filling on the
  first venue selection after the restart. Only the weekly DM is behind
  `VENUE_CONCENTRATION_ALERT_ENABLED`.
- **Existing log rows keep the old bare-array `topCandidates` and carry no
  funnel.** `parsePoolSizes` returns null for them on purpose — a zeroed funnel
  would drag the median down and fake a pool collapse. They show as
  `samples: 0` until new rows accumulate.
- **A thin city will look concentrated and that is arithmetic, not a defect.**
  Two of three dates in one place is 66%. The alert therefore always carries
  the sample size; a minimum-sample threshold was deliberately NOT added
  because it would blind the alarm exactly when a new market launches.

Post-deploy check — production currently has **0 matches ever**, so the log
table is empty and both surfaces will legitimately return nothing until the
first Thursday batch pairs someone and that pair reaches `negotiating_venue`:

```sh
psql "$DATABASE_URL" -c "select count(*), count(city_key) from venue_selection_logs;"
curl -sD- -o /dev/null -H "Authorization: Bearer $ADMIN_API_KEY" \
  'https://api-admin.gennety.com/admin/analytics/venue-concentration?days=7' | head -1
```

**Rollback:** revert the code and restart; the additive column can stay. To stop
only the DM without a code change, set `VENUE_CONCENTRATION_ALERT_ENABLED=false`
and `pm2 restart gennety-bot --update-env`.

---

**PENDING — admin dialog media + the fat user card (ARCHITECTURE.md
→ `chat_events` / Admin API).** Not deployed yet. **No env change, no flag
change, no Mini App change** (`apps/webapp` untouched) — but it needs an
**additive `db:push` BEFORE the restart**, and it ships alongside the blocks
below, which need their own schema steps. Do every schema step, then one
restart. It also requires a **dashboard redeploy** (separate repo,
`~/Desktop/gennety-admin-dashboard`, auto-deploys to Vercel on push).

One new nullable `chat_events` column (`media`) is SELECTED by the admin dialogs
reader and WRITTEN by the outbound API transformer on every media send, so a DB
missing it throws `P2022` on the first photo the bot sends after the restart —
the PM2 crash-loop this file warns about. Verify additive first (expect one
`ADD COLUMN`, zero `DROP`):

```sh
export DATABASE_URL="$(sed -n 's/^DATABASE_URL=//p' .env | tail -1 | tr -d '"')"
pnpm --filter @gennety/db exec prisma migrate diff \
  --from-schema-datasource prisma/schema.prisma \
  --to-schema-datamodel prisma/schema.prisma --script
pnpm --filter @gennety/db db:push
pnpm db:drift-check   # must exit 0 before pm2 restart
```

What ships, and why each piece exists:

- **Chat media is finally recorded.** `chat_events` stored only a sentence
  ("(photo card, no caption)", "sent a photo"), so the admin dialog reader could
  say a photo happened and never show it — every image in every conversation was
  invisible, which is what "многое количество форматов контента в чате просто не
  видно" actually was. The `file_id` is now read off the API **result**, which is
  the only capture point that works for the bytes-only sends (date card, кружок,
  generated voice note) that carry no id going out.
- **Inbound media too**, plus stickers, which previously fell through
  completely unrecorded.
- **The rich AI-compose finaliser now records itself.** `streamComposedRich`
  persists its final message with `sendRichMessage`, a raw Bot API call the
  outbound transformer does not classify, and unlike the classic stream it
  never called `recordOutboundMessage`. So **every Profiler question was absent
  from the timeline** — the reader showed a user's answers with nothing above
  them, and the concierge agent resolving a bare "why?" against the last thing
  on screen could not see the question either. Visible in production today: the
  06:01 answers in one live dialog have no questions above them.
- **The user card carries the data it always claimed to.** `eloScore` was
  already in the payload and simply never rendered; `homeCity`, tickets,
  Premium, the contact rails, `embeddingDirty`, `standbyCount`, the vibe axes,
  the match history and the Profiler answers were not in the payload at all.
- **Cache freshness.** Analytics TTLs run 10–60 min with nothing on screen
  admitting it. Every cached route now emits `X-Data-Generated-At` /
  `X-Data-Cache` and honours `?fresh=1`.

**Four things worth knowing before the restart:**

- **The timeline now records from `/start`, not from the end of onboarding**
  (founder decision 2026-07-31 — PRODUCT_SPEC §2.1). Registration was the one
  stretch of the conversation the dialog reader could not see. Expect
  `chat_events` to grow faster and to contain onboarding-era content: a typed
  OTP code, and a ≤300-char excerpt of a pasted AI-memory export (that branch
  is off in production — `AI_MEMORY_EXPORT_ENABLED=false` — so it is currently
  theoretical). The 30-day `retention` sweep is what bounds both. The phone
  number is still never stored; the contact share is recorded as the event.
  Reverting is a code change, not a flag: `resolveChatTarget` in
  `services/chat-events.ts`.
- **Existing rows have `media = NULL` and stay text-only.** Nothing backfills,
  and nothing can: Telegram `file_id`s were never stored for those sends. The
  transcript fills in from the first message after the restart.
- **The CORS `exposedHeaders` addition is load-bearing** for the dashboard's
  freshness display — without it the browser silently cannot read the header
  even though the server sends it. `ADMIN_DASHBOARD_ORIGIN` must be a concrete
  origin (it already is) or CORS is denied outright and this is moot.

Post-deploy check, beyond the standard checklist — the column should start
filling within minutes of any real bot traffic, and onboarding chats should
start appearing at all:

```sh
psql "$DATABASE_URL" -c "select kind, count(*) from chat_events where media is not null group by 1;"
# Was structurally 0 before this deploy — anything here proves the widened scope.
psql "$DATABASE_URL" -c "select count(*) from chat_events e join users u on u.id=e.user_id where u.onboarding_step <> 'completed';"
curl -sD- -o /dev/null -H "Authorization: Bearer $ADMIN_API_KEY" \
  https://api-admin.gennety.com/admin/analytics/cities | grep -i 'x-data-'
```

**Rollback:** revert the code in both repos and restart; the additive column can
stay. There is no flag — the recorder writes `media` unconditionally, and the
worst case of leaving it is a nullable column nothing reads.

---

**PENDING — `reference_expired` is escapable again (PRODUCT_SPEC §1.4 rule 5).**
Not deployed yet. **Code-only: no Prisma schema change, no env change, no flag
change, no Mini App change** (`apps/webapp` untouched). Ships with whatever
restart carries the blocks below.

What it fixes: `beginLivenessCheck` refused every `verified` user, so a user
whose reference selfie the 90-day scrub removed was told by three surfaces to
"verify again to change your photos" and then refused `409 already_verified` by
the only call that could do it. The refusal is now conditional on
`verifiedSelfiePath`. Such a re-run deliberately does **not** write `pending` —
matching admits `verified` only, so a downgrade would drop a long-tenured user
out of the pool over a photo edit.

**Probably nobody is in this state yet — not verified against the live DB.** The
scrub keys off `verifiedAt + 90 days`, and the production state recorded at the
2026-07-27 deploy was a single `verified` account whose check ran 2026-07-26, so
its reference is not due for scrubbing until late October. That is an inference
from a three-day-old note, not a measurement. Run this before assuming the fix is
still theoretical (and note the admin API cannot answer it — it needs the DB):

```sh
psql "$DATABASE_URL" -c "select count(*) from users where verification_status='verified' and verified_selfie_path is null;"
```

**Rollback:** revert the code and restart. Nothing else to undo.

---

**PENDING — peer-wait shimmer v2 (PRODUCT_SPEC §3.6b).** Not deployed yet.
**No env change, no flag change, no Mini App change** (`apps/webapp` untouched) —
but it needs an **additive `db:push` BEFORE the restart**, and it ships alongside
the two blocks below, which need their own schema steps. Do all three schema
steps, then one restart.

Two new nullable `matches` columns (`peer_wait_started_at_a/_b`) are SELECTED by a
worker that runs every 20 s, so a DB missing them throws `P2022` on the first tick
— the PM2 crash-loop this file warns about. Verify additive first (expect two
`ADD COLUMN`, zero `DROP`):

```sh
export DATABASE_URL="$(sed -n 's/^DATABASE_URL=//p' .env | tail -1 | tr -d '"')"
pnpm --filter @gennety/db exec prisma migrate diff \
  --from-schema-datasource prisma/schema.prisma \
  --to-schema-datamodel prisma/schema.prisma --script
pnpm --filter @gennety/db db:push
pnpm db:drift-check   # must exit 0 before pm2 restart
```

What ships: the shimmer's wording stops rotating on a 60 s clock and instead
climbs a **five-tier ladder keyed to how long that side has actually waited**
(<5 m / 5 m–1 h / 1–6 h / 6–24 h / >24 h), one line each, plain text with no
icon. Plus two coverage fixes: the calendar's **both-picked-no-overlap**
state (previously silent for BOTH sides until the §3.5c 24 h check-in) and the
**§3.7b venue-change board** (previously no shimmer at all — its ~4 s polling only
covers an open Mini App).

**Three things worth knowing before the restart:**

- **Tiers 4 and 5 are claims about other workers.** "Напомнили {name} о вас" at
  6 h is true only because `match-nudge` fires there, and "{name} долго не
  отвечает" at 24 h is the window the §3.5c 24 h check-in / 48 h cancellation
  sits in. If either schedule is retuned, retune these boundaries with it
  (`TIERS` in `services/peer-wait.ts`).
- **The copy was rewritten once already, same day (2026-07-31), before ever
  shipping.** The first five-tier pass (`Ждём {name}` / `От {name} пока тихо` /
  …) was too terse for a repeat visitor to tell what was actually being waited
  on; every line now states the mechanic ("ждём ответа") explicitly, chosen from
  three candidate ladders demoed live in a dev chat. Tier 5 also dropped the
  "время поджимает" tail — a founder call that the bare fact carries the
  urgency without an explicit pressure phrase.
- **These statuses carry no emoji or animated glyph at all** (founder decision
  2026-07-30) — unlike every other `<tg-thinking>` beat in the product, which
  keeps its AIActions glyph. If a future edit adds one back, that is a product
  change, not a fix; a test in `services/peer-wait.test.ts` asserts the absence.
- **One venue-change interaction is expected, not a bug.** That branch runs on
  `scheduled`, which is not a Profiler-blocking status, so a Profiler question can
  land mid-wait and collapse the draft; the next tick (≤20 s) re-issues it. The
  other three scenarios sit on statuses where the waiting side's chat is quiet.

Watch on the first day that the anchor is only written on real waits — it should
NOT grow by one row per user per tick:

```sh
psql "$DATABASE_URL" -c "select count(*) from matches where peer_wait_started_at_a is not null or peer_wait_started_at_b is not null;"
pm2 logs gennety-bot --lines 200 --nostream | grep '\[peer-wait\]'
```

**Rollback:** `PEER_WAIT_TICK_MS=0` + `pm2 restart gennety-bot --update-env`
disables the whole feature with no code change (note that with it off the
calendar/venue waits show nothing at all — the old confirmation messages were
removed, not merely decorated). Or revert the code; the additive columns can stay.

---

**PENDING — stage-aware pinned banner (PRODUCT_SPEC §2.1).** Not deployed yet.
**This change adds no Prisma schema change, no env change, no flag change, and no
Mini App change** (`apps/webapp` untouched) — but it ships alongside the planning
stall chain below, which DOES need an additive `db:push`, so follow that block's
schema step. Sequence: Deploy Full Server Code → `db:push` (for §3.5c) →
`pnpm db:drift-check` → `pm2 restart`.

What ships: the pinned banner stops always counting down to Thursday. A user
holding a live match is excluded from that batch (§3.2 filter 8), so the banner
now counts down whatever is actually next for them — the 24 h reply deadline on a
`proposed` pitch (label byte-identical to the pitch keyboard's own button), the
time to the date once `scheduled`, or a neutral "date being planned" in between,
each opening the My Date hub instead of the menu. No live match → the original
drop countdown, unchanged. The unlaunched-city waitlist banner still outranks
everything.

**No new API-call volume.** The banner was already re-edited every minute per
active user, and the per-tick match query is still one `findMany` (widened from
`scheduled` to all four live statuses — a user holds at most one live row, so
cardinality is unchanged). Nothing new is sent; only the text of the message that
was already being edited changes.

Two things worth knowing before the restart:

- **The scheduled-date line moved rather than being added.** It used to be an
  extra line *below* the drop status; a scheduled date now owns the whole banner.
  Anyone with a live date sees the drop schedule leave the pin — intended, with
  the reasoning in §2.1.
- **Production had 0 matches ever at the last deploy**, so on day one every
  active account is on the unchanged drop mode and this is invisible until the
  first Thursday batch actually pairs someone. The new modes therefore get their
  first real exercise in production — verify them on `@gennetytestbot` first.

Post-deploy check (beyond the standard checklist): the `status-timer` heartbeat's
`eligible`/`unchanged` counts should look exactly like the previous deploy's, and
no new banner errors should appear.

```sh
pm2 logs gennety-bot --lines 200 --nostream | grep 'status-banner'
```

**Rollback:** revert the code and restart. Nothing else to undo — no schema, no
env, no flag, no Mini App state.

---

**PENDING — planning stall chain (PRODUCT_SPEC §3.5c).** Code-only otherwise:
**no env change, no flag change, no Mini App change** (`apps/webapp` untouched).
Always-on — there is no feature flag, because the thing it fixes is a hole rather
than a feature: the scheduling and venue steps had no deadline, so a partner who
went quiet kept BOTH sides out of every weekly batch indefinitely.

**⚠️ Requires an additive `db:push` BEFORE the restart.** Seven new nullable
`matches` columns are selected by a worker that runs every hour AND written by
`startScheduling` on every mutual accept, so a DB missing them throws `P2022` —
the PM2 crash-loop this file warns about. Verify additive first (expect seven
`ADD COLUMN`, zero `DROP`):

```sh
export DATABASE_URL="$(sed -n 's/^DATABASE_URL=//p' .env | tail -1 | tr -d '"')"
pnpm --filter @gennety/db exec prisma migrate diff \
  --from-schema-datasource prisma/schema.prisma \
  --to-schema-datamodel prisma/schema.prisma --script
pnpm --filter @gennety/db db:push
pnpm db:drift-check   # must exit 0 before pm2 restart
```

New columns: `venue_nudge1_sent_at`, `venue_nudge2_sent_at`,
`scheduling_opened_at`, `stall_check_in_sent_at_a/_b`,
`stall_confirmed_at_a/_b`.

What ships: 6 h/12 h reminders on the venue step (which had none), a "still in?"
check-in with 🟢/🔴 at 24 h, and cancellation at 48 h that frees both sides for
the next drop. Plus cancellation by **text or voice at every planning stage** —
the agent's `propose_cancel_date` filtered on `scheduled` alone, so someone
writing "I want to cancel" mid-planning got an explanation and no way out.

**Two behaviours worth knowing before the restart:**

- **The existing scheduling nudge cadence changes anchor.** It counted from
  `dispatchedAt`, which also covers the up-to-24 h decision window, so a pair
  that accepted at hour 23 could get "pick a time" seconds after the Calendar
  card. It now counts from `scheduling_opened_at`. In-flight rows have that
  column null and keep the old dispatch anchor, so nothing in flight changes
  behaviour mid-deploy.
- **The 48 h cancellation is real and irreversible.** Production currently holds
  0 matches ever, so there is nothing in flight to sweep on the first tick — but
  check before restarting if that has changed:

```sh
psql "$DATABASE_URL" -c "select status, count(*) from matches where status in ('negotiating','negotiating_venue') group by 1;"
# Any such row older than 48h will be cancelled on the first non-quiet-hours
# tick. Both sides get a notice and next-batch priority; nothing is lost, but
# know it is coming rather than discovering it in the logs.
```

Watch the first day via the cron line — it only logs when something happened:

```sh
pm2 logs gennety-bot --lines 200 --nostream | grep '\[match-nudge\]'
pm2 logs gennety-bot --lines 200 --nostream | grep '\[match-stall\]'
```

**Known gap, deliberately deferred:** a stall cancellation does **not** refund a
paid Date Ticket. That hole already exists on every other cancellation path
(emergency cancel of a scheduled date burns both tickets today — neither
`cancel-in-flight-matches.ts` nor `handlers/date/emergency.ts` mentions refunds).
It is being fixed in a separate pass under one rule: the date didn't happen → the
ticket returns to the wallet, for everyone who paid. Until then this change
widens the existing hole slightly, so don't leave the two deploys far apart.

**Rollback:** revert the code and restart. The additive columns can stay. There
is no flag to flip — if the chain has to be stopped without a code revert, set
`MATCH_NUDGE_CRON_SCHEDULE` far-future (e.g. `0 0 31 2 *`), which also silences
every other match nudge.

---

**Deployed 2026-07-29 — admin ops endpoints + the three blocks that had been
sitting PENDING below (`f9e08eb`, 30 commits since `58134b8`… i.e. everything
after the 2026-07-27 release).** Full server code + Mini App + **both** additive
migrations. The three PENDING blocks that used to head this file
(peer-wait shimmer, Kyiv-only market gate, chat timeline) all shipped in this
one deploy and are marked *Deployed* in place below; their env/rollback notes
stay valid as reference.

What prompted it: six `/admin/*` paths were 404ing. The finding was that **none
of them was a stale deploy** — prod's admin surface was byte-identical to HEAD.
They had never been written, and three already existed under a different name
(`/admin/analytics/matches`, `/admin/dialogs`, `/admin/analytics/weekly-matches`).
New: `/admin/health` `/admin/stats` `/admin/dashboard` `/admin/matches`
(`admin/routes/ops.ts`), plus `/admin/conversations` and
`/admin/analytics/founder-weekly` as aliases on the existing handlers.

Schema step was verified additive before running — `prisma migrate diff --script`
produced **zero DROPs**: 4 × `ADD COLUMN` (`matches.peer_wait_*`) and
`CREATE TABLE chat_events` + 2 indexes + FK. `db:push` → `db:drift-check` **OK**
→ restart.

Preflight green: **183 bot test files / 2503 tests**, all typechecks, `pnpm build`,
`security:secrets` (875 files), `security:audit` 0 advisories.

Post-deploy verified: `Bot @gennetybot started`, **all crons registered plus
`[worker] Peer-wait shimmer every 20000ms`** (that line is the proof the new code
is live — it did not exist before), `:3100`/`:3101` listening, `/v1/ping` ok,
admin `401` unauthenticated, **all 12 Mini App pages 200**, `supportedCities`
now Kyiv-only via `/v1/app/config`, `/admin/dialogs/:id` `sources.timeline: true`
(was `false` — the table finally exists), restart count 1 with no crash loop, and
**zero new `P2022`/`P2023`** (counts held at 113/14, all historical — confirmed by
firing fresh requests and re-counting).

Two live bugs were found and fixed while verifying, both pre-existing:
- **`/admin/users/:id` 500'd on a malformed id.** A non-UUID does not read as
  "not found" to Prisma — it throws `P2023`, which the route reported as
  "Internal server error" with a stack trace. Now `400 {"error":"id must be a
  UUID"}` on `/admin/users/:id`, its `/conversation`, and `/admin/dialogs/:id`.
- **`datingadmin.gennety.com` is DOWN** (not caused by this deploy, not fixed by
  it): its Let's Encrypt certificate has **expired**, and even ignoring the cert
  the host answers `404`, so the domain is no longer attached to the Vercel
  project. DNS still points at Vercel. The dashboard is reachable only at
  `https://gennety-dating-dashboard.vercel.app`. Note `ADMIN_DASHBOARD_ORIGIN`
  still lists the dead domain, which is harmless but should be re-pointed when
  the domain is restored. **Superseded 2026-08-01** — see below.

**2026-08-01 (env-only) — `admin.gennety.com` added to `ADMIN_DASHBOARD_ORIGIN`.**
The dashboard's Vercel domain was changed to `admin.gennety.com`, and the admin
API's CORS allowlist is a concrete-origin list (empty/`*` DENIES cross-origin),
so every request from the new domain failed at the preflight — surfacing in the
browser as `Failed to fetch` with nothing loading at all, not even the user
list. Fixed by editing `/opt/gennety/.env` (backed up first) +
`pm2 restart gennety-bot --update-env`:

```
ADMIN_DASHBOARD_ORIGIN=https://admin.gennety.com,https://datingadmin.gennety.com,https://gennety-dating-dashboard.vercel.app
```

All three are kept so the old Vercel URL keeps working during the cutover. The
dead `datingadmin` entry is still listed and still harmless. Verified live: a
preflight carrying `Origin: https://admin.gennety.com` answers `204` with
`access-control-allow-origin` echoing that origin, while a foreign origin gets
`204` with **no** `access-control-allow-origin` (i.e. the allowlist is still a
real gate, not a wildcard). **This is the only change needed when the dashboard
moves domains** — no code, no schema, no redeploy. Rollback: restore the
`.env.bak.*` snapshot and restart.

rsync dry-run listed exactly 2 deletions (the usual stale `apps/video/build`
artifacts). **The exclude list was widened for this run** with
`--exclude 'prod-backup-*.json' --exclude '*.bak.*'`: the droplet holds
`prod-backup-2026-07-27T14-08-06-066Z.json` (a logical DB dump that exists
nowhere else) and a hand-edit `.bak` of `admin/server.ts`, both of which the
documented flag set would have deleted. Consider keeping those excludes.

**Rollback:** re-sync a checkout at `58134b8`, restart, redeploy the Mini App
from it. The additive columns/table can stay. `PEER_WAIT_TICK_MS=0` disables the
shimmer without a redeploy.

---

**Deployed 2026-07-29 (was PENDING) — peer-wait shimmer (PRODUCT_SPEC §3.6b).**
Code-only otherwise: **no flag change, no Mini App change** (`apps/webapp`
untouched). One new optional env var, one **required additive `db:push`**.

**⚠️ Push the schema BEFORE the restart.** The new
`matches.peer_wait_message_id_a/_b` + `peer_wait_edited_at_a/_b` columns are
selected by a worker that runs every 20 s, so a DB missing them throws `P2022`
on the first tick — the PM2 crash-loop this file warns about. Verify additive
first (expect four `ADD COLUMN`, zero `DROP`):

```sh
export DATABASE_URL="$(sed -n 's/^DATABASE_URL=//p' .env | tail -1 | tr -d '"')"
pnpm --filter @gennety/db exec prisma migrate diff \
  --from-schema-datasource prisma/schema.prisma \
  --to-schema-datamodel prisma/schema.prisma --script
pnpm --filter @gennety/db db:push
pnpm db:drift-check   # must exit 0 before pm2 restart
```

What ships: instead of a flat "saved, we'll tell you when they reply" line, the
side that has committed and is now blocked on its partner sees a
`<tg-thinking>` shimmer for the WHOLE wait, wording rotating, gone the moment
the partner answers. Applies to the pitch decision (the card stays, shimmer
under it), the calendar first-mover, and the venue confirm (both of which now
send NO message at all).

**`PEER_WAIT_TICK_MS`** (optional, default `20000`, `0` disables the whole
feature) — the re-issue interval. A rich draft dies ~30 s after it is issued, so
this must stay comfortably under that or the shimmer visibly blinks out between
ticks. `0` is the kill switch: no redeploy, just
`pm2 restart gennety-bot --update-env`.

**Watch on the first day: call volume.** This is a per-waiter heartbeat — one
draft re-issue every 20 s for every side currently waiting. Confirm the worker is
only touching real waits:

```sh
# Logs only when something notable happened (fallback sent/cleared, or errors).
pm2 logs gennety-bot --lines 200 --nostream | grep '\[peer-wait\]'
# Should stay empty on the rich path: the fallback is for clients that cannot
# render rich drafts, and a non-empty column means someone is on that path.
psql "$DATABASE_URL" -c "select count(*) from matches where peer_wait_message_id_a is not null or peer_wait_message_id_b is not null;"
```

**Rollback:** set `PEER_WAIT_TICK_MS=0` and restart (feature off, no code
change), or revert the code. The additive columns can stay either way. Note that
with the feature off the calendar/venue waits show nothing at all — the old
confirmation messages were removed, not merely decorated.

**Deployed 2026-07-29 (was PENDING) — Kyiv-only market gate.** **No Prisma schema
change, no env change, no flag change.** Requires a **Mini App redeploy**
(`apps/webapp` changed: `onboarding.tsx` / `onboarding-i18n.ts` /
`onboarding.css` / `api.ts`), so the sequence is Deploy Full Server Code →
`db:drift-check` → `pm2 restart` → `./scripts/deploy-webapp.sh`.

What ships: registration accepts **Kyiv only** (PRODUCT_SPEC §1.3). The
launched-market list is a code constant
(`packages/shared/src/markets.ts` → `SUPPORTED_MARKETS`), deliberately NOT an
env var — a market is only real once its curated venue catalog, ads and ops
exist, and an env toggle would let someone open a city before any of that is
ready. Launching a city is: seed + review its `curated_venues` rows, add the
`SUPPORTED_MARKETS` entry (its `cityKey` must match the venue rows'
`cityKey`), redeploy.

Two behaviour notes worth knowing before the restart:

- **The city step no longer calls Google Places at all** (search and the
  geolocation resolve are both first-party now). `PLACES_API_KEY` is still
  required for venues and the date card — do not remove it. This also removes a
  latent bug: without the key, the old reverse-geocode resolved ANY coordinates
  to Kyiv.
- **Accounts already registered outside Kyiv are not touched** — no status
  change, no data rewrite. They gain a `menu:city` row offering a one-tap move
  to Kyiv, their pinned banner switches from the drop countdown to waitlist
  copy (the `status-timer` worker self-heals it within a minute), and the
  Thursday no-match DM becomes an honest "we haven't launched in {city}" with
  the switch button (no famine tier, no discount, no Rematch offer). Production
  held 9 users at the last deploy with Kyiv covering 6, so expect roughly 3
  accounts on this path.

Post-deploy checks (beyond the standard checklist):

```sh
curl -s https://dating-api.gennety.com/v1/app/config | grep -o 'supportedCities.*ua:kyiv'
# The city step is Kyiv-only end to end; confirm on the dev bot that a search
# for "Berlin" returns nothing and geolocation outside Kyiv explains itself.
psql "$DATABASE_URL" -c "select home_city_key, count(*) from profiles group by 1 order by 2 desc;"
```

**Rollback:** revert the code, restart, and redeploy the Mini App from the
previous checkout. Nothing else to undo — no schema, no env, no flag. A city
switched to Kyiv stays switched (it is an ordinary profile write).

---

**Deployed 2026-07-29 (was PENDING) — chat timeline for the concierge agent
(`chat_events`).** Code-only otherwise: **no env change, no flag change, no Mini App
change** (`apps/webapp` untouched).

**⚠️ Requires an additive `db:push` BEFORE the restart.** The new
`chat_events` table is read on every menu-agent turn and written by the
outbound API transformer on every message the bot sends, so a DB missing it
throws `P2022` on the first message after restart — the PM2 crash-loop this
file warns about. Verify additive first (expect one `CREATE TABLE` + two
`CREATE INDEX`, zero `DROP`):

```sh
export DATABASE_URL="$(sed -n 's/^DATABASE_URL=//p' .env | tail -1 | tr -d '"')"
pnpm --filter @gennety/db exec prisma migrate diff \
  --from-schema-datasource prisma/schema.prisma \
  --to-schema-datamodel prisma/schema.prisma --script
pnpm --filter @gennety/db db:push
pnpm db:drift-check   # must exit 0 before pm2 restart
```

What ships: the concierge agent can finally see what the user is reacting to
(PRODUCT_SPEC §2.1) — every durable outbound message, every button tap by its
visible label, and Mini App submissions, rendered into its prompt as a "Recent
chat timeline". Written at three boundaries (grammY API transformer, one
inbound middleware, ~12 explicit calls in the initData routes), not at the ~276
individual send sites.

**Two things to watch on the first day, both about write volume.** The
transformer records only `send*` methods — every `edit*` is skipped precisely
because the pinned status banner and the pitch countdown re-render **once a
minute per user**. Confirm that holds in production:

```sh
# Should grow roughly with real messages, NOT by ~1 row/user/minute.
psql "$DATABASE_URL" -c "select count(*), max(created_at) from chat_events;"
# No 'analysing…' / status-beat rows: those sends are marked ephemeral and a
# deleteMessage also removes whatever row it created.
psql "$DATABASE_URL" -c "select direction, kind, left(summary,60) from chat_events order by created_at desc limit 20;"
```

Retention: the existing `retention` cron (`45 3 * * *` Kyiv) now also sweeps
`chat_events` older than **30 days**, batched at 1000 rows/tick — no new cron,
no new env.

**Rollback:** revert the code and restart. The table can stay (nothing else
reads it) or be dropped separately; no env, flag, or Mini App state to undo.

**Deployed 2026-07-27 (latest) — onboarding photo editor, MIN_PHOTOS 3, one
onboarding entry point, pre-drop teaser removed (`867129e`, 11 code commits
since `e774daa`).** Code only: **no Prisma schema change** (`db:drift-check`
returned OK with nothing to push), no env change, no flag change, **no Mini App
redeploy** (`apps/webapp` was untouched by every commit in the range).

Carries: the in-onboarding photo editor (`photo-editor.ts` / `photo-cards.ts` /
`photo-stage-panel.ts` — the first upload is no longer write-only, PRODUCT_SPEC
§1.3), `MIN_PHOTOS` lowered 4 → 3, the removal of the whole `face_obscured`
obstruction gate, the §1.4 quorum change that drops a failing photo instead of
the account (plus the withheld activation when that leaves the profile under the
minimum), one onboarding entry point (the legacy chat consent/language screens
are deleted), and the removal of the pre-drop teaser worker.

**The teaser removal is the deploy's own proof of freshness.** The pre-restart
log block carried `[cron] Pre-match announce scheduled: "0 18 * * 3"`; the
post-restart block does not. That cron disappearing is what confirms the new
code is actually live, the same way the Rematch cron appearing confirmed its
flag flip.

rsync dry-run listed **7** deletions and every one was intended: the 5 files git
actually deletes in this range (`consent.ts`, `language.ts`, `prompts.ts`,
`pre-match-announce.ts` + its test) and the 2 usual stale `apps/video/build`
artifacts. `.env` survived with all 8 `.env.bak.*` snapshots intact.

Preflight green locally: **typecheck clean, 172 bot test files / 2281 tests
passed, `pnpm build` clean, `security:secrets` passed (845 files),
`security:audit` clean (0 advisories)**, tree clean and level with `origin/main`.

Post-deploy verified: `Bot @gennetybot started`, all crons registered (Rematch +
venue-change refund retries present, so both flags still on; Pre-match announce
correctly absent), `:3100`/`:3101` listening, `/v1/ping` ok, admin `401`, **all
12 Mini App pages `200`**, zero `P2022` / `FATAL` / unhandled rejections, restart
count 31 → 32 (single restart, PID stable). Server markers confirm the new code:
`MIN_PHOTOS = 3`, `photo-editor.ts` present, `pre-match-announce.ts` gone. The
only error-log lines are the documented `status-banner … chat not found` pair —
the `status-timer` heartbeat reads `eligible:3 unchanged:3 permanentFailures:2`,
i.e. the same two unreachable Telegram rows under their 6-hour cooldown.

**Production state recorded at this deploy (baseline before the ad launch):** 9
users total (6 `onboarding`, 3 `active`), verification funnel 6 `unverified` / 1
`verified` / 2 `rejected`, Kyiv holds 6 of them — **4 male, 0 female** — and
there have been **0 matches and 0 dates ever**. So the entire post-match half of
the product has never executed once in production. `REFERRAL_FEATURE_ENABLED`
stays `false` (still under development); its code shipped in this range only in
the sense that it was already there and untouched.

**Rollback:** re-sync a checkout at `e774daa` and restart. No schema, no env, no
flag, no Mini App to undo.

**Prior: 2026-07-27 — sunglasses stop rejecting profile photos, plus
the overdue Profiler schema (`e774daa`, 3 commits since `35df65b`).** Code only:
no env change, no flag change, **no Mini App redeploy** (`apps/webapp` carries
its own inlined i18n and does not import `@gennety/shared` strings, so the
changed `photoFaceObscured` copy is bot-side only).

Driven by a production audit rather than a guess: `media_validation_rejections`
plus the PM2 logs, across prod AND dev, showed `face_obscured` was **9 of the 11
real (non-retryable) rejections ever recorded — ~82% of all upload friction** —
while `unsafe_content` had never fired once and `no_face` had fired exactly once
in six weeks. So the fix is one sub-check, not the feature: the sunglasses branch
is gone, the mask/covering branch stays (PRODUCT_SPEC §1.3 records why — a
covered face becomes a `fail` at verification, and one `fail` hard-rejects the
whole account under the §1.4 quorum rule).

**⚠️ The mandatory `db:drift-check` gate earned its keep on this deploy.** It
failed *before* the restart — not from this change, which touches no
`schema.prisma`, but from the **Profiler** columns `profiles.profiler_answer_
window_until` / `profiler_question_message_id`, committed to `main` in `f54d53a`
after the last deploy and never pushed. Prod had been running pre-Profiler code,
so nothing was broken yet; restarting the freshly-synced code against that DB
would have thrown `P2022` on the first Profiler question and surfaced as a PM2
crash loop — exactly the failure mode this file warns about. Verified additive
before pushing: `prisma migrate diff --script` produced **two nullable
`ADD COLUMN`s and zero DROPs**. Ran `db:push` → `db:drift-check` **OK** → restart.

Preflight green locally: **bot 171 files / 2267 tests, webapp 144, shared 207,
all typechecks clean, `pnpm build` clean, `security:secrets` passed,
`security:audit` clean**, tree clean and level with `origin/main`. The rsync
dry-run listed only the 2 usual stale `apps/video/build` artifacts as deletions,
and the 7 `.env.bak.*` snapshots survived it.

Post-deploy verified: `Bot @gennetybot started`, **all 16 crons** registered
(incl. Rematch + venue-change refund retries, so both flags are still on),
`:3100`/`:3101` listening, `/v1/ping` ok, admin `401`, **all 12 Mini App pages
`200`**, zero `P2022` / `FATAL` / unhandled rejections, restart count 30 → 31
(single restart, same PID holding — no crash loop). The only error-log lines are
the documented `status-banner … chat not found` pair for two unreachable
Telegram rows. Confirmed on the live droplet that `MIN_SUNGLASSES_CONFIDENCE` is
gone from the deployed source and the new RU rejection copy is in place.

**How to tell whether this was the right gate — no new instrumentation needed.**
Watch `media_validation_rejections`: if `face_obscured` drops toward zero,
sunglasses were the cause; if it continues at the same rate, what remains are
genuine coverings.

**Rollback:** `git revert e774daa`, redeploy. The additive Profiler columns may
stay either way — they are required by current `main` regardless.

**Prior: 2026-07-26 — card-based photo manager, honest liveness-retry
copy, branded detector (`9b3e51e`, 8 commits since `2c5f206`).** Code + Mini App:
no Prisma schema change, no env change, no flag change. Ships the §2.1 card-based
photo manager (one message per photo with its own 🗑 button, coalesced upload
bursts, per-frame rejection replies), the §1.4 outcome-split liveness-retry copy
(`not_live` / `expired`/`in_progress` / `no_reference` instead of one generic
"shaky camera" guess), the theme-aware branding of the Face Liveness detector,
a body-encoded-404 fix in `services/storage.ts` that could wedge account
deletion, and the drop of the hourglass emoji from the pinned-banner countdown
button.

Preflight green locally: **typecheck clean, all tests pass (bot 169 files /
2212 tests), `pnpm build` clean**, working tree clean and level with
`origin/main`. Ran Deploy Full Server Code → `db:drift-check` (**OK**, nothing to
push — the diff touches no `schema.prisma`) → `pm2 restart`, then Deploy Mini App
Only (`apps/webapp` changed: `liveness-theme.css`, `liveness-detector.tsx`,
`verification.html`). The rsync dry-run listed only the 2 usual stale
`apps/video/build` artifacts as deletions.

Post-deploy verified: `Bot @gennetybot started`, all 14 crons registered,
`:3100`/`:3101` listening, `/v1/ping` ok, admin `401`, all 11 Mini App pages
`200`, the self-hosted liveness assets still serve correctly
(`/liveness/tfjs-wasm/*.wasm` → `application/wasm`, `/liveness/blazeface/
model.json` → `application/json`), restart count 27 → 28 (single restart, no
crash loop), and no new lines in the error log — the `face mismatch → rejected`
entry there is the pre-existing 2026-07-26 session, and the `status-banner …
chat not found` lines are the documented unreachable-chat cooldown. The 113
`P2022` hits in the historical log all predate earlier pushes.

**Rollback:** re-sync a checkout at `2c5f206` and redeploy the Mini App from it.
Nothing else to undo — no schema, no env, no flag.

**Prior: 2026-07-26 (later) — a missing reference selfie is retryable, not a
dead end (`2c5f206`).** Code-only: no Prisma schema change, no env change, no
flag change, no Mini App change. A verification run that cannot fetch the
reference selfie used to write `pending_review` — a status with no button, that
the re-engagement stall sweep skips, behind an app gate that stays locked — so
the user could never get out (PRODUCT_SPEC §1.4 rule 4). It now writes `pending`
and DMs the Verify button, and it restores `verified` instead of demoting a user
our own outage tripped over.

Found via a live incident: one prod account (`telegramId 782065541`) had sat in
that dead end since 2026-07-25 20:16 UTC — a photo-edit rerun against a
Persona inquiry whose selfie was never stored (`selfie fetch failed
{ error: 'no_selfie' }`, Persona-era code, ~9.5 h before the Face Liveness
migration commit). **The account was recovered by hand** (`pending_review` →
`unverified`, `personaInquiryId`/`faceMatchedAt`/`faceMatchScore` → null);
`photoFaceScores` was deliberately left as `[0,0,0,0]` to preserve the
`photos[i] ↔ photoFaceScores[i]` 1:1 invariant — the next successful run
overwrites it. It was the only row in `pending_review` (plus 1 `rejected`, 7
`unverified`).

The bug was NOT Persona-specific — the migration carried that branch over
verbatim and only swapped the selfie source underneath it. The live AWS-era
trigger is the 90-day `selfie-retention` scrub plus the admin
"rerun verification" button, which checks `personaInquiryId` but **not**
`verifiedSelfiePath`: before this fix, one click on any user verified 90+ days
ago would have demoted them out of the match pool into the same inescapable
state. No such user exists yet, which is why it had not fired.

Preflight green locally: bot suite **167 files / 2181 tests**, typecheck clean.
Ran Deploy Full Server Code → `db:drift-check` (**OK**, nothing to push) →
`pm2 restart`. rsync dry-run listed only the 2 usual stale `apps/video/build`
artifacts as deletions. Post-deploy verified: `Bot @gennetybot started`, all 14
crons registered, `:3100`/`:3101` listening, `/v1/ping` ok, admin `401`, all 11
Mini App pages `200`, restart count 26 → 27 (single restart, no crash loop), and
no new lines in the error log.

**Also confirmed by this deploy's log review:** the "still to confirm" item from
the migration block below — one live end-to-end verification from a real
production account — has happened. A real AWS liveness session
(`4c74f6d7-cd00-4e40-99c2-59f6a5be333b`, a UUID, not an `inq_*`) ran the full
pipeline and returned a well-formed `rejected` (4 photos scored 0.027–0.046
against the selfie). Face Liveness is working end-to-end in production.

**Rollback:** `git revert 2c5f206`, redeploy. Nothing else to undo — no schema,
no env. The hand-recovered account is independent of the code and stays
recovered either way.

**Prior: 2026-07-26 — identity verification moved from Persona to AWS
Rekognition Face Liveness.** The sandbox-Persona era is over: production had
been running test-only KYC behind `ALLOW_SANDBOX_PERSONA=true` since
2026-07-17, and that override no longer exists because Face Liveness has no
sandbox/production key split to waive.

Sequence: env delta first (the bot refuses to boot without the new keys, so
they must precede the restart) → rsync → install/build → `db:push` →
`db:drift-check` → `pm2 restart` → Mini App deploy.

- **Env** (`/opt/gennety/.env`, backed up to `.env.bak.20260726-160202`):
  removed all seven Persona keys (`ENABLE_PERSONA_VERIFICATION`,
  `PERSONA_TEMPLATE_ID`, `PERSONA_ENVIRONMENT_ID`, `PERSONA_API_KEY`,
  `PERSONA_WEBHOOK_SECRET`, `PERSONA_HOSTED_URL_BASE`,
  `ALLOW_SANDBOX_PERSONA`); added `FACE_LIVENESS_ENABLED=true`,
  `FACE_LIVENESS_REGION=eu-west-1`, `FACE_LIVENESS_MIN_CONFIDENCE=0.8`,
  `LIVENESS_STS_ROLE_ARN=arn:aws:iam::147010141827:role/GennetyLivenessClient`,
  `LIVENESS_CREDENTIALS_TTL_SECONDS=900`. No new AWS credentials were needed —
  the existing `gennety-bot-rekognition` user gained two Rekognition actions
  plus `sts:AssumeRole`, and a new `GennetyLivenessClient` role carries the
  single `StartFaceLivenessSession` grant a user's device briefly holds.
- **⚠️ An unrelated schema drift surfaced and had to be resolved first.**
  `db:drift-check` failed on the **Rematch** tables (`matches.source`,
  `matches.rematch_paid_by_id`, `rematch_purchases`) — committed to `main`
  earlier and never deployed, exactly as this file's Rematch section warns.
  Verified additive before pushing: `prisma migrate diff --script` produced 6
  statements, all `ALTER TABLE ADD COLUMN` / `CREATE TABLE` / `CREATE INDEX`,
  **zero `DROP`** (the only "DELETE" match was `ON DELETE CASCADE` in the new
  table's FK). `db:push` then `db:drift-check` → OK. The liveness migration
  itself is schema-free: `personaInquiryId` now holds the AWS session id.
- **rsync** dry-run listed 12 deletions, all intended: the 9 deleted
  Persona/poller files, the dead `verification.css`, and 2 stale
  `apps/video/build` artifacts.
- **Verified after restart:** `Bot @gennetybot started`, all 14 crons
  registered, `:3100`/`:3101` listening, restart count 25 → 26 (single restart,
  no crash loop), and **no new lines in the error log** — the `[persona] handler
  error` entries there predate the deploy by two hours and belong to the
  webhook that no longer exists. `pnpm probe-liveness` **on the droplet** passed
  all three AWS permissions with production env. `/v1/ping` ok, admin `401`, all
  11 Mini App pages `200`, the self-hosted model + wasm assets serve with
  `application/wasm`, and `POST /v1/webhooks/persona` now `404`s.
  (`GET /v1/me/verification/url` answers `401` rather than `404` because
  `requireAuth` runs before routing in that router — the route is genuinely
  gone.)
- **Still to confirm:** one live end-to-end verification from a real account.
  The dev run on `@gennetytestbot` passed fully (real AWS session, reference
  selfie stored, `CompareFaces` [1.000, 0.988, 1.000, 0.999] → `verified`), so
  the remaining unknown is only production's own Mini App host.

**Rollback:** `git revert` the migration commits, restore
`.env.bak.20260726-160202`, redeploy. Realistic because production identity was
sandbox-only — no real `verified` cohort depends on it. The additive Rematch
schema can stay either way.

Prior: 2026-07-25 — phone-based account login (`d1ad29f`), code-only.
Prior the same day: full catch-up release (85 commits), additive
`db:push`, flag alignment, and a dev↔prod isolation fix (details in the dated
blocks below). Prior: 2026-07-23 — dev↔prod schema-drift reconciliation + the
2026-07-22 code release. Earlier: 2026-07-21
(full server deploy — **self-healing Telegram drop banner**, commit `045279c`;
no Prisma schema change). Production build and PM2
restart succeeded; `/v1/ping` stayed healthy, every Mini App returned `200`,
and the unauthenticated admin API returned `401`. A legacy pinned-banner orphan
was unpinned only after its message id, create/edit timestamps, text, account
creation timestamp, and status matched the pre-deploy audit; the final
production orphan count was zero. The 16-minute observation window produced the
expected second heartbeat with `eligible=2`, `unchanged=2`, no new errors, no
429s, and no PM2 restart-count growth. Both DB-active Telegram rows returned
`400 chat not found`, so the worker correctly left them untracked under the
six-hour unreachable cooldown; there was no reachable active chat for a live
client rendering check.)

**2026-07-27 (env-only) — Rematch turned ON.** Founder decision, immediately
after the release below verified clean. Added a single line to
`/opt/gennety/.env` (backed up to `.env.bak.20260727-033937` first):

```
REMATCH_FEATURE_ENABLED=true
```

then `pm2 restart gennety-bot --update-env` + `pm2 save`. No schema step — the
`matches.source` / `rematch_paid_by_id` columns and the `rematch_purchases`
table were already in the prod DB (see the release note below). No Mini App
change; Rematch is Telegram-only and has no Mini App surface.

**The flag flip is confirmed by the cron, not by the env line.** The startup
block after the restart now carries `[cron] Rematch refund retry scheduled:
"0 * * * *"`, which is registered only when the flag is on — the block
immediately before it (same log, pre-restart) does not. That cron is what makes
"never keep money without delivering a match" durable, so its presence is the
real proof the feature is live rather than half-on. Also verified: `Bot
@gennetybot started`, `:3100`/`:3101` listening, `/v1/ping` ok, PM2 restart
count 29 → 30 (single restart, no crash loop), no new `P2022` / `FATAL` /
unhandled rejections.

Every other `REMATCH_*` key is left unset, so the code defaults apply:
`REMATCH_STARS=150`, `REMATCH_MAX_PER_WEEK=2`, `REMATCH_COOLDOWN_HOURS=24`,
`REMATCH_GIFT_CAP_DAYS=7`, `REMATCH_PRE_BATCH_BLACKOUT_HOURS=6`.

**⚠️ Open pricing decision — the label may under-promise the charge.** 150⭐ is
$3.00 at the ticket rate ($6.99/350⭐ = $0.02/⭐) but ≈$3.59 at the more
conservative $0.024/⭐ rate documented under `PREMIUM_STARS`, while the offer
copy says **$2.99**. Both fixes are env-only: `REMATCH_STARS=125`, or raise
`REMATCH_PRICE_USD_DISPLAY`. Not resolved at flip time.

**Rollback is one line:** delete `REMATCH_FEATURE_ENABLED` (or set `false`) and
`pm2 restart gennety-bot --update-env`. The additive schema may stay. Note that
rollback stops *new* offers but does not refund an in-flight purchase — the
refund sweep is itself flag-gated, so if a purchase is stranded in `processing`,
flip the flag back on long enough for the hourly sweep to settle it.

**Deployed 2026-07-27 — Rematch + audit hardening + retention (`35df65b`, 40
commits).** Carried the paid **Rematch** feature (`REMATCH_PRODUCT_SPEC.md`,
PRODUCT_SPEC §3.11) plus the security/audit hardening batch (AUTH-1, XSS-1,
ADMIN-1/2, BONUS-1, liveness-session binding, report-triage bounding, OTP
connection handling, 12 dependency advisories), the data-retention sweep, the
durable venue-change refund rail, and the founder-report 90-day link expiry.

Preflight green locally: **171 bot / 15 webapp / 13 shared test files (2251 /
144 / 205 tests)**, all typechecks clean, `pnpm build` clean, tree clean and
level with `origin/main`.

Ran Deploy Full Server Code → `db:push` → `db:drift-check` (**OK**) →
`pm2 restart`, then Deploy Mini App Only (`apps/webapp` changed). The rsync
dry-run listed exactly **2** deletions, both stale `apps/video/build`
artifacts; `.env*` and `keys/` were excluded and the 5 `.env.bak.*` rollback
snapshots survived.

**Schema step was verified additive before running:** `prisma migrate diff
--script` produced **zero DROP statements** — only `founder_reports.expires_at`,
`users.pending_liveness_session_id`, and the new `venue_change_purchases` table
(+ its unique/FK indexes). Notably the Rematch objects (`matches.source`,
`matches.rematch_paid_by_id`, `rematch_purchases`) were **already present in the
prod DB** and so did not appear in the plan.

**Rematch shipped dark and was verified inert** *(superseded the same day — see
the env-only flip above)*: no `REMATCH_*` keys existed in `/opt/gennety/.env`,
so `REMATCH_FEATURE_ENABLED` defaulted to `false`; the startup log correctly
showed **no** "Rematch refund retry" cron (it registers only when the flag is
on) while the new "Venue-change refund retry" and "Data retention" crons did
appear.

Post-deploy verified: `Bot @gennetybot started`, all crons registered,
`:3100`/`:3101` listening, `/v1/ping` ok, admin `401`, **all 11 Mini App pages
`200`**, zero `P2022` / `FATAL` / unhandled rejections, and the PM2 restart
count moved exactly 28 → 29 (no crash loop). The status-timer heartbeat's
`permanentFailures: 2` is the known pre-existing "chat not found" for two
unreachable Telegram rows, not a regression.

**Deployed 2026-07-25 (later) — phone-based account login (`d1ad29f`).**
Code-only: no Prisma schema change, no env change, no flag change. A verified
phone number now resolves to the existing account instead of dead-ending on
"this number is already linked to another account" (PRODUCT_SPEC §1.1,
`services/account-linking.ts`), which is what unblocks a user who verified on
the iOS rail and then opened the bot, or who re-created their Telegram account.
Preflight green locally: **166 bot / 13 webapp / 13 shared test files (2156 /
127 / 202 tests)**, both typechecks clean, `pnpm build` clean, tree level with
`origin/main`. (One pre-existing lint error in `apps/webapp/src/referral.ts:277`
is unrelated and was left alone.)

Ran Deploy Full Server Code → `db:drift-check` (**OK**, nothing to push) →
`pm2 restart`, then Deploy Mini App Only (`apps/webapp` changed: a `completed`
account now routes straight to the done screen). The rsync dry-run listed only
two stale `apps/video/build` artifacts as deletions. Post-deploy verified:
`Bot @gennetybot started`, all 14 crons registered, `:3100`/`:3101` listening,
`/v1/ping` ok, admin `401`, all 11 Mini App pages `200`, no `P2022` / unhandled
rejections, and the PM2 restart count held at 25 (no crash loop).

**Deployed 2026-07-25 — full catch-up release + dev↔prod isolation fix.**
Prod was 85 commits behind (146 files); it had no referral/promo code at all.
Preflight was green locally (`typecheck` clean, **164 test files / 2127 tests
passed**, `openapi:lint` valid, tree clean and level with `origin/main`).
Deployed with Deploy Full Server Code → additive `db:push` → `db:drift-check`
→ `pm2 restart`, then Deploy Mini App. The schema step was verified additive
twice before running: the prod↔local `schema.prisma` diff showed no column
removals, and `prisma migrate diff --script` produced **zero DROP statements**
(6 new columns — `matches.proposal_deadline_nudge_sent_at`,
`matches.synergy_reason_b`, `users.promo_redeemed_at`,
`users.referral_counted_at`, `users.referral_invitee_premium_at`,
`users.referral_verified_count` — plus the `promo_codes` /
`promo_redemptions` tables). Post-deploy: `Bot @gennetybot started`, all 14
crons registered, `:3100`/`:3101` listening, `/v1/ping` ok, admin `401`, all
11 Mini App pages `200`, **zero new `P2022`** (the 113 in the historical log
all predate earlier pushes).

Flag changes in this deploy (`/opt/gennety/.env`, backed up first):

| Key | Before | After | Why |
|---|---|---|---|
| `VENUE_INTENT_V2_ROLLOUT_PERCENT` | `10` | `100` | Founder decision — full live after the 2026-07-25 dev E2E ran the two-step concierge end-to-end. **Note this skips the staged 10→50→100 / 48h-per-step guard documented in the Venue Intent V2 rollout section**; acceptable here only because prod had 0 matches at the time. Roll back to `10` on any hard-constraint violation or fake/closed assignment. |
| `VENUE_INTENT_V2_SHADOW_PERCENT` | `100` | `0` | Redundant once live is 100% (dev parity). |
| `TYPE_PREF_FLOOR` | `1.0` | `0.7` | `V_type` now actually re-ranks instead of shadow no-op. Safe for the existing cohort: `typePreferenceMultiplier` returns `1` when the seeker has no radar signal or the candidate has no overlapping appearance tags. |
| `PROMO_FEATURE_ENABLED` | (unset) | `true` | Inert until a code exists — create with `pnpm promo:create`. |
| `REFERRAL_FEATURE_ENABLED` | (unset) | `false` | **Set explicitly, not left to the default.** The referral program is unfinished (founder decision 2026-07-25): its code ships with this release but every surface is gated — menu row, hub, `/v1/referral/*`, `/v1/me/referral*`, the onboarding wow screen, and the verification-pipeline reward all check the flag. Verified live: `/v1/referral/state` → `404`, `features.referral` → `false`. Flip to `true` to launch. |
| `PREMIUM_PRICE_USD_DISPLAY` | `$10` | `$9.99` | Clears the stale-value note from the 2026-07-21 deploy. |
| `PUBLIC_CORS_ORIGIN` | `*` | `https://dating-calendar.gennety.com,https://gennety.com,https://www.gennety.com` | Removes the wildcard warning. Verified: Mini App origin gets `access-control-allow-origin`, a foreign origin gets none, and native clients (no `Origin` header) are unaffected. |
| `EXPO_ACCESS_TOKEN` | `` (empty) | removed | Expo rail retired 2026-07-18; the process no longer reads it. |

**⚠️ rsync `--delete` footgun — the exclude list in Deploy Full Server Code was
widened.** The old list excluded only `.env`, `.env.local`, `.env.test`, so a
deploy silently deleted every `/opt/gennety/.env.bak.*` (the documented env
rollback path) **and `/opt/gennety/keys/`**. That is not hypothetical: the APNs
`.p8` key at `APNS_KEY_PATH=/opt/gennety/keys/AuthKey_JTLFAQ8RM2.p8` **is gone
from the droplet** (a full-filesystem `find / -name '*.p8'` returns nothing), so
native-iOS push and Live Activities are dead until the key is re-uploaded from
Apple Developer → Certificates → Keys. No user impact today (no iOS client has
shipped). The exclude list is now `.env*`, `keys/`, and the local tooling dirs;
always dry-run with `--itemize-changes | grep '^\*deleting'` before a real sync.
The 6 deletions in this run were all intended (4 obsolete `welcome-gift`
кружки dropped by commit `d068ccd`, which kept `ru.mp4` only, plus two
`apps/video/build` artifacts).

**Curated venue catalog: nothing to push.** Prod (972 active = 448 base +
90 premium `ua:kyiv` + 434 legacy `city_key NULL` rows the runtime dedupes by
`placeId`) is a superset of dev (537), with equal-or-better facet coverage
(338 vs 337 base, 87 vs 87 premium).

**Deployed 2026-07-23 — dev↔prod schema-drift reconciliation + 2026-07-22 code
release.** The prod DB was a day behind the code: additive schema from
venue-intent-v2 (`matches.venue_*` + the `venue_selection_logs` table +
`curated_venues` enrichment, `8181bfb`), Type Radar (`profiles.type_radar_*`/
`appearance_tags` + `match_score_logs.score_type`, `6cbd996`), and
`subscription_ledger.note` (`b8b2975`) was missing, and the DB still carried the
dead `web_registration_links` table (6 rows) + `WebRegistrationPurpose` enum
(removed from code 2026-07-19). Reconciled with one
`prisma db push --accept-data-loss` (Variant B: +32 columns, +`venue_selection_logs`
+ indexes, dropping only the two dead objects; a full `SELECT *` logical backup of
all 24 tables was taken first via `scripts/dump-prod-backup.mjs`). Then Deploy Full
Server Code (rsync → build → `pnpm db:drift-check` gate → `pm2 restart`) and Deploy
Mini App (`deploy-webapp.sh`). Verified: `db:drift-check` OK on the droplet, bot
online with admin `:3100` + public `:3101` listening, `/v1/ping` healthy, zero new
P2022, all Mini App pages `200`. No feature flags changed. The new
`pnpm db:drift-check` preflight guard (`8fa57cb`) is now the mandatory gate in
Deploy Full Server Code below.

Prior full deploy: 2026-07-21 (**Gennety Premium launch**:
recurring Telegram Stars + StoreKit subscription, venue-change premium tier.
`PREMIUM_FEATURE_ENABLED=true` + `PREMIUM_STARS=500` / `PREMIUM_PRICE_USD_DISPLAY=$10`
/ `PREMIUM_APPSTORE_PRODUCT_ID=premium_monthly` added; Mini App redeployed
(`premium.html` + reworked `venue-change.html`); Kyiv premium catalog imported
(70 premium venues, 14/domain × 5 domains); `features.premium: true` live,
`/v1/premium/state` → 401 (mounted+on). **Schema applied additively via
`prisma db execute`, NOT `db:push`:** the prod DB still carries the obsolete
`web_registration_links` table (6 rows) + `WebRegistrationPurpose` enum from the
2026-07-19 web-registration removal, so a plain `db:push` demands
`--accept-data-loss` to drop them. To keep the Premium launch additive-only, the
five premium ALTER/CREATE statements (`users.premium_*`, `curated_venues.tier`,
`matches.venue_change_tier`, `subscription_ledger`) were generated with
`prisma migrate diff` and run via `prisma db execute`, filtering out the two
DROP statements. **Follow-up (separate, founder-approved):** run
`prisma db push --accept-data-loss` to drop the dead `web_registration_links`
table + enum once you're comfortable — no code reads them (PRODUCT_SPEC §1.1).
Prior full deploys: 2026-07-18 (iOS Stage 0 backend slice:
`/v1/app/config`, phone rail `/v1/auth/phone/*` (Gateway/Twilio creds not yet
set → clean 503), direct APNs transport with the live `.p8` key at
`/opt/gennety/keys/AuthKey_JTLFAQ8RM2.p8` (sandbox probe returned
`BadDeviceToken` = provider auth verified), additive `db:push` of
`phone_otps` + `live_activity_tokens`, and the advisory-lock P2010 hotfix —
see the Prisma gotcha below). Prior full deploys: 2026-07-17 (security/i18n
+ `ALLOW_SANDBOX_PERSONA=true`; PM2 command changed to the explicit tsx
binary path — see the PM2 gotcha in Production Inventory), 2026-07-15,
2026-07-13.

**Prisma raw-SQL gotcha (2026-07-18):** `pg_advisory_xact_lock(...)` returns
`void`, and Prisma 6.19+ throws P2010 ("Failed to deserialize column of type
'void'") when it is run through `$queryRawUnsafe`. Use `$executeRawUnsafe`
for lock/side-effect statements — it skips result deserialization. This bit
the phone rail's first live probe and was latent in the email-OTP path.

This file is the production runbook for the DigitalOcean deployment. It
contains the real hostnames, paths, service names, and deploy commands. Raw
secret values are intentionally not duplicated here: keep them only in the
gitignored env files and provider dashboards listed below.

## Production Inventory

| Item | Value |
|---|---|
| Droplet | DigitalOcean droplet `Gennety-Dating` |
| Public IP | `167.172.178.229` |
| SSH user | `root` |
| SSH key on this Mac | `~/.ssh/id_rsa` |
| Local repo | `/Users/pro/Desktop/Gennety Dating` |
| GitHub remote | `https://github.com/Gennety-Dating/Gennety-Dating-Backend.git` |
| Production code path | `/opt/gennety` |
| Production env file | `/opt/gennety/.env` |
| Mini App static path | `/var/www/dating-app` |
| Caddy config | `/etc/caddy/Caddyfile` |
| PM2 process | `gennety-bot` |
| PM2 cwd | `/opt/gennety` |
| PM2 command | `cd /opt/gennety && ./apps/bot/node_modules/.bin/tsx apps/bot/src/index.ts` |
| PM2 startup service | `pm2-root.service` |

**PM2 command gotcha (2026-07-17):** the process must launch tsx via the
explicit workspace binary (`./apps/bot/node_modules/.bin/tsx`), NOT `npx tsx`.
`tsx` is a devDependency of `apps/bot` only; after the 2026-07-16 lockfile
change, `pnpm install` no longer hoists a root `node_modules/.bin/tsx`, so
`npx tsx` from `/opt/gennety` hits `tsx: not found` and PM2 crash-loops
(observed live on the 2026-07-17 deploy). Keep the cwd at `/opt/gennety` —
`.env` resolution is file-relative and unaffected, but stay consistent.

## Autonomous Deploy Rule

When asked to deploy, use this file as the canonical source and proceed without
asking for hostnames, paths, service names, Caddy routes, env-file locations, or
credential locations. Pick the deploy path from the user's wording:

- "deploy everything", "full deploy", "deploy server", or backend/code changes:
  use **Deploy Full Server Code**.
- "deploy Mini App", "deploy webapp", "calendar", or frontend-only changes:
  use **Deploy Mini App Only**.
- "env", "token", "secret", "port", or config-only changes:
  use **Deploy Env-Only Changes**.
- Prisma schema changes: run the schema step in **Deploy Full Server Code**.

Only stop to ask when access is blocked, required secrets are missing from the
documented locations, or the requested action is destructive beyond the rollback
steps documented here.

Production runtime versions verified on the droplet:

- Node.js `v20.20.2`
- pnpm `10.33.0`
- npm `10.8.2`
- PM2 `6.0.14`
- Caddy `2.6.2`

## Required Production System Dependency

Profile photo/video validation launches `ffmpeg` and `ffprobe` as operating
system processes. They are not JavaScript packages, so `pnpm install` does not
install them. The Ubuntu/Debian package named `ffmpeg` provides both commands.

Install it once on the current droplet, and repeat this step for every
replacement/rebuilt production host:

```sh
ssh root@167.172.178.229 '
  if ! command -v ffmpeg >/dev/null || ! command -v ffprobe >/dev/null; then
    apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get install -y ffmpeg
  fi
  ffmpeg -version | head -n 1
  ffprobe -version | head -n 1
'
```

The long local Homebrew build on Intel macOS is not the expected production
path. Ubuntu normally installs a prebuilt `apt` package. Never set
`PROFILE_MEDIA_VALIDATION_ENABLED=true` until both production version checks
succeed.

## Dev ↔ Prod Isolation

Production is the controlled environment with real users; local dev is for
testing. Nothing may flow between them. Audited 2026-07-25 — current state:

| Resource | Dev | Prod | Isolated? |
|---|---|---|---|
| Postgres | local Docker `localhost:5434/gennety_dev` (`pnpm dev:db:up`) | Supabase `aws-0-eu-west-1.pooler…/postgres` | ✅ separate servers |
| Telegram bot | `@gennetytestbot` (token `8627…`) | `@gennetybot` (token `8707…`) | ✅ separate tokens — mandatory, long polling delivers each update to exactly one consumer |
| Supabase Storage | `selfies-dev` / `profile-photos-dev` / `chat-attachments-dev` | `selfies` / `profile-photos` / `chat-attachments` | ✅ since 2026-07-25 (same project, separate buckets) |
| OpenAI / Resend / AWS / Places | shared keys | shared keys | ⚪ stateless — no cross-contamination |
| Founder ops bot | shared `FOUNDER_BOT_TOKEN` + chat, feed OFF | same token/chat, feed ON | ✅ since 2026-07-25 — see below |
| Identity liveness | shared AWS creds; sessions are per-request | same | ✅ since 2026-07-26 — AWS Face Liveness sessions carry no shared server-side config and no webhook, so dev and prod cannot reach each other (this row used to be Persona's ⚠️) |

**Fixed 2026-07-25 — founder-feed leak (dev registrations in the real ops
DM).** There is only ONE founder bot and ONE founder chat, and `.env.local`
carried `FOUNDER_NOTIFY_ENABLED=true` with the same `FOUNDER_BOT_TOKEN` /
`FOUNDER_TELEGRAM_ID` as prod, so local test accounts were announced to the
founder exactly like real users. Confirmed: the dev DB has 2 users with
`founderNotifiedAt` set (2026-07-25 11:42 / 12:12) — both fired from
`@gennetytestbot`. Two locks now: `.env.local` (+ `.env.local.example`) sets
`FOUNDER_NOTIFY_ENABLED=false`, and `services/founder-notify.ts` hard-suppresses
the feed whenever `NODE_ENV=development` (the value `scripts/dev-bot.mjs` sets;
prod leaves `NODE_ENV` unset, and ONLY an explicit `development` mutes the
feed, so a missing value can never silence production). Everything reaching the
founder DM is therefore prod-only: new activations, freeze/delete snapshots,
weekly-match reports, scheduled-date cards, and ops alerts.

**Fixed 2026-07-25 — Supabase Storage leak.** `.env.local` overrides
`BOT_TOKEN` and `DATABASE_URL` but used to leave `SUPABASE_*` to `.env` (the
prod-like copy), so the dev bot wrote Persona selfies, mobile profile photos,
and chat images straight into the **production** buckets. Confirmed: dev user
ids `5607aa76…` / `1a357d89…` had objects in prod `selfies`. `.env.local` now
pins `SUPABASE_SELFIE_BUCKET=selfies-dev`, `SUPABASE_PHOTO_BUCKET=
profile-photos-dev`, `SUPABASE_CHAT_BUCKET=chat-attachments-dev`
(`.env.local.example` carries the same block). The URL and service key stay
shared, so a stronger isolation would be a second Supabase project for dev.

**Known residue — orphaned dev objects in the prod `selfies` bucket.** 6 of
its 8 user-id prefixes belong to no prod user row (`6efffed1…`, `5a61bdad…`,
`5607aa76…`, `4ce48f96…`, `29ed79a8…`, `1a357d89…`); only `d9731286…` and
`2a899ad8…` are real prod selfies. Deleting the six is a destructive prod
storage operation — do it deliberately, not as part of a deploy.

**Resolved 2026-07-26 — the Persona webhook cross-talk is gone.** Dev and prod
used to share one Persona template whose webhook target pointed at prod, so a
**dev** verification fired a webhook at **production** (it no-op'd on an unknown
reference-id, but it polluted the prod error log, and the dev bot never received
a webhook at all). AWS Face Liveness has no webhook and no shared template: each
session is created and read within one request, by whichever process created it.
Dev and prod share only the stateless AWS credentials, so a dev check is
invisible to prod. Billing is shared — a dev liveness check costs the same
$0.015 as a real one, which is worth remembering during test loops.

**Never** point local code at prod: keep `.env.local` present (deleting it
makes the local process load `.env`, i.e. the **production** bot token and
database), and never rsync `.env.local` to the droplet.

## Credentials And Secrets

Do not paste raw tokens, passwords, private keys, or database URLs into this
file. This repo explicitly forbids committing secrets. The deployment still has
all credential locations documented here:

| Credential | Where to get it |
|---|---|
| SSH private key | Local machine: `~/.ssh/id_rsa` |
| Production bot/env secrets | Droplet: `/opt/gennety/.env` |
| Local production env copy | Local repo: `.env` |
| Local dev overrides | Local repo: `.env.local` |
| DigitalOcean access | DigitalOcean dashboard for droplet `Gennety-Dating` |
| DNS | Hostinger DNS for `gennety.com` |
| Telegram production bot | BotFather entry for `@gennetybot`; token is `BOT_TOKEN` |
| Telegram dev bot | BotFather entry for `@gennetytestbot`; token is in `.env.local` |
| Supabase Postgres/storage | Supabase dashboard; URL/key values are in `.env` / `/opt/gennety/.env` |
| OpenAI | OpenAI dashboard; key is `OPENAI_API_KEY` |
| Resend | Resend dashboard; key is `RESEND_API_KEY` |
| AWS Face Liveness | Same IAM user as Rekognition (`gennety-bot-rekognition`) plus the `GennetyLivenessClient` role — see "Verification production gate" |
| AWS Rekognition | AWS IAM user `gennety-bot-rekognition` |
| Google Places | Google Cloud API key `PLACES_API_KEY` |
| APNs push (native iOS) | Apple Developer → Certificates → Keys: `.p8` APNs Auth Key (`APNS_KEY_PATH` on the droplet) + Key ID + Team ID |
| Twilio Verify (primary phone rail) | Twilio console; `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_VERIFY_SERVICE_SID` |
| Telegram Gateway (optional secondary) | gateway.telegram.org (login with the founder's Telegram); token is `TELEGRAM_GATEWAY_TOKEN` |

SSH connect:

```sh
ssh root@167.172.178.229
```

SSH connect with explicit key:

```sh
ssh -i ~/.ssh/id_rsa root@167.172.178.229
```

List configured production env keys without printing values:

```sh
ssh root@167.172.178.229 'cut -d= -f1 /opt/gennety/.env'
```

Edit production env:

```sh
ssh root@167.172.178.229
cd /opt/gennety
cp .env ".env.bak.$(date +%Y%m%d-%H%M%S)"
nano .env
pm2 restart gennety-bot --update-env
pm2 save
```

Important: production and local development must never share `BOT_TOKEN`.
Telegram long polling sends each update to only one consumer, so a local
process using the production token can steal updates from production.

## Production Endpoints

| Endpoint | Target | Purpose |
|---|---|---|
| `https://dating-api.gennety.com` | Caddy -> `localhost:3101` | Public `/v1/*` API for the mobile app and the Telegram Mini Apps |
| `https://api-admin.gennety.com` | Caddy -> `localhost:3100` | Admin analytics API, `ADMIN_API_KEY` bearer auth |
| `https://dating-calendar.gennety.com` | `/var/www/dating-app` | Telegram Mini App static bundles |
| `@gennetybot` | PM2 process `gennety-bot` | Production Telegram bot, long polling |

There is no identity-provider webhook any more: Face Liveness verdicts are read
server-to-server inside the client's `/event` request (the session expires 3
minutes after it is minted). `/v1/webhooks/persona` was removed — Persona's
dashboard webhook can be deleted on their side.

Known Caddy config:

```caddyfile
api-admin.gennety.com {
    reverse_proxy localhost:3100
}

dating-api.gennety.com {
    reverse_proxy /v1/* localhost:3101
}

dating-calendar.gennety.com {
    root * /var/www/dating-app
    file_server
    encode gzip zstd
    try_files {path} /index.html

    header {
        Strict-Transport-Security "max-age=31536000; includeSubDomains"
        X-Content-Type-Options "nosniff"
        Referrer-Policy "strict-origin-when-cross-origin"
        -Server
    }

    @assets path *.js *.css *.svg *.png *.woff2
    header @assets Cache-Control "public, max-age=31536000, immutable"
    header /index.html Cache-Control "no-cache"
}
```

## Preflight Before Deploy

Run from the local repo:

```sh
cd "/Users/pro/Desktop/Gennety Dating"
git status --short
pnpm install
pnpm test
pnpm build
pnpm security:secrets
pnpm security:audit
```

`pnpm security:audit` is a **mandatory** preflight step (added 2026-07-26). It
existed as a script long before it was in this runbook, and the gap is exactly
how a CRITICAL `fast-xml-parser` advisory reached the shipped Mini App bundle —
the package rides in via `@aws-amplify/ui-react-liveness`, so a client-side CVE
was invisible to any server-side check. Fix transitive advisories with an entry
in the root `pnpm.overrides` block (already used for seven packages) rather than
waiting on the upstream dependency. **Never pin an override BELOW the patched
version** — `postcss` was held at `8.5.10` while the fix was `8.5.18`, so the
override itself was the vulnerability.

Identity and profile-media validation preflight:

```sh
ffmpeg -version
ffprobe -version
# The process must refuse to boot unless all of these are production-ready:
grep -E '^(MANDATORY_VERIFICATION_ENABLED|FACE_LIVENESS_ENABLED|LIVENESS_STS_ROLE_ARN|FACE_MATCH_PROVIDER|PROFILE_MEDIA_VALIDATION_ENABLED)=' .env
```

These local checks do not prove that the production droplet has the package.
Run the server-side installation/check in **Required Production System
Dependency** during the production rollout.

Verify the three narrow Rekognition actions and run consenting/synthetic QA
media before deployment. Production must have
`MANDATORY_VERIFICATION_ENABLED=true`, `FACE_LIVENESS_ENABLED=true`, a
configured `LIVENESS_STS_ROLE_ARN`, `FACE_MATCH_PROVIDER=rekognition`, and
`PROFILE_MEDIA_VALIDATION_ENABLED=true`. The process now fails closed before
starting if any trust boundary is weakened. An identity-provider outage is not
rolled back by disabling verification; pause new onboarding or roll back code
while keeping existing verified users safe.

For narrow code changes, file-scoped tests are acceptable before the full build:

```sh
pnpm vitest run path/to/file.test.ts
pnpm tsc --noEmit --project apps/bot/tsconfig.json
```

Check production is reachable before changing it:

```sh
ssh root@167.172.178.229 'pm2 status'
curl -s https://dating-api.gennety.com/v1/ping
curl -sI https://dating-calendar.gennety.com
curl -sI https://dating-calendar.gennety.com/onboarding.html
curl -sI https://dating-calendar.gennety.com/verification.html
curl -sI https://dating-calendar.gennety.com/ticket.html
curl -sI https://dating-calendar.gennety.com/tickets.html
curl -sI https://dating-calendar.gennety.com/venue-change.html
curl -sI https://api-admin.gennety.com
```

Expected smoke results:

- `dating-api.gennety.com/v1/ping` returns JSON with `"ok": true`.
- `dating-calendar.gennety.com` returns HTTP `200`.
- `dating-calendar.gennety.com/onboarding.html` returns HTTP `200`.
- `dating-calendar.gennety.com/verification.html` returns HTTP `200`.
- `dating-calendar.gennety.com/ticket.html` returns HTTP `200`.
- `dating-calendar.gennety.com/venue-change.html` returns HTTP `200`.
- `api-admin.gennety.com` returns HTTP `401` without bearer auth.

## Deploy Full Server Code

The droplet path `/opt/gennety` is not a git checkout. Deploy by syncing the
local working tree to the server while preserving remote env files.

From the local repo:

```sh
cd "/Users/pro/Desktop/Gennety Dating"

```sh
# ALWAYS dry-run first. Every line must be a deletion you intend.
rsync -az --delete --dry-run --itemize-changes \
  --exclude '.git/' --exclude 'node_modules/' --exclude 'dist/' --exclude 'tmp/' \
  --exclude '.env*' --exclude 'keys/' \
  --exclude '.claude/' --exclude '.agents/' --exclude '.codex/' --exclude '.gstack/' \
  ./ root@167.172.178.229:/opt/gennety/ | grep '^\*deleting'
```

Then the real sync (identical flags, minus `--dry-run`):

```sh
rsync -az --delete \
  --exclude '.git/' \
  --exclude 'node_modules/' \
  --exclude 'dist/' \
  --exclude 'tmp/' \
  --exclude '.env*' \
  --exclude 'keys/' \
  --exclude '.claude/' \
  --exclude '.agents/' \
  --exclude '.codex/' \
  --exclude '.gstack/' \
  ./ root@167.172.178.229:/opt/gennety/
```

**`.env*` and `keys/` are not optional excludes.** `.env*` (not just `.env`)
covers the `.env.bak.*` snapshots that Rollback depends on. `keys/` holds
server-only Apple secrets (`APNS_KEY_PATH`, `APPSTORE_KEY_PATH`) that exist
nowhere in the repo — the narrower pre-2026-07-25 list already destroyed the
APNs `.p8` once.

Then install, validate, and restart on the droplet:

```sh
ssh root@167.172.178.229
cd /opt/gennety

# Required once per production host. Safe to keep in the deploy checklist:
# installation is skipped when both commands already exist.
if ! command -v ffmpeg >/dev/null || ! command -v ffprobe >/dev/null; then
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y ffmpeg
fi
ffmpeg -version | head -n 1
ffprobe -version | head -n 1

pnpm install --frozen-lockfile
pnpm --filter @gennety/db db:generate
pnpm build
```

If `packages/db/prisma/schema.prisma` changed, update the production database
schema before restarting the bot. The Prisma CLI runs inside `packages/db` and
does **not** read the root `/opt/gennety/.env`, so `DATABASE_URL` must be passed
in explicitly — without it `db:push` fails with `P1012: Environment variable not
found: DATABASE_URL`:

```sh
cp .env ".env.bak.$(date +%Y%m%d-%H%M%S)"
export DATABASE_URL="$(sed -n 's/^DATABASE_URL=//p' .env | tail -1 | tr -d '"')"
pnpm --filter @gennety/db db:push
```

There is no Prisma migrations directory in this repo at the moment, so the
current workflow is Prisma `db:push`. Before risky schema changes, take a
Supabase backup from the Supabase dashboard. The droplet currently does not
have `pg_dump` installed.

Prisma refuses to add a `@unique` column without `--accept-data-loss`, even when
the column is brand new (it cannot know the column will be all-`NULL`). Before
reaching for that flag, confirm the change is genuinely additive. The
authoritative gate is `pnpm db:drift-check` (it introspects the live prod DB
rather than diffing schema files); to SEE which DROPs `--accept-data-loss` would
run, dump the plan with `prisma migrate diff --from-schema-datasource
prisma/schema.prisma --to-schema-datamodel prisma/schema.prisma --script` (URL
read from env, never `--from-url`, which would leak the password into `ps` and
pnpm's failure echo) and confirm every DROP is one you intend. The older manual
pair below still works as a cross-check — the deploy is only safe if **both** hold:

```sh
# 1. No column/model removals in the schema diff (empty output = additive only):
diff -u <(ssh root@167.172.178.229 'cat /opt/gennety/packages/db/prisma/schema.prisma') \
        packages/db/prisma/schema.prisma | grep '^-' | grep -v '^---' | grep -vE '^-\s*(///)?\s*$'
# 2. The new unique columns do not yet exist in the *public* schema (Supabase's
#    auth.users has its own `phone` column — always filter on table_schema).
```

Then run `pnpm --filter @gennety/db db:push --accept-data-loss`.

**Schema drift is a real failure mode here.** A production DB missing a column
the code reads throws `P2022` as an *unhandled rejection*, which kills the
process — an unnoticed drift shows up as a PM2 restart loop, not as a clean
error. If `pm2 status` shows a climbing restart count, check
`grep P2022 /root/.pm2/logs/gennety-bot-error.log` before anything else; a
`db:push` is the fix.

**Mandatory drift gate before restart.** Whether or not you think the schema
changed, confirm the production DB now matches the code schema — this turns the
silent P2022 crash-loop above into a clean pre-restart stop:

```sh
export DATABASE_URL="$(sed -n 's/^DATABASE_URL=//p' .env | tail -1 | tr -d '"')"
pnpm db:drift-check   # exit 0 = match (safe); exit 2 = DRIFT → run db:push, re-check
```

Restart after the code and any required schema update are both in place:

```sh
pm2 restart gennety-bot --update-env
pm2 save
```

## Deploy Mini App Only

Use the existing script:

```sh
cd "/Users/pro/Desktop/Gennety Dating"
./scripts/deploy-webapp.sh
curl -sI https://dating-calendar.gennety.com
curl -sI https://dating-calendar.gennety.com/onboarding.html
curl -sI https://dating-calendar.gennety.com/verification.html
curl -sI https://dating-calendar.gennety.com/ticket.html
curl -sI https://dating-calendar.gennety.com/tickets.html
curl -sI https://dating-calendar.gennety.com/venue-change.html
```

The script builds `apps/webapp` with Vite and rsyncs:

```text
apps/webapp/dist/ -> root@167.172.178.229:/var/www/dating-app/
```

Vite is configured for multiple entries (`vite.config.ts`), so the same rsync
deploys the Mini Apps together — `index.html` (calendar), `feedback.html`
(post-date feedback), `location.html` (venue handoff), `onboarding.html`
(full-screen Telegram onboarding), `verification.html` (AWS Face Liveness
Embedded SDK KYC flow), `ticket.html` (Date Ticket, feature-flagged
premium post-accept gate), `tickets.html` (ticket store / wallet,
feature-flagged pre-purchase bundles), and `venue-change.html` (feature-flagged
female-exclusive venue swap). Caddy's `try_files {path} /index.html` resolves
direct hits like `/feedback.html` and `/onboarding.html` before the SPA
fallback.

The liveness flow needs one one-time provider-side setup step (it doesn't
affect rsync output, but skipping it breaks the Mini App):
1. **BotFather** `/setdomain` → `dating-calendar.gennety.com` for
   `@gennetybot`. Without this, the Mini App can't request camera
   permissions inside the Telegram WebView.

Note the detector fetches its TF.js wasm backend and Blazeface model from
public CDNs by default. If a client network can't reach them, self-host both
from `/var/www/dating-app` and set `config.binaryPath` / `config.faceModelUrl`
in `apps/webapp/src/liveness-detector.tsx`.

The webapp production build bakes in:

```text
VITE_API_BASE_URL=https://dating-api.gennety.com
```

## Deploy Env-Only Changes

```sh
ssh root@167.172.178.229
cd /opt/gennety
cp .env ".env.bak.$(date +%Y%m%d-%H%M%S)"
nano .env
pm2 restart gennety-bot --update-env
pm2 save
pm2 logs gennety-bot --lines 80 --nostream
curl -s https://dating-api.gennety.com/v1/ping
```

### Production flag state last observed (2026-07-13)

**Update 2026-07-23 — remaining dark features enabled in safe shadow mode
(founder-approved, env-only + PM2 restart).** The two features that were still
off (Type Radar, Venue Intent V2) were switched on in their *designed* launch
posture — enabled but not yet influencing matching — NOT flipped to full live:
- `TYPE_RADAR_ENABLED=true` with `TYPE_PREF_FLOOR=1.0` — the "choose your type"
  onboarding step + answer collection go live; the `V_type` multiplier stays a
  no-op (shadow) until predictiveness is validated over 3–4 batches, per
  TYPE_RADAR_PRODUCT_SPEC. Verified live: `GET /v1/radar/deck` now returns `401`
  (auth-gated) instead of `404`.
- `VENUE_INTENT_V2_ENABLED=true` with `VENUE_INTENT_V2_SHADOW_PERCENT=100` /
  `VENUE_INTENT_V2_ROLLOUT_PERCENT=0` — the new two-step concierge selector
  computes + writes its append-only `venue_selection_logs` for 100% of pairs
  but real matches still schedule via the existing path (live 0%), exactly the
  documented "shadow ≥7 days / 30 pairs before advancing live" rollout.

**Superseded 2026-07-25.** Both were advanced to their live posture in the
catch-up deploy: `TYPE_PREF_FLOOR=0.7` (the `V_type` multiplier now re-ranks)
and `VENUE_INTENT_V2_ROLLOUT_PERCENT=100` / `SHADOW_PERCENT=0`. See the
2026-07-25 block at the top of this file, including the note that the venue
rollout skipped the staged 10→50→100 guard. `PROMO_FEATURE_ENABLED=true` was
added at the same time; `REFERRAL_FEATURE_ENABLED=false` is set explicitly
because the referral program is unfinished. **Superseded 2026-07-26 for
identity:** Persona and its `ALLOW_SANDBOX_PERSONA` override are gone; the
provider is AWS Face Liveness and the sandbox-vs-real-KYC question no longer
exists (see the block at the top of this file). No schema work remains.

Every product feature is now **on** in `/opt/gennety/.env`: tickets + Telegram
Stars, Registration v2's phone track, the fact collector (which is what actually
feeds the matching engine's vibe axes), Elo vision seed, pre-date coordination,
venue change v2, the date card, the match card, and Rekognition face-match.

`ENABLE_PERSONA_VERIFICATION` was on, while
`MANDATORY_VERIFICATION_ENABLED` was still off. After the identity trust-gate
hardening that state stopped booting; as of 2026-07-17
`MANDATORY_VERIFICATION_ENABLED=true` was set and production ran the sandbox
Persona key behind an explicit `ALLOW_SANDBOX_PERSONA=true` override. **That
whole arrangement was retired on 2026-07-26** when identity moved to AWS Face
Liveness — see "Verification production gate" below for the current gate.

**Provider credentials, verified by probing each one from the droplet** (a flag
is worthless without its provider):

| Credential | State | Consequence |
|---|---|---|
| Supabase (DB + Storage) | **migrated 2026-07-13 to a new project** — see below | Storage works for the first time (the old project's keys were never filled in — they were the literal `your_supabase_…` placeholders from `.env.example`, so uploads 403'd with `Invalid Compact JWS`). |
| `PERSONA_API_KEY` | **retired 2026-07-26** (was a SANDBOX key, `persona_sand…`, so identity checks were test flows rather than real KYC) | Replaced by AWS Face Liveness on the existing `AWS_*` credentials + the `GennetyLivenessClient` STS role. Verify with `pnpm probe-liveness`; delete the `PERSONA_*` keys from `/opt/gennety/.env`. |
| `PLACES_API_KEY` | ~~empty~~ → **set** (re-verified on the droplet 2026-07-25; a live Place Details probe of a real curated Kyiv venue returned its cover photo) | Google Places: the venue fallback when no curated venue is in range, the Location Mini App autocomplete, the venue-change catalog beyond curated rows, and — since 2026-07-25 — **every** venue photo, including for curated venues (resolved from `placeId` at assignment). Without it the curated base still covers Kyiv/Kharkiv/Odesa, so scheduling degrades to gradient-only cards rather than dying. |
| `EXPO_ACCESS_TOKEN` | retired 2026-07-18 (Expo rail removed; native push is direct APNs via `APNS_*`) | Can be deleted from `/opt/gennety/.env`; the process no longer reads it. |

Re-probe any credential from the droplet before trusting a flag flip; the probes
are cheap and each one of these was wrong in a different way.

### Supabase project migration (2026-07-13)

Production moved to a **new Supabase project** because the credentials for the
old one were lost. Current project ref: **`ophztqjrabwemkqwidkq`**
(`eu-west-1`); the old one was `junbjqkdhdjrpennczib` (`eu-north-1`), and it is
left **untouched and intact** as the rollback path — restoring it is a matter of
putting the old `DATABASE_URL` / `SUPABASE_*` values back from an `.env.bak.*`
and restarting.

The migration was cheap because the data was tiny (14 MB) and the schema is
code. If it ever has to be repeated:

1. Create the project, then set `DATABASE_URL`, `SUPABASE_URL`,
   `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY` in `/opt/gennety/.env`.
   `SUPABASE_URL` is always `https://<project-ref>.supabase.co` — the ref is in
   the DB connection string's username **and** inside the JWT keys, so it never
   has to be looked up in the dashboard.
2. `pnpm --filter @gennety/db db:push` (with `DATABASE_URL` exported — see the
   schema section above). This creates every table **and** the `vector`
   extension, since the Prisma datasource declares `extensions = [vector]`.
   The functional `matches_pair_canonical_idx` is created by the bot at boot.
3. Copy the data with a Prisma script, users first (everything else FKs to
   them), then `profiles` / `onboarding_progress` / `no_match_notices` /
   `bot_sessions` / `system_knowledge` / `curated_venues`. `Profile.embedding`
   is `Unsupported("vector(1536)")` and cannot be copied through the Prisma
   client — set `embeddingDirty = true` on the copied profiles instead and let
   the `embedding-refresh` cron rebuild the vectors from OpenAI.
4. Create the three **private** buckets: `selfies`, `profile-photos`,
   `chat-attachments`.
5. Restart, then prove it: row counts match, `/v1/ping` is `ok`, and a probe
   upload into `SUPABASE_SELFIE_BUCKET` returns 200 (that upload is step 1 of
   `verification-pipeline.ts` and is exactly what used to fail).

### Verification production gate

**Provider: AWS Rekognition Face Liveness (migrated off Persona 2026-07-26).**
The migration's whole point was ending the sandbox era: production had been
running `ALLOW_SANDBOX_PERSONA=true` since 2026-07-17, i.e. Persona TEST flows
rather than real KYC, because a live Persona key costs a fixed ~$250/mo
regardless of volume. Face Liveness is ~$0.015 per check with no monthly floor
(so a paused ad campaign costs nothing), and our Persona template only ever
used selfie-liveness — no document checks — so nothing was lost functionally.

There is **no sandbox/production key split to police any more**, and therefore
no override to remove. `identityTrustConfigurationErrors` requires
`FACE_LIVENESS_ENABLED=true`, real `AWS_ACCESS_KEY_ID` /
`AWS_SECRET_ACCESS_KEY`, and `LIVENESS_STS_ROLE_ARN`, alongside the unchanged
`MANDATORY_VERIFICATION_ENABLED=true`, `FACE_MATCH_PROVIDER=rekognition` and
`PROFILE_MEDIA_VALIDATION_ENABLED=true`. A production-like process refuses to
start unless all of them hold — the credential check matters because
flag-on-but-unconfigured would render a verification CTA that opens a Mini App
with no session to run.

**Historical debt:** `verified` statuses granted during the sandbox window
(2026-07-17 → 2026-07-26) carry no real identity guarantee and were never
retroactively cleared. Audit that cohort before it matters commercially.

**Cost per verified user.** One liveness check ≈ **$0.015** (first 500k/mo,
us-east-1 list price; eu-central-1 may differ slightly) plus the existing
`CompareFaces` calls — one per profile photo, ≈ $0.001 each, so 4–10 photos add
≈ $0.004–0.010. A verified user therefore costs roughly **$0.02–0.03**, and a
retry costs another $0.015. At 1,000 registrations/month that is ~$25 versus
Persona's $250 floor.

**⚠️ Region: Face Liveness runs in `eu-west-1`, not `eu-central-1`.**
`FACE_LIVENESS_REGION` (default `eu-west-1`) is deliberately separate from
`AWS_REGION`, which stays `eu-central-1` for `CompareFaces` / `DetectFaces` /
moderation. Measured across every EU region on 2026-07-26, **`eu-west-1`
(Ireland) is the only one that serves Face Liveness** for this account —
`eu-central-1` and `eu-west-2` refuse it, and the rest have no Rekognition
endpoint at all. This is also where our Supabase project lives, so the
reference selfie never leaves that region.

**The trap that cost us a debugging session:** a region that does not serve Face
Liveness answers `CreateFaceLivenessSession` with an `AccessDeniedException`
carrying an **empty message** — indistinguishable from an IAM denial, and
nothing like the `UnknownOperationException` you would expect. If the probe
fails, rule out the region before touching IAM: `sts:AssumeRole` lives in the
same policy as the Rekognition permissions, so if step 2 of the probe succeeds
the policy is live and the region is your problem.

**Required AWS setup** (account `147010141827`; IAM is global, so no region
applies to these two steps). Both console-side:

1. Add to the `gennety-bot-rekognition` user policy:
   `rekognition:CreateFaceLivenessSession`,
   `rekognition:GetFaceLivenessSessionResults` (Resource `*`), and
   `sts:AssumeRole` on
   `arn:aws:iam::147010141827:role/GennetyLivenessClient`.
2. Create role **`GennetyLivenessClient`** — trust policy: Principal =
   `arn:aws:iam::147010141827:user/gennety-bot-rekognition`, Action
   `sts:AssumeRole`. Permission policy: `rekognition:StartFaceLivenessSession`
   on `*` and nothing else. This is the grant a user's browser/phone briefly
   holds (15 min, the AssumeRole floor) to sign its own video stream;
   Rekognition supports no resource-level ARN for that action, so the narrow
   action list plus the short TTL is the containment. The backend re-asserts
   the same ceiling as an inline session policy, so widening the role later
   does not silently widen what a client gets.

Verify all three permissions without a camera or a billed check:

```sh
pnpm probe-liveness   # CreateSession → AssumeRole → GetSessionResults
```

An unused session is not billed as a check and expires on its own after 3
minutes, so the probe is free and safe to re-run.

**BotFather `/setdomain` must include `dating-calendar.gennety.com`** — the
detector needs camera permission inside the Telegram WebView. (The Persona
"Allowed origins" dashboard step is gone with the provider.)

Matching admits only verified users and the persisted pre-flip skip cohort. The
AI vision Elo seed runs inside the verification pipeline, so live verification
also restores meaningful league calibration for new users.

Required/high-impact env keys:

- Telegram: `BOT_TOKEN`, `BOT_USERNAME`, `WEBAPP_URL`,
  `WEBAPP_FEEDBACK_URL` (optional — defaults to `${WEBAPP_URL}/feedback.html`,
  which Caddy already serves from the same `/var/www/dating-app` root),
  `CUSTOM_EMOJI_MENU_ID`, `CUSTOM_EMOJI_ACCEPT_ID`,
  `CUSTOM_EMOJI_DECLINE_ID`, `CUSTOM_EMOJI_VERIFIED_ID` (optional —
  animated checkmark next to a verified partner in the match-pitch caption;
  empty falls back to a static `✓` glyph),
  `CUSTOM_EMOJI_DATE_ID` (optional — animated icon on the conditional
  primary-styled "My Date" main-menu row; empty → the 💫 label still renders,
  just without an `icon_custom_emoji_id`), `MESSAGE_EFFECT_MATCH_ID`,
  `MESSAGE_EFFECT_FEEDBACK_ID` (optional — Bot API 7.6 effect on the T+24 h
  feedback DM; empty = no effect),
  `MESSAGE_EFFECT_MUTUAL_ID` (falling-hearts effect on the mutual-match reveal
  — the Date Ticket card, and only that card; **defaults to ❤️
  `5159385139981059251`, so no env change is needed** — set it empty to
  disable, or to another effect id to change the animation. Code-only
  otherwise: no schema, no flag, no Mini App change.)
- **My Date hub + scheduled-date banner (always-on — no feature flag).** The
  conditional "My Date" main-menu row and its hub (PRODUCT_SPEC §2.1) plus the
  status-banner countdown-to-your-date are always active; they degrade to the
  parts each sub-feature enables (the cached/re-rendered date card respects
  `DATE_CARD_FEATURE_ENABLED`, Change venue `VENUE_CHANGE_FEATURE_ENABLED`, Enter
  chat `COORDINATION_FEATURE_ENABLED`). **Requires `db:push` of the additive
  `matches.date_card_file_id_a` / `date_card_file_id_b` columns first**
  (non-destructive; they cache the rendered date-card `file_id` for instant hub
  re-open). No new system dependency; the only optional env is
  `CUSTOM_EMOJI_DATE_ID` above.
- Database/storage: `DATABASE_URL`, `SUPABASE_URL`,
  `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_SELFIE_BUCKET`,
  `SUPABASE_PHOTO_BUCKET`, `SUPABASE_CHAT_BUCKET`
- AI/email/onboarding: `OPENAI_API_KEY`, `RESEND_API_KEY`, `SMTP_FROM`,
  `OTP_LOG_TO_CONSOLE`, `ONBOARDING_FACT_COLLECTOR_ENABLED` (default `false`;
  enable only after schema push and backfill verification)
  - **AI-memory export kill switch:** `AI_MEMORY_EXPORT_ENABLED` (default
    **`true`** — `config.ts` reads `!== "false"`, so the Magic Prompt branch
    stays on unless explicitly disabled). Set `AI_MEMORY_EXPORT_ENABLED=false`
    to hide the whole feature (PRODUCT_SPEC §1.3): the onboarding Mini App skips
    the AI-memory choice screen, `POST /v1/telegram-onboarding/ai-memory` 404s,
    and onboarding runs vibe → photos with the deterministic fallback summary —
    i.e. every user takes the existing "declined" path. **No schema change, no
    backfill, no Mini App rebuild required to flip it** (the bundle reads the
    server's `aiMemoryExportEnabled` from `/state`; redeploying the Mini App is
    only needed to pick up the client-side skip for *cached* older bundles,
    which are already safe because the server 404s the write). Toggle live with
    `pm2 restart gennety-bot --update-env`. Rollback = remove the line (or set
    `true`); `User.aiMemoryExportPreference` is never rewritten by the flag, so
    the branch returns exactly as it was. In-flight effects when turning it
    off: users parked on the choice screen / Magic Prompt step advance straight
    to photos, and a paste already buffered is dropped instead of saved.
    **Current state (2026-07-30): OFF in production AND off in dev.** Prod has
    carried `AI_MEMORY_EXPORT_ENABLED=false` in `/opt/gennety/.env` since
    2026-07-26; `.env.local` (+ `.env.local.example`) now sets the same, because
    the default is `true` and a dev box without the line walks an onboarding
    flow no production user can reach — choice screen → Magic Prompt paste →
    an AI-derived `psychologicalSummary` feeding `V_explicit`. Nothing in the
    production pool is AI-memory-derived: audited 2026-07-30, **zero** users
    have ever held `aiMemoryExportPreference = accepted` (15 rows: 14
    `undecided`, 1 `declined`), so the five populated `psychologicalSummary`
    values are all the deterministic vibe fallback. **Rollback trap:** four env
    backups predating 2026-07-26 (`.env.bak.20260713`…`20260725`) have no such
    line, so restoring one silently turns the feature back on.
  - **Vibe onboarding questions (no flag of their own).** The two §1.3 vibe
    questions (`friday_vibe` / `vibe_focus`) and their matching signal live in
    the collector, so they are active only when
    `ONBOARDING_FACT_COLLECTOR_ENABLED=true`. Requires `db:push` of the new
    `Profile.friday_vibe_text` / `vibe_focus_text` / `energy_axis` /
    `orientation_axis` / `social_role` / `anchor_tags` / `vibe_extracted_at`
    columns first (additive, non-destructive; missing columns → P2022
    crash-loop). No new system dependency — extraction reuses `OPENAI_API_KEY`.
    The matching weight re-split (`V_explicit` 0.65 / `V_research` 0.35) and the
    new vibe quadrant factor are code-only and need no env; `V_league` (and
    `MALE_REACH_ELO`) are unchanged.
- OpenAI model selection (single source of truth, `apps/bot/src/models.ts`):
  every chat/vision call site resolves its model from the `MODELS` map, so an
  OpenAI generation retirement is a one-line change (or a live env override).
  Current defaults are the GPT-5.6 tiers (migrated off the retiring GPT-5.4/4.1
  families 2026-07): `MODELS.vision`/`MODELS.agent` → **`gpt-5.6-terra`**
  (attractiveness Elo seed + conversational/user-facing generation),
  `MODELS.visionFast`/`MODELS.fast` → **`gpt-5.6-luna`** (simple photo checks +
  cheap classification / short worker DMs). Four optional overrides —
  `OPENAI_MODEL_VISION`, `OPENAI_MODEL_VISION_FAST`, `OPENAI_MODEL_AGENT`,
  `OPENAI_MODEL_FAST` — let ops pin/roll a model live via
  `pm2 restart gennety-bot --update-env`, no redeploy and no schema change.
  Embeddings (`text-embedding-3-small`), Whisper, and moderation are
  deliberately NOT routed through `MODELS` (changing the embedding model forces
  a full re-embed). Note: switching `MODELS.vision` shifts the Elo seed's score
  distribution for newly verified users; `Profile.eloSeedDetails.model` records
  the model per seed so the drift is auditable.
- Chat progress streams: no production env flag. Do not set or reintroduce a
  `RICH_THINKING_ENABLED` live toggle — the rich path is hard-coded per call site
  (`rich: true`), never a global default, because Telegram draft/rich-draft APIs
  are treated by clients as generated AI replies and can reserve scroll space
  below the preview, and that tradeoff must be chosen deliberately per flow.
  Two categories of stream exist:
  - **Thinking-status beats** (`runStatusSequence`, the "agent is analysing /
    working" lines): AI-memory analysis, liveness verify check, verification
    soft-skip, profile-video upload check, onboarding photo-burst check
    (`photoReviewSteps`), concierge venue selection, date-card
    render + share, plus the Profiler batch boundary, the Profiler in-batch
    questions (PRODUCT_SPEC §Phase 1b), and the periodic profile-survey
    "thinking" pause (PRODUCT_SPEC §1.3). These all call with `rich: true` so
    they render as the native `<tg-thinking>` shimmer + AI Actions `<tg-emoji>`
    draft, degrading to the classic `sendMessage` + `editMessageText` stream when
    a client can't render rich drafts. No env toggle gates this — nothing to
    configure at deploy time.
  - **Content streams** (`streamDraftsToChat(..., { rich: true })` →
    `streamRichDraftsToChat`): the match pitch, no-match notice, and ice-breaker
    DMs also stream via the native rich AI-compose draft path (lead "thinking"
    chunk = `<tg-thinking>` shimmer), but their **final persisted message is a
    plain `sendMessage`, never a rich message** — it must stay a normal text
    message, and the proposal-countdown worker live-edits the pitch's final
    message via `editMessageText`. Same degrade-to-classic fallback. Also no env
    toggle.
  The AI Actions `<tg-emoji>` glyphs are the baked `AI_EMOJI` ids in
  `services/ai-emoji.ts` (no env).
- Admin API: `ADMIN_API_KEY`, `ADMIN_PORT`, `ADMIN_DASHBOARD_ORIGIN`
- Public API: `JWT_SECRET`, `JWT_ACCESS_TTL`, `JWT_REFRESH_TTL`,
  `PUBLIC_PORT`, `PUBLIC_CORS_ORIGIN` (comma-separated browser origins allowed to
  call `/v1/*`; empty now **denies** cross-origin instead of wildcarding — native
  mobile clients send no `Origin` header and are unaffected. Prefer listing the
  concrete browser origins — the Mini App host `https://dating-calendar.gennety.com`
  plus any web signup site — over `*`, which still works but logs a warning.)
- Native iOS app: `IOS_MIN_SUPPORTED_APP_VERSION` (optional, default empty →
  no forced update). Served pre-auth by `GET /v1/app/config` as
  `minSupportedIosVersion`; set e.g. `1.2.0` only to retire a broken/insecure
  old build — every older client blocks behind an "update the app" screen.
  Toggled live with `pm2 restart gennety-bot --update-env`; no schema change.
- Native-app phone rail (`/v1/auth/phone/*`, shares the Registration v2
  `PHONE_AUTH_ENABLED` gate — 404 while off): `TWILIO_ACCOUNT_SID` /
  `TWILIO_AUTH_TOKEN` / `TWILIO_VERIFY_SERVICE_SID` (**primary rail** —
  Twilio Verify, founder decision 2026-07-18; no phone number purchase
  needed) and optionally `TELEGRAM_GATEWAY_TOKEN` (secondary —
  gateway.telegram.org; empty → Gateway never used).
  `PHONE_CODE_PRIMARY_PROVIDER` (default `twilio`; set `telegram` to flip
  the order). Either rail alone works; with neither set the endpoints
  answer 503 and the Telegram one-tap flow is unaffected. Twilio gotchas:
  a trial account only texts numbers verified in the console, and Geo
  Permissions must allow the target countries.
  **Requires `db:push` of the additive `phone_otps` table first**
  (non-destructive). Anti-SMS-pumping: per-phone+IP express limits plus a
  durable per-phone cooldown (60 s) and daily cap (6/day) in the table.
- StoreKit 2 tickets (native iOS; rides `TICKET_FEATURE_ENABLED`):
  `APPSTORE_KEY_PATH` (App Store Connect → Users and Access → Integrations →
  In-App Purchase key `.p8`, scp'd next to the APNs key), `APPSTORE_KEY_ID`,
  `APPSTORE_ISSUER_ID` (same Integrations page), `APPSTORE_BUNDLE_ID`
  (default `com.gennety.ios`), `APPSTORE_ENVIRONMENT` (`sandbox` default →
  TestFlight/dev purchases; `production` for App Store builds),
  `APPSTORE_TICKET_PRODUCTS` (default `ticket_1:1,ticket_3:3,ticket_6:6`).
  Server Notifications V2 URL to set in App Store Connect:
  `https://dating-api.gennety.com/v1/webhooks/appstore`. Without the keys
  the purchase endpoint answers 503; no schema change (rides the unique
  `ticket_ledger.external_payment_id` already deployed for Stars).
- Push (native iOS, direct APNs — the Expo rail was retired 2026-07-18):
  `APNS_KEY_PATH` (path to the `.p8` APNs Auth Key on the droplet, e.g.
  `/opt/gennety/keys/AuthKey_XXXXXX.p8` — NOT committed; scp it manually),
  `APNS_KEY_ID` (the key's 10-char id), `APNS_TEAM_ID` (Apple Developer
  Team ID), `APNS_BUNDLE_ID` (default `com.gennety.ios`),
  `APNS_ENVIRONMENT` (`sandbox` default — dev/TestFlight builds use the
  sandbox host; set `production` for App Store builds). With any of the
  first three empty, pushes are dropped with a warning and everything else
  works. **Requires `db:push` of the additive `live_activity_tokens` table
  first** (non-destructive). `EXPO_ACCESS_TOKEN` is retired and can be
  removed from `/opt/gennety/.env`.
- Liveness (AWS Rekognition Face Liveness — replaced Persona 2026-07-26):
  `FACE_LIVENESS_ENABLED` (must be `true` in production — startup fails
  closed), `FACE_LIVENESS_MIN_CONFIDENCE` (default `0.8`; below it the check is
  RETRYABLE, never `rejected`), `LIVENESS_STS_ROLE_ARN`
  (`arn:aws:iam::147010141827:role/GennetyLivenessClient`),
  `LIVENESS_CREDENTIALS_TTL_SECONDS` (default/floor `900`). Reuses the existing
  `AWS_*` credentials and region. **Since 2026-07-26 requires `db:push` of the
  additive `users.pending_liveness_session_id` column** (nullable,
  non-destructive) — it binds a liveness session to the user who minted it, and
  the `/event` handler reads it unconditionally, so a DB missing it throws
  `P2022` on every completed check. Push the schema BEFORE restarting. **Removed with the provider:**
  `ENABLE_PERSONA_VERIFICATION`, `PERSONA_TEMPLATE_ID`,
  `PERSONA_ENVIRONMENT_ID`, `PERSONA_API_KEY`, `PERSONA_WEBHOOK_SECRET`,
  `PERSONA_HOSTED_URL_BASE`, `ALLOW_SANDBOX_PERSONA` — delete these from
  `/opt/gennety/.env`; the process no longer reads them.
- Face match: `FACE_MATCH_PROVIDER`, `FACE_MATCH_THRESHOLD_VERIFY`
  (default 0.85), `FACE_MATCH_THRESHOLD_REVIEW` (default 0.75),
  `FACE_MATCH_MIN_VERIFIED_PHOTOS` (default 1), `AWS_REGION`,
  `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `ELO_VISION_SEED_ENABLED`
- Profile media validation: `PROFILE_MEDIA_VALIDATION_ENABLED` (default **`true`**
  — `config.ts` reads `!== "false"`, so strict upload-time validation is on
  unless it is explicitly disabled; this doc previously claimed `false`),
  `PROFILE_MEDIA_VALIDATION_FAIL_OPEN` (must remain `false` in
  production), `PROFILE_VIDEO_MAX_ANALYSIS_FRAMES` (default `24`), and
  `PROFILE_VIDEO_VALIDATION_TIMEOUT_MS` (default `60000`). Requires local
  `ffmpeg` + `ffprobe`, OpenAI, and an IAM policy containing exactly
  `rekognition:CompareFaces`, `rekognition:DetectFaces`, and
  `rekognition:DetectModerationLabels`. No new AWS access key is required.
- App-wide theme (light/dark, **always-on — no feature flag**): users pick a
  theme in onboarding (after the city gate; default `dark`) or change it later
  via Settings → Change theme. Every Mini App renders it (shared `theme.css`
  tokens + a pre-paint boot snippet in each `*.html`, which also honors a
  `?theme=` deep-link) and both server PNG cards (date + match) render in the
  recipient's `User.theme`. **Requires `db:push` of the additive `users.theme`
  (enum `Theme`, default `dark`) / `theme_chosen_at` columns first** (additive,
  non-destructive), and redeploy the Mini App bundle so all screens ship the
  theme system. No new env, no new system dependency.
- Registration v2 (phone rail feature-flagged; identity gate mandatory):
  `PHONE_AUTH_ENABLED` (default `false`) turns on the sign-up fork + the
  general-track phone rail (Mini App PathGate/PhoneGate, `POST
  /v1/telegram-onboarding/track`, the trusted `message.contact` handler);
  `MANDATORY_VERIFICATION_ENABLED=true` removes the verification
  Skip button, refuses legacy skip callbacks, and adds the verification-stall
  re-engagement sweep. Production-like startup refuses any other verification
  setting. **Requires `db:push` of the additive `users.phone`
  (unique) / `phone_verified_at` / `registration_track` columns first**
  (non-destructive; deploy code + push schema BEFORE flipping either flag —
  the new columns are read unconditionally by matching and `/state`). Also
  redeploy the Mini App bundle (`onboarding.html`) so the fork screens exist.
  The student ticket bonus (+2 at uni-email verification, `student_bonus`
  ledger reason) rides `TICKET_FEATURE_ENABLED` — no flag of its own, no
  schema beyond the wallet tables. `PHONE_AUTH_ENABLED` can be rolled back to
  the email-only flow; mandatory identity verification must remain enabled.
- Matching: `MALE_REACH_ELO` (default `36` Elo ≈ 6 attractiveness points) —
  one-directional "reach up" allowance that lets a less-attractive man match a
  somewhat more-attractive woman without the `V_league` penalty (hetero pairs
  only; matching down and same-gender pairs unaffected). Raise for a stronger
  male lift, lower toward `0` to disable. No restart side effects beyond the
  standard `pm2 restart`.
- Proposal reply countdown + deadline nudge (always-on, no feature flag,
  Telegram-only): the pitch's live reply-deadline **button** re-render
  (`workers/proposal-countdown.ts`, `editMessageReplyMarkup`) and the new
  match-nudge **deadline heads-up** (`workers/match-nudge.ts`, one DM ~2 h
  before the 24 h TTL to still-undecided sides). Both run on the existing crons
  (`PROPOSAL_COUNTDOWN_CRON_SCHEDULE`, `MATCH_NUDGE_CRON_SCHEDULE`) — no new
  schedule, no new env. `PROPOSAL_COUNTDOWN_CRON_SCHEDULE` defaults to
  `* * * * *` since 2026-07-25 (was `*/5 * * * *`) so the button label moves
  every minute; `editMessageReplyMarkup` raises no notification, and the load
  is one edit per undecided side per minute only during a 24 h window (paced at
  25 edits/s, single-flight via `guardedTick`). Set the env override back to
  `*/5 * * * *` to restore the old cadence without a redeploy. **Requires `db:push` of the additive
  `matches.proposal_deadline_nudge_sent_at` column first** (nullable,
  non-destructive; a DB missing it throws `P2022` on the nudge sweep). Mobile
  clients render their own countdown from the public API and are unaffected.
- Per-side synergy rationale (always-on, no feature flag, bug fix 2026-07-25):
  the match-reveal synergy reason is now stored + rendered **per side in that
  side's own language** instead of pair-wide (it used to splice side A's
  sentence into side B's otherwise-localized pitch header, and into the mobile
  `synergyReason`). **Requires `db:push` of the additive
  `matches.synergy_reason_b` column first** (nullable, non-destructive; a DB
  missing it throws `P2022` on every pitch dispatch AND on
  `GET /v1/matches/current`, so push the schema BEFORE restarting). Existing
  rows keep their single reason and fall back to it for side B. No env, no new
  system dependency; `/v1/*` contract unchanged (same `synergyReason` field,
  correct language).
- Matching — stated age-band preference: `AGE_RANGE_PREF_FLOOR` (default `0.6`)
  and `AGE_RANGE_PREF_DECAY_PER_YEAR` (default `0.1`). The soft `V_agePref`
  multiplier dampens (never excludes) a candidate whose actual age is outside
  the seeker's stated preferred-**partner** age band (`Profile.ageRangeMin/Max`,
  edited via the **Search Prefs → Partner age range** menu / the menu-agent
  `update_age_range` tool / mobile `PATCH /v1/me`). Neutral (1.0) for users who
  never set a band, so it's inert for most users. Set
  `AGE_RANGE_PREF_FLOOR=1.0` to disable entirely; lower the floor / raise the
  decay for a stronger preference. **Requires `db:push` of the additive
  `match_score_logs.score_age_pref` column first** (non-destructive, defaults to
  `1`). No new system dependency; toggled live with `pm2 restart gennety-bot
  --update-env`.
- Venue picker: `PLACES_API_KEY`
- Anti-spam / LLM token budget (always-on, in-memory; no schema, no new dep):
  the Telegram bot meters text/voice per user (flood + daily token budget) in
  `bot-rate-limit.ts`, and the JWT LLM routers (`/v1/chat`, `/v1/assistant`,
  `/v1/onboarding`) gain `usageGuard`. Tokens are counted from the exact
  `usage.total_tokens` OpenAI returns, attributed via an `AsyncLocalStorage`
  context that `services/openai-fetch.ts` reads (call sites only swapped their
  default `fetch` for `openaiFetch`). Env (all optional, safe defaults):
  `BOT_RATE_LIMIT_ENABLED` (default `true`), `BOT_FLOOD_BURST_LIMIT` (`40`) /
  `BOT_FLOOD_BURST_WINDOW_MS` (`60000`), `BOT_FLOOD_SUSTAINED_LIMIT` (`300`) /
  `BOT_FLOOD_SUSTAINED_WINDOW_MS` (`3600000`), `LLM_TOKEN_BUDGET_ENABLED`
  (default `true`), `LLM_USER_DAILY_TOKEN_BUDGET` (`180000`),
  `LLM_GLOBAL_HOURLY_TOKEN_BUDGET` (`0` = global breaker off). Thresholds are
  deliberately loose so normal fast use never trips them. Counters are in-memory
  (single PM2 process) and reset on restart — no `db:push`, toggled live with
  `pm2 restart gennety-bot --update-env`. Whisper (audio) stays under the
  existing per-request voice limiter, not the token budget.
- Date Ticket (feature-flagged monetization): `TICKET_FEATURE_ENABLED`
  (default `false` — leave off until launch), `TICKET_PAYMENT_MODE`
  (`mock` default / `stripe`), `TICKET_PRICE_CENTS` (default `699`),
  `TICKET_PAYMENT_WINDOW_HOURS` (default `24`).
  - **Real payments = Telegram Stars (XTR), the production rail.**
    `TICKET_STARS_ENABLED` (default `false`) makes the date gate **and** the
    store pay natively in Telegram Stars via `WebApp.openInvoice` +
    `pre_checkout_query` + `successful_payment` (`handlers/payments.ts`). Needs
    **no** merchant account / provider token (empty provider token +
    `currency: "XTR"`); Stars→TON withdrawal is a Telegram-side setting.
    `TICKET_BUNDLE_STARS` (default `1:350,3:830,6:1350`, `<count>:<stars>` pairs)
    sets the per-bundle Star price; the gate derives its per-scope price from the
    1-ticket entry (self/partner 1×, both 2×). **Requires the additive unique
    `ticket_ledger.external_payment_id` column to be deployed first** (the
    Telegram charge id — exactly-once store credit and durable date-gate
    refunds; non-destructive). Gate payments are recorded before settlement;
    the hourly expiry worker retries `gate_refund_pending` rows and opens free
    scheduling only after Telegram confirms the refund. When Stars
    is on, the mock `/{ticket,tickets/store}/{intent,confirm}` routes 404 (PAY-1)
    so Stars is the sole purchase rail; the free wallet "Use a ticket" path is
    unaffected. Redeploy the Mini App bundle (`ticket.html` + `tickets.html`) so
    the ⭐-priced `openInvoice` buttons ship. Rollback: flip
    `TICKET_STARS_ENABLED` back to `false` — the mock returns exactly as before;
    the additive column may stay. Star prices are env-tunable at launch without
    a code change. The famine single-ticket discount is USD-only and is inert on
    Stars purchases.
  - Going live with **Stripe** instead (alternate path) additionally needs
    `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`,
  `STRIPE_WEBHOOK_SECRET` + `TICKET_PAYMENT_MODE=stripe` (see the
  `// TODO: Stripe Production Mode` branches in
  `services/ticket-payment.ts`). Requires `db:push` of the new `Match`
  ticket columns first — including the additive `partner_paid_seen_at` /
  `partner_paid_nudged_at` columns backing the §3.5b goodwill-cover read-receipt
  (the payer's "she saw it ❤️" DM + the guaranteed completion nudge). The
  read-receipt DMs reuse the existing `MESSAGE_EFFECT_TICKET_ID` heart on the
  payer's confirmation; no new env. Redeploy the Mini App bundle (`ticket.html`)
  so his success screen shows the "you covered {name}'s ticket 💛" copy.
  - **Ticket wallet + store (same flag).** `TICKET_FEATURE_ENABLED` also turns
    on the user ticket wallet: onboarding bonuses (6+ photos, profile video),
    the **My Tickets** menu, the store Mini App (`tickets.html`, bundles
    1/3/6), and the "Use a ticket" gate path. `MESSAGE_EFFECT_TICKET_ID`
    (optional — Bot API 7.6 effect on the reward DM; empty = no effect).
    Requires `db:push` of the new `User.ticket_balance`,
    `Profile.photo_bonus_ticket_at` / `video_bonus_ticket_at` columns and the
    new `ticket_ledger` table first, and `tickets.html` deployed with the Mini
    App bundle.
  - **Welcome gift (same flag).** Every new user is gifted 1 free Date Ticket as
    a pre-roll before their first match pitch — an optional founder **video
    note** (кружок) + a gift DM. `MATCH_PREROLL_DELAY_MS` controls the pause
    between a delivered gift pre-roll and the match card reveal (default 2 min).
    `MESSAGE_EFFECT_GIFT_ID` is optional — Bot API 7.6 effect on the gift DM;
    empty = no effect; pick a celebratory id like 🎉/❤️. Video assets are bundled
    at `apps/bot/src/assets/welcome-gift/<gender>-<lang>.mp4` (square video-note
    MP4, ≤60s, e.g. `male-ru.mp4`, `female-en.mp4`); they ride the standard code
    rsync, no ffmpeg needed (the bot just sends a ready
    file). A missing asset for a (gender, language) pair degrades gracefully to
    the gift DM only, so partial coverage is safe — drop in more MP4s over time.
    Idempotent via a `welcome_gift` `ticket_ledger` row (no extra schema beyond
    the wallet columns above).
  - **Famine discount (same flag).** On the 2nd consecutive no-match week
    (tier ≥ 2) the no-match DM grants a one-time **77% discount on a single
    ticket**, valid 30 days, applied to the date gate's `self` scope and the
    store's "1 ticket" bundle (`services/ticket-discount.ts`). Optional env
    overrides `FAMINE_DISCOUNT_PCT` (default `77`) and `FAMINE_DISCOUNT_TTL_DAYS`
    (default `30`). Requires `db:push` of the new
    `User.ticket_discount_pct` / `ticket_discount_granted_at` /
    `ticket_discount_expires_at` / `ticket_discount_consumed_at` columns first
    (additive, non-destructive). No new system dependency; runs inside the
    existing no-match cron + ticket Mini App routes. Inert unless
    `TICKET_FEATURE_ENABLED`.
- Pre-date coordination (feature-flagged): `COORDINATION_FEATURE_ENABLED`
  (default `false` — leave off until launch). When on, the bot offers matched
  users a way to find each other ~1h before the date (share Telegram, request
  partner's, or an anonymous bot-relayed chat). Requires `db:push` of the new
  `User.telegramUsername`, `Match.coord*`/`proxy*` columns, and the
  `proxy_messages` table first. Runs on the existing date-lifecycle
  `setInterval` — no new cron schedule. Variant C (anonymous proxy) is a
  documented, narrow carve-out to the no-in-app-chat invariant
  (PRODUCT_SPEC.md §Core Principles): post-match, time-boxed, text-only,
  fully logged, with an in-line Report button.
- Venue change v2 (feature-flagged, paid): `VENUE_CHANGE_FEATURE_ENABLED`
  (default `false` — leave off until launch) + `VENUE_CHANGE_STARS` (default
  `150`, the flat Telegram Stars price of one settled change). When on, BOTH
  sides' scheduled cards carry a "Change venue" button into the shared likes
  board (3 km catalog, hearts with ~4 s live sync, overlap = agreement —
  calendar mechanics); a settled change costs `VENUE_CHANGE_STARS` paid
  natively in Stars (hetero: the man pays + the female-only express unilateral
  swap; same-sex: the initiator). Decline/lapse NEVER cancels the match — the
  original venue stands. No free text anywhere (the v1 mandatory-comment
  carve-out is gone). Telegram-only. **Requires `db:push` of the additive v2
  `Match` columns first** (`venue_likes_a/b`, `venue_change_photo_url/name`,
  `venue_change_paid_by_id/paid_at`, `venue_change_pay_declined_at`,
  `venue_change_offer_pay_sent_at`, `venue_change_ping_sent_to_a/b_at`,
  `venue_change_express_at` — non-destructive), and redeploy the Mini App
  bundle (`venue-change.html`, fully reworked board UI). Payments ride the
  Stars rails (`venue:<matchId>:<mode>` payload in `handlers/payments.ts`; no
  merchant account — same XTR mechanics as tickets, independent of
  `TICKET_STARS_ENABLED`); a lost parallel-pay race is auto-refunded via
  `refundStarPayment`. The wish-card PNG reuses the date-card satori stack +
  bundled fonts (no new system dependency); Places venue photos stream through
  `GET /v1/venue-change/photo`, so `PLACES_API_KEY` is needed (already required
  for the venue picker). The lapse/express-revert sweep runs on the existing
  date-lifecycle `setInterval`. **Since 2026-07-26 there is also one new hourly
  cron** — `VENUE_CHANGE_REFUND_CRON_SCHEDULE` (default `0 * * * *`, registered
  only when the flag is on) — retrying failed Stars refunds and reversing
  purchases abandoned mid-settle, the twin of `REMATCH_REFUND_CRON_SCHEDULE`.
  **Requires `db:push` of the new additive `venue_change_purchases` table
  first** (non-destructive; the settle path writes to it on every payment, so a
  DB missing it throws `P2022` on the `successful_payment` boundary — push the
  schema BEFORE restarting). Rollback: flip the flag off; the additive
  columns/table may stay.
- Gennety Premium (feature-flagged, recurring subscription, §Premium):
  `PREMIUM_FEATURE_ENABLED` (default `false` — leave off until launch),
  `PREMIUM_STARS` (default `500`, the monthly Telegram Stars price ≈ $10),
  `PREMIUM_PRICE_USD_DISPLAY` (default `$9.99`, display-only — production `.env`
  still carries the launch value `$10`; update it to `$9.99` on the next deploy
  to match the code default), and
  `PREMIUM_APPSTORE_PRODUCT_ID` (default `premium_monthly`, the StoreKit 2
  auto-renewable subscription id — matched by full id or last dot-segment). When
  on, the menu shows a ✨ Gennety Premium row → hub → the Premium Mini App
  (`premium.html`), and the venue-change board shows premium venues locked with a
  subscribe-in-place upsell; a subscriber's venue changes are free. **Standalone
  per-user entitlement** (`services/premium.ts`) — decoupled from venue-change.
  - **Telegram Stars recurring rail.** `POST /v1/premium/stars-invoice` mints a
    `createInvoiceLink` with `subscription_period=2592000` (Telegram supports
    only the 30-day period; empty provider token + `XTR`, no merchant account).
    The `sub:premium` payload is settled by the bot's `successful_payment`
    handler on the first charge AND every auto-renewal, exactly-once via the
    recurring `telegram_payment_charge_id`. Cancellation is native (Telegram →
    Settings → Subscriptions) OR **in-chat via the menu agent** (the user asks to
    cancel → `offer_cancel_premium` tool → a nonce-bound confirm card → Bot API
    `editUserStarSubscription`, `handlers/menu/premium-cancel.ts`); either way the
    entitlement simply lapses at `premiumUntil` (no early revoke, no mid-period
    refund). After a confirmed in-chat cancel the bot asks the churn reason and
    stores it on the `cancelled` `subscription_ledger.note`. Telegram-only.
  - **iOS StoreKit rail (parallel).** `POST /v1/premium/appstore/transaction`
    (JWT) + the existing App Store Server Notifications webhook
    (`/v1/webhooks/appstore`, now routes SUBSCRIBED/DID_RENEW/EXPIRED/REFUND/
    REVOKE for the premium product) reuse the `APPSTORE_*` config already
    deployed for tickets. No new Apple keys.
  - **Premium venues.** Curated venues carry a `tier` (`base`/`premium`); premium
    rows may exceed the ≤ MODERATE price cap and are seeded with
    `pnpm seed-venues:pull --tier=premium` (relaxed price gate; every other
    quality gate stays) → review → `seed-venues:import --apply`. The auto-assign
    concierge picker stays base-only.
  - **In-chat cancellation.** No new env. The menu agent's `offer_cancel_premium`
    tool + `handlers/menu/premium-cancel.ts` handle it; the churn reason lands in
    the additive `subscription_ledger.note` column (see below). Telegram-only —
    App Store subs are guided to iOS Settings, iOS cancels natively via Apple, so
    no `/v1/*` contract change.
  - **Requires `db:push` first** of the additive `users.premium_*` columns, the
    new `subscription_ledger` table (now including the additive nullable
    `subscription_ledger.note` churn-reason column — non-destructive; a DB
    missing it throws `P2022` on an in-chat cancel), `curated_venues.tier`, and
    `matches.venue_change_tier` (all non-destructive; deploy code + push schema
    BEFORE flipping the flag — the new columns are read by the venue board and
    the entitlement service). Redeploy the Mini App bundle (`premium.html` +
    reworked `venue-change.html`). No new system dependency. Rollback: flip
    `PREMIUM_FEATURE_ENABLED` off; the additive columns/table may stay. An
    entitlement already granted stays valid regardless of the flag.
- Referral program (feature-flagged, "Give a date, get a date", see
  `REFERRAL_PRODUCT_SPEC.md`): `REFERRAL_FEATURE_ENABLED` (default `false` —
  leave off until launch). Rides the already-on `TICKET_FEATURE_ENABLED` +
  `PREMIUM_FEATURE_ENABLED` (it pays rewards in Date Tickets AND complimentary
  Premium months). Tunables: `REFERRAL_INVITEE_PREMIUM_MONTHS` (default `1`, the
  invited user's welcome Premium month shown on the onboarding wow screen),
  `REFERRAL_LADDER` (default `1:1:1,3:1:1,5:1:1,10:2:2` =
  `<count>:<ticketsDelta>:<monthsDelta>`, the referrer's milestone ladder —
  cumulative 1/1, 2/2, 3/3, 5/5), and `REFERRAL_DAILY_REWARD_CAP` (default `3`,
  a per-referrer 24h anti-fraud reward-hold). The reward fires at the invited friend's **verification** (the
  anti-fraud gate); the invitee's Premium month is granted at the onboarding
  screen. **Requires `db:push` of the additive `users.referral_verified_count`
  (default 0) / `referral_counted_at` / `referral_invitee_premium_at` columns
  first** (non-destructive; the referrer tally + invitee once-markers). Rewards
  reuse `ticket_ledger` (`referral_milestone`) + `subscription_ledger`
  (`referral`) — no new tables. Also **redeploy the Mini App bundle**
  (`referral.html` ships with the Vite build — the referrer ladder + one-tap
  share). Uses `BOT_USERNAME` (invite deep link) + `PUBLIC_BASE_URL` (the public
  HMAC-signed `GET /v1/referral/card` image Telegram fetches for the shared
  photo) — both already set. The branded share card reuses the date/match-card
  satori stack + bundled fonts (no new system dependency); a render failure
  degrades the share to a rich text article. Runs inline at verification / the
  onboarding screen — no new cron. iOS: `GET/POST /v1/me/referral*` (JWT) +
  `features.referral` in `/v1/app/config`. Rollback: flip the flag off; the
  additive columns may stay. Telegram-first; iOS attribution via a referral code.
- Promo codes (feature-flagged, independent campaign links, see
  `PROMO_CODES_PRODUCT_SPEC.md`): `PROMO_FEATURE_ENABLED` (default `false` — leave
  off until launch). Rides the already-on `TICKET_FEATURE_ENABLED` +
  `PREMIUM_FEATURE_ENABLED`. Grants a NEW user **1 free Date Ticket + 3 months
  Premium** at a richer, distinct onboarding wow screen (new users only,
  first-touch, mutually exclusive with referral). Tunables (all optional):
  `PROMO_DEFAULT_TICKETS` (`1`) / `PROMO_DEFAULT_PREMIUM_MONTHS` (`3`, the
  `promo:create` defaults), `PROMO_ATTRIBUTION_TTL_MIN` (`60`, iOS
  fingerprint-match window), `PROMO_APP_STORE_URL` (the App Store URL the
  `GET /v1/promo/:code` landing bounces iOS visitors to; empty → no redirect),
  and the emergency `PROMO_MANUAL_ENTRY_ENABLED` (`false` — a pre-wired
  manual-entry fallback field, off by product decision). **Requires `db:push` of
  the additive `users.promo_redeemed_at` column + the new `promo_codes` /
  `promo_redemptions` tables first** (non-destructive). Rewards reuse
  `ticket_ledger` (`promo`) + `subscription_ledger` (`promo`). Also **redeploy
  the Mini App bundle** (`onboarding.html` ships the new promo wow screen).
  Create codes with the CLI: `pnpm promo:create --code=SUMMER3M --tickets=1
  --months=3 --max=500 --expires=2026-09-01` (also `promo:disable` /
  `promo:stats` / `promo:list`; writes to the `DATABASE_URL` in scope — run with
  prod env for prod). Telegram uses `t.me/<bot>?start=promo_<CODE>` (reliable);
  iOS is a custom deferred deep link (clipboard + coarse fingerprint via the
  in-memory `services/promo-attribution.ts`, `GET /v1/promo/:code` landing +
  `POST /v1/me/promo/claim-deferred` + `/v1/me/promo/claim`, JWT), **best-effort
  with no manual fallback** — a miss silently loses the gift (flip
  `PROMO_MANUAL_ENTRY_ENABLED` if painful). `features.promo` in `/v1/app/config`;
  iOS client tasks in `~/Desktop/Gennety-iOS/IMPLEMENTATION_PLAN.md`. Runs inline
  at the wow screen — no new cron, no new system dependency. Rollback: flip the
  flag off; the additive columns/tables may stay. Launch: deploy code + push
  schema BEFORE flipping the flag (the new columns are read by onboarding state),
  create at least one code, then set `PROMO_FEATURE_ENABLED=true`.
- Rematch (feature-flagged, paid on-demand engine re-run, PRODUCT_SPEC §3.11 /
  `REMATCH_PRODUCT_SPEC.md`): `REMATCH_FEATURE_ENABLED` (default `false` — leave
  off until launch). When on, a man whom the Thursday batch left unpaired, or
  whose match expired without a date, gets a DM offering one paid re-run of the
  matching engine for himself; the woman it finds never buys and never sees a
  price — she gets an ordinary pitch with gift framing. Telegram-only (Stars is a
  Telegram rail); no `/v1/*` or OpenAPI change. Tunables: `REMATCH_STARS`
  (default `150`), `REMATCH_PRICE_USD_DISPLAY` (`$2.99`, display-only),
  `REMATCH_MAX_PER_WEEK` (`2`), `REMATCH_COOLDOWN_HOURS` (`24`),
  `REMATCH_GIFT_CAP_DAYS` (`7`, protects a candidate from serial gift-pitching),
  `REMATCH_PRE_BATCH_BLACKOUT_HOURS` (`6`, keeps a single-seeker run from taking
  a candidate the globally-optimal Thursday batch needed; `0` disables),
  `REMATCH_FAILED_LOOKBACK_DAYS` (`14`), and `REMATCH_REFUND_CRON_SCHEDULE`
  (`0 * * * *`). **Requires `db:push` of the additive `matches.source` (default
  `'weekly'`) / `matches.rematch_paid_by_id` columns and the new
  `rematch_purchases` table FIRST** (non-destructive, but `matches.source` is
  read unconditionally by the pitch + the admin algorithm route, so a DB missing
  it throws `P2022` on every dispatch — push the schema BEFORE restarting).
  Payments ride the existing Stars rails (`rematch:v1` payload in
  `handlers/payments.ts`; no merchant account, same XTR mechanics as tickets and
  independent of `TICKET_STARS_ENABLED`). The refund-retry cron is registered
  only when the flag is on. No Mini App change, no new system dependency.
  **Pricing note:** 150⭐ follows the ticket rate ($6.99/350⭐ = $0.02/⭐ → ≈$3.00);
  at the more conservative $0.024/⭐ rate documented under `PREMIUM_STARS`, 150⭐
  bills nearer $3.59 — if you want Premium's strict "never under-promise the
  charge" convention, set `REMATCH_STARS=125` or raise the display price (both
  env-only). Rollback: flip the flag off; the additive columns/table may stay.
- Date card (feature-flagged): `DATE_CARD_FEATURE_ENABLED` (default `false` —
  leave off until launch). When on, each side's `scheduled` confirmation is a
  rendered PNG date card (partner photo + venue photo + details) sent
  screenshot/forward-protected, with a Share button that re-sends a copy with
  the partner's face blurred (PRODUCT_SPEC.md §3.7a). Telegram-only in v1.
  Requires `db:push` of the new `Match.venuePhotoUrl` / `venuePhotoName`
  columns first. No new system dependency: rendering uses `satori`,
  `@resvg/resvg-js`, and `@napi-rs/canvas` (prebuilt binaries pulled by
  `pnpm install --frozen-lockfile`, **not** ffmpeg/Chromium), and the bundled
  Roboto + Archivo Black TTFs in `apps/bot/src/assets/fonts/` ride the standard
  code rsync.
  **Venue photos require `PLACES_API_KEY` — no key, no venue photo** (the card
  still renders, on its branded gradient). Since 2026-07-25 Google Places is the
  SINGLE source: the retired `CuratedVenue.photoUrl` fallback is gone, and
  curated venues — the primary assignment source — have their cover resolved
  from their stored `placeId` at assignment time (`fetchPlacePhotoName`, one
  extra Places request per scheduled date; also fires at a §3.7b venue-change
  agreement / express mint). Google's bytes are fetched at render, credited on
  the card, never persisted. (`PLACES_API_KEY` re-verified present on the
  droplet 2026-07-25, and a live probe of a real curated Kyiv venue returned its
  cover photo — superseding the stale "empty" note in the 2026-07-13 flag table
  below.) Runs inline at venue finalization —
  no new cron. Any render failure degrades to the existing plain-text scheduled
  DM, so the flag is safe to toggle live with `pm2 restart gennety-bot
  --update-env`.
- Match card (feature-flagged): `MATCH_CARD_FEATURE_ENABLED` (default `false`).
  When on, the match-pitch photo album is replaced by the rendered collage
  card set (card 1 = photo + name/vibe panel, following cards = one full-bleed
  photo each; PRODUCT_SPEC.md §3.3). Uses the same satori/resvg/canvas stack
  and bundled fonts as the date card plus `apps/bot/src/assets/brand/butterfly-logo.svg`
  and the Unbounded woffs in `assets/fonts/` (all ride the code rsync), and one
  extra OpenAI call per side for the short card copy. Any copy/render/send
  failure falls back to the plain protected media group, so the flag is safe to
  toggle live with `pm2 restart gennety-bot --update-env`. No schema change.
- Type Radar (feature-flagged visual appearance calibration, §Type Radar /
  `TYPE_RADAR_PRODUCT_SPEC.md`): `TYPE_RADAR_ENABLED` (default `false` — the
  whole feature ships dark) + `TYPE_PREF_FLOOR` (default `1.0` = the `V_type`
  match multiplier is a pure no-op even when enabled; launch value ≈ `0.7`,
  the weakest factor — read directly by the match engine, mirroring
  `AGE_RANGE_PREF_*`). When on, the conversational onboarding shows a skippable
  visual "choose your type" step **before** the Magic Prompt (a `web_app` button
  into `radar.html` + an inline Skip); submit/skip resumes the flow. The
  compiled per-set preference vector (`Profile.typePrefTags`) scores a partner's
  `Profile.appearanceTags` — the candidate side is tagged by an **isolated**
  cheap vision pass on the verified branch (separate from the Elo attractiveness
  call, so a tagging regression never perturbs the live Elo seed; no extra call
  while dark). **Requires `db:push` of the additive `Profile.type_radar_answers`
  / `type_pref_tags` / `type_radar_completed_at` / `type_radar_age_band` /
  `appearance_tags` and `match_score_logs.score_type` columns first** (all
  nullable/defaulted, non-destructive). Also **redeploy the Mini App bundle**
  (`radar.html` ships with the Vite build) — the 24 band-A calibration portraits
  live in `apps/webapp/public/radar/a/*.jpg` and ride the webapp rsync. No new
  system dependency (tagging reuses `OPENAI_API_KEY` via the `visionFast`
  model). Rollout is two-stage: (1) `db:push` + deploy code + Mini App with the
  flag OFF (everything inert); (2) flip `TYPE_RADAR_ENABLED=true` to start
  collecting radar answers while `TYPE_PREF_FLOOR=1.0` keeps scoring unchanged
  (shadow); later lower `TYPE_PREF_FLOOR` (e.g. `0.7`) to let `V_type` actually
  re-rank. `WEBAPP_URL` must be a real HTTPS host for the picker button (dev
  without a tunnel degrades to Skip-only). Rollback: flip the flag off; the
  additive columns/images may stay.
- Type Radar "thinking state" (always-on, rides `TYPE_RADAR_ENABLED`):
  `RADAR_THINKING_ENABLED` (default **`true`** — `config.ts` reads
  `!== "false"`). The ~10.7s status sequence played in chat between the radar
  Mini App closing and the next onboarding question
  (`TYPE_RADAR_PRODUCT_SPEC.md` → *Close → "thinking state" → next question*;
  PRODUCT_SPEC §1.3): four scripted beats then a profile counter decelerating
  onto a 160–220 total. **No schema change, no Mini App redeploy, no new
  dependency** — it is bot-side only and reuses the existing
  `runStatusSequence` primitive, so a full server code deploy carries it.
  Localized in all five languages.
  Two things worth knowing before flipping it:
  - It is a **deliberate labor illusion**. Nothing is scanned — the radar
    verdicts are saved before it starts, and matching doesn't run until the
    Thursday batch. Founder-approved (2026-07-27) with the copy as specified.
  - It **holds the user ~10.7s** (plus a 2.2s lead-in that waits out the Mini
    App's own close animation) before their next onboarding question. That is
    real added time in the funnel — watch
    `GET /admin/analytics/onboarding-funnel` for a drop-off bump at the
    AI-memory / photos step after enabling it.

  Set `RADAR_THINKING_ENABLED=false` + `pm2 restart gennety-bot --update-env`
  to drop straight to the next question; nothing else changes. That kill switch
  is the whole rollback.
- Founder notifications (feature-flagged private ops feed): `FOUNDER_NOTIFY_ENABLED`
  — **ON in production since 2026-07-16** (founder bot `@sverkausbot`, chat id set).
  When on, a SEPARATE founder bot DMs the founder four things: (1) each new user's
  full profile + photos on first activation (no AI-memory dump), (2) a tokenized
  weekly-matches report link after the Thursday batch, (3) both date cards + venue
  when a date locks in, (4) the full profile + **phone number** + photos when a
  user freezes or hard-deletes their account (bot Settings→Delete/Freeze and mobile
  `DELETE /v1/me`; the delete path snapshots the row and downloads any photo
  bytes before the storage cleanup + Prisma cascade run). (Item 4 briefly sent
  an anonymous event instead, 2026-07-16 → 2026-07-28, over a since-reverted
  GDPR concern — see PRODUCT_SPEC.md §2.1 and `legal/privacy-policy.md` §12.2.)
  Requires `FOUNDER_BOT_TOKEN` (a bot from BotFather —
  kept distinct from `BOT_TOKEN`; `file_id`s are per-bot so the founder bot uploads
  raw bytes), `FOUNDER_TELEGRAM_ID` (the founder's numeric chat id — they must
  `/start` the founder bot once), and `PUBLIC_BASE_URL` (default
  `https://dating-api.gennety.com`, used to build the report link). **Requires
  `db:push` of the additive `users.founder_notified_at` column and the new
  `founder_reports` table first** (non-destructive; the idempotency marker +
  report snapshots). The report page (`GET /v1/founder/report/:token`) is served
  by the existing public API — no Caddy/DNS change. Photos in the report stream
  through the main bot, so no `PLACES_API_KEY` dependency. Runs inline at
  activation / venue-finalize / the weekly cron — no new cron schedule. The
  founder-facing dashboard "Weekly matches" tab lives in the separate
  `gennety-dating-dashboard` repo and consumes `GET /admin/analytics/weekly-matches`.
  **Since 2026-07-26 also requires `db:push` of the additive nullable
  `founder_reports.expires_at` column** — report links now expire after 90 days
  (the token is the page's sole auth and rides in the URL, so it also sits in
  access logs). A null means never-expires, so links created before the upgrade
  keep working. Rollback: flip the flag off; the additive column/table may stay.
- Optional cron overrides: `MATCH_CRON_SCHEDULE`, `CRON_TIMEZONE`,
  `EXPIRY_CRON_SCHEDULE`, `NO_MATCH_NOTICE_CRON_SCHEDULE`,
  `PROPOSAL_COUNTDOWN_CRON_SCHEDULE`, `RE_ENGAGEMENT_CRON_SCHEDULE`,
  `MATCH_NUDGE_CRON_SCHEDULE`,
  `STATUS_TIMER_CRON_SCHEDULE`, `AUTO_UNSUSPEND_CRON_SCHEDULE`,
  `EMBEDDING_REFRESH_CRON_SCHEDULE`, `SELFIE_RETENTION_CRON_SCHEDULE`,
  `VENUE_REVALIDATION_CRON_SCHEDULE`, `TICKET_EXPIRY_CRON_SCHEDULE`,
  `RETENTION_CRON_SCHEDULE`,
  `REMATCH_REFUND_CRON_SCHEDULE`, `VENUE_CHANGE_REFUND_CRON_SCHEDULE`,
  `PROFILER_CRON_SCHEDULE`, `DATE_LIFECYCLE_TICK_MS`, `DISPATCH_DELAY_MS`,
  `MATCH_PREROLL_DELAY_MS`
- Data retention (always-on, no feature flag, added 2026-07-26):
  `RETENTION_CRON_SCHEDULE` (default `45 3 * * *`, Europe/Kyiv) deletes aged OTP
  challenges (7 d), dead refresh sessions (30 d past unusable), and proxy-chat
  messages (90 d). No schema change, no new env beyond the schedule, no new
  system dependency. **Deletes are irreversible, so verify the backlog before
  the first production run**: check `SELECT count(*) FROM phone_otps WHERE
  created_at < now() - interval '7 days';` (and the same for `email_otps`,
  `user_sessions`, `proxy_messages`) so the first sweep's numbers are expected
  rather than a surprise. Batched at ≤1000 rows per table per tick, so a large
  backlog drains over several nights instead of one long-running transaction.
  **The `user_sessions` window is deliberately tied to `JWT_REFRESH_TTL` (30 d)
  — if you raise that env var, raise `SESSION_RETENTION_MS` with it**, or
  refresh-token reuse detection quietly stops firing for long-lived tokens.
  Rollback: set the schedule far-future (e.g. `0 0 31 2 *`); nothing else reads
  the worker.
- Onboarding funnel analytics (always-on, no feature flag): step-level
  drop-off + hesitation telemetry feeding `GET /admin/analytics/onboarding-funnel`
  and the weekly `GET /admin/analytics/founder-digest` (consumed by the external
  **Hermes** agent — see `HERMES_AGENT_PROMPT.md`). Requires `db:push` of the new
  additive `onboarding_step_events` table first (non-destructive; missing table →
  the collector's best-effort telemetry just logs a warning and onboarding still
  works, but the endpoint returns empty until the table exists). No new env, no
  new system dependency; writes ride the existing onboarding collector.
- Profiler (Phase 1b, always-on): post-onboarding Q&A batches that fuel
  icebreakers + date-planning hints (NOT matching). No feature flag —
  `PROFILER_CRON_SCHEDULE` (default `*/15 * * * *`) only tunes cadence; set it
  far-future to effectively pause. Requires `db:push` of the new
  `profiler_answers` table, `ProfilerPriority` enum, and the
  `Profile.time_zone` / `profiler_*` columns first (additive, non-destructive).
  **2026-07-26 update — requires `db:push` of two more additive
  `profiles` columns before deploying the code**: `profiler_answer_window_until`
  and `profiler_question_message_id` (both nullable; a DB missing them throws
  `P2022` on the first question sent, which surfaces as a PM2 restart loop).
  They bound how long an open question may claim the user's free text
  (PRODUCT_SPEC §Phase 1b), so an unrelated message no longer gets recorded as
  its answer. No new env and no new system dependency; the same release also
  halves the Profiler shimmer, drops its emoji, stops streaming the question
  text, shortens `PROFILER_STALL_TIMEOUT_MS` to 6 h, and expands the question
  bank with situational questions that repeat each drop cycle — all code-only.

Production safety checks:

- `DEV_OTP_BYPASS_TELEGRAM_IDS` must be empty in production; startup refuses
  any non-empty value outside the explicit development runtime.
- Keep `ONBOARDING_FACT_COLLECTOR_ENABLED=false` during the first production
  deploy. Before enabling it: back up PostgreSQL, run
  `pnpm --filter @gennety/db db:push`, run `pnpm onboarding:backfill` and
  inspect aggregate counts, then run `pnpm onboarding:backfill:apply`.
  Enable Development first and complete the two-account E2E. Production
  rollback is the env flag; the additive `onboarding_progress` table may stay.
- `OTP_LOG_TO_CONSOLE` must be `false` or unset in production. It only relaxes
  local identity checks when `NODE_ENV=development`; otherwise startup fails.
- `JWT_SECRET` must contain at least 32 cryptographically random bytes (the
  template uses 64 hex characters), otherwise the public API refuses to start.
  Access tokens are accepted only as HS256 tokens issued by
  `gennety-public-api` for the `gennety-mobile` audience; changing these claims
  is an API migration, not a deploy-time toggle.
- `PUBLIC_PORT` should remain `3101` unless Caddy is changed too.
- `ADMIN_PORT` should remain `3100` unless Caddy is changed too.
- `WEBAPP_URL` should point to `https://dating-calendar.gennety.com`.

## Logs And Operations

PM2:

```sh
ssh root@167.172.178.229 'pm2 status'
ssh root@167.172.178.229 'pm2 describe gennety-bot'
ssh root@167.172.178.229 'pm2 logs gennety-bot --lines 200 --nostream'
ssh root@167.172.178.229 'pm2 monit'
```

PM2 log files:

```text
/root/.pm2/logs/gennety-bot-out.log
/root/.pm2/logs/gennety-bot-error.log
```

Warning: bot error logs can include Telegram context objects. Do not paste raw
logs into public issues or commits without checking for tokens/user data.

Caddy:

```sh
ssh root@167.172.178.229 'systemctl status caddy --no-pager'
ssh root@167.172.178.229 'journalctl -u caddy -n 200 --no-pager'
ssh root@167.172.178.229 'caddy validate --config /etc/caddy/Caddyfile'
ssh root@167.172.178.229 'systemctl reload caddy'
```

PM2 startup:

```sh
ssh root@167.172.178.229 'systemctl status pm2-root --no-pager'
ssh root@167.172.178.229 'pm2 save'
```

Manual bot restart:

```sh
ssh root@167.172.178.229
cd /opt/gennety
pm2 restart gennety-bot --update-env
pm2 logs gennety-bot --lines 100 --nostream
```

If the PM2 process is missing:

```sh
ssh root@167.172.178.229
cd /opt/gennety
pm2 start bash --name gennety-bot -- -c "cd /opt/gennety && ./apps/bot/node_modules/.bin/tsx apps/bot/src/index.ts"
pm2 save
systemctl status pm2-root --no-pager
```

## Database Operations

Generate Prisma client:

```sh
ssh root@167.172.178.229
cd /opt/gennety
pnpm --filter @gennety/db db:generate
```

Push current Prisma schema to production:

```sh
ssh root@167.172.178.229
cd /opt/gennety
pnpm --filter @gennety/db db:push
```

Check Prisma version/config:

```sh
ssh root@167.172.178.229 'pnpm --dir /opt/gennety --filter @gennety/db exec prisma --version'
```

Current production logs showed this schema drift pattern:

```text
Prisma P2022: The column `users.referral_source` does not exist in the current database.
```

If that appears after deploying code that references a new column, run
`pnpm --filter @gennety/db db:push` on the droplet and restart PM2.

## Curated Venue Seeding

The concierge venue picker is curated-first (`curated_venues` table; Google
Places is the fallback). After the `CuratedVenue` schema reaches a DB (via
`db:push`), populate the base with the two-phase seeder. It needs `PLACES_API_KEY`
in env and writes to whichever DB `DATABASE_URL` points at — run it with prod env
to seed production.

```sh
# 1. Fill in scripts/curated-venues.config.json (university domain + centre lat/lng).
# 2. Pull candidates from Google Places under the production quality gate:
pnpm seed-venues:pull
# 3. Hand-edit scripts/curated-venues.candidates.json:
#    flip "approved": true on keepers, tweak "priority" (1 best … 3 ok) + "vibeTags".
# 4. Dry-run, then apply:
pnpm seed-venues:import
pnpm seed-venues:import --apply
```

Re-running `--pull` overwrites the candidates file; `--import --apply` is
idempotent (upsert on domain+Place id, with name/address fallback) so it's safe
to re-run after edits.
The import also deletes rows matching the operator brand blocklist.

For the reviewed Kyiv expansion, refresh and validate the committed approved
catalog before importing:

```sh
pnpm sync-venues:kyiv
pnpm sync-venues:kyiv --apply
pnpm sync-venues:kyiv --check
pnpm seed-venues:import --in=scripts/curated-venues.kyiv.approved.json --apply
```

When the operator hands over a raw list of venue NAMES (no place ids), resolve
and triage it first — `sync-venues:kyiv` needs stable place ids and fails on
anything below the quality gate:

```sh
# 1. Put the names in scripts/curated-venues.kyiv.additions.json
#    ({"name": "...", "tier": "base|premium|alternative"}).
pnpm resolve-venues:kyiv --write          # names -> place ids + review flags
# 2. Read the flags. A `name-mismatch` is Google answering with a DIFFERENT
#    venue — confirm the address, then set "acceptMatch": true, or fix "query".
pnpm merge-venues:kyiv                    # dry run: what is accepted/rejected
pnpm merge-venues:kyiv --apply            # fold into the expansion manifest
#    --promote-expensive re-tiers EXPENSIVE base venues to premium instead of
#    dropping them (an operator decision — off by default).
# 3. Reconcile + re-tag, then import as above.
pnpm sync-venues:kyiv --apply
pnpm backfill-venue-facets --only-missing --apply
```

`backfill-venue-facets --only-missing` matters: `sync-venues:kyiv` rebuilds rows
from Google Places, which knows nothing about Venue Intent V2 facets. It now
carries existing `facetTags`/`hardCapabilities` across a rebuild, but venues
added for the first time have none, and without `hardCapabilities` a row fails
the V2 indoor/outdoor hard filter and never gets picked.

## Caddy Or Domain Changes

Edit and validate:

```sh
ssh root@167.172.178.229
nano /etc/caddy/Caddyfile
caddy fmt --overwrite /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile
systemctl reload caddy
journalctl -u caddy -n 80 --no-pager
```

DNS for `gennety.com` is managed at Hostinger. All Gennety Dating API domains
must stay prefixed with `dating-` or `api-admin`; `api.gennety.com` belongs to
a sibling project and must not be used here.

## Rollback

Code rollback is currently file sync based, not git based on the server.

Fast rollback options:

1. Re-sync a known-good local checkout to `/opt/gennety`.
2. Restore a previous local commit, then run the full server deploy again.
3. If only env changed, restore one of `/opt/gennety/.env.bak.*`, then restart
   PM2.
4. If only Mini App changed, rebuild and rerun `./scripts/deploy-webapp.sh`
   from a known-good local checkout.

Env rollback:

```sh
ssh root@167.172.178.229
cd /opt/gennety
ls -lt .env.bak.*
cp .env.bak.YYYYMMDD-HHMMSS .env
pm2 restart gennety-bot --update-env
pm2 save
```

## Post-Deploy Checklist

```sh
ssh root@167.172.178.229 'pm2 status'
ssh root@167.172.178.229 'pm2 logs gennety-bot --lines 100 --nostream'
curl -s https://dating-api.gennety.com/v1/ping
curl -sI https://dating-calendar.gennety.com
curl -sI https://dating-calendar.gennety.com/onboarding.html
curl -sI https://dating-calendar.gennety.com/verification.html
curl -sI https://dating-calendar.gennety.com/ticket.html
curl -sI https://dating-calendar.gennety.com/tickets.html
curl -sI https://dating-calendar.gennety.com/venue-change.html
curl -sI https://api-admin.gennety.com
```

Then check:

- PM2 `gennety-bot` is `online`.
- Bot log says `Bot @gennetybot started`.
- Bot log says admin API is listening on `:3100` when `ADMIN_API_KEY` is set.
- Bot log says public API is listening on `:3101`.
- Public `/v1/ping` returns `{ "ok": true, ... }`.
- Calendar, onboarding, and verification Mini Apps return HTTP `200`.
- Admin API returns HTTP `401` without bearer auth.
# Venue Intent V2 rollout

This release is additive. Before enabling it, take the standard production DB
backup, deploy code, then run the documented production `db:push`. Do not drop
legacy vibe or venue columns. Backfill curated rows with `city_key` (`ua:kyiv`,
`ua:kharkiv`, `ua:odesa`) via the reviewed venue import inputs; duplicate legacy
domain rows may remain because runtime deduplicates them.

Before live rollout, audit every active `base` curated row used by V2: rating
must be at least 4.0 with at least 30 reviews; commercial/admission categories
must have a provider `price_level` or one operator-confirmed canonical price tag
(`free`, `inexpensive`, `moderate`). Rows without this evidence remain stored
for operator repair and Venue Change, but fail closed for the initial automatic
assignment. No schema migration is required for this policy update.

Start with all three flags at zero/off. Then enable the master flag with shadow
10% and live 0%. Keep shadow for at least seven days and 30 completed pairs.
Advance live 10% → 50% → 100% with at least 48 hours per step. Roll live back to
0 immediately on any hard-constraint violation, fake/closed assignment,
finalisation error regression, or venue-change-rate increase over baseline by
more than five percentage points. Shadow can remain on during rollback.
