<!-- WHEN_TO_READ: You need to know how the voice note's lead text (b79cf24f) reached production, or when production came back onto full main after the file-scoped cache deploys. -->

# 2026-11-28 — full main on production (`04e03951`): voice note carries the text typed before it

The founder asked for the commit to be explained first, then approved it in chat («Выкати и b79cf24f тоже»).

1. What shipped: full `main` at `04e03951`. Over production `a849fa09`, the only code is `b79cf24f`:
   - `POST /v1/chat/voice` accepts an optional field `text`.
   - That text is stored as its own user message before the note and answered in the same turn.
   - The response carries `leadMessageId`.
   - See decision `2026-11-26-voice-lead-text.md`.
2. Production is back on full `main`: the file-scoped trees `8e7d0450` and `a849fa09` are superseded.
3. Not shipped: the uncommitted chat web-search work (`chat-web-search.ts`, `packages/shared/src/web-search.ts`), which sat staged in the local checkout. The sync came from a clean worktree at `04e03951`.
4. Tests on `main`: 38 files around the chat, the agents, reactions and the video read, 752 of 752. GitHub CI still fails only on the clock-dependent `date.test.ts`, the same as on production before this deploy.
5. Sync:
   - The source was a detached worktree at `04e03951`, with the runbook's excludes plus `.git` and `node_modules`, `-c`, and without `--delete`.
   - Content changes were exactly the six files of `b79cf24f`, plus `openapi/gennety-v1.yaml` and docs.
   - Afterwards `keys/`, both `node_modules` and both backups were present.
6. Not needed: no migration, no env, no dependency, no Mini App build.
7. Runtime:
   - `pm2 restart gennety-bot --update-env` and `pm2 save`.
   - `/v1/ping` returns ok and the bot started.
   - The restart count is 16, of which one is this deploy.
8. iOS: older builds never send `text`, so nothing changes for them. The behaviour reaches people with the build that has the new composer.
9. Not checked yet: a real voice note with typed text, which needs that build and a signed-in user.
10. Rollback: revert `b79cf24f`, sync and restart. The stored lead messages stay as ordinary user messages.
