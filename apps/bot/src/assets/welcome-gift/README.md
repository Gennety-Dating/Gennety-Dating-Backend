# Welcome-gift video notes (кружки)

Founder video notes played as a pre-roll before a new user's first-ever match
pitch, alongside the gift DM (see `services/welcome-gift.ts`,
`handlers/matching/pitch.ts`, PRODUCT_SPEC §3.5b).

## File naming

Drop square Telegram **video-note** MP4s here, named `<gender>-<lang>.mp4`:

- `gender` ∈ `male` | `female` (chosen from `User.gender`)
- `lang` ∈ `en` | `ru` | `uk` | `de` | `pl`

Examples: `male-ru.mp4`, `female-en.mp4`.

### Fallback chain & per-language notes

The sender resolves the note in this order — first hit wins:

1. `<gender>-<lang>.mp4` — gender + language specific.
2. `<lang>.mp4` — one note per language, shown to both genders.

A more specific file always overrides a broader one; identical files share one
uploaded Telegram `file_id`. **There is deliberately no global `default.mp4`
fallback** — the video note is an explicit per-language opt-in, so any language
without a matching file gets only the text-only gift DM.

**Currently shipped**: `ru.mp4` only (the founder note, one file for both
genders). Every other language (`en` / `uk` / `de` / `pl`) intentionally ships
no video note and receives just the gift DM. Same format rules below.

## Format

- Square aspect ratio (video notes are circular in Telegram).
- ≤ 60 seconds.
- The bot just forwards the ready file to `sendVideoNote` — no ffmpeg/transcode.

## Partial coverage is safe

The sender checks for the exact `<gender>-<lang>.mp4` at send time. If it's
missing, the video note is skipped and only the gift DM is sent. So you can ship
a subset (e.g. `male-ru` + `female-ru` + the English pair) and add more languages
later — no code change, the matrix lights up as files appear.

These assets are deployed by the standard code rsync to `/opt/gennety`.
