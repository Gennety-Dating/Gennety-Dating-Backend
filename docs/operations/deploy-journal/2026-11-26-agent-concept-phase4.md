<!-- WHEN_TO_READ: You need to know how agent concept phase 4 (the proactive senders) reached production, what was checked, or how to roll it back. -->

# 2026-11-26 — agent concept phase 4 on production (`ca1e08a6`)

The founder approved all nine phase 4 recommendations in chat («Да, внедряй»), then approved the deploy and both migrations («Да, выкатывай»).

1. What shipped: `main` at `ca1e08a6`, the eight phase 4 commits from `1fd3d7f6` to `ca1e08a6` on top of production `75c13ccd`. The two later commits on `main` (`ea0038b4`, `3ca030c5`, the token budget) were NOT shipped. Their block in `pending.md` stays PENDING and waits for its own yes.
2. Preflight: the local Mac could not run it (DiskPulse refused disk admission under load). GitHub CI on `ca1e08a6` was green on every step instead:
   - secrets, lint, typecheck;
   - unit tests: bot 518 files, webapp 70, shared 30;
   - Mini App build;
   - PostgreSQL integration tests, 15 files;
   - `pnpm security:audit`: no known vulnerabilities.
3. Sync: a detached worktree at `ca1e08a6`, the runbook's excludes plus `.git`, and `-c` (checksum). Content changes were exactly the phase 4 files.
   - It ran **without `--delete`**. The dry run would have deleted only untracked artifacts: `apps/video/build/`, `apps/video/out/`, `apps/bot/evals/out/`, `apps/video/apps/` and `butterfly-logo.svg.brand-backup-20260928`. Phase 4 removes no tracked file, so they were left in place.
   - Afterwards `keys/` and both `*-backup-*.json` were present.
4. Database:
   - `.env` was backed up as `.env.bak.20261126-150957-phase4`.
   - `db:deploy` applied `20261126100000_profiler_pause_off_switch` and `20261126120000_notify_only_dates`.
   - `db:drift-check`: OK, only the five known foreign tables differ.
5. Runtime:
   - `pnpm install --frozen-lockfile` and `db:generate` ran.
   - The Mini App was not rebuilt, because phase 4 changes no `apps/webapp` file.
   - `pm2 restart gennety-bot --update-env` and `pm2 save`.
   - No env was changed; phase 4 has no flag.
6. Checks after the restart:
   - `/v1/ping` returns ok.
   - `GET /v1/me/notifications` without auth returns 401, so the route is mounted.
   - The log shows the APIs listening, `Profiler scheduled` and `Bot @gennetybot started`.
   - A minute later the restart count had not moved (12, one of them this deploy). There was no new `P2022`; the last one in the log is far older.
7. Not checked yet: an authenticated `PATCH /v1/me/notifications`, and the two new rows in Telegram ⚙️ Settings. Both need a signed-in user (`pending.md` phase 4 block, step 5).
8. Seen in the log, unrelated to this deploy: `[venues] photo proxy failed … 403 PERMISSION_DENIED (places.googleapis.com)`, about 26.8k lines that started long before it.
9. Rollback: revert the phase 4 commits, sync, and restart. The columns can stay, because the old code does not read them. The `DROP COLUMN` statements are in the phase 4 block of `pending.md`.
