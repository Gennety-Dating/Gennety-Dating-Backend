#!/usr/bin/env bash
#
# Regenerates public/footage/ and public/audio/ for the GennetyHero product film.
#
# The clips ARE committed — the composition has to render on a fresh clone — but
# they are derived, and this is the derivation. Every window here was chosen
# against a contact sheet; the reasoning is in video-production-plan.md §B, and
# the frame offsets in src/hero/timeline.ts are measured against these exact
# in-points. Change a window and re-check TRIM.
#
# The sources are the founder's own recordings and live OUTSIDE the repo.
#
# Usage:  ./scripts/extract-hero-footage.sh [source-dir]
#         source-dir defaults to ~/Downloads
set -euo pipefail

SRC_DIR="${1:-$HOME/Downloads}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

SRC_PRODUCT="$SRC_DIR/IMG_1798.MP4"        # 592x1280 — full onboarding walkthrough
SRC_CHAT="$SRC_DIR/Gennety Ads.mp4"        # 1080x2336 — conversational profile, HD
SRC_LIFE="$SRC_DIR/Gennety Ad video.mp4"   # 1920x1080 — produced brand film

for f in "$SRC_PRODUCT" "$SRC_CHAT" "$SRC_LIFE"; do
  [ -f "$f" ] || { echo "missing source: $f" >&2; exit 1; }
done

mkdir -p "$HERE/public/footage" "$HERE/public/audio"

# --- Mini App screens -------------------------------------------------------
# crop=592:1130:0:150 drops the iOS status bar and Telegram's Russian nav row.
# That crop is why src/hero/ui/Phone.tsx exists: it frames what is left.
prod() {
  ffmpeg -v error -y -ss "$2" -to "$3" -i "$SRC_PRODUCT" \
    -vf "crop=592:1130:0:150,fps=30" -an \
    -c:v libx264 -crf 17 -preset slow -pix_fmt yuv420p \
    "$HERE/public/footage/$1.mp4"
  echo "  $1"
}
echo "product screens:"
prod intro-stats    40.0  50.0   # 75 hours / 9,500 swipes / $200, each counting up
prod intro-cards    60.5  73.0   # competitor carousel + rotating captions
prod intro-turn     72.5  79.5   # "So we built Gennety"
prod intro-promise  77.5  89.0   # the AI-matchmaker line typing out
prod intro-date     88.0 101.5   # the outcome chain, incl. "You both said yes"
prod intro-orb     103.5 112.5   # AI handoff — "Passing context to the bot"

# --- HD chat ----------------------------------------------------------------
# Crops below the user's bubble and above the input bar. The window is bounded:
# the soft keyboard opens at ~34.0s and drags Telegram's Russian chrome in.
echo "chat:"
ffmpeg -v error -y -ss 30.4 -to 34.0 -i "$SRC_CHAT" \
  -vf "crop=1080:620:0:505,fps=30" -an \
  -c:v libx264 -crf 17 -preset slow -pix_fmt yuv420p \
  "$HERE/public/footage/chat-question.mp4"
echo "  chat-question"

# --- Lifestyle --------------------------------------------------------------
# Centre 9:16 crop, then ONE lanczos upscale to delivery size — doing it here
# rather than letting the browser scale at render time.
life() {
  ffmpeg -v error -y -ss "$2" -to "$3" -i "$SRC_LIFE" \
    -vf "crop=608:1080:656:0,scale=1080:1920:flags=lanczos,fps=30" -an \
    -c:v libx264 -crf 18 -preset slow -pix_fmt yuv420p \
    "$HERE/public/footage/$1.mp4"
  echo "  $1"
}
echo "lifestyle:"
life life-rain     21.5 31.0
life life-bench    61.0 71.0
life life-field    83.0 89.0
life life-festival 89.5 98.0

# --- Music bed --------------------------------------------------------------
# Extracted, but NOT used: the film renders silent by default. This source is
# sparse sound design rather than a score (mean −35…−50 dB, 30.4 LU range), so
# it is inaudible under most of the cut. Kept as a reference bed — see the plan
# §A.4 and the musicVolume prop.
echo "audio:"
ffmpeg -v error -y -ss 52.0 -to 99.0 -i "$SRC_LIFE" -vn -ac 2 -ar 48000 \
  -c:a aac -b:a 192k "$HERE/public/audio/score.m4a"
echo "  score.m4a"

echo
echo "done. verify with: pnpm --filter @gennety/video render:hero:preview"
