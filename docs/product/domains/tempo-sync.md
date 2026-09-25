<!-- WHEN_TO_READ: You are touching life rhythm / Tempo Sync — the Apple Health tags, `/v1/me/rhythm`, V_rhythm in scoring, venue Tier 2, the post-date place, or anything that might read `user_rhythm_profiles`. Read the fence first: `apps/bot/src/services/rhythm/boundary.test.ts`. -->

## Tempo Sync — life rhythm from Apple Health

Decisions: journal 2026-09-24 (variant B, rhythm is a matching factor) and
2026-09-25 (implementation). Ships dark: `TEMPO_SYNC_ENABLED=false` until the
policy in `legal/tempo-sync-draft.md` is published.

### What reaches the server

Only the iOS app can read Apple Health. It reduces 28 days of hourly step counts
(wheelchair pushes included) **on the device** to two tags and sends them with
`PUT /v1/me/rhythm` (`packages/shared/src/life-rhythm.ts` is the contract):

| Tag | Values | Rule (on the device) |
|---|---|---|
| `activity` | calm · moderate · active | median daily steps < 5 000 · 5 000–9 999 · ≥ 10 000 |
| `chronotype` | early · intermediate · late · null | midpoint of the 10–90 % cumulative-steps window, median over weekends (≥ 4) else all days: < 13:30 · 13:30–15:59 · ≥ 16:00; null with < 6 placeable days |

Fewer than 10 days with data → nothing is sent (iOS never says whether access
was denied, so "denied" and "no data" are one state). Sleep, workouts and every
other Health type are not read. A profile not re-synced for 35 days is absent
for every reader and deleted by the nightly retention sweep.

### Where it is used

1. **Matching** — `V_rhythm = 1 + w·(2·sim − 1)` inside `composeScore`, centred
   so connecting Health is not a loss; exactly 1 when either side has no
   profile (every Telegram-only account). `RHYTHM_MATCH_WEIGHT` (default 0,
   max 0.1, planned 0.05). The pair similarity is logged to
   `match_score_logs.rhythm_similarity` at any weight. Not part of
   `allocationFingerprint`.
2. **Venue Tier 2** — reweights the draw INSIDE the 5 % sampling band only
   (`applyVenueDiversity.tier2Weight`); the calmer known side leads; a chip of
   the movement dimension switches that dimension off. Facts come from
   `scripts/enrich-venues-osm.mjs`; unenriched = neutral.
3. **Post-date place** — for a calm lead a café, for an active lead a park,
   ≤ 900 m and open when the date ends; stored without the reason, tied to the
   venue's place id, served as `afterDatePlace`.

### Who never sees it

The partner (no tags, no reasons, neutral copy), OpenAI prompts, the bot's
messages, the founder feed, and per-user admin reads. The only analytics is
`/admin/analytics/rhythm-outcomes` — pair aggregates with cells under 20
suppressed. Any new reader must be added to the fence test with its reason.
