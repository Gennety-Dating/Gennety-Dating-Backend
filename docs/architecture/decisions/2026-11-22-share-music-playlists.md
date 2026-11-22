<!-- WHEN_TO_READ: Touching the share sheet's music read (`/v1/me/share/music`, `/add`), how shared playlist tracks are matched and added to the profile's music, the profile's 30-track cap, or why some providers read only part of a list. -->

# 2026-11-22 — Shared playlists into the profile's music

## 2026-11-22 — A shared playlist becomes cards, «Добавить N» appends them; the profile's music cap goes from five to 30

**Kind:** founder decision (the cap) + agent design (the rest)

**What:**

1. The founder's report: a `music.youtube.com` playlist shared to the iOS extension fell to the wishlist as one «music.youtube.com / in your words» card with a disabled «Add 0». Asked whether «Добавить N» may exceed the five-track profile cap, the founder chose **raise the cap to 30** (over keeping five, and over a separate music library, which would have been a schema change). The profile and the match pitch draw the first five and open the rest on a tap. `PROFILE_MUSIC_MAX_TRACKS = 30` in shared constants; no migration.
2. New `POST /v1/me/share/music` (`services/share-music/`): YouTube Music and YouTube playlists and albums, Spotify, Apple Music, Yandex Music and SoundCloud playlists, albums and single tracks become up to 30 cards (`SHARE_MUSIC_MAX_TRACKS`), all addable ones ticked while the profile has room, those already pinned marked `added`. Plain YouTube videos stay with `/v1/me/share/video`. The app calls the music read first and falls back on 400 `not-music` (or 404 from an older server).
3. No new API key: logged-out reads only — Spotify's embed player data, YouTube's playlist page and oEmbed, an Apple Music page's schema.org block (or the Apple Music catalogue API with the MusicKit key the profile already uses), Yandex Music's anonymous public JSON, SoundCloud's page data — all through the existing SSRF wall with a music-only allowlist.
4. A profile keeps only Spotify and Apple Music ids, so a track from YouTube, Yandex or SoundCloud is searched in Spotify's catalogue (the existing search) and kept only on the same core name plus a shared artist; otherwise `not_found`, never a guess. The card shows the catalogue's own words — what will be pinned.
5. New `POST /v1/me/share/music/add` (`appendProfileMusic`): appends after the pinned set; duplicates (same id or same song from the other provider), dropped ids and tracks past the cap are skipped and counted rather than failing the import.
6. Nothing read reaches a model (`share-music.boundary.test.ts`), the display-only rule of the Spotify Developer Policy applies as to every pinned track; logs carry counts only.
7. Demo mode: nothing to branch — the extension is iOS-only and the demo is the Telegram bot; the puppet has no music.

**Why:** Searching thirty songs one by one is exactly what the founder wanted gone, and a five-slot profile made «all at once» impossible. Matching into Spotify keeps the profile's guarantees (provider's own metadata, weekly refresh, removed tracks disappear) instead of storing YouTube or Yandex titles nobody re-checks, and avoids a schema change.

**Rejected:** a separate music library table (schema change, a second music surface); storing YouTube / Yandex / SoundCloud tracks under a new provider value (old iOS builds decode `MusicProvider` as an enum, and nothing would refresh them); SoundCloud's and YouTube's keyed or internal APIs to read past what the page shows (rule 5 — ask first; left as open points); fuzzy matching that could pin the wrong song; any model to clean titles.

**What it changes going forward:** iOS must render many rows in the extension, call `/v1/me/share/music` first, and show up to 30 tracks on the profile (spec phase 8). The nightly music refresh reads 1,000 rows a night (was 200). The `schema.prisma` comment still says five and is corrected with the next migration. Live provider shapes were not reachable from the build container: the deploy block carries a one-link-per-provider live check.

**Recorded in:** `docs/product/domains/share-music-playlists.md`, `docs/product/domains/profile-music.md`, `openapi/gennety-v1.yaml`.
