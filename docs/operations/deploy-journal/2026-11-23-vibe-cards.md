<!-- WHEN_TO_READ: Checking the 2026-11-23 production deploy of the agent's vibe cards (aura, attractiveness, swag gap on a photo), rolling it back, or making the next file-scoped deploy (its base is this deploy tree). -->

# 2026-11-23 — production: vibe cards (file-scoped deploy)

The founder said yes in chat («Да, выкатить») after the iOS drawing «Силуэт» was in main and on «Орёл» (`cc2347a5`). No migration, no dependency change, no env change: `AGENT_VIBE_CARDS_ENABLED` is unset, so the tool is on, and only for app builds that send `vibe` in `X-Gennety-Chat-Cards`.

## What shipped

1. Decisions: [2026-11-21-agent-vibe-cards.md](../../architecture/decisions/2026-11-21-agent-vibe-cards.md) (variant C, then the drawing «Силуэт» on 2026-11-22). Spec: `docs/product/domains/agent-vibe-cards.md`.
2. Production was `c6cf02ac`. `main` still holds pending packages (agent concept, long-term memory, suggested replies, reminders with a migration, chat statuses, shared playlists, chat archive), so `1c7ea73d`, `bdc876a3`, `ac0f0b55`, `f988dbd6` and `130516a6` were cherry-picked onto `c6cf02ac` in a separate worktree, keeping only the vibe lines where they met those packages. Deploy-tree commit: `3578058c` (local branch `deploy/vibe-2026-11-23`, not pushed, like `c6cf02ac`). **The next file-scoped deploy starts from `3578058c`.**
3. Fourteen files were synced with `rsync --relative --files-from`, no `--delete`, after the nine existing server copies were checked byte-equal to `c6cf02ac`: `apps/bot/src/config.ts`, `apps/bot/src/public/routes/chat.ts`, `apps/bot/src/services/chat-activity.ts` and its test, `apps/bot/src/services/chat-agent.ts`, `openapi/gennety-v1.yaml`, `packages/shared/src/i18n.ts` and its test, `packages/shared/src/index.ts`; new: `chat-vibe-card.ts` and its test, `chat-agent-vibe.test.ts`, `packages/shared/src/vibe-cards.ts`, `apps/bot/scripts/vibe-eval.ts`.

## Preflight

1. Deploy-tree typecheck of the bot clean. Tests: chat agent, vibe and activity 187/187; `packages/shared` 483/483; `src/public` 1223/1224 in a full run — `public-api.test.ts > POST /v1/auth/logout > requires auth` failed under load and passes alone (230/230); the file is untouched by this deploy.
2. Live model eval on `main` (`vibe-eval.ts`, `gpt-6-luna`, 12 cases × 3): 36/36 twice; after the last change every line under a drawing carries the step.
3. `pnpm security:secrets` passed. `pnpm security:audit`: the same 1 high as on 2026-11-22, `effect` ≤3.22.0 via `packages/db > prisma > @prisma/config`; production already runs it and this deploy changes no dependency. **Fix still owed** (override `effect` to `>=3.22.1`, check `prisma --version` and `db:generate`).

## Rollout

1. Rollback archive of the nine changed files: `/opt/gennety-predeploy-20261123-164054-vibe.tar`. Roll back: extract it in `/opt/gennety`, delete the five new files listed above, `pm2 restart gennety-bot --update-env`. Or set `AGENT_VIBE_CARDS_ENABLED=false` in `.env` and restart: the tool and its rules drop from every turn.
2. `pm2 restart gennety-bot --update-env` and `pm2 save`. Restarts went from 7 to 8 (this one only). `online`, «Bot @gennetybot started», `:3100` and `:3101` listening.

## Verified

1. Server hashes of `vibe-cards.ts` and `chat-agent.ts` equal the deploy tree.
2. On the droplet, read-only: `AGENT_VIBE_CARDS_ENABLED` resolves to true, `VIBE_ARCHETYPE_MAX_LEN` is 26, `turnTools` offers `show_vibe_card` with `vibeCards` and not without it.
3. `/v1/ping` ok; Mini App, onboarding and verification pages 200; admin API 401 without auth. Root `*.json` (4) and `keys/` (3) in place.
4. `[venues] photo proxy failed … HTTP 403` fills the log after the restart; the error log already held 23,396 such lines, so it predates this deploy. Not investigated.

## Not checked

1. A real turn: no photo was sent to the production agent. The first person who asks on «Орёл» (`cc2347a5`) is the first live check, including Vision cutting the person out on the phone.
2. The Telegram bot and the demo bot are unchanged: the tool needs the app header.
