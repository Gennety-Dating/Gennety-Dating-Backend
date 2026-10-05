<!-- WHEN_TO_READ: Investigating the blank demo Calendar or the SQL NULL grid initialization fix deployed on 2026-10-05. -->

# 2026-10-05 — Demo Calendar NULL grid repair

Demo backend only: deployed `apps/bot/src/handlers/matching/scheduler.ts` to
`/opt/gennety-demo` and restarted `gennety-demo`. Production was not restarted
or modified. No environment, schema or static Mini App changes.

Root cause: PostgreSQL `proposed_times` was NULL for the active negotiating
match after the ticket gate completed. Prisma returned an empty list, but
`isEmpty: true` failed to claim that row. The scheduler now normalizes only
NULL grids in negotiating rows, then uses its existing compare-and-set.

Recovered the affected demo match with the actual scheduler and a silent API
stub, without sending Telegram messages. Initialization created 84 slots;
repeating it preserved the grid and scheduling anchor. A signed request to
`https://demo-api.gennety.com/v1/calendar/state` returned HTTP 200 and 77
selectable slots. Existing availability was empty before recovery.

Validation: 7,580 workspace tests passed (399 shared, 735 Mini App, 6,446 bot),
build and bot typecheck passed, tracked-secret check passed, dependency audit
passed with two previously ignored moderate advisories. The initial full test
run picked up local `*-dev` storage names; rerunning with the mocked fixtures'
expected `SUPABASE_SELFIE_BUCKET=selfies` and `SUPABASE_VOICE_BUCKET=voice-prompts`
passed all tests. Tests mock storage calls; no storage data was changed.

Rollback source is `/root/gennety-backups/calendar-null-20261005/scheduler.ts`.
Copy it back and restart only `gennety-demo`. The recovered grid is ordinary
scheduling state and should remain intact.

The same backend fix is committed for the next production release.
