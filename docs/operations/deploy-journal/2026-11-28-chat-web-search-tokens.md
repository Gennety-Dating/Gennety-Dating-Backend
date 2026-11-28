<!-- WHEN_TO_READ: You need to know how the `search_web` token economy reached production, or how it was checked there. -->

# 2026-11-28 — production `159b1068`: `search_web` spends about half the tokens

The founder approved the deploy in chat («Да, делай» to «Делать фазы 1–3 и 5 и выкатить на прод?»).

1. What shipped: `159b1068` on top of production `6f469192` + docs `0dc870a6`. See decision `2026-11-28-chat-web-search.md` → «Token economy».
   - One look-up per request, low reasoning, 800 output tokens.
   - Word-set cache key `chat-web:v2`, «nothing found» kept 30 min.
   - A same-turn repeat reuses the first result; «search narrower» when the summary misses the asked detail.
2. Checks before the sync:
   - The production `chat-agent.ts`, `chat-web-search.ts`, `packages/shared/src/web-search.ts` and `index.ts` were byte-identical to `0dc870a6`.
   - Tests: `chat-web-search` 14 of 14. Full bot suite: 8353 of 8356 under load. The failures varied between runs (timeouts, 404s). Run alone, only `date.test.ts` C-1 failed, and it fails on clean `main` too.
   - Bot and shared typecheck: 0 errors.
3. Sync: only the seven files of `159b1068` (`rsync -c --files-from`), so production equals `main`. Local `.claude/` and worktrees were not sent.
4. Not needed: no migration, no env, no dependency, no Mini App build.
5. Runtime:
   - `pm2 restart gennety-bot --update-env` and `pm2 save`.
   - `/v1/ping` on 3101 returns ok. The restart count is 18, of which one is this deploy.
6. Checked on production with `searchWeb` (user `deploy-smoke`, Kyiv):
   - «MAKEUP Black Friday 2026 Київ знижки» returned `found` in 6.3 s, `searches=1`, with makeup.com.ua cited, at 12.9k input / 243 output tokens. The same query before this deploy was 21k input in 8.4 s.
   - The same question with other case and punctuation came from the cache in 36 ms.
7. Measured before the deploy, six fixed Kyiv queries: 113k → 59k tokens (−48 %), 8.0 → 5.3 s.
8. Rollback: sync `0dc870a6` versions of the three code files back and restart, or set `CHAT_WEB_SEARCH_ENABLED=false`.
