<!-- WHEN_TO_READ: A shared TikTok / Instagram / YouTube link comes back «closed» («… didn't show the video»), or you touch `short-video/metadata.ts`, the share-sheet video read or the agent's video block. -->

# 2026-11-17 — why shared videos came back «closed», and the TikTok read moved to the embed page

The founder reported that almost every TikTok or Reels link shared to Gennety ended on «Instagram didn't show the video — No cover or caption to go on». The screen is the share sheet's `closed` state (`ShareVideoView`, `share.video.closed.*`); the agent chat uses the same reader (`share-video/read.ts`), so the agent was blind to the same links.

1. **Cause, measured on 2026-11-17 from the founder's Mac (not a datacenter IP).**
   - TikTok: `tiktok.com/oembed` now answers every id, real or invented, with a bare skeleton (`embed_product_id`, `embed_type`, sizes). There is no `title`, no `author_name` and no `thumbnail_url`, so `readTikTok` returned `no_metadata` for every video.
   - Instagram: the post page served to a logged-out browser is a ~540 KB app shell with no `og:description` and no `og:image`, for `/p/`, `/reel/` and `/embed/captioned/` alike. This is no longer only Meta's datacenter rate limit; a home IP gets the same shell.
   - YouTube: oEmbed still returns the title, the author and the thumbnail. YouTube links read fine.
   - Production logs were not read: SSH to the droplet was refused to this session.
2. **TikTok fix.** `readTikTok` now reads `tiktok.com/embed/<id>`, the public player page any site embedding a TikTok loads. Its `__FRONTITY_CONNECT_STATE__` JSON carries the caption (`itemInfos.text`), the cover frames (`coversOrigin` / `covers`, on `tiktokcdn.com`, already allowlisted) and the author. oEmbed stays as the fallback in case TikTok fills it again.
   - The depth decided on 2026-10-24 is unchanged: logged-out, no cookies, no token, no frames, no audio.
   - A browser-shaped UA is kept as before. A crawler UA (pretending to be Facebook's or Telegram's link-preview bot) was considered and rejected: it is impersonation.
   - Verified live: two public TikToks returned a caption, an author and a cover that downloads. Invented ids still come back `no_metadata`.
3. **Instagram.** Not fixed by this change, because every route left needs a founder decision (rule 5). The options put to the founder are:
   - read on the iPhone with Apple's LinkPresentation (the iMessage preview fetcher) and send the caption and cover to the API; no new vendor, but a `/v1` contract change and an iOS release, and not verified yet;
   - Meta oEmbed Read through a Meta app (free, needs app review, and Meta has been removing the thumbnail and author from it);
   - a paid scraping API (Apify and similar, per-request cost, terms-of-service risk).
4. **Honest dead end.** When a video still cannot be read, the agent's block now tells the model to say so briefly and ask for a screenshot of the video or a line on what is in it. The iOS share-sheet copy `share.video.closed.body` should say the same thing instead of «try another link»; that copy change goes with the Instagram decision.
5. **Demo mode.** Same behaviour. The read is a public-page fetch plus one vision call, with no paid step and no write outside the chat.

## 2026-11-20 — Instagram: the phone reads the link preview

The founder chose «try reading on the iPhone» (option 1 above). If that fails, the founder suggested downloading the video the way Telegram downloader bots do, with the load kept off our servers.

1. **Measured first.** Apple's LinkPresentation was run on the Mac with the same framework the iPhone has.
   - `instagram.com/p/BsOGulcndj-/` and its `/reel/` twin returned the title «Just An Egg 🥚 в Instagram», the start of the caption (about 70 characters, ending in «…») and the real post image (400×400 JPEG).
   - The TikTok link returned «TikTok · Zach King» and a 1024×537 cover frame.
   - Apple's fetcher gets the tags that our server's fetch does not. It does this from the person's own connection and with Apple's own client, so nothing on our side pretends to be anyone.
2. **Contract.** `POST /v1/me/share/video` takes an optional `preview` with `title`, `summary` and `image` (base64 JPEG/PNG, at most 300 KB decoded). The rules:
   - The server's own read always comes first. The preview is used only when that read returns nothing.
   - A read built from a preview is cached under the person's id and never under the shared URL key. The app could send anything, so one person's preview must never become what another person's link reads as.
   - The agent chat (`videoTakeBlocks` gets `userId`) and `/video/ask` find that personal read without sending the preview again.
3. **The caption is truncated.** iOS exposes the caption's start only through `LPLinkMetadata`'s non-public `summary` key. The app reads it defensively (`responds(to:)`, KVC) and sends nothing when it is missing. The title and the cover still go.
4. **Telegram.** Unchanged, because no phone sits between the link and our server there. Instagram stays `closed` there, and the agent asks for a screenshot.
5. **Demo mode.** Same behaviour.
6. **Downloading the video.** Not built. It would come back only if the preview path fails on real reels.

## 2026-11-20 — Pinterest pins in the share sheet and the agent chat

The founder asked for Pinterest as well: a video pin is read as a video, and a photo pin by its image.

1. **Read path.** The server reads `widgets.pinterest.com/v3/pidgets/pins/info/?pin_ids=<id>`, the public JSON that Pinterest's own embed button loads, logged-out. It gives the text (title plus description), the largest image (`736x`/`564x`, on `pinimg.com`, now allowlisted), the creator, and a video list. A video pin can have `is_video: false`, so a non-empty `videos.video_list` counts as video too. Idea pins fall back to their first story image.
2. **Links.** Any country site counts (`pinterest.com`, `de.pinterest.com`, `pinterest.co.uk`, …), as do slugged pins (`/pin/<slug>--<id>/`) and `pin.it/<code>` stubs (one allowlisted redirect hop). Profiles and boards are not pins and are not read.
3. **Prompt.** A photo pin tells the model that it sees the pin's image itself, not a cover frame. A video pin reads like any other short video, from its cover and text.
4. **Surfaces.** The iOS share sheet and the agent chat on both surfaces, because `findSharedVideoUrl` uses the same classifier. Telegram therefore gets Pinterest too, since the server reads it itself.
5. **Demo mode.** Same behaviour.
6. **Verified live from the Mac.** A photo pin (`99360735500167749`) and a video pin (`487022147210444696`) each returned text, a creator and an image that downloads. `/pin/1/` came back `not_video`.
