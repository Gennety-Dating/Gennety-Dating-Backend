# Welcome-gift video notes (кружки)

Founder video notes played as a pre-roll before a new user's first-ever match
pitch, alongside the gift DM (see `services/welcome-gift.ts`,
`handlers/matching/pitch.ts`, PRODUCT_SPEC §3.5b).

## File naming

Drop square Telegram **video-note** MP4s here, named `<gender>-<lang>.mp4`:

- `gender` ∈ `male` | `female` (chosen from `User.gender`)
- `lang` ∈ `en` | `ru` | `uk` | `de` | `pl`

Examples: `male-ru.mp4`, `female-en.mp4`.

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
