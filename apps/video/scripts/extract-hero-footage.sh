#!/usr/bin/env bash
#
# Regenerates public/footage/ for the GennetyHero product film.
#
# The clips ARE committed — the composition has to render on a fresh clone — but
# they are derived, and this is the derivation. Every window was chosen against a
# filmstrip; the reasoning is in video-production-plan.md §B, and the `trim`
# values in src/hero/timeline.ts are measured against these exact in-points.
# Change a window and re-check TRIM.
#
# Sources are the founder's own screen recordings and live OUTSIDE the repo:
#   IMG_2588.MP4   19s   the five profile-basics screens
#   IMG_2590.MP4  107s   conversational profiling -> Type Radar -> photo request
#   IMG_2604.MP4  135s   match decision -> Type Radar close (calendar + card retired)
#   IMG_2730.MP4   32s   the venue step, end to end (60fps, 576x1248)
#   IMG_2731.MP4    5s   the finished date card with its venue block
#   IMG_2771.MP4    6s   the ideal-Friday question, answered and sent
#   IMG_2772.MP4    9s   the calendar act: dates -> the shared slot -> the lock
#   IMG_2775.MP4    9s   opening Telegram and finding Gennety already there
#
# **A missing source is a WARNING, not an error** (changed 2026-08-19). The
# first three are already gone from the founder's Desktop, and refusing to run
# meant this script could no longer regenerate the two clips whose sources DO
# still exist. Each block guards its own source, so the script always produces
# everything it can and names, loudly, what it could not.
#
# Usage:  ./scripts/extract-hero-footage.sh [source-dir]
#         source-dir defaults to ~/Desktop
set -euo pipefail

SRC_DIR="${1:-$HOME/Desktop}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

BASICS="$SRC_DIR/IMG_2588.MP4"
PROFILE="$SRC_DIR/IMG_2590.MP4"
DATE="$SRC_DIR/IMG_2604.MP4"
VENUE="$SRC_DIR/IMG_2730.MP4"
CARD="$SRC_DIR/IMG_2731.MP4"
ASK="$SRC_DIR/IMG_2771.MP4"
CAL="$SRC_DIR/IMG_2772.MP4"
TG="$SRC_DIR/IMG_2775.MP4"

MISSING=()

have() {
  if [ -f "$1" ]; then return 0; fi
  MISSING+=("$1")
  return 1
}

mkdir -p "$HERE/public/footage"

# NO CROP. The full 576x1280 phone screen, status bar included.
#
# Two earlier versions cropped it (first the app chrome as well, then just the
# iOS status bar at `crop=576:1196:0:84`) because that strip carries the red
# screen-recording pill — the one element on screen that says "this is a demo".
# Both drew a replacement status bar in ui/Iphone.tsx, and both read as pasted
# on: a drawn strip keeps its own colour while the app behind it changes.
#
# The recording indicator is dealt with where it actually is instead — one
# opaque black rounded rect over the pill's measured bounds (ui/Iphone.tsx
# `PILL`), which is the Dynamic Island's own expanded shape. So the clock, the
# signal bars, the wifi arc, the battery and the island are all the device's
# own, in the device's own colours, over the real app. Nothing else is touched.
cut() {
  ffmpeg -v error -y -ss "$3" -to "$4" -i "$2" \
    -vf "fps=30" -an \
    -c:v libx264 -crf 17 -preset slow -pix_fmt yuv420p \
    "$HERE/public/footage/$1.mp4"
  echo "  $1"
}

# The same, for a source that is not already 576x1280.
#
# IMG_2730 is 576x1248 — a different capture aspect, not a crop of the others:
# its status bar sits at exactly the same rows (the recording pill is x 176-195,
# y 36-53 in every recording, measured) while its content is laid out 32px
# shorter overall. So the top, which is the only part the drawn `PILL` cover has
# to agree with, already lines up, and what differs is everything below it.
#
# `scale=576:1280` therefore stretches it 2.56% vertically and NOTHING else.
# The alternatives are both worse. Padding 32 rows of black at the bottom puts a
# black band inside a lit phone screen. Letting `ScreenClip`'s `objectFit: cover`
# handle it scales 2.56% in BOTH axes, which crops ~7px off each side and — the
# part that actually breaks — pushes the pill 2.4px outside the drawn cover,
# leaving the red hairline that cover exists to remove. A 2.56% stretch on one
# axis is invisible on a map, a keyboard and a form; a red hairline is not.
cut_scaled() {
  ffmpeg -v error -y -ss "$3" -to "$4" -i "$2" \
    -vf "fps=30,scale=576:1280" -an \
    -c:v libx264 -crf 17 -preset slow -pix_fmt yuv420p \
    "$HERE/public/footage/$1.mp4"
  echo "  $1"
}

if have "$BASICS"; then
  echo "profile basics (IMG_2588):"
  cut basics-name       "$BASICS" 0.6  4.2   # "Твоє ім'я" typing out
  cut basics-age        "$BASICS" 4.6  8.0   # the age slider settling on 21
  cut basics-gender     "$BASICS" 8.4  11.9  # the question + the tap burst at ~10.3
  cut basics-preference "$BASICS" 11.0 15.4  # two columns of real photographs
  cut basics-height     "$BASICS" 14.6 19.2  # the height drum spinning
fi

if have "$PROFILE"; then
  echo "understanding (IMG_2590):"
  # NOTE: `chat-question` moved to IMG_2771 on 2026-08-21 — see that block.
  # The LAST stretch of the radar, not the first. Everything before ~81s was
  # ruled out by the founder screen by screen: the opening holds one man for
  # 3.5s, 74-75s is a mirror selfie with the phone across the face, and 75.5-76.5
  # is a specific profile they asked to see gone. This window carries four
  # distinct men and ends on the "Що зачепило?" tags — the POSITIVE ones, which
  # is the better beat anyway. Extracted with ~0.3s of head slack and ~0.6s of
  # tail slack; the shot itself is clip 0.2-6.6s.
  cut radar-swipe       "$PROFILE" 80.9 88.2
  cut radar-done        "$PROFILE" 88.5 93.0 # "Готово" — it saved what it learned
fi

if have "$DATE"; then
  echo "the decision (IMG_2604):"
  # 13.0s, not 0.0s: the opening take runs into the calendar transition ~2s in,
  # while this stretch holds the whole decision thread stable for 7 seconds.
  cut match-decision    "$DATE" 13.0  20.0
  # NOTE: this source owns ONE shot now. Its venue step and date card went to
  # IMG_2730/IMG_2731 on 2026-08-19, and its calendar act (`cal-dates`,
  # `cal-overlap`, `time-reveal` — неділя 16 серпня, 13:00) went to IMG_2772 on
  # 2026-08-21, because that date had passed and a product film must not open on
  # a date already behind the viewer. The retired windows are in git.
fi

if have "$VENUE"; then
  # The venue step, which the film used to cover in 3.4s of a map and an empty
  # form. This recording walks the whole thing, so the film now shows the
  # product doing the work rather than the screen it does it on:
  #   1.0-2.4   the map opens on a dropped pin
  #   2.5-8.6   searching an address, real autocomplete answering
  #   8.7-10.4  the pin moves there, "Підтвердити"
  #  10.5-22.6  "Яке місце?" -> typing "Ресторан на даху с гарним видом" -> "Зчитую вайб…"
  #  22.6-25.5  "Думаю…"
  #  25.5-28.2  "Ось що я вловив" — the free text parsed back into chips
  #  28.2-31.5  back in the chat, "Передали Артём, чекаємо відповіді"
  #
  # Four of those seven are in the film. The opening map is dropped because the
  # confirm at 8.7 says the same thing with the search behind it, and "Думаю…"
  # is dropped because it is a button label changing for three seconds — the
  # chips screen makes the same point by showing the RESULT of the thinking.
  echo "the venue step (IMG_2730, 60fps -> 30, 576x1248 -> 1280):"
  cut_scaled place-search "$VENUE" 5.2  8.6   # typing "Володимирська", the list answering
  cut_scaled place-map    "$VENUE" 8.5  10.6  # the pin lands, "Підтвердити →"
  cut_scaled place-vibe   "$VENUE" 18.9 22.9  # the vibe finished, "Далі", "Зчитую вайб…"
  cut_scaled place-chips  "$VENUE" 26.1 28.15 # "Ось що я вловив" + the parsed chips
fi

if have "$ASK"; then
  # Replaces IMG_2590's take of the same beat. It is the same question and the
  # same answer, one run later; what it adds is the END of the exchange — the
  # answer actually sent, and the bot's «Обмірковую…» under it. The old window
  # stopped while the sentence was still in the input bar, so the film asked a
  # question and never showed it landing.
  echo "the question that does the work (IMG_2771):"
  cut chat-question     "$ASK" 2.7  6.2
fi

if have "$CAL"; then
  # The calendar act, all three shots, from one 9.5s take:
  #   0.9-2.7   «Обери дату» — 23/24/25 серпня carrying МЕТЧ badges
  #   2.8-4.8   the slot sheet opens on «вівторок, 25 серп.», 17:00 already lit
  #   4.9-6.5   the ЗБІГ toggle goes on, «Зберегти» becomes «Підтвердити»
  #   6.6-7.7   «Зберігаємо…»
  #   7.8-9.5   the butterfly, then the tick, over «вівторок, 25 серп. 17:00»
  #
  # The 2.0s of dead hold at 2.8-4.8 is elided by the cut between shots, which
  # is what a cut is for.
  echo "the calendar act (IMG_2772):"
  cut cal-dates         "$CAL" 0.80 3.05  # «Обери дату» — three days carry МЕТЧ
  cut cal-overlap       "$CAL" 4.80 6.60  # 17:00 is the shared slot; ЗБІГ goes on
  cut time-reveal       "$CAL" 6.50 9.46  # saving -> butterfly -> вівторок, 25 серп. 17:00
fi

if have "$CARD"; then
  # Replaces IMG_2604's date card. Same card, and the venue block — 📍 Hey Guys,
  # вулиця Дмитрівська 60, the grounded blurb — sits under it and is on screen
  # for the whole hold, which is what makes this the end of the venue story
  # rather than a poster.
  #
  # **It STOPS at 3.62s, and that number is measured rather than chosen**
  # (2026-08-21). At 3.65s the scroll brings «чт, 20 серпня о 13:00» into frame,
  # and this take is from the 20-серпня run while the calendar act above is from
  # the 25-серпня one. Ending before that line is what makes the film state a
  # date exactly once — in the calendar — instead of twice, differently. The
  # last clean frame is 3.617s; the shot runs to 3.55s.
  #
  # The cost, stated: the three actions the card carries (Відкрити в картах /
  # Змінити місце / Поділитися карткою) arrive AFTER the date line, so they are
  # out of the film. That is the trade — three buttons for a film that does not
  # contradict itself — and it is reversible the moment a date card exists from
  # the same run as IMG_2772.
  echo "the finished date card (IMG_2731):"
  cut date-card         "$CARD" 0.80 3.62
fi

if have "$TG"; then
  # The proof under the title card: home screen -> Telegram -> Gennety is the
  # chat at the top -> Start -> the Mini App takes over.
  #
  # **Sped 2.4x HERE, not in Remotion** (founder: «чтобы не растягивать видео,
  # стоит ускорить именно это видео»). Baking it into the clip means the file is
  # an ordinary 30 fps clip like the other seventeen and decodes like them; the
  # alternative asks the renderer to resample on the fly for the one shot with
  # no reason to be special. 8.75s of source becomes 3.65s on screen.
  #
  # `setpts` must come BEFORE `fps` — the other way round resamples first and
  # then throws away 60% of the frames it just made.
  echo "opening Telegram (IMG_2775, 2.4x):"
  ffmpeg -v error -y -ss 0.15 -to 8.90 -i "$TG" \
    -vf "setpts=PTS/2.4,fps=30" -an \
    -c:v libx264 -crf 17 -preset slow -pix_fmt yuv420p \
    "$HERE/public/footage/tg-open.mp4"
  echo "  tg-open"
fi

echo
if [ ${#MISSING[@]} -gt 0 ]; then
  echo "SKIPPED — source not found (its clips in public/footage/ are untouched):" >&2
  for f in "${MISSING[@]}"; do echo "  $f" >&2; done
  echo >&2
fi
echo "done. verify with: pnpm --filter @gennety/video render:hero:preview"
