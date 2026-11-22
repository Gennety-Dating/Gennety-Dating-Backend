<!-- WHEN_TO_READ: Checking the 2026-11-22 production deploy of `recommendedIosVersion` on `/v1/app/config` (soft iOS update hint), or rolling it back. -->

# 2026-11-22 — production: `recommendedIosVersion` (file-scoped deploy)

The founder said yes in chat («Да, выкатывай», then «Выкатить сейчас» on the red audit below). There was no migration, no dependency change and no env change: `IOS_RECOMMENDED_APP_VERSION` is not set, so the field is `null` and no hint is shown.

## What shipped

1. `279f10c8`: optional `recommendedIosVersion` on `GET /v1/app/config`. Decision: [2026-11-22-ios-soft-update.md](../../architecture/decisions/2026-11-22-ios-soft-update.md).
2. Production was `6a2d2697` + `213cdbc2` / `876de4c8`. `main` holds pending packages (reminders with a migration, suggested replies, shared playlists, vibe cards), so the commit was applied onto `876de4c8` in a separate worktree. Deploy-tree commit: `c6cf02ac`, code files only.
3. Four files were synced, no `--delete`, after the server copies were checked byte-equal to the base: `apps/bot/src/config.ts`, `apps/bot/src/public/routes/app-config.ts`, `apps/bot/src/public/app-config.test.ts`, `openapi/gennety-v1.yaml`.

## Preflight

1. Bot typecheck in the deploy tree clean; `app-config` tests green; secrets check passed.
2. `src/public` in the deploy tree: 1222 of 1224 passed. The two failures differ between runs (date-state cover links, profile-video), pass alone (32/32), and the base without the change also fails two other tests in a full run. They are load-dependent flakes, not caused by this change; not investigated further. The other test folders were not run.
3. `pnpm security:audit` reports 1 high: `effect` ≤3.22.0 (GHSA-7589-6fvf-x4pw), path `packages/db > prisma > @prisma/config > effect`. Production already runs `effect@3.21.0` and this deploy changes no dependency; shipped with the founder's explicit choice. **Fix still owed:** override `effect` to `>=3.22.1` and check `prisma --version` and `db:generate`.

## Rollout

1. Rollback archive: `/opt/gennety-predeploy-20261122-143657-soft-update.tar`. Extract it in `/opt/gennety` and restart.
2. `pm2 restart gennety-bot --update-env` and `pm2 save`. Restarts went from 6 to 7 (this one only). The bot came up `online` with «Bot @gennetybot started», `:3100` and `:3101` listening.

## Verified

1. `GET /v1/app/config` on production answers `recommendedIosVersion: null`, `minSupportedIosVersion: null`.
2. `/v1/ping` ok; Mini App, onboarding and verification pages 200; admin API 401 without auth.
3. Root `*.json` files and `keys/` (3 files) are in place.

## Not checked

1. The hint on a phone with a real value. The installed client (`b031f40b`) refuses to show it while its App Store link is the placeholder, so nothing can be seen until a build with the real App Store id ships.
