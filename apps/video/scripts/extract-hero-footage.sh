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
# So the clock, the signal bars, the wifi arc and the battery are the device's
# own, in the device's own colours, over the real app. The ONE thing that is
# not is the Dynamic Island — see `ISLAND` below.

# ── ISLAND ────────────────────────────────────────────────────────────────────
#
# **iOS expands the Dynamic Island while it is recording the screen, and the
# expanded shape is what made the film look wrong** (founder, 2026-08-22:
# «сделать классического размера, а не как сейчас… она выглядит ненатурально»).
#
# Measured on the frames rather than estimated: the recording island occupies
# **x 160-412, y 17-72** (253 x 56) with a red outline reaching x 156-417,
# y 14-75, against a classic island of ~183 x 52. So it is 38% too wide, in
# every clip, because the phone was recording in every clip.
#
# The previous fix was a black rounded rect at the expanded bounds (a `PILL` in
# ui/Iphone.tsx). That removed the red and kept an island — but an island 264px
# wide, i.e. it made iOS's own over-wide shape *slightly wider still*. It also
# only mattered on the seven clips whose status bar is not black; on the other
# eleven the whole strip measures RGB ~(3,3,3) and neither the island nor the
# cover is visible at all.
#
# **This erases the island from the footage and lets Remotion draw a correct
# one.** The erase is a horizontal gradient between the two columns immediately
# outside the island — x 146 and x 427, the only pixels in that band that belong
# to neither the island nor the clock/battery — stretched across it. That works
# because what sits behind the status bar is always a blur or a flat fill, so it
# carries no horizontal structure to smear; verified on all seven clips where
# the strip is not black.
#
# Two details are load-bearing:
#
#   - **The crop is 1px wide and the filter chain converts to rgb24 first.**
#     A 1px crop of yuv420p is invalid (the chroma planes would be half a
#     pixel) and ffmpeg reports it as `width '0'`, which reads like a syntax
#     error rather than a format one.
#   - **hstack of the two 1px columns, THEN scale, is what makes it a
#     gradient.** Stretching one column alone paints a flat band, and the two
#     sides genuinely differ (Telegram's header measures (92,94,102) on the
#     left against (75,94,113) on the right). Bilinear across the pair
#     interpolates between them while each column keeps its own vertical
#     gradient.
#
# It also removes the red recording dot, which is the reason a smaller cover
# was never an option: the dot sits at **x 176-195**, near the island's LEFT
# end, so any centred pill narrow enough to look classic leaves it exposed —
# measured at RGB (245,62,49) against black on all eighteen clips.
# Takes the label of the stream to erase; leaves the result on [out].
# Written as a function rather than a string because both callers need it at a
# different point in their chain, and a shell substring edit on a filtergraph
# is the kind of clever nobody can read six months later.
island_erase() {
  echo "[$1]format=rgb24,split=3[base][sl][sr];\
[sl]crop=w=1:h=72:x=146:y=6[lc];\
[sr]crop=w=1:h=72:x=427:y=6[rc];\
[lc][rc]hstack=inputs=2,scale=w=272:h=72:flags=bilinear[grad];\
[base][grad]overlay=x=154:y=6[out]"
}

cut() {
  ffmpeg -v error -y -ss "$3" -to "$4" -i "$2" \
    -filter_complex "[0:v]fps=30[f];$(island_erase f)" -map "[out]" -an \
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
#
# The island erase runs AFTER the scale here, not before, so its band is the
# same rows in every clip in the film. Scaling first moves this source's island
# down by 2.56% (y 17-72 becomes y 17.4-73.8) and its outline to y 76.9 — still
# comfortably inside the 6-78 band the erase covers.
cut_scaled() {
  ffmpeg -v error -y -ss "$3" -to "$4" -i "$2" \
    -filter_complex "[0:v]fps=30,scale=576:1280[s];$(island_erase s)" -map "[out]" -an \
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
  # **Sped HERE, not in Remotion** (founder: «чтобы не растягивать видео,
  # стоит ускорить именно это видео»). Baking it into the clip means the file is
  # an ordinary 30 fps clip like the other seventeen and decodes like them; the
  # alternative asks the renderer to resample on the fly for the one shot with
  # no reason to be special.
  #
  # **1.35x, not the 2.4x it shipped at, and the speed is not what changed.**
  # The founder read the first cut as far too fast, and the cause was that
  # nearly half the source is a frozen screen: measured frame-to-frame, the
  # recording holds still for 0.0-0.85, 1.40-2.35, 4.15-4.85, 5.60-6.68 and
  # 8.15-8.53 — **3.96s of dead air out of 8.93s**. Speeding the clip up
  # therefore had to drag the six moments that carry the beat along with it,
  # and it bought nothing, because the frozen stretches are the same picture
  # however fast you play them.
  #
  # So the holds are cut and the action is slowed. The five windows below are
  # every stretch where something actually moves, and the cuts between them
  # land inside frozen frames — measured at 0.006-0.03 mean frame difference
  # against 20-58 for a real transition, i.e. the joins are not merely
  # unobtrusive, there is nothing there to see. Verified again on the finished
  # clip: the worst step at any of the four joins is 1.34, which is the level
  # of an ordinary cut elsewhere in the film, inside a 348px handset.
  #
  # The result is 4.13s of screen time carrying 4.13s of ACTION, against 3.65s
  # carrying about 2.05s. The beats get twice as long; the film grows by half a
  # second.
  #
  # `setpts` must come BEFORE `fps` — the other way round resamples first and
  # then throws away the frames it just made. `trim` is per-segment and its
  # `setpts=PTS-STARTPTS` rebases each one, or concat stacks their original
  # timestamps and the clip plays back at the wrong length.
  echo "opening Telegram (IMG_2775, holds cut, 1.35x):"
  ffmpeg -v error -y -i "$TG" -filter_complex "\
[0:v]trim=0.60:1.45,setpts=PTS-STARTPTS[k1];\
[0:v]trim=2.25:4.20,setpts=PTS-STARTPTS[k2];\
[0:v]trim=4.78:5.70,setpts=PTS-STARTPTS[k3];\
[0:v]trim=6.68:8.20,setpts=PTS-STARTPTS[k4];\
[0:v]trim=8.53:8.93,setpts=PTS-STARTPTS[k5];\
[k1][k2][k3][k4][k5]concat=n=5:v=1:a=0[cat];\
[cat]setpts=PTS/1.35,fps=30[f];$(island_erase f)" -map "[out]" -an \
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
