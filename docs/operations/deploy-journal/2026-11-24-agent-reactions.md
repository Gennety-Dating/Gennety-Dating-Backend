<!-- WHEN_TO_READ: Checking the 2026-11-24 production deploy of agent chat reactions step 1 (main `75c13ccd`, migration `20261124120000_chat_message_reactions`, founder preview), rolling it back, or planning the next deploy (its base is this tree). -->

# 2026-11-24 — production: agent chat reactions, step 1, founder preview

The founder said yes in chat: «Да, выкатывай», answering whether to ship reactions with the migration for him only. Production was full main `35661eb5` plus the founder-preview env of the same night. This deploy is again a full one: the droplet now holds `main` `75c13ccd` as is.

## What shipped

1. The PENDING block «emoji reactions in the agent chat, step 1» from [pending.md](./pending.md). Decision [2026-11-24-agent-reactions](../../architecture/decisions/2026-11-24-agent-reactions.md), spec `docs/product/domains/agent-reactions.md`.
2. Migration `20261124120000_chat_message_reactions`: three nullable columns on `messages` (`user_reaction`, `agent_reaction`, `reacted_at`), no index, no row touched.
3. Env: one new line, `AGENT_REACTIONS_USER_IDS` with the founder's user id `371c0f02-3413-46c7-b6eb-0320afd0e2a9`. `AGENT_REACTIONS_ENABLED` stays unset, so it is off for everyone else.
4. Code diff against production: `config.ts`, `public/routes/chat.ts`, `services/chat-agent.ts`, `chat-reactions.ts` (new), `feature-preview.ts`, `proxy-chat.ts`, `suggested-replies.ts`, `packages/shared/src/agent-reactions.ts` (new), the Prisma schema, openapi and docs. No lockfile, webapp or dependency change, so the Mini App was not rebuilt.

## Preflight (local `main` = `origin/main` = `75c13ccd`, clean)

1. `typecheck` of shared and bot clean; `db:generate` OK.
2. Tests touched by the change: 14 files, 322/322 (`chat-reactions-route`, `chat-agent-reactions`, `chat-reactions`, `suggested-replies`, `proxy-chat`, `chat-agent`).
3. `pnpm security:secrets` OK.

## Rollout (2026-11-24 17:07–17:10 UTC)

1. Rollback archive: `/opt/gennety-predeploy-20261124-170729-reactions.tar` (tree without `node_modules`, `apps/video`, `.env*`). `.env` backup `.env.bak.*-reactions`.
2. Sync from a `git archive` export of `75c13ccd` with the runbook excludes plus `*.brand-backup-*` and the four artefact paths of the previous deploy. The dry run had no deletions; content changes were exactly the files listed above.
3. On the droplet: `pnpm install --frozen-lockfile`, `db:generate`, `migrate status` (only `20261124120000` pending), `db:deploy` (applied), `pnpm db:drift-check` OK (the 5 known foreign `canvas_*` tables left alone).
4. `.env` gained the preview line, then `pm2 restart gennety-bot --update-env`, `pm2 save`.

## Verified

1. Process `online`, restarts 10 → 11 (this one only); «Bot @gennetybot started», `:3100` and `:3101` listening, no P2022 in the fresh log.
2. `/v1/ping` ok; `GET /v1/chat/history`, `GET /v1/chat/sessions` and `PUT /v1/chat/messages/{id}/reaction` answer 401 without auth: the routes are live behind auth.
3. With the production env on the droplet, `agentReactionsOn` from `services/feature-preview.ts` answers true for the founder and false for any other id.
4. Server hashes of `chat-reactions.ts`, `public/routes/chat.ts`, `chat-agent.ts` and `schema.prisma` equal `75c13ccd`.
5. Root `*.json` (2 backups, plus `package.json` and `tsconfig.base.json`), `keys/` (3) and the `.env.bak.*` snapshots are in place.

## Not checked

1. A live reaction from «Орёл»: long-press row, double-tap ❤, and Gennety's 🙏 on «ок, спасибо» against the real model. The iOS build `462de3b3` already on the phone turns reactions on once history rows carry `reactions`.

## Roll back

1. Feature only: delete the `AGENT_REACTIONS_USER_IDS` line, restart. Stored reactions stay in the columns, unread.
2. Code: extract the archive in `/opt`, `pnpm install --frozen-lockfile`, `db:generate`, restart. The three columns may stay: the old code does not name them.
