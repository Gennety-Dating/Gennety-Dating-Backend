<!-- WHEN_TO_READ: You need to know how the app chat agent's `search_web` reached production, or how it was checked there. -->

# 2026-11-28 — full main on production (`6f469192`): the app chat agent searches the web itself

The founder approved the deploy in chat («Да, выкатывай на прод и устанавливай»).

1. What shipped: full `main` at `6f469192`. Production was on `04e03951` (deploy `bb60ba06`), so the only code is `6f469192`:
   - The new function tool `search_web` (`chat-web-search.ts`, limits in `packages/shared/src/web-search.ts`).
   - It reports the `web` activity step, and the «Looking things up» rules are in `CHAT_ADDENDUM`.
   - See decision `2026-11-28-chat-web-search.md`.
2. Checks before the sync:
   - The production `chat-agent.ts` was byte-identical to `6f469192^`.
   - Tests on `main`: `chat-web-search`, `chat-activity` and the eleven `chat-agent*` files, 187 of 187.
   - Bot typecheck: 0 errors after `prisma generate`.
3. Sync: from the clean main checkout, with the runbook's excludes plus `.git`, `node_modules` and `.DS_Store`, `-c`, and without `--delete`.
   - Content changes were exactly the seven files of `6f469192`, plus docs.
   - Afterwards `keys/`, both `node_modules` and both backups were present.
4. Not needed: no migration, no env, no dependency, no Mini App build. `CHAT_WEB_SEARCH_ENABLED` is unset, so the tool is on.
5. Runtime:
   - `pm2 restart gennety-bot --update-env` and `pm2 save`.
   - `/v1/ping` returns ok. The restart count is 17, of which one is this deploy.
6. Checked on production: `searchWeb` was run once with the production key and model (user `deploy-smoke`, Kyiv, «MAKEUP Black Friday 2026»). It returned `found` in 8.4 s with makeup.com.ua and Vogue UA pages cited, at 21k input tokens.
7. Not checked yet: a real turn in the app chat showing «Ищу в интернете…». That needs a signed-in person.
8. Rollback: set `CHAT_WEB_SEARCH_ENABLED=false` in `/opt/gennety/.env` and restart, or sync `04e03951` back and restart.
