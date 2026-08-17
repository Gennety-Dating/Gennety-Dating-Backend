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
#   IMG_2604.MP4  135s   match decision -> calendar -> venue -> date card
#
# Usage:  ./scripts/extract-hero-footage.sh [source-dir]
#         source-dir defaults to ~/Desktop
set -euo pipefail

SRC_DIR="${1:-$HOME/Desktop}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

BASICS="$SRC_DIR/IMG_2588.MP4"
PROFILE="$SRC_DIR/IMG_2590.MP4"
DATE="$SRC_DIR/IMG_2604.MP4"

for f in "$BASICS" "$PROFILE" "$DATE"; do
  [ -f "$f" ] || { echo "missing source: $f" >&2; exit 1; }
done

mkdir -p "$HERE/public/footage"

# ONE crop profile: 576x1196 @ y=84 — the whole phone screen minus the iOS
# status bar.
#
# Only the status bar goes, and only because it carries the red screen-recording
# pill, which is the single thing on screen that says "this is a demo". A clean
# status bar is drawn back on in ui/Iphone.tsx. Everything else stays: the Mini
# App nav row, Telegram's header, the pinned bar. An earlier version cropped
# those away too and the result read as a cropped screenshot rather than as
# somebody using a phone.
cut() {
  ffmpeg -v error -y -ss "$3" -to "$4" -i "$2" \
    -vf "crop=576:1196:0:84,fps=30" -an \
    -c:v libx264 -crf 17 -preset slow -pix_fmt yuv420p \
    "$HERE/public/footage/$1.mp4"
  echo "  $1"
}

echo "profile basics (IMG_2588):"
cut basics-name       "$BASICS" 0.6  4.2   # "Твоє ім'я" typing out
cut basics-age        "$BASICS" 4.6  8.0   # the age slider settling on 21
cut basics-gender     "$BASICS" 8.4  11.9  # the question + the tap burst at ~10.3
cut basics-preference "$BASICS" 11.0 15.4  # two columns of real photographs
cut basics-height     "$BASICS" 14.6 19.2  # the height drum spinning

echo "understanding (IMG_2590):"
cut chat-question     "$PROFILE" 36.0 52.0 # ideal-Friday question + the honest answer
# The LAST stretch of the radar, not the first. Everything before ~81s was
# ruled out by the founder screen by screen: the opening holds one man for
# 3.5s, 74-75s is a mirror selfie with the phone across the face, and 75.5-76.5
# is a specific profile they asked to see gone. This window carries four
# distinct men and ends on the "Що зачепило?" tags — the POSITIVE ones, which
# is the better beat anyway. Extracted with ~0.3s of head slack and ~0.6s of
# tail slack; the shot itself is clip 0.2-6.6s.
cut radar-swipe       "$PROFILE" 80.9 88.2
cut radar-done        "$PROFILE" 88.5 93.0 # "Готово" — it saved what it learned

echo "date journey (IMG_2604):"
# 13.0s, not 0.0s: the opening take runs into the calendar transition ~2s in,
# while this stretch holds the whole decision thread stable for 7 seconds.
cut match-decision    "$DATE" 13.0  20.0
cut cal-dates         "$DATE" 26.5  31.5   # "Обери дату"
cut cal-overlap       "$DATE" 30.8  35.6   # 13:00 lights up — the shared slot
cut time-reveal       "$DATE" 35.2  39.6   # butterfly + "неділя, 16 серп. 13:00"
cut place-map         "$DATE" 41.3  45.8   # departure pin — usable window is 1.5-3.3s of this clip
cut place-vibe        "$DATE" 48.5  53.5   # "Яке місце?"
cut date-card         "$DATE" 117.5 125.5  # Error 404: Chat not found. Try real life.

echo
echo "done. verify with: pnpm --filter @gennety/video render:hero:preview"
