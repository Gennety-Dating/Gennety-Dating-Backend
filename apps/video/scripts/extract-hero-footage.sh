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

# Two crop profiles, and they are the reason ui/Screen.tsx exists at all.
#
#   mini  576x1100 @ y=160 — drops the iOS status bar (with its red recording
#                            dot) and the Mini App's "Back / Close · ⌄ ···" row.
#   chat  576x860  @ y=320 — additionally drops Telegram's chat header, the
#                            pinned-message bar and the "Translate to English"
#                            strip, none of which belong in a product film.
mini() {
  ffmpeg -v error -y -ss "$3" -to "$4" -i "$2" \
    -vf "crop=576:1100:0:160,fps=30" -an \
    -c:v libx264 -crf 17 -preset slow -pix_fmt yuv420p \
    "$HERE/public/footage/$1.mp4"
  echo "  $1"
}
chat() {
  ffmpeg -v error -y -ss "$3" -to "$4" -i "$2" \
    -vf "crop=576:860:0:320,fps=30" -an \
    -c:v libx264 -crf 17 -preset slow -pix_fmt yuv420p \
    "$HERE/public/footage/$1.mp4"
  echo "  $1"
}

echo "profile basics (IMG_2588):"
mini basics-name       "$BASICS" 0.6  4.2   # "Твоє ім'я" typing out
mini basics-age        "$BASICS" 4.6  8.0   # the age slider settling on 21
mini basics-gender     "$BASICS" 8.4  11.9  # the question + the tap burst at ~10.3
mini basics-preference "$BASICS" 11.0 15.4  # two columns of real photographs
mini basics-height     "$BASICS" 14.6 19.2  # the height drum spinning

echo "understanding (IMG_2590):"
chat chat-question     "$PROFILE" 36.0 52.0 # ideal-Friday question + the honest answer
mini radar-swipe       "$PROFILE" 65.5 78.0 # Type Radar, several cards + tag chips
mini radar-done        "$PROFILE" 88.5 93.0 # "Готово" — it saved what it learned

echo "date journey (IMG_2604):"
# 13.0s, not 0.0s: the opening take runs into the calendar transition ~2s in,
# while this stretch holds the whole decision thread stable for 7 seconds.
chat match-decision    "$DATE" 13.0  20.0
mini cal-dates         "$DATE" 26.5  31.5   # "Обери дату"
mini cal-overlap       "$DATE" 30.8  35.6   # 13:00 lights up — the shared slot
mini time-reveal       "$DATE" 35.2  39.6   # butterfly + "неділя, 16 серп. 13:00"
mini place-map         "$DATE" 41.5  46.0   # departure pin (unused in the cut)
mini place-vibe        "$DATE" 48.5  53.5   # "Яке місце?"
chat date-card         "$DATE" 117.5 125.5  # Error 404: Chat not found. Try real life.

echo
echo "done. verify with: pnpm --filter @gennety/video render:hero:preview"
