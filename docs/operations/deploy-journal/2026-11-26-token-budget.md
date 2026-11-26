<!-- WHEN_TO_READ: You need to know how the token budget change (cached tokens at a tenth, usage log, cache-friendly agent request) reached production, what was checked, or how to roll it back. -->

# 2026-11-26 — token budget on production (`83f8376e`)

The founder approved the deploy in chat («Да, выкатывай») after the two commits were described.

1. What shipped: `main` at `83f8376e` on top of production `ca1e08a6`.
   - `ea0038b4` counts cached prompt tokens at a tenth and logs `[llm-usage]` per call.
   - `3ca030c5` lays the app chat request out for the prompt cache (rules → history → live data), uses a 30–39 row history window and a per-person `prompt_cache_key`, and moves the Telegram prompt to rules-first.
   - `83f8376e` is the phase 4 deploy journal and changes no code.
2. Preflight: GitHub CI was green on `ea0038b4` and on `3ca030c5`. Locally the bot suite ran 8339 of 8340 tests green; the one failure is a test that fails only under load and passes on its own.
3. Sync:
   - The source was a detached worktree at `83f8376e`, synced with the runbook's excludes plus `.git`, and `-c` (checksum).
   - It ran without `--delete`. Content changes were exactly the 29 files of these commits.
   - Afterwards `keys/` and both `*-backup-*.json` were present.
4. Not needed: no migration, no dependency change (`pnpm-lock.yaml` unchanged), no env change, no Mini App rebuild. All three new env keys use their defaults.
5. Runtime: `pm2 restart gennety-bot --update-env` and `pm2 save`.
6. Checks after the restart:
   - `/v1/ping` returns ok.
   - The process is online. The restart count went from 12 to 13, and that one is this deploy.
   - The log shows every cron scheduled and `Bot @gennetybot started`.
7. Not checked yet: the first `[llm-usage]` and `[chat] turn usage` lines.
   - No OpenAI call happened in the five minutes after the restart (22:45 Kyiv).
   - After the first app chat message, run `pm2 logs gennety-bot --lines 200 --nostream | grep -E "\[llm-usage\]|\[chat\] turn usage"`.
   - Expect `cached` close to `prompt` from the second message of a chat on, and no `prompt_cache_key refused` warning.
8. Rollback:
   - `LLM_CACHED_TOKEN_WEIGHT=1` plus `pm2 restart gennety-bot --update-env` restores the old count.
   - `LLM_PROMPT_CACHE_KEY=false` drops the key.
   - The layout goes back only by reverting `3ca030c5`, then syncing and restarting.
9. Still true: the per-person budget counter is in memory, so this restart reset everyone's daily count to zero.
