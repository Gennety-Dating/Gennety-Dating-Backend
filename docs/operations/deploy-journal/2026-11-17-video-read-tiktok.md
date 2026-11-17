<!-- WHEN_TO_READ: Checking the 2026-11-17 production deploy of the TikTok embed-page read (shared videos «closed»), or rolling it back. -->

# 2026-11-17 — production `8af27ab2`: TikTok read from the public embed page

Server code sync from local `main` `8af27ab2` (was `da7d6061`). The founder said yes in chat («Да, выкатывай»). There was no migration, no dependency change, no env change and no webapp change.

## What shipped

- `8af27ab2` makes `short-video/metadata.ts` read TikTok from `tiktok.com/embed/<id>`, with oEmbed as the fallback. TikTok's oEmbed had started answering with an empty skeleton, so every shared TikTok came back `closed`, both in the share sheet and in the agent chat.
- When a video cannot be read, the agent now asks for a screenshot or a line on what is in it.
- See decision [2026-11-17-video-read-tiktok-embed.md](../../architecture/decisions/2026-11-17-video-read-tiktok-embed.md).

## Preflight

1. Bot tests for `short-video`, `share-video` and `agent-video-takes` passed, 104/104. The bot `typecheck` and `lint` were clean.
2. The full `pnpm test` was not run for this deploy. The change touches only those three modules.

## Rollout

1. No rollback archive was taken. To roll back, `git revert 8af27ab2` and sync again; the change is source-only.
2. The dry run with the runbook's excludes wanted to delete `apps/bot/src/assets/brand/butterfly-logo.svg.brand-backup-20260928`, a server-only file. It was kept by adding `--exclude '*.brand-backup-*'`.
3. The local renders were also excluded: `apps/video/out/` (251 MB, gitignored), `apps/video/build/`, `apps/bot/evals/out/` and `.DS_Store`.
4. The final dry run listed 0 deletions and 8 files: the commit above plus docs.
5. After the sync, the 4 `*.json` files in the root and `keys/` (3 files) were still in place.
6. `pm2 restart gennety-bot --update-env` and `pm2 save` ran. `pnpm install` was not needed because the lockfile did not change. The bot came up `online`, and its restart count stayed at 4.

## Verified

1. The reader ran on the droplet itself (a datacenter IP) on two public TikToks. `@zachking/video/6768504823336815877` and `@scout2015/video/6718335390845095173` each returned a caption, an author and a cover URL.
2. On the Mac, the cover from the embed page downloaded as `image/jpeg`. A made-up id still returns `no_metadata`.
3. Not checked:
   - a TikTok link sent through the app chat or the share sheet on a phone;
   - TikTok `vm.tiktok.com` short links, because no real one was at hand.
4. Instagram Reels still come back `closed`. Logged-out Instagram pages carry no OG tags. Fixing it waits for the founder's choice, listed in §3 of the decision.
