<!-- WHEN_TO_READ: You are working on sharing a music link into Gennety through the iOS share extension — a playlist, an album or a single track from YouTube Music, YouTube, Spotify, Apple Music, Yandex Music or SoundCloud — on `/v1/me/share/music` or `/v1/me/share/music/add`, on how those tracks are matched and added to the profile's music, or on the iOS sheet that shows them. -->

# Shared playlists into the profile's music

> **Status:** backend built 2026-11-22, on `main`, not deployed. iOS change
> described in phase 8, not built (separate repo). Decision:
> [2026-11-22-share-music-playlists.md](../../architecture/decisions/2026-11-22-share-music-playlists.md).
> Related: [profile-music.md](./profile-music.md) (where the tracks land and the
> display-only rule), the short-video share sheet in
> [morning-after-and-wishlist.md](./morning-after-and-wishlist.md) and the
> decision journal entry of 2026-10-24.

## Why

The founder shared a `music.youtube.com` playlist to the Gennety share extension.
Nothing recognised it as music: `/v1/me/share/video` answered `not-video`, the app
fell back to the wishlist, and the sheet showed one generic «music.youtube.com /
in your words» card with a disabled «Add 0». He asked for a seamless path: share a
playlist, see all its songs, add them all in one tap, without searching for each
song one by one.

## Shape of the feature

The share sheet asks the server what the link is. A music link answers with every
track of the list as a card, all ticked; «Добавить N» appends the ticked tracks to
the profile's music in one call. The profile now holds up to 30 tracks (five
before; the founder chose 30 on 2026-11-22 so a playlist lands whole), and the
profile and the match pitch draw the first five and open the rest on a tap.

## Phases

1. **Recognition** (`apps/bot/src/services/share-music/links.ts`, pure, no network).
   A shared URL is music when it is one of these, after tracking parameters are
   stripped and the URL is made canonical (the canonical URL is the cache key):
   - YouTube Music: `music.youtube.com/playlist?list=…` (a playlist; an album when
     the list id starts `OLAK5uy_`), `music.youtube.com/browse/MPREb_…` (an album
     page), `music.youtube.com/watch?v=…` (one track; a `list=` beside it is
     ignored, the person shared the song).
   - YouTube: `www.youtube.com/playlist?list=…` and `m.youtube.com/playlist?list=…`.
     A plain YouTube video (`watch`, `youtu.be`, Shorts) is NOT music: it stays
     with the short-video read, unchanged.
   - Spotify: `open.spotify.com/{playlist|album|track}/<id>`, with or without
     `intl-xx/` or `embed/`; `spotify.link/…` and `spoti.fi/…` short links are
     followed one hop.
   - Apple Music: `music.apple.com/<storefront>/{playlist|album|song}/…`; an album
     link with `?i=<song id>` (what «Share song» produces) is one track.
   - Yandex Music on any country site (`.ru .com .by .kz .uz`): `/album/<id>`,
     `/album/<id>/track/<id>`, `/track/<id>`, `/users/<owner>/playlists/<kind>`
     and the new `/playlists/<uuid>`.
   - SoundCloud: `soundcloud.com/<user>/sets/<set>` (a playlist or album),
     `soundcloud.com/<user>/<track>` (one track), `m.soundcloud.com`, and
     `on.soundcloud.com/…` short links followed one hop.
   - Artist pages, podcasts, episodes, channels, `likes` and other app pages are
     not music. A URL with credentials or a non-default port is refused.

2. **Expansion** (`read.ts`, `parse.ts`). Only what a logged-out browser is served,
   through the existing SSRF wall (`fetchAllowlistedPage`) with a music-only host
   allowlist (`isShareMusicHost`); no new API key anywhere. Per source:
   - Spotify playlist or album: the embeddable player's page
     (`open.spotify.com/embed/…`, `__NEXT_DATA__`) lists every track with its
     Spotify id, name and artists. Album rows take the album cover. A playlist row
     has no cover there, so each row's cover comes from the existing single-track
     lookup (`GET /v1/tracks/{id}` on the app token, four at a time), which also
     warms the cache «Добавить» reads from. If that lookup fails the card stays,
     without a cover, still addable. A Spotify track link is that one lookup.
   - YouTube and YouTube Music playlists: the `www.youtube.com/playlist` page
     (`ytInitialData`, body cap raised to 4 MB for this caller only, consent
     cookie `SOCS=CAI` so an EU server is not sent to the consent page). The first
     page is about 100 rows. A YouTube Music album page is a script app, but its
     escaped data names the album's `OLAK5uy_` playlist, which is then read the
     same way. A YouTube Music track is YouTube's public oEmbed. Song and artist
     come from the upload: a «Artist - Topic» channel's title is the song; else
     «Artist - Song (Official Video) ft. Guest» is split, video labels dropped and
     the guest moved to the artists; else the channel is the artist.
   - Apple Music: with the MusicKit key configured (already used for profile
     songs), the catalogue API's playlist or album, first page of tracks, read as
     Apple Music songs with their storefront. Without the key, the page's
     schema.org block (`MusicPlaylist` / `MusicAlbum`), matched like any other
     source.
   - Yandex Music: the anonymous public JSON at `api.music.yandex.net` (album
     with tracks, owner playlist, uuid playlist, track); the page's schema.org
     block as a fallback. Unavailable tracks and id-only rows are counted, not
     shown.
   - SoundCloud: the page's `__sc_hydration` data. A set describes only its first
     few tracks in full; the rest are id-only stubs that only SoundCloud's keyed
     API resolves, so they are counted as unreadable and the read is `partial`.
     Resolving them would need SoundCloud's API with a client id — not added
     (rule 5, ask first).

3. **Cards** (`read.ts`).
   - A profile keeps only Spotify and Apple Music ids, because their metadata is
     re-read weekly and a removed track disappears. A track that came with such an
     id (Spotify, Apple Music with the key) needs no matching.
   - Every other track is searched in Spotify's catalogue (the profile's existing
     search, `matchQuery` = primary artist + core title) and kept only on a
     confident hit: the same core name after brackets, «- Remastered …» and
     «feat. …» are cut on both sides, and at least one shared artist. A source
     row with no artist is not searched. A near miss is `not_found`, never a
     wrong song on someone's profile.
   - A matched card shows the catalogue's own title, artists and cover — exactly
     what will be pinned — and keeps a link back to the source track.
   - One card per song: the same song twice in a list (an upload and its lyric
     video, two releases) shows once, before any lookup; two rows that land on one
     catalogue track show once after.
   - At most `SHARE_MUSIC_MAX_TRACKS` (30) cards, equal to the profile cap.
     `truncated` says the list is longer (the cap or the provider's first page);
     `total` is the provider's own count when it gives one.
   - States, per person and never cached: `added` (already on the profile — the
     same id, or the same song from the other provider by title key), `new`
     (addable), `not_found` (no catalogue match, cannot be ticked).
   - Ticks by default: every `new` card, in list order, while the profile has
     room (`slotsLeft`). `selectedCount` is the N of «Добавить N». The person can
     untick any card.

4. **Adding** (`appendProfileMusic` in `services/music/profile-music.ts`).
   - `POST /v1/me/share/music/add` with the ticked cards' `match` refs
     (`{ provider, trackId, storefront? }`, 1..30) appends them after the pinned
     set, in the order sent; nothing pinned is removed or re-read.
   - Forgiving where `PUT /v1/me/music` is strict: a duplicate, an id the provider
     no longer serves and a track past the cap are skipped and counted
     (`skipped.duplicate / notFound / overLimit / failed`), so one bad row never
     sinks a 30-track import. Reads stop at the free slots and at a provider's
     quota wall.
   - Each new row is the provider's own answer for its id; the client never
     supplies a title or a cover. 409 `too_many_tracks` when the profile is
     already full; 502 / 503 only when not one track could be read.

5. **Failure and partial reads.**
   - Not a music link: 400 `not-music`; the app falls back to the video read and
     then to the wishlist, exactly as before.
   - The provider gave nothing (blocked, consent page, private list, page changed):
     200 with `status: closed` and no cards — the sheet says it could not open the
     list and offers to search instead.
   - The whole read answers within `SHARE_MUSIC_READ_BUDGET_MS` (15 s). Tracks
     still unmatched when time or Spotify's quota runs out come back `not_found`
     and the read is `partial`; a partial read is not cached, so sharing again
     may do better. A complete read is cached for an hour per canonical URL.

6. **Boundaries.**
   - Nothing read here reaches a model, a prompt, the embedding or the matcher:
     a playlist is music taste, and the profile's music is display-only under
     the Spotify Developer Policy. `share-music.boundary.test.ts` fails if a
     source in `services/share-music/` imports a model or reads the pinned-track
     table; the existing `ai-boundary.test.ts` still allows only
     `profile-music.ts` and `matches-service.ts` to read it.
   - Logs carry the source, kind, status and counts only — never a URL, a title
     or an artist.
   - Covers are the providers' CDN URLs, never downloaded by the server.
   - Behind `PROFILE_MUSIC_ENABLED` (404 `profile-music-disabled` while off), not
     the wishlist switch. Rate limits: 30 reads and 60 adds per person per hour.

7. **Demo mode.** No branch and nothing to answer. The share extension is iOS-only
   and the demo is the Telegram bot, so a demo visitor never reaches these routes;
   the puppet has no pinned music, so the raised cap changes nothing it shows. No
   gate, paid step or negotiation step is added. The same holds for the demo API
   if an iOS build is ever pointed at it: the routes behave as in production.

8. **iOS change note** (separate repo, built on the founder's Mac later). The API
   is additive; an iOS build without these changes behaves exactly as today.
   - Share extension, order of calls: first `POST /v1/me/share/music { url }`.
     On 200 show the music sheet. On 400 `not-music` or any 404 fall back to
     `POST /v1/me/share/video`, and on its `not-video` to the wishlist, as now.
   - Music sheet: header with `coverUrl`, `title`, `author` and, when `total` is
     set, «N треков»; when `truncated`, a line «Показаны первые 30». A list of
     `tracks` (the extension must render many rows in a scroll view, not one card),
     each with cover, title, artists and a checkmark bound to `selected`. A
     `not_found` card is dimmed, not tickable, with «Не нашли в каталоге». An
     `added` card is dimmed with «Уже в профиле». A «Выбрать все / Снять все»
     toggle over the tickable cards. The button «Добавить N» counts the current
     ticks, starts at `selectedCount`, is disabled at zero, and stops further
     ticks at `slotsLeft` (show «Место в профиле: K»).
   - Branding: a card whose `match.provider` is `spotify` shows the Spotify logo,
     `apple_music` the Apple Music badge — the title and cover then ARE that
     provider's (the same rule as the profile).
   - `status: closed`: «Не получилось открыть плейлист» and a button to the
     existing music search. `partial`: a small note «Часть треков не прочиталась
     — можно поделиться ещё раз».
   - «Добавить N» → `POST /v1/me/share/music/add { tracks: [match…] }` with
     `{ provider, trackId, storefront }` of every ticked card; on 200 show
     «Добавлено N» (and «пропущено K» when `skipped` is not all zeros), then close
     the extension. 409 → «В профиле уже 30 треков».
   - Profile and pitch: the music section must cope with up to 30 tracks — draw
     the first five, then «Ещё N» opening the full list. `PUT /v1/me/music` now
     takes up to 30; the editor's own picker should allow ticking up to 30.
   - Loading: the read can take up to ~15 s for a 30-track YouTube list; show the
     sheet's existing progress state with «Читаю плейлист…».

9. **The cap change, 5 → 30.** `PROFILE_MUSIC_MAX_TRACKS` in shared constants;
   `MAX_PROFILE_TRACKS` in `profile-music.ts` reads it. No migration: `position`
   has no database check. The `schema.prisma` doc comment still says five and
   0..4; it is corrected with the next migration rather than touching the schema
   file now. The nightly refresh looks at 1,000 rows a night instead of 200,
   since a week of rows grows with the cap and each Spotify row is its own request
   in development mode. Legal texts that say «up to three» tracks were already
   left untouched on 2026-10-19 and are still not edited here.

10. **Verification and open points.**
    - Unit tests run on saved, trimmed responses in
      `services/share-music/__fixtures__/`. The cloud container that built this
      could not reach any provider, so the fixtures mirror each provider's known
      response shape rather than a byte-for-byte capture. The first live check from
      the droplet is part of the deploy block (pending.md): one link per provider,
      and if a shape differs, a fresh capture replaces the fixture.
    - Spotify's development-mode quota is app-wide and unpublished; a 30-track
      YouTube list costs up to 30 searches, a Spotify playlist up to 30 track
      lookups. Watch `[share-music] read` logs for `partial: true` after launch.
    - Yandex Music may refuse anonymous API calls from a non-CIS server; then
      Yandex links read `closed` until a fallback is chosen.
    - Not done: SoundCloud stubs (needs SoundCloud's keyed API), YouTube lists
      beyond the first page (needs YouTube's internal continuation API), Apple
      Music playlists beyond the first 100 rows, matching against Apple Music's
      catalogue instead of Spotify's, the Telegram bot and the Mini App.
