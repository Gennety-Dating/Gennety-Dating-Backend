#!/usr/bin/env bash
#
# Erases the expanded Dynamic Island from clips in public/footage/ that can no
# longer be re-cut, because their source recording is gone from the founder's
# Desktop.
#
# This exists only because of that. `extract-hero-footage.sh` applies the same
# erase (`island_erase`, and the reasoning lives there) to everything it cuts;
# thirteen of the eighteen clips have no source left to cut, so the erase has
# to be applied to the committed file itself:
#
#     IMG_2588 -> basics-name, basics-age, basics-gender,
#                 basics-preference, basics-height
#     IMG_2590 -> radar-swipe, radar-done
#     IMG_2604 -> match-decision
#     IMG_2730 -> place-search, place-map, place-vibe, place-chips
#     IMG_2731 -> date-card
#
# **It costs one extra H.264 generation on those thirteen.** That is the whole
# price and it is worth naming: the clips are CRF 17 screen recordings of flat
# UI colour, so a second pass at CRF 17 is imperceptible — but it is not free,
# and it is a reason not to run this repeatedly. It IS idempotent in effect (the
# columns it samples are outside the island and unchanged by a previous run), so
# a second run costs quality and changes nothing else.
#
# Usage:  ./scripts/erase-island-in-place.sh [clip ...]
#         with no arguments, the thirteen orphans above.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FOOTAGE="$HERE/public/footage"

DEFAULT=(
  basics-name basics-age basics-gender basics-preference basics-height
  radar-swipe radar-done
  match-decision
  place-search place-map place-vibe place-chips
  date-card
)

CLIPS=("$@")
if [ ${#CLIPS[@]} -eq 0 ]; then CLIPS=("${DEFAULT[@]}"); fi

# Kept byte-identical to `island_erase` in extract-hero-footage.sh. If one
# changes, change both — a clip erased by one and a clip erased by the other
# have to line up under the same drawn island in ui/Iphone.tsx.
island_erase() {
  echo "[$1]format=rgb24,split=3[base][sl][sr];\
[sl]crop=w=1:h=72:x=146:y=6[lc];\
[sr]crop=w=1:h=72:x=427:y=6[rc];\
[lc][rc]hstack=inputs=2,scale=w=272:h=72:flags=bilinear[grad];\
[base][grad]overlay=x=154:y=6[out]"
}

for clip in "${CLIPS[@]}"; do
  src="$FOOTAGE/$clip.mp4"
  if [ ! -f "$src" ]; then
    echo "  $clip — MISSING, skipped" >&2
    continue
  fi
  tmp="$FOOTAGE/.$clip.island.mp4"
  ffmpeg -v error -y -i "$src" \
    -filter_complex "$(island_erase 0:v)" -map "[out]" -an \
    -c:v libx264 -crf 17 -preset slow -pix_fmt yuv420p \
    "$tmp"
  mv "$tmp" "$src"
  echo "  $clip"
done

echo
echo "done. The drawn island lives in src/hero/ui/Iphone.tsx (ISLAND)."
