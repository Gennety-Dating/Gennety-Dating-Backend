<!-- WHEN_TO_READ: Checking the 2026-11-17 production deploy (chat quote context), or rolling it back. -->

# 2026-11-17 — production `da7d6061`: quoting an agent reply in the app chat

Full server deploy from local `main` `da7d6061` (was `be56bf50`), 04:37–04:40 UTC, using the runbook «Deploy Full Server Code». The founder said yes in chat («Да, выкатывай»). There was no migration, no env change and no webapp change.

## What shipped

- `da7d6061` adds the `chat_quote` chat context to `/v1/chat/message` (`context.text`) and `/v1/chat/voice` (`contextText`). It is stored in `messages.context`, and the model sees a «Replying to …» line in front of the turn. See decision [2026-11-17-chat-quote.md](../../architecture/decisions/2026-11-17-chat-quote.md).

## Preflight

- `pnpm install --frozen-lockfile`, `db:generate`, `typecheck`, `build`, `security:secrets` and `security:audit` were green.
- `pnpm test` results:
  - shared 472/472;
  - webapp 784/784;
  - bot 7892/7895.
- The three bot failures:
  - `wishlist-lookup › catalog photos` is the known failure.
  - `admin/server › rerun-verification 404` and `account-status › freeze idempotent` failed only under load. Run on their own, they pass 72/72.

## Rollout

- Rollback archive: `/opt/gennety-predeploy-20261117-043740/code.tar`.
- The dry run listed 0 deletions and 13 files, all from the commit above plus docs. The excludes were the same as on 2026-11-16.
- After the sync, both `*-backup-*.json` files, `keys/` (3 files) and `.env` were still in place.
- `pnpm install --frozen-lockfile` and `db:generate` ran, then `pm2 restart gennety-bot --update-env` and `pm2 save`. The webapp was not rebuilt because nothing in it changed.

## Verified

- `gennety-bot` is online. The log shows `:3100`, `:3101` and `Bot @gennetybot started`.
- `/v1/ping` returns `ok`. `POST /v1/chat/message` without a token returns 401.
- `chat_quote` is present in `chat-context.ts` on the droplet.
- Not checked: a live quoted turn. The app build that sends quotes installs after this.

## Rollback

1. `tar -xf /opt/gennety-predeploy-20261117-043740/code.tar -C /opt/gennety`
2. `pnpm install --frozen-lockfile && pnpm --filter @gennety/db db:generate`
3. Restart the bot.

Rows already stored with a `chat_quote` context stay readable by older code, which ignores that kind and shows no chip.

Demo: not deployed.
