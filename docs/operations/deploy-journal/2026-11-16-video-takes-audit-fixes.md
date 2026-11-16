<!-- WHEN_TO_READ: Checking the 2026-11-16 production deploy (agent video takes, app audit fixes), or rolling it back. -->

# 2026-11-16 — production `be56bf50`: agent video takes and app audit fixes

Full server deploy from local `main` `be56bf50` (was `57c6c510` from 2026-11-13),
19:02–19:06 UTC, runbook «Deploy Full Server Code». The founder said yes in chat
(«выкатывай»). No migration, no env change; `AGENT_VIDEO_TAKES_ENABLED` is unset,
so it uses its default, ON.

## What shipped

- `bcbbb831`, `3828ba6d`, `5f815a96` — app audit fixes (the PENDING 2026-11-15 block in
  [pending.md](./pending.md)):
  - `POST /v1/me/feedback/attendance`;
  - `lastOutcome` on `/v1/matches/current`;
  - `clientMessageId` on `/v1/chat/voice`;
  - the `chat.reply` push and the app push legs for expiry and the ticket gate;
  - the app prompt surface and `get_my_date`.
- `be56bf50` — agent video takes, phases 1–4 (the PENDING 2026-11-16 block):
  - the agent reads shared TikTok, Reels and YouTube links;
  - its taste and the looks red lines;
  - the trend glossary;
  - the `suggest_video` tool.
- Docs-only commits `c5a1e299`, `d4cb803a`, `42ce3e47`.

## Preflight

- `pnpm install --frozen-lockfile`, `db:generate`, `pnpm typecheck`, `pnpm build`,
  `pnpm security:secrets`, `pnpm security:audit` green («No known vulnerabilities found»).
- `pnpm test` (with `SUPABASE_SELFIE_BUCKET=selfies SUPABASE_VOICE_BUCKET=voice-prompts`):
  shared 472/472, webapp 784/784, bot 7881/7883. The two failures:
  - `wishlist-lookup › catalog photos › warms brand items once…` is the known failure from 2026-11-13.
  - `chat-sessions-route › lists the caller's chats with the default page size` is flaky under load.
    - Alone it passes 29/29.
    - Three runs of `src/public/routes` gave 375/375, 375/375 and 374/375. The third failure was a
      different test, `voice-prompt` base64 fallback.
- Production smoke green before the change.

## Rollout

- Rollback archive of the server code before sync: `/opt/gennety-predeploy-20261116-190225/code.tar`
  (no `node_modules`, no `dist`).
- The rsync dry run had no deletions and changed 59 files, all from the commits above. The excludes
  were the same as on 2026-11-13, including the brand-backup SVG.
- After the sync, both `*-backup-*.json`, `keys/` (3 files) and `.env` were still in place.
- On the droplet:
  - ffmpeg and ffprobe present;
  - `pnpm install --frozen-lockfile`, `db:generate` and the webapp build ran;
  - `pnpm db:drift-check` OK (5 foreign canvas tables left alone);
  - `prisma migrate status` up to date.
- The Mini App was copied to `/var/www/dating-app`; the previous copy is
  `/var/www/dating-app.prev-20261116-190507`. Then `pm2 restart gennety-bot --update-env` and `pm2 save`.

## Verified after deploy

- `pm2 status`: `gennety-bot` online, restart count +1 (this restart only), still stable 50 s later.
  The log shows the admin API on `:3100`, the public API on `:3101` and `Bot @gennetybot started`.
  No P2022 after the restart (the last one is far back in the log).
- `/v1/ping` → `{"ok":true,…}`. Calendar, onboarding, verification, ticket, tickets and venue-change
  → 200. Admin → 401.
- `POST /v1/me/feedback/attendance` and `GET /v1/chat/sessions` without a token → 401
  `{"error":"Missing bearer token"}` (routes present).
- Not checked: a live TikTok link in the app chat and the `lastOutcome` key with a real token.
- Re-checked by the video-takes session, about 19:20 UTC:
  - `gennety-bot` runs through `tsx` from source, and `@gennety/shared` resolves to `src/index.ts`;
  - `apps/bot/src/services/agent-video-takes.ts` and `packages/shared/src/agent-takes.ts` are present on the droplet;
  - `.env` has no `AGENT_VIDEO_TAKES_ENABLED` line, so the default is ON;
  - the last 1,000 log lines have no errors from video takes.

## Rollback

1. `tar -xf /opt/gennety-predeploy-20261116-190225/code.tar -C /opt/gennety`
2. `pnpm install --frozen-lockfile && pnpm --filter @gennety/db db:generate`
3. Restart the bot.
4. Mini App: copy `/var/www/dating-app.prev-20261116-190507` back.

To turn off only the video takes: `AGENT_VIDEO_TAKES_ENABLED=false` in `.env`, then restart. There is
no data to undo.

Demo: not deployed.
