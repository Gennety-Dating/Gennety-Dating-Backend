<!-- WHEN_TO_READ: You need to know how the prompt cache fix (part 3: live part out of the cached block, fixed 30-row window, Telegram live part split) reached production, or why production is file-scoped and not on full main. -->

# 2026-11-28 — prompt cache, part 3, on production (file-scoped `8e7d0450`)

The founder approved the deploy in chat («Да, выкатывай»).

1. What shipped: `70b9a247`, cherry-picked onto production `83f8376e`, plus the docs commit `4a7a107a`. The result is the deploy tree `8e7d0450`, which is not on `main`.
   - Code: `chat-agent.ts`, `menu-agent.ts` and `prompt-layout.ts`, with their tests.
   - `b79cf24f` is on `main` between them and was NOT shipped. It is the voice note that carries the text typed before it. Its decision `2026-11-26-voice-lead-text.md` waits for its own «да».
   - The cherry-pick conflicted only in `docs/architecture/decisions/INDEX.md`, the row that commit added. The deploy tree kept production's copy.
   - The next deploy of full `main` ships `b79cf24f` and needs that yes.
2. Tests on the deploy tree: 40 files, 830 of 832 green. The two failures fail on production `4a7a107a` alone too, and they depend on the clock:
   - `date.test.ts` «does NOT re-prompt feedback once feedbackPromptedAt is set (C-1)». The same failure is in GitHub CI on `b79cf24f` and on `70b9a247`; it is the only red step.
   - `public-api.test.ts`: a different test fails on each run.
3. Sync: the runbook's excludes plus `.git` and `node_modules` (as files too), with `-c`, without `--delete`. Content changes: exactly the five code files plus docs. Afterwards `keys/`, both `node_modules` and both `*-backup-*.json` were present.
4. Not needed: no migration, no dependency, no env change, no Mini App build.
5. Runtime: `pm2 restart gennety-bot --update-env` and `pm2 save`. `/v1/ping` returns ok, the bot started, and the restart count is 14, of which one is this deploy.
6. Not checked yet: the cache on real turns. A new app chat should show `cached=0` on turn 1 and the rules and tools block cached from turn 2. Telegram should show `cached > 0` from its second message.
7. Rollback: sync production `83f8376e` (or `4a7a107a`) back and restart.
