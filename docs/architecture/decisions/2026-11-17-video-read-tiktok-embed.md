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
