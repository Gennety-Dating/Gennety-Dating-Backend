<!-- WHEN_TO_READ: Checking the 2026-11-13 production deploy (in-app chat «about you» questions, Telegram ticket gate variant B), or rolling it back. -->

# 2026-11-13 — production `57c6c510`: «about you» questions in the app's chat

Full server deploy from local `main` `57c6c510` (was `d49a9241` from 2026-11-03),
13:01–13:06 UTC, runbook «Deploy Full Server Code». No migration, no env change, no flag.

## What shipped

- `58ed6839` — `POST /v1/chat/profiler` and the reply intercept in `POST /v1/chat/message`
  (decision `docs/architecture/decisions/2026-11-13-profiler-in-app-chat.md`). Needed before the
  iOS build `69c311ba`, which calls the route; an older server answered 404 and the app showed no question.
- `07c06131`, `f3228fd6` — Telegram ticket gate and «Чего хочется?» (the PENDING 2026-11-04 block in
  [pending.md](./pending.md)); Mini App rebuilt on the droplet.
- `57c6c510` — audit gate: overrides `fast-xml-parser` 5.7.0 → 5.12.0 (low advisory, Rekognition XML
  path) and `@typescript-eslint/typescript-estree>minimatch` 11.0.8 (moderate, lint only). Server
  resolved `fast-xml-parser@5.12.0`.

## Preflight

- `pnpm --filter @gennety/bot typecheck` green (after a local `db:generate`; the stale client lacked the
  screenshot models). Targeted tests `profiler-chat`, `chat-sessions-route`, `chat-route-audit`: 57/57.
- Full `pnpm test`: shared 454/454, webapp 784/784, bot 7773/7774 with
  `SUPABASE_SELFIE_BUCKET=selfies SUPABASE_VOICE_BUCKET=voice-prompts`. The one failure,
  `wishlist-lookup.test.ts › catalog photos › warms brand items once…`, fails the same way on the
  previous main `665cb5bd` — pre-existing, unrelated to this deploy.
- `pnpm build`, `pnpm security:secrets`, `pnpm security:audit` green. Production smoke green before change.

## Rollout

- Rollback archive of the server code before sync: `/opt/gennety-predeploy-20261113-130140/code.tar`
  (no `node_modules`, no `dist`).
- rsync dry-run deletions: `apps/webapp/src/ticket/PartialTimer.tsx` (removed in `07c06131`) and
  `apps/bot/src/assets/brand/butterfly-logo.svg.brand-backup-20260928` (server-only backup, never in git).
  The founder chose to keep the backup: it was excluded from both runs.
- Extra excludes beyond the runbook: `apps/video/out/`, `apps/video/build/`, `apps/bot/evals/out/`,
  `.DS_Store` — 280 untracked local renders and bundles (293 MB) that were never on the server.
- On the droplet: ffmpeg/ffprobe present, `pnpm install --frozen-lockfile`, `db:generate`,
  webapp build, `pnpm db:drift-check` OK (5 foreign canvas tables left alone), `prisma migrate status`
  up to date (33 migrations). Mini App copied to `/var/www/dating-app`, previous copy
  `/var/www/dating-app.prev-20261113-130442`. `pm2 restart gennety-bot --update-env`, `pm2 save`.

## Verified after deploy

- `pm2 status`: `gennety-bot` online; log shows admin API on `:3100`, public API on `:3101`,
  `Bot @gennetybot started`; no new errors (only a blocked-user 403 and the known CARTO key warning).
- `/v1/ping` → `{"ok":true,"now":"2026-11-13T13:05:41.346Z"}`; calendar, onboarding, verification,
  ticket, tickets, venue-change → 200; admin → 401.
- `POST /v1/chat/profiler` without a token → 401 `{"error":"Missing bearer token"}` (route present, not 404).

## Rollback

`tar -xf /opt/gennety-predeploy-20261113-130140/code.tar -C /opt/gennety`, then
`pnpm install --frozen-lockfile && pnpm --filter @gennety/db db:generate` and restart; Mini App:
copy `/var/www/dating-app.prev-20261113-130442` back. No data to undo.

Demo: not deployed.
