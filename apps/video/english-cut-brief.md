# The English cut of `GennetyHero` — handoff brief

> **Paste this whole file as the opening prompt of a fresh session.** It is
> written to be executable without the conversation that produced it.
>
> Written 2026-08-23, after measuring every source in `~/Desktop/EN mp4`. Every
> timestamp below is measured, not estimated; where I guessed I say so.

---

## 0. The task in one paragraph

`GennetyHero` is the Gennety product film: 62.8 s, 1080×1920, 30 fps, cut from
eighteen screen recordings of the running product, played inside one drawn
iPhone under one continuous camera, closing on a four-card drawn title act. It
is Ukrainian. **Build the English cut.** Same film — same shape, same rhythm,
same camera, same title act — from new English recordings, because the screens
are captures and captures cannot be re-lettered. This is a *localisation of the
edit*, not a new film: if you find yourself designing a beat that the Ukrainian
cut does not have, stop and re-read this line.

---

## 1. Read these before touching anything

In this order. They are long and they are the point — most of the decisions
below were made once already, expensively, and are recorded there.

| File | What it holds |
|---|---|
| `apps/video/video-production-plan.md` | §A recordings, §B recording map, §C quality audit, §D what was left out and why, §E the cut, §E.1 the title act, §F technical strategy |
| `apps/video/README.md` | working rules, the handset, re-cutting the footage |
| `apps/video/motion-audit.md` | why the camera was rebuilt as one global transform |
| `apps/video/src/hero/timeline.ts` | the cut, as data. Every `beat` note is a reason |
| `apps/video/src/hero/camera.ts` | the dolly. Six holds, five steps, monotone |
| `apps/video/src/hero/titles.ts` | the drawn act; the type measurements |
| `apps/video/scripts/extract-hero-footage.sh` | how every clip is derived |
| `DECISIONS.md` (repo root) | founder decisions, including several that constrain this work |

---

## 2. Invariants — do not re-litigate these

These are founder decisions and measured conclusions. They carry into the
English cut unchanged.

1. **No product UI is redrawn.** Every screen on camera is footage. The only
   drawn typography is the title act.
2. **The phone is static; only the camera approaches.** One `<World>`, one
   `<Iphone>` in it, one `cameraAt(frame)`. No pan, no roll, no per-shot
   transform. The zoom never reverses.
3. **The Dynamic Island is erased from the footage and redrawn by Remotion.**
   iOS expands the island while recording the screen, and the red dot sits at
   its left end (measured x 178–193 on the English sources too — the Ukrainian
   figure was 176–195, i.e. the same). `island_erase()` in the extraction script
   transfers **verbatim**; see §5.
4. **Speed changes are baked into extraction, never `playbackRate`.**
5. **The film states a date exactly once.** In Ukrainian this forced the date
   card to be trimmed short. In English it does not — see §4.5.
6. **Vertical only.** A horizontal variant would need a different edit.

---

## 3. The sources

Six recordings, all `576×1280 @ 30 fps` — the same geometry as the Ukrainian
sources, so `cut()` applies to all of them and **`cut_scaled()` is not needed**
(that helper exists only for IMG_2730, which was 576×1248).

```
~/Desktop/EN mp4/
  IMG_2790.MP4  138.7s  onboarding: Telegram chat → basics → back to chat → profiling Q&A
  IMG_2791.MP4   25.8s  the ideal-Friday answer, typed and sent, «Thinking…» under it
  IMG_2794.MP4   54.3s  the match decision → It's a match → Date Ticket → Ticket secured
  IMG_2795.MP4   67.0s  You're in → date planning → Pick a date → 17:00 → locked in → map
  IMG_2796.MP4   75.9s  the venue act end to end → the finished date card
  IMG_2798.MP4   35.0s  the Type Radar («Choose your type») → All set
```

### 3.1 `IMG_2790` — content map (measured at 1 s)

```
 0.0– 3.5   Telegram: the Gennety DEMO chat, "What can this bot do?", Start
 3.5– 5.5   "Synchronizing — Checking your onboarding state before the next step"
 5.5– 9.3   "Your name", empty  ⚠️ RUSSIAN (ЙЦУКЕН) KEYBOARD ON SCREEN
 9.3–10.0   keyboard switches; "English & Français" is printed on the spacebar
10.0–12.5   "Mary" typed → "Saving…"
12.5–15.5   "How old are you?" — 25 → 21 → "Saving…"
15.5–18.7   "Are you a man or a woman?" — cards flip to photos, "I'm a woman" tapped,
            the emoji burst lands at ~18.2
18.7–19.9   "Who do you want to meet?" — Men / Women / Both   ⚠️ ONLY ~1.2 s
19.9–24.6   "How tall are you?" — the drum spins 175 → 167
24.6–30.5   "Passing context to the bot" → "The bot is waiting for you"
30.5–31.5   "Done — Return to chat"
31.5–…      back in Telegram; the profiling questions and "Big tennis" being typed
```

### 3.2 `IMG_2798` — the Type Radar, card by card

Card changes measured by frame-to-frame difference (peak, /255 mean):

```
 1.20– 1.43  the card stack arrives                      (24.7)
 1.43– 4.85  CARD 1  — bearded, black tee, indoor;
             "What caught your eye?" tags appear ~3.4    (positive tags)
 4.85– 6.77  CARD 2  — mint tee, café;
             "What put you off?" tags appear ~5.6        (negative tags)
 6.77– 7.65  CARD 3  — grey shirt, rooftop at dusk        (34.9)
 7.65– 8.55  CARD 4  — beige, MIRROR SELFIE WITH A PHONE  (38.5)  ⚠️
 8.55– 9.55  CARD 5  — black shirt, restaurant            (49.5)
 9.55–10.50  CARD 6  — black tee, light background        (28.8)
10.50–12.50  CARD 7  — light purple shirt, bookshelves;
             "What put you off?" tags ~11.5               (50.5)
12.50–14.05  CARD 8  — blue shirt, curly hair             (28.1)
14.05–14.95  CARD 9  — dark shirt, dim                    (43.2)
14.95–17.95  CARD 10 — white tee, bar; tag panel ~15.9    (41.4 / 55.1)
17.95–18.95  CARD 11 — white tee, seated                  (28.0)
18.95–21.7   the butterfly, "Saving your taste…" → "All set —
             We've saved your preferences and we'll use them
             to find your matches."                       (69.6)
21.7–…       back in chat, "Checking your ratings" / "Reading your preferences"
```

### 3.3 The other four, in one line each

- **`IMG_2791`** — "Describe your ideal Friday night" answered with *"A private
  high floor pant house in Tokyo on a rainy night"*, sent, then "Thinking…".
  This is the English `chat-question`. The answer completes on camera, which is
  the whole reason the Ukrainian cut re-shot this beat.
- **`IMG_2794`** — "Want to go on a date with him? Just answer yes or no" → Yes →
  "Confirm below — and I'll take care of the rest" → **Yes, I'm going** →
  "Accepted ✨ Waiting on them" → "It's mutual 💚 Get your Date Ticket" → the
  ticket screens.
- **`IMG_2795`** — "You're in / Both tickets are secured" → Go to date planning →
  Pick a date (Mon 24 / Tue 25 / Wed 26 August carrying **MATCH** badges) →
  Wednesday 26 Aug, 17:00 marked **BOTH** → Confirm → the tick →
  "Wednesday 26 Aug 17:00" → "Your date is locked in ✨" → the WED 26 AUGUST
  17:00 card → "Mark where you'll be setting off from" → Pick on map → the map.
- **`IMG_2796`** — the map search ("TSUM") → Confirm → "What kind of spot?" →
  "Cafe" → Continue → "Thinking… ⟳" → "Here's what I picked up — tap to
  fine-tune" with the chip grid and **Looks right — find our spot** → the
  finished date card: *One Tea Tree, Reitarska St 30*, the review blurb, the
  peak-time note, **Wed 26 August at 17:00**, and three actions.

---

## 4. Gaps and decisions — resolve these before cutting

### 4.1 There is no English `tg-open` — **this is the one real blocker**

The Ukrainian film ends on the Telegram card: home screen → open Telegram →
Gennety is the chat at the top → Start → the Mini App takes over. Nothing in the
English set contains it. `IMG_2790` opens *already inside* the chat with a Start
button, which is half of it and has no app-open in it.

**Ask the founder for one more recording** before building the title act:

> ~9 seconds, phone UI language English. Start on the home screen. Open
> Telegram. The Gennety chat is at the top of the list — open it. Press Start.
> Let the Mini App take over and stop as soon as it has. Do not hurry; dead air
> is cut in extraction (the Ukrainian source was 8.9 s of which 3.96 s was
> frozen, and cutting the holds is what fixed it).

Build everything else first; the Telegram card is the last 5 s of the film and
does not block the other seventeen shots. If the founder declines, the fallback
is `IMG_2790` 0.0–3.5 s — the chat and the Start button, no app-open — and the
card's line has to stop claiming something the picture no longer shows.

### 4.2 The Russian keyboard in `basics-name`

At 5.5–9.3 s of `IMG_2790` the name screen carries a **ЙЦУКЕН keyboard**, and at
9.3–10.0 s the spacebar reads "English & Français" while the language switches.
Both are fatal to an English cut.

**Use 10.0–12.6 s**: "Mary" typing on the English keyboard, through "Saving…".
That is ~2.6 s against the Ukrainian shot's 2.6 s — it fits exactly. Verify the
spacebar label has faded by your in-point before you commit to it.

### 4.3 `basics-preference` is only ~1.2 s long

"Who do you want to meet?" holds for 18.7–19.9 s. The Ukrainian shot is 84
frames (2.8 s). You cannot have 2.8 s here.

Do not stretch it and do not loop it. Either run the shot at ~36 frames and give
the 48 frames back to `basics-height` (which has 4.7 s of source and can carry
them), or drop the shot and let "Are you a man or a woman?" carry the whole
preference beat. **Prefer the first** — the two columns of photographs are one
of the few frames in the act that is not type on black.

### 4.4 The Date Ticket act is new — and is not in this film

`IMG_2794` continues past the decision into "It's a match", "Claim your Date
Ticket", the ticket card, "Use a ticket — for you", "Ticket secured", and
`IMG_2795` opens on "You're in / Both tickets are secured". **None of this
exists in the Ukrainian cut.**

**Skip it.** This is a localisation, and the brief for it is parity. The cut
from "Yes, I'm going" straight to the calendar elides the ticket exactly the way
the Ukrainian cut elides two seconds of dead hold — that is what a cut is for.
Record the decision in `DECISIONS.md` so the next session does not "discover"
the missing beat and add it back. If the founder asks for it later it is one
shot from `IMG_2794` at ~40–44 s and it costs ~2 s of runtime.

### 4.5 The English date card may keep its date line

The Ukrainian `date-card` stops at 3.62 s of its source because the scroll
brought «чт, 20 серпня» into frame, and that take was from a different run than
the calendar — so the film would have stated two different dates. **The English
recordings do not have this problem**: `IMG_2795` locks *Wednesday 26 August
17:00* and the `IMG_2796` date card says *Wed 26 August at 17:00*. Same run,
same date.

So the English card can run past its date line and can include the three actions
(Open in Maps / Change venue / Share this card) that the Ukrainian cut had to
drop. Take them — but keep the shot's *length* in the Ukrainian range, because
the camera's last beat and the handover to the title act are built on it.

### 4.6 Continuity artefacts to check and then accept or fix

- **The clock jumps** across sources (08:17 → 08:22 → 09:05 → 09:08 → 09:31).
  The Ukrainian cut has the same class of artefact and it survives because
  nobody reads a 20 px clock inside a 604 px handset. Check it at full size once
  and then stop worrying about it.
- **Wifi vs LTE** in the status bar differs between sources. Same reasoning.
- **The profile name is "Mary"** and the radar shows men — consistent. The match
  ticket names *Gleb & Артём*, which is Cyrillic on an English card. Check
  whether it lands in any shot you keep; if it does, choose a window without it.

---

## 5. The Type Radar constraint — founder, 2026-08-23, hard

> «Я хочу, чтобы… в английской версии экран выбора типажа… показывались только
> первые две карточки и последние две. Ну и либо меньше… Короче, неважно,
> сколько ты будешь показывать карточек, но точно не больше четырёх. Используй
> либо первые две, либо последние две в видео.»

**At most four cards, drawn only from cards 1–2 and the final two.** Cards 3
through 9 do not appear. Fewer than four is fine.

Two things make this easy rather than awkward:

- **Card 4 is the mirror selfie with a phone across the frame.** The Ukrainian
  cut vetoed exactly that shot by hand. The rule excludes it for free.
- **Card 1 ends on the positive tags** ("What caught your eye?") and so does
  card 10 (~15.9 s). The Ukrainian cut deliberately chose a window that closes
  on positive tags, because it shows the AI being told what *worked* rather than
  counting rejections. Both ends of this recording give you that.

**Build it as two shots, not one spliced clip.** The head and the tail are ten
seconds apart in the source; splicing them into one file asks the viewer to
believe a continuity that is not there, and a bad join inside a swipe animation
is visible. The film already hard-cuts sixteen times — a cut between two radar
cards is the film's own grammar, and it costs nothing.

Recommended windows, to be verified against a filmstrip:

```
radar-first   IMG_2798  1.30 – 4.85   card 1 + its "What caught your eye?" tags   (3.55 s)
radar-last    IMG_2798 14.95 – 18.30   card 10 + its tag panel                    (3.35 s)
radar-done    IMG_2798 19.60 – 21.40   the butterfly → "All set"                  (1.80 s)
```

That is 6.9 s of radar against the Ukrainian cut's 6.4 s + 1.6 s — close enough
that the camera's beats barely move. If you need to save time, shorten
`radar-first` to end at 4.20 s (before the tag panel is fully read) rather than
cutting `radar-last`, because the tail is where the two-card rule earns its
keep: the AI is finishing, not starting.

**Do not add a fourth card unless the founder asks.** Three shots already read
as "it looked at several"; the constraint exists because they want it shorter,
not because two is a target.

---

## 6. Architecture — parameterise, do not fork

`GennetyAd.tsx` already localises this way and the workspace's own convention
(`README.md`, `.claude/skills/gennety-video`) says so: *a new locale is a new
`<Composition>` + a new copy block + a new timeline block, reusing the
component.* Copying `src/hero/` to `src/hero-en/` duplicates about 1 700 lines
of load-bearing reasoning and guarantees the two cuts drift. Do not do it.

The shape:

```ts
export type Lang = "uk" | "en";

// timeline.ts
export const SHOTS: Record<Lang, Shot[]> = {uk: [...], en: [...]};
export const WORLD_END = (lang: Lang) => { ... };

// camera.ts
const BEATS: Record<Lang, readonly Beat[]> = {uk: [...], en: [...]};
export const cameraAt = (frame: number, lang: Lang): CameraState => ...
export const glowAt  = (frame: number, lang: Lang): number => ...

// titles.ts
export const SLOGANS: Record<Lang, readonly SloganCard[]> = ...
export const TELEGRAM: Record<Lang, ...> = ...
export const MARK: Record<Lang, ...> = ...
export const HERO_DURATION_IN_FRAMES: Record<Lang, number> = ...

// GennetyHero.tsx — add `language: z.enum(["uk", "en"])` to the schema and
// thread it to World, TelegramCard and Mark. ScreenClip needs nothing: a
// Shot already carries its own `src`.

// Root.tsx — register `GennetyHeroEnglish`, 1080×1920, 30fps,
// durationInFrames: HERO_DURATION_IN_FRAMES.en.
```

**Footage paths need no code change.** Put the English clips in
`public/footage/en/` and set the English `Shot.src` values to
`"en/basics-name"`, `"en/radar-first"`, and so on. `ScreenClip` and
`TelegramCard` build `footage/${src}.mp4` already, so the subfolder falls out of
the data. Leave the Ukrainian clips where they are — thirteen of them can no
longer be regenerated (their sources are gone from the Desktop) and moving files
you cannot rebuild buys nothing.

`camera.probe.ts` takes a language argument and must be run for **both**.

---

## 7. Extraction

Write `scripts/extract-hero-footage-en.sh` next to the existing one. Do not
extend the Ukrainian script — its per-source `have()` guards and its comments
are a record of a specific set of recordings, and interleaving a second language
makes both unreadable.

Copy these **byte-identical** from `extract-hero-footage.sh`:

- `island_erase()` — verified against the English sources: the red recording dot
  is at x 178–193, the status strip measures RGB ~(3,3,3) on Mini App screens
  and ~96–105 mean luminance on the Telegram chat screens, and the sample
  columns x 146 and x 427 sit outside the island in both cases. Exactly the
  Ukrainian profile.
- `cut()`.

You do **not** need `cut_scaled()`. Every English source is already 576×1280.

The Telegram clip, when it arrives, gets the same treatment as the Ukrainian
one: profile it for frozen stretches, `trim`/`concat` the moving parts, then
`setpts=PTS/N,fps=30` — **`setpts` before `fps`**, and `setpts=PTS-STARTPTS` on
every segment or `concat` stacks the original timestamps. Aim for ~1.3–1.4×
after the holds are cut; the Ukrainian clip shipped at 2.4× and the founder read
it as far too fast, and the cause was dead air, not speed.

---

## 8. The cut

Match the Ukrainian shape. Its durations, as the target:

```
basics-name        78f   basics-age        66f   basics-gender     78f
basics-preference  84f   basics-height     72f   chat-question     90f
radar-swipe       192f   radar-done        48f   match-decision   108f
cal-dates          54f   cal-overlap       48f   time-reveal       76f
place-search       78f   place-map         51f   place-vibe        96f
place-chips        54f   date-card         78f
                                        WORLD_END = 1323f (44.1 s)
```

Where an English recording will not carry a shot's Ukrainian length, move the
frames to a neighbour in the same act rather than to the film's total — the
camera's beats are anchored to act boundaries, not to individual cuts. The two
known cases are §4.3 (preference, short) and §5 (radar, split in two).

`fadeIn` is **not** a stylistic choice. Nine Ukrainian shots carry 6–14 frames
of it purely to absorb a measured one-frame jump in mean luminance at the cut.
Re-derive them for English: render, measure the frame's mean luminance across
every boundary, and put a fade only where the step is large. A cut between two
similarly-lit screens gets nothing, because it needs nothing.

---

## 9. The title act, in English

`titles.ts` holds the reasoning; read it before rewording. Two rules matter more
than the translation:

- **The setup line is byte-identical on both slogan cards** (`SETUP`). The
  anaphora is the whole construction and it only works if the repeat is exact,
  to the pixel. Both cards are `anchorTop`.
- **Line breaks are measured, not eyeballed.** Unbounded 700 is a wide face. The
  box is `1080 − 2×72 = 936 px`, the size is 82 px, tracking `+0.03em`. The
  widest Ukrainian line is «завантажувати» at 10.16 em ≈ 833 px. Sum the font's
  own advance widths for every English line before you commit; a line that
  overflows does not wrap gracefully here, it breaks the layout.

Proposed copy — **all of it subject to the measurement above**:

```
SETUP        "To be" / "happy,"
card 1       "you don't need" / "to download" / "a dating app"
card 2       "you need" / "to delete them"          ← the accent card, burgundy
card 3       "Every day" / "is a chance" / "for a date"
Telegram     "Now on Telegram"
mark line    "YOUR AI MATCHMAKER"                   ← Roboto 34, plenty of room
```

Two notes on that list:

- **"Already on Telegram" is the literal translation and it will not fit.**
  Nineteen characters of Unbounded 700 at 82 px is roughly 967 px against a
  936 px box, and `TelegramCard` sets `whiteSpace: nowrap`, so it will not even
  wrap to tell you. "Now on Telegram" says the same thing in fifteen. If the
  founder wants the literal line, the card needs its own smaller size — and
  `titles.ts` argues at length that four cards at four sizes reads as four
  designs, so raise it with them rather than deciding it.
- **"Every day is a chance for a date"** is tighter than a literal rendering of
  «Кожного дня у тебе є шанс на побачення» and keeps the promise card to three
  short lines, which is what makes it the one card with no pause in it.

`fonts.ts` already loads Unbounded with a Latin sample string as well as a
Cyrillic one, so an English cut needs no change there. Leave both samples in —
the family is declared twice with `unicode-range` and dropping the Cyrillic
probe would break the Ukrainian cut.

---

## 10. The camera

`BEATS` frame numbers are absolute and therefore move whenever the cut does.
Re-space them for the English `WORLD_END`, keeping the shape:

- six held distances, five slow steps, **monotone** — the zoom never reverses;
- scale range 0.88 … 1.24 (a 1.30× worst-case upscale of the 576 px source);
- ~60 % of the world held still;
- every step placed *inside* a shot or crossing a cut mid-flight, never starting
  on one — a move that begins exactly when the screen changes reads as the cut
  having caused it.

Then run the probe for both languages. It fails loudly if either rule is broken.

---

## 11. Definition of done

```sh
pnpm --filter @gennety/video typecheck
pnpm --filter @gennety/video lint
pnpm --filter @gennety/video exec tsx src/hero/camera.probe.ts   # both languages
pnpm --filter @gennety/video exec remotion render GennetyHeroEnglish out/gennety-hero-en.mp4 --crf=16
```

And by eye, at full size:

- [ ] no Cyrillic anywhere on any screen in the film;
- [ ] no red recording dot and no expanded island on any frame;
- [ ] the Type Radar shows **at most four cards**, all of them from the first two
      or the last two;
- [ ] every cut inspected as a boundary frame, not skimmed in playback;
- [ ] the Ukrainian cut still renders — you changed shared files.

Then: commit and push (single branch `main`, explicit paths, never `git add -A`
— parallel sessions share this working tree), and write a `DECISIONS.md` entry
covering the Date Ticket act being deliberately skipped, the radar rule, and
whatever you resolved for the missing `tg-open`.
