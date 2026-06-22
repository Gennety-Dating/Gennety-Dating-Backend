# Delete/freeze video notes (кружки)

Founder video note played as the first step when a user taps **Delete Account**
in Settings (see `services/delete-freeze-video.ts`, `handlers/menu/settings.ts`).
It explains why freezing is the better move; the Freeze / Delete buttons are sent
right after it.

## File naming

Drop square Telegram **video-note** MP4s here, named `<lang>.mp4`:

- `lang` ∈ `en` | `ru` | `uk` | `de` | `pl`

Examples: `ru.mp4`, `en.mp4`.

## Format

- Square aspect ratio (video notes are circular in Telegram), e.g. 512×512 or 640×640.
- H.264 video + AAC audio.
- ≤ 60 seconds.
- The bot just forwards the ready file to `sendVideoNote` — no ffmpeg/transcode.

## Partial coverage is safe

The sender checks for the exact `<lang>.mp4` at send time. If it's missing, the
video note is skipped and only the text + Freeze/Delete buttons are sent. So you
can ship a subset and add more languages later — no code change.

These assets are deployed by the standard code rsync to `/opt/gennety`.
