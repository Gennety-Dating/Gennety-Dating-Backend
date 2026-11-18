<!-- WHEN_TO_READ: Checking the 2026-11-18 production deploy (agent stances on hot topics), or rolling it back. -->

# 2026-11-18 — production `6a2d2697`: agent stances on hot topics

This was a full server deploy from local `main` `6a2d2697`, replacing `8af27ab2` from 2026-11-17. It ran 04:29–04:32 UTC under the runbook section «Deploy Full Server Code». The founder said yes in chat («да»). There was no migration, no env change and no Mini App change. `AGENT_STANCES_ENABLED` is not set, so it takes its default, ON.

## What shipped

- `bd0f9361`, `114907e8` — the agent stances, phases 3–4 of [agent-stances.md](../../product/domains/agent-stances.md):
  - Every agent turn, in Telegram and in the app chat, carries the hot-topic rules and the political boundary.
  - Stances 0–32 are injected when the person's last two messages name them, at most three per turn.
  - Each stance is framed by `User.gender` and `User.preference`.
- Docs-only commits: `25af509f`, `6a2d2697`.

## Preflight

- These were green: `pnpm install --frozen-lockfile`, `db:generate`, `pnpm typecheck`, `pnpm build` and `pnpm security:secrets`.
- `pnpm test` (with `SUPABASE_SELFIE_BUCKET=selfies SUPABASE_VOICE_BUCKET=voice-prompts`): shared 483/483, webapp 784/784, bot 7900/7903. The three failures:
  - `wishlist-lookup › catalog photos › warms brand items once…` is the known failure from 2026-11-13.
  - Two tests in `public/location.test.ts` fail under load only; alone the file passes 34/34.
- `pnpm security:audit` reports 1 high: `picomatch` ≤4.0.7, ReDoS (GHSA-fc5q-39xc-vjpf).
  - It is shipped anyway: no patched version exists (latest is 4.0.7, and the advisory lists none), so an override cannot fix it.
  - Its only path is `typescript-eslint › … › tinyglobby › picomatch`, the local linter, and it never runs on the bot's request path.
  - Pin an override as soon as a fixed `picomatch` is published.
- Live eval: `apps/bot/scripts/stance-eval.ts` asked 62 questions, each as a woman and as a man. The first run found 6 slips, which were fixed in `114907e8`, and the final run had none.
- Production smoke was green before the change.

## Rollout

- Rollback archive of the server code: `/opt/gennety-predeploy-20261118-042956/code.tar` (no `node_modules`, no `dist`).
- Rsync used the runbook excludes plus `--exclude '*.brand-backup-*'`.
  - The dry run had 0 deletions with that exclude. Without it, the server-only brand-backup SVG would have been deleted.
  - 299 files changed, mostly the local `apps/video/build` Remotion bundle, which is not part of the runtime.
- After the sync, these were still in place: both `*-backup-*.json` files, `keys/` (3 files), `.env` and the brand-backup SVG.
- On the droplet:
  - `pnpm install --frozen-lockfile` and `db:generate` ran.
  - `pnpm db:drift-check` was OK (the 5 foreign canvas tables left alone).
  - `prisma migrate status` was up to date.
  - Then `pm2 restart gennety-bot --update-env` and `pm2 save`.
- The Mini App was not rebuilt, because no `apps/webapp` change has been made since the last deploy.

## Verified after deploy

- `pm2`: `gennety-bot` is online with restart count 5 (+1, this restart only), still stable a minute later. The log shows the admin API on `:3100`, the public API on `:3101` and `Bot @gennetybot started`.
- `/v1/ping` → `{"ok":true,…}`; `/v1/chat/sessions` without a token → 401.
- On the droplet, `agentStanceBlocks` for «он хочет открытые отношения» returns the rules and the `open-relationships` stance.
- No stance errors in the error log.
- Not checked: a live chat turn with a real account.

## Rollback

- Stances only: put `AGENT_STANCES_ENABLED=false` in `.env`, then `pm2 restart gennety-bot --update-env`. There is no data to undo.
- Full rollback:
  1. `tar -xf /opt/gennety-predeploy-20261118-042956/code.tar -C /opt/gennety`
  2. `pnpm install --frozen-lockfile && pnpm --filter @gennety/db db:generate`
  3. Restart the bot.

Demo: not deployed.
