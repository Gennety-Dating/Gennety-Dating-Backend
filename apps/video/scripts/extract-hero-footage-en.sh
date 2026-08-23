#!/usr/bin/env bash
#
# Regenerates public/footage/en/ for the ENGLISH cut of the GennetyHero film.
#
# Deliberately a SECOND script rather than a language flag on the first one.
# `extract-hero-footage.sh`'s per-source `have()` guards and its comments are a
# record of one specific set of recordings — thirteen of which no longer exist
# on the founder's Desktop and can never be regenerated. Interleaving a second
# language would make both unreadable and would put the irreplaceable Ukrainian
# windows one careless edit away from being lost.
#
# What IS shared, byte-identical, is `island_erase()` and `cut()`. Both were
# re-verified against the English sources rather than assumed (2026-08-23):
# the red recording dot measures x 178-193, the expanded island x 160-412 at
# y 44, the status strip is RGB ~(3,3,3) on Mini App screens and ~63-72 mean
# luminance on the Telegram/home screens, and the sample columns x 146 and
# x 427 sit outside the island in every case. That is the Ukrainian profile
# exactly, so the erase transfers without a single number changing.
#
# `cut_scaled()` is NOT here and is not needed: every English source is already
# 576x1280 at 30 fps. IMG_2730 was the only 576x1248 recording in the project.
#
# Sources — the founder's English screen recordings, OUTSIDE the repo:
#   IMG_2790.MP4  139s  onboarding: Telegram chat -> basics -> profiling Q&A
#   IMG_2791.MP4   26s  the ideal-Friday answer, typed and sent, "Thinking..."
#   IMG_2794.MP4   54s  the match decision -> It's a match -> Date Ticket
#   IMG_2795.MP4   67s  date planning -> Pick a date -> 17:00 -> locked in -> map
#   IMG_2796.MP4   76s  the venue act end to end -> the finished date card
#   IMG_2798.MP4   35s  the Type Radar ("Choose your type") -> All set
#   IMG_2802.MP4    8s  home screen -> Telegram -> Gennety -> Start -> Mini App
#
# Same policy as the Ukrainian script: a missing source is a WARNING, not an
# error, so the script always produces everything it can and names what it could
# not.
#
# Usage:  ./scripts/extract-hero-footage-en.sh [source-dir]
#         source-dir defaults to ~/Desktop/EN mp4
set -euo pipefail

SRC_DIR="${1:-$HOME/Desktop/EN mp4}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

BASICS="$SRC_DIR/IMG_2790.MP4"
ASK="$SRC_DIR/IMG_2791.MP4"
MATCH="$SRC_DIR/IMG_2794.MP4"
CAL="$SRC_DIR/IMG_2795.MP4"
VENUE="$SRC_DIR/IMG_2796.MP4"
RADAR="$SRC_DIR/IMG_2798.MP4"
TG="$SRC_DIR/IMG_2802.MP4"

MISSING=()

have() {
  if [ -f "$1" ]; then return 0; fi
  MISSING+=("$1")
  return 1
}

OUT="$HERE/public/footage/en"
mkdir -p "$OUT"

# ── ISLAND ────────────────────────────────────────────────────────────────────
# Copied verbatim from extract-hero-footage.sh; that file carries the full
# reasoning. Short version: iOS expands the Dynamic Island while recording, and
# the red dot sits at its LEFT end (x 178-193), so no centred pill narrow enough
# to look classic can cover it. This erases the island from the footage — a
# horizontal gradient built from the two columns immediately outside it, x 146
# and x 427 — and lets Remotion draw a correct one.
#
# The two load-bearing details, unchanged: the 1px crops need rgb24 first
# (a 1px crop of yuv420p is invalid), and it is the hstack of the two columns
# BEFORE the scale that makes it a gradient rather than a flat band.
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
    "$OUT/$1.mp4"
  echo "  en/$1"
}

if have "$BASICS"; then
  # The profile basics. Every window here starts AFTER 10.0s for one reason:
  # 5.5-9.3s of this recording carries a ЙЦУКЕН keyboard on the name screen, and
  # 9.3-10.0s has "English & Français" printed across the spacebar while the
  # language switches. Measured frame by frame, the spacebar label is gone by
  # 9.88s; `basics-name` starts at 9.80 and the film trims 3 frames past it.
  echo "profile basics (IMG_2790):"
  cut basics-name       "$BASICS"  9.80 12.85  # "M" -> "Mary" -> keyboard out -> "Saving..."
  cut basics-age        "$BASICS" 12.80 16.00  # 25, the slider dragged to 21, "Saving..."
  # The gender cards flip to photographs at 16.50 and the tap burst lands at
  # 17.80-18.50. 2.44s of clean screen, against the Ukrainian shot's 2.6s.
  cut basics-gender     "$BASICS" 16.05 18.85
  # **1.45s of source, against the Ukrainian shot's 2.8s.** The screen settles at
  # 18.85 and the next one replaces it at 20.33; there is no more of it than
  # this. It is NOT stretched and NOT looped — the missing frames went to
  # `basics-height` and `basics-age`, which have the source to carry them.
  # Two columns of real photographs is one of the few frames in this act that is
  # not type on black, which is why the shot survives at all.
  cut basics-preference "$BASICS" 18.78 20.50
  # The drum holds at 175, spins 21.43-22.70, and settles on 167. The window
  # stops at 24.10 rather than at the source's 24.60: 22.73-24.37 is a 1.6s dead
  # hold on the settled drum, and this act does not need a third of it.
  cut basics-height     "$BASICS" 20.85 24.10
fi

if have "$ASK"; then
  # The exchange COMPLETES on camera, exactly as the Ukrainian re-shoot does:
  # the answer finishes typing, is sent at 19.8, and "Thinking..." appears under
  # it at 20.3. Everything before 18.5 is 18 seconds of a sentence being typed.
  echo "the question that does the work (IMG_2791):"
  cut chat-question     "$ASK" 18.50 22.20
fi

if have "$RADAR"; then
  # ── THE FOUR-CARD RULE (founder, 2026-08-23) ──────────────────────────────
  # «сколько ты будешь показывать карточек, но точно не больше четырёх.
  #  Используй либо первые две, либо последние две в видео.»
  #
  # The source holds TWELVE cards. Cards 3 through 10 do not appear in the film,
  # and card 4 — a mirror selfie with the phone across the frame, the exact shot
  # the Ukrainian cut vetoed by hand — is excluded for free by the rule.
  #
  # Three cards ship, not four: card 1, and the last two. Fewer is explicitly
  # allowed and the constraint exists because the founder wants this act
  # SHORTER, so a fourth would be spending the concession it grants.
  #
  # **Two clips, not one splice.** The head and the tail are eleven seconds
  # apart in the source; joining them inside a swipe animation would ask the
  # viewer to believe a continuity that is not there. A cut between two radar
  # cards is the film's own grammar — it hard-cuts sixteen times.
  #
  # Both windows close on POSITIVE tags ("What caught your eye?"), which is the
  # beat the Ukrainian cut chose deliberately: the AI being told what WORKED
  # rather than counting rejections. Card 1's land at 3.93 and card 11's at 16.83.
  echo "the Type Radar (IMG_2798) — 3 cards, first + last two:"
  cut radar-first       "$RADAR"  2.00  4.95  # card 1 + "What caught your eye?"
  cut radar-last        "$RADAR" 16.05 19.10  # card 11 + its tags, swipe, card 12
  cut radar-done        "$RADAR" 19.65 21.50  # the butterfly -> "All set"
fi

if have "$MATCH"; then
  # **This window stops at 8.32 and the number is measured, not chosen.** At
  # 8.27 the bot prints "Passed to Артём, waiting for an answer" — Cyrillic, on
  # an English card. The shot itself runs to 8.07 (frames 3-107); what is left is
  # tail, only ever seen underneath the next shot's fade.
  #
  # The window also starts at 4.50 rather than at 3.65 where the question lands:
  # that stretch is a 2.07s dead hold on "Want to go on a date with him?" with a
  # keyboard under it, and eliding it is what a cut is for. The name "Артём, 29"
  # scrolls off the top before 4.0, so the whole shot is free of it.
  #
  # The Date Ticket act that follows in this recording (It's a match / Claim your
  # Date Ticket / Ticket secured, ~25-50s) is DELIBERATELY NOT EXTRACTED. It does
  # not exist in the Ukrainian cut and this is a localisation. See DECISIONS.md.
  echo "the decision (IMG_2794):"
  cut match-decision    "$MATCH" 4.50 8.32
fi

if have "$CAL"; then
  # The calendar act, all three shots from one take — and, as in the Ukrainian
  # cut, the ONLY place the film states a date. Wednesday 26 August, 17:00.
  #
  #  30.47  the date list paints: Mon 24 / Tue 25 / Wed 26 all carrying MATCH
  #  31.67  Wednesday is tapped, the slot sheet slides up
  #  33.00  17:00 goes from MATCH to BOTH; "Save" becomes "Confirm"
  #  35.30  "Saving... ⟳"
  #  35.80  the butterfly, then the tick, over "Wednesday 26 Aug 17:00"
  #
  # `cal-dates` is 1.3s of source against the Ukrainian shot's 1.8s — the list
  # paints at 30.47 and the sheet covers it at 31.67. The 15 frames it cannot
  # carry went to `cal-overlap`, which has 3.0s of source and only needs 2.1.
  echo "the calendar act (IMG_2795):"
  cut cal-dates         "$CAL" 30.42 32.05  # three days carry MATCH
  cut cal-overlap       "$CAL" 32.20 34.60  # 17:00 goes BOTH; Save -> Confirm
  cut time-reveal       "$CAL" 35.20 38.00  # saving -> butterfly -> Wed 26 Aug 17:00
fi

if have "$VENUE"; then
  # The venue act end to end, from the one recording that walks the whole thing:
  #   1.03-2.60   the map opens on a dropped pin
  #   2.67-7.05   "TSUM" typed, Places answers, the suggestion is tapped
  #   7.15-9.03   the pin sits on it, "Confirm →"
  #  9.60-17.07   "What kind of spot?" -> "Cafe" -> Continue -> "Thinking... ⟳"
  #  17.57-19.73  "Here's what I picked up — tap to fine-tune" + the chip grid
  #  71.57-75.87  the finished date card
  #
  # The opening map is dropped for the reason the Ukrainian cut drops it: the
  # confirm at 7.15 says the same thing with the search behind it.
  echo "the venue act (IMG_2796):"
  cut place-search      "$VENUE"  4.35  7.30  # typing "TSUM", the list answering
  cut place-map         "$VENUE"  7.10  9.20  # the pin, "Confirm →"
  cut place-vibe        "$VENUE" 14.20 17.75  # "Cafe", Continue, "Thinking... ⟳"
  cut place-chips       "$VENUE" 17.75 19.80  # the free text parsed back into chips
  # **The English card keeps its date line, and that is the one place this cut
  # is allowed to be longer than the Ukrainian one** (see §4.5 of the handoff
  # brief). The Ukrainian date-card stops at 3.62s because the scroll brought
  # «чт, 20 серпня» into frame from a different run than its calendar. Here the
  # calendar locks Wednesday 26 August 17:00 and this card says "Wed 26 August
  # at 17:00" — same run, same date — so the shot can run through the scroll:
  # the date line and the three actions (Open in Maps / Change venue / Share
  # this card) at 71.4, then the view rises to Error 404: Chat not found. Try
  # real life. with the venue block under it, settled from 73.1.
  cut date-card         "$VENUE" 71.20 75.30
fi

if have "$TG"; then
  # The proof under the title card: home screen -> Telegram -> the Gennety chat
  # -> Start -> the Mini App takes over.
  #
  # ── TWO STRETCHES OF THIS RECORDING MUST NOT SHIP ─────────────────────────
  #
  # (a) **The chat list, 0.83-2.18s, is ELIDED.** Checked by rendering the frame
  #     at the 348px the Telegram card actually delivers, not guessed at full
  #     size. Three rows carry Russian text, and one of them is the founder's own
  #     notification bot printing a live signup with a real person's name, age,
  #     gender, sought gender and city. That is not an alphabet problem and no
  #     amount of "nobody reads it at that size" makes it publishable. The same
  #     rows name internal tooling: Gennety dev, Gennety Playbook, gennety
  #     alerts, my Hermes Workspace.
  #
  #     So k1 ends at 0.80 — measured: the app card is still a small blurred
  #     rectangle and its rows are indistinguishable smudges at full resolution;
  #     by 0.83 they begin to resolve. It STARTS at 0.20 rather than 0.42: the
  #     first cut gave the home screen 0.38s, and on the render that was not a
  #     beat, it was a flash between the handset finishing its entrance and the
  #     chat arriving. 0.60s is long enough to read "this is a phone, and
  #     Telegram is on it", which is the only thing this segment has to say. The beat still reads, because what carries
  #     it is the icon lifting off the home screen. The cost, stated: the
  #     Ukrainian card showed Gennety is the chat at the TOP of the list, and
  #     this one does not. Recovering it needs a fifteen-second re-record with a
  #     publishable list — a clean account, or the internal chats archived.
  #     Muting them is not enough; muted chats still show their last message.
  #
  # (b) **The tail, 5.33-8.23s, is CUT.** The recording continues past the app
  #     taking over into "Your phone number" and then an iOS "Share Phone
  #     Number?" system alert. The card's beat is *this is a real thing you can
  #     open right now*, and it lands when the product appears. A permission
  #     dialog is not a payoff, and it would end a Gennety film on the one frame
  #     in it that belongs to Apple.
  #
  # ── NOT SPED UP, and that is a change from the Ukrainian clip's 1.35x ──────
  #
  # 4.46s of this 8.23s source is a frozen screen — 54%, against 44% there. That
  # source still had ~5s of action left after its holds were cut and needed
  # compressing; this one leaves 3.1s, and cutting the holds already does the
  # whole job. The founder's note on the Ukrainian version was that it read too
  # fast. (If a ramp is ever added: `setpts` goes BEFORE `fps`, or ffmpeg
  # resamples first and then throws away the frames it just made.)
  #
  # `setpts=PTS-STARTPTS` on every segment is not optional — without it concat
  # stacks the original timestamps and the clip plays back at the wrong length.
  #
  # Three segments, not five. The holds inside k2 and k3 are short enough to be
  # beats rather than dead air, and every join is one fewer place to see a seam.
  #   k1  0.20-0.80  the home screen, Telegram about to open  0.60s
  #   k2  2.20-3.72  the chat, Start pressed, the bot answers, Open Gennety
  #   k3  4.10-5.30  Open Gennety -> the Mini App -> "Synchronizing"
  echo "opening Telegram (IMG_2802, chat list elided, 1.0x):"
  ffmpeg -v error -y -i "$TG" -filter_complex "\
[0:v]trim=0.20:0.80,setpts=PTS-STARTPTS[k1];\
[0:v]trim=2.20:3.72,setpts=PTS-STARTPTS[k2];\
[0:v]trim=4.10:5.30,setpts=PTS-STARTPTS[k3];\
[k1][k2][k3]concat=n=3:v=1:a=0[cat];\
[cat]fps=30[f];$(island_erase f)" -map "[out]" -an \
    -c:v libx264 -crf 17 -preset slow -pix_fmt yuv420p \
    "$OUT/tg-open.mp4"
  echo "  en/tg-open"
fi

echo
if [ ${#MISSING[@]} -gt 0 ]; then
  echo "SKIPPED — source not found (its clips in public/footage/en/ are untouched):" >&2
  for f in "${MISSING[@]}"; do echo "  $f" >&2; done
  echo >&2
fi
echo "done. TG_CLIP_FRAMES in src/hero/titles.ts is derived from tg-open.mp4 —"
echo "re-read it after any re-cut:  ffprobe -v error -select_streams v:0 \\"
echo "  -show_entries stream=nb_frames -of csv=p=0 public/footage/en/tg-open.mp4"
