<!-- WHEN_TO_READ: You are working on music on the profile — the Apple Music or Spotify tracks a person pins, the catalogue search, the top-tracks import, or where those tracks may and may not appear. -->

# Music on the Profile (Apple Music + Spotify)

> **Status:** built 2026-09-11, shipped dark — `PROFILE_MUSIC_ENABLED` and
> `SPOTIFY_TOP_TRACKS_ENABLED` are both off by default. Apple Music added
> 2026-10-08 as the main provider; it is on wherever the MusicKit key is set.
> Decisions: the 2026-09-11 and 2026-10-08 entries in the
> [decision index](../../architecture/decisions/INDEX.md).
> Architecture: [integrations](../../architecture/integrations.md) (Spotify Web
> API row), [data model](../../architecture/data-model.md) (`profile_music_tracks`),
> [API surface](../../architecture/api-surface.md) (`/v1/me/music`,
> `/v1/music/search`, `/v1/integrations/spotify/*`).

## What it is

A person may pin up to **three** tracks to their profile, from Apple Music or
Spotify, mixed freely. They see them on their own profile; their **match
partner** sees them on the pitch. Nobody else does — the same reach as partner
photos.

Three ways to pick:

1. **My Apple Music** — the main path (decision 2026-10-08). The iPhone asks
   the system for Apple Music access (MusicKit) and reads what the person
   recently played; they tick up to three. The server receives only the
   catalogue song ids and the account's storefront, and reads the metadata
   from the Apple Music API with Gennety's MusicKit key. No user cap; an
   empty history (no subscription, nothing played) falls back to search.
2. **Search** — everyone. Spotify's catalogue, no Spotify login.
3. **Import my Spotify top tracks** — behind a second flag. One Spotify consent screen,
   then the person's 15 most-played tracks of roughly the last six months, from
   which they pick up to three. Built and switched off: since 2026-02 a
   development-mode Spotify app admits at most five hand-allow-listed accounts,
   and Extended Quota is granted only to organisations with ≥250k MAU. Anyone
   else gets Spotify's 403, and the app says so and offers search instead.

## Invariants

- **Display-only.** Spotify's Developer Policy forbids analysing Spotify content
  for "building profiles of users" and ingesting it into any ML/AI model; the
  same rule is applied to Apple Music tracks. The
  tracks never feed the embedding, the matcher, the pitch text, wingman hints or
  any prompt — `apps/bot/src/services/music/ai-boundary.test.ts` enforces it.
  "They both love the same band" is exactly the idea this rules out.
- **A property of the person, not of the pair.** Shown on the profile and on the
  pitch; never on a lock-screen surface (Live Activity, Dynamic Island, widget),
  per the iOS decision of 2026-09-02.
- **The client sends ids; the server writes the metadata.** What a partner reads
  is Spotify's or Apple's own answer for those ids, never text or an image a
  client chose. An Apple Music id travels with the storefront it was read in.
- **Current, not archived.** Metadata is re-read weekly and a track its
  provider drops disappears from the profile (Spotify's Developer Terms allow
  only temporary caching; Apple Music is refreshed the same way).
- **Nothing of the Spotify account is kept.** The import reads once and forgets
  the token — no refresh token, no Spotify user id. Clearing the tracks clears
  everything Spotify-derived about that person.
- **The provider's branding, wherever a track is drawn:** for Spotify the full
  Spotify logo, the cover neither cropped nor overlaid (4 pt corners on a
  phone), and a link that opens the track in Spotify; for Apple Music the
  official Apple Music badge and a link to the song's `music.apple.com` page.
- **No previews played.** Spotify returns `preview_url` = null for every app
  registered after 2024-11-27; Apple's 30-second preview is stored but not
  played yet.

## Surfaces

| Surface | What |
|---|---|
| iOS profile editor | A "Music" section: up to three tracks, saved the moment they change (like photos, not through the editor's Save button) |
| iOS picker sheet | "My Apple Music" while `features.appleMusic` is true; Spotify search; "Connect Spotify" only while `features.spotifyTopTracks` is true |
| iOS own profile | The pinned tracks under "About" |
| iOS pitch | The partner's tracks (`SerializedMatch.partnerMusicTracks`) |
| Telegram / Mini App | Not shown — v1 is iOS-only |

## Not done

- **Favorite films.** Postponed by the founder on 2026-10-08 (iOS journal):
  posters need a licensed source — TMDB is free only for non-commercial use,
  and Apple's free catalogue lacks most films in the Ukrainian storefront.
  Back only with a decision on a TMDB licence.
- **Apple Music search** on the server — search stays Spotify's.
- **Telegram display** of the tracks.
