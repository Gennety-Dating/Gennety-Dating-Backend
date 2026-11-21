<!-- WHEN_TO_READ: Checking the 2026-11-20 production deploy (phone link preview for Instagram/TikTok, Pinterest pins), or rolling it back. -->

# 2026-11-20 — production: phone link preview + Pinterest pins (file-scoped deploy)

The founder said yes in chat («Да, выкатывай»). There was no migration, no dependency change and no env change.

## What shipped

1. `386af2db` adds an optional `preview` (title, summary, cover) to `POST /v1/me/share/video`. It is used only when the server's own read is empty, and the result is cached for that person only. The agent chat and `/video/ask` find that read by `userId`.
2. `155e2b91` adds Pinterest pins, photo and video, read from the public widget JSON.
3. See the decision file [2026-11-17-video-read-tiktok-embed.md](../../architecture/decisions/2026-11-17-video-read-tiktok-embed.md), sections dated 2026-11-20.

## Why file-scoped

1. Production was on `6a2d2697`. `main` holds three PENDING packages on top of that: reminders (with migration `20261120090000_agent_reminders`), suggested replies, and chat statuses. None of them was approved for this deploy.
2. So the two commits were cherry-picked onto `6a2d2697` in a separate worktree. The deploy-tree commits are `213cdbc2` and `876de4c8`. The only conflict was the `videoTakeBlocks` call, where the line `userId,` was kept without the pending `onWatch`.
3. The bot typecheck in that tree was clean. Tests passed: `share-video`, `short-video`, `agent-video-takes`, `routes/share` and `chat-agent`, 238/238.
4. Before the sync, the server copies of `chat-agent.ts`, `agent-video-takes.ts`, `share-video/read.ts` and `routes/share.ts` were checked byte-equal to `6a2d2697`.
5. Only 7 files were synced, with no `--delete`:
   - `routes/share.ts`;
   - `agent-video-takes.ts`;
   - `chat-agent.ts`;
   - `share-video/links.ts`;
   - `share-video/read.ts`;
   - `share-video.test.ts`;
   - `openapi/gennety-v1.yaml`.

## Rollout

1. Rollback archive of the replaced files: `/opt/gennety-predeploy-20261120-200312-share-preview.tar`. To roll back, extract it in `/opt/gennety` and restart.
2. `pm2 restart gennety-bot --update-env` and `pm2 save` ran. The bot came up `online`, and the restart count went from 5 to 6 (this restart only). The 4 root `*.json` files and `keys/` (3 files) were in place afterwards.
3. **The next full deploy from `main` already contains these commits.** It must still apply the reminders migration first, as `pending.md` says.

## Verified on the droplet (stubbed model call, real fetches)

1. A Pinterest photo pin (`99360735500167749`) came back `read` with `photo: true`, its text, its creator and a 39 KB image.
2. A Pinterest video pin (`487022147210444696`) came back `read` with `photo: false`.
3. An Instagram reel with no preview came back `closed`.
4. The same reel with a preview (LinkPresentation title, caption start and cover, taken on the Mac) came back `read`, author «Just An Egg 🥚».
5. The same person without a preview then got `read`. Another person got `closed`.
6. TikTok came back `closed`: the embed page went empty after 2026-11-17 (see the decision). In the app it now goes through the phone.

## Not checked

1. Instagram, TikTok and Pinterest links on the phone, in the share sheet and in the chat. The build itself is installed (see below), but the live links were not tried on it.
2. A real `pin.it` short link.

## iOS client (2026-11-22)

1. The iOS integration run merged `claude/share-link-preview` into Gennety-iOS `main` as patch-equivalent commits `89904cf3`, `28f15f1a` and `af68d6ce`. The last two fix the Swift 6 build: a `Sendable` box for `LPLinkMetadata`, and the optional chat message text.
2. Gennety-iOS `main` `9477f78b` was built and installed on «Орел» on 22.11 at 00:34, with 1450/1450 unit tests passing. The integration session reported this.
