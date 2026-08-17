# Gennety — product film production plan (`GennetyHero`)

> Delivered: 1080×1920, 30 fps, H.264, **45.4 s**, `out/gennety-hero.mp4`.
> Cut entirely from three screen recordings of the running product.
> This is the audit behind the cut — what exists, what each clip shows, what is
> unusable and why, and the editorial decisions taken.

---

## 0. The premise

Three recordings were supplied. Between them they cover the product end to end:
the profile a person fills in, the questions the AI asks, the match decision,
the calendar landing on a shared time, the venue, and the date card.

That is enough for a complete film **without recreating a single screen**. Every
frame of UI on camera is footage. The only thing drawn in Remotion is the end
card. The camera is a CSS transform on a wrapper, so no product pixel is ever
repainted.

---

## A. Asset inventory

### A.1 The supplied recordings

| File | Res | Dur | fps | Covers |
|---|---|---|---|---|
| `IMG_2588.MP4` | 576×1280 | 0:19 | 30 | The five profile-basics screens: name, age, gender (+ tap burst), the photo preference fork, the height drum |
| `IMG_2590.MP4` | 576×1280 | 1:47 | 30 | Conversational profiling in Telegram → **Type Radar** → the photo request |
| `IMG_2604.MP4` | 576×1280 | 2:15 | 30 | Match decision → calendar → time lock → departure pin → venue → **date card** |

All three are the **`Gennety DEMO`** bot, in **Ukrainian**, recorded 2026-08-16.
Total 4:21 of source for a 45 s film — roughly a 6:1 shooting ratio, which is
why the plan is mostly about what to leave out.

### A.2 Brand assets already in the workspace

`public/brand/butterfly-logo.svg` (the mark the bot stamps on its own cards),
`brand/logo-wordmark.png`, and the `fonts/` set (Archivo Black, Roboto,
Unbounded). Design tokens from `gennety_design_system/DESIGN.md` and
PRODUCT_SPEC §3.7a: `INK #030303`, `SOFT #F5F5F5`, `WINE #8B253B`,
`WINE_LIGHT #D16B80`, `MUTED #A7A2A6`, `OUTLINE #1a1a1a`.

### A.3 Audio

None supplied, and the recordings carry only incidental phone audio. **The film
renders silent.** See §G.

---

## B. Recording map

Timecodes measured off filmstrips, not guessed.

### B.1 `IMG_2588.MP4` — profile basics

| Timecode | State | Used |
|---|---|---|
| 0:00–0:03 | "Твоє ім'я" — name typing, Ukrainian keyboard | ✓ 0.6–4.2 |
| 0:03–0:04 | Name settled, keyboard dropped | ✓ |
| 0:04–0:08 | "Скільки тобі років?" — the age slider, 25 → 21 | ✓ 4.6–8.0 |
| 0:08–0:09 | "Зберігаю…" | — |
| 0:09–0:11 | "Ти хлопець чи дівчина?" — **the tap burst fires at ~10.3** (flowers, hearts, a crown, a diamond) | ✓ 8.4–11.9 |
| 0:11–0:15 | "Кого ти хочеш бачити?" — two photo columns, Хлопців / Дівчат / І тих, і тих | ✓ 11.0–15.4 |
| 0:15–0:19 | "Який у тебе зріст?" — the height drum, 175 → 165 | ✓ 14.6–19.2 |

The whole clip is usable. It is also the highest-value 19 seconds in the set:
five distinct, purpose-built controls, none of which looks like a form.

### B.2 `IMG_2590.MP4` — understanding

| Timecode | State | Used |
|---|---|---|
| 0:00–0:35 | Chat opening, "Open Gennety", hobbies and partner-qualities questions, heavy typing | ✗ keyboard-dominated |
| **0:36–0:52** | **"Опиши ідеальний вечір п'ятниці — без обмежень щодо грошей і логістики. Тільки чесно — а не так, як «правильно» звучало б."** → answered *"Вечеря на даху с бокалом гарного вина"* | ✓ 36–52 |
| 0:52–1:04 | More chat, "Обрати типаж" CTA appears | — |
| **1:05–1:30** | **Type Radar** — full-screen portraits, "Не моє" / "Мій типаж", optional tag chips (Обличчя, Фігура, Волосся, Стиль, Тату, Борода, Загальний вайб) | ✓ 65.5–83 |
| 1:30–1:33 | "Готово — ми зберегли твої вподобання" | ✓ 88.5–93 |
| 1:33–1:47 | Photo request | ✗ not needed |

### B.3 `IMG_2604.MP4` — the date journey

| Timecode | State | Used |
|---|---|---|
| 0:00–0:02 | Verification note + "Хочеш піти з ним на побачення?" + "Да" + green **"Так, іду на побачення"** | ✗ *see note* |
| 0:02–0:12 | Calendar, first pass — picking 18:00/18:30/19:00, "Запропонувати час" | — |
| 0:12–0:13 | "Збережено ✓ Чекаємо співрозмовника" | — |
| **0:13–0:20** | Same decision thread, **completely static for 7 s** | ✓ 13–20 |
| 0:26–0:31 | "Обери дату" — the date list | ✓ 26.5–31.5 |
| **0:31–0:35** | **13:00 lights up** — the slot both sides marked, then "Підтвердити" | ✓ 30.8–35.6 |
| **0:35–0:39** | **The butterfly, then "неділя, 16 серп. 13:00"** | ✓ 35.2–39.6 |
| 0:39–0:46 | Locked-time card in chat, then **the departure-point map** | ✓ 41.3–45.8 |
| 0:46–0:48 | Browser geolocation permission dialog | ✗ dev artifact |
| 0:48–0:54 | "Яке місце?" — free-text vibe + "Далі" | ✓ 48.5–53.5 |
| 0:54–1:57 | Concierge working, repeated locked-time card | ✗ static repetition |
| **1:58–2:05** | **The date card** — *Error 404: Chat not found. Try real life.* — venue photo, polaroid, "Très Branché", address, 4.5/5 | ✓ 117.5–125.5 |
| 2:05–2:15 | Buttons: Відкрити в картах / Змінити місце / Поділитися карткою | — |

**Note on 0:00–0:02.** The richest single frame in the whole set is here — the
verification line, the question, the "Да", and the green button all visible at
once. It is not used because the shot only holds for ~2 s before the calendar
Mini App slides over it, and this is the film's emotional turn; it needed 3.8 s.
The 0:13–0:20 stretch carries the identical thread and is rock-steady, so the
cut takes the length over the marginally better framing.

---

## C. Quality audit

Stated plainly, because each of these constrained the cut:

1. **576×1280 against a 1080×1920 delivery.** The screen is shown at 604 px in
   every shot — a **1.05× upscale**, effectively native. That is the payoff of
   putting it inside a handset rather than blowing it up to fill the frame.
2. **One thing that must never appear: the red screen-recording pill** in the
   iOS status bar. It is the single element on screen that says "this is a
   demo". The extraction crop removes the status bar and only the status bar
   (`crop=576:1196:0:84`); a clean one is drawn back in `ui/Iphone.tsx`.
   Everything else stays — the Mini App nav row, Telegram's header, the pinned
   bar — because they are what a person actually sees when using this product.
3. **It is the `Gennety DEMO` bot**, not production. No dev badge is visible
   once cropped, but the film should not be described as production capture.
4. **Keyboard dominance.** Most of `IMG_2590` is someone typing, with an
   autocorrect bar. Only one chat exchange is used, and it is used *because*
   the typing is the point — an honest question getting an honest answer.
5. **One hard-unusable region**: the browser geolocation permission dialog at
   `IMG_2604` 0:46.
6. **Long static stretches.** `IMG_2604` 0:54–1:57 is a minute of the same
   locked-time card while the concierge works. Correct product behaviour,
   nothing to film.
7. **No reference video was supplied this time**, so the cut follows the
   brief's own direction (long holds early, tightening middle, one burst, long
   payoff) rather than matching a specific film.

---

## D. What was left out, and why

| Candidate | Decision |
|---|---|
| Photo upload / face detection | OUT — friction, not desire |
| "Open Gennety" / Mini App launch | OUT — plumbing |
| Hobbies + partner-qualities questions | OUT — one honest question says it better than three |
| First calendar pass (18:00/18:30/19:00) | OUT — the film shows the *overlap*, not the proposing |
| "Збережено · Чекаємо співрозмовника" | OUT — a waiting state, and the film should not wait |
| ~~Departure-point map pin~~ | **RESTORED** — cut once as a second "pick a place" beat, put back: without it the venue simply appears, and the point is that the concierge picks somewhere both people can reach |
| Concierge working (1 minute) | OUT — static |
| Post-card buttons (Maps / Змінити місце / Share) | OUT — the film ends on the card, not on a toolbar |
| Visual intro (statistics, competitor cards) | **NOT AVAILABLE** — not in these recordings |
| Lifestyle / real-world footage | **NOT AVAILABLE** |

**On the two that are missing.** Without an intro capture the film has no
"problem" act, and without lifestyle footage it cannot cut out of the app at the
end. Both were deliberately *not* substituted: the film opens on the product and
closes on the product's own line — *Error 404: Chat not found. Try real life.* —
which is the strongest available ending and needs no help. §H says what a
re-shoot would buy.

---

## E. The cut — 16 shots, 45.4 s

| # | Time | Beat | Source |
|---|---|---|---|
| 1 | 0.0–2.6 | Твоє ім'я — the quietest way in | basics-name |
| 2 | 2.6–4.8 | The age slider settling | basics-age |
| 3 | 4.8–7.4 | Gender — and the burst the tap throws | basics-gender |
| 4 | 7.4–10.2 | Кого ти хочеш бачити — two columns of real photographs | basics-preference |
| 5 | 10.2–12.6 | The height drum | basics-height |
| 6 | 12.6–15.6 | An honest question, an honest answer | chat-question |
| 7 | 15.6–22.1 | **Type Radar** — five faces go past | radar-swipe |
| 8 | 22.1–23.7 | Готово | radar-done |
| 9 | 23.2–26.8 | **Хочеш піти з ним на побачення?** The turn | match-decision |
| 10 | 26.8–28.8 | The calendar opens | cal-dates |
| 11 | 28.8–31.0 | **13:00 lights up** — the shared slot | cal-overlap |
| 12 | 31.0–34.4 | **Butterfly → неділя, 16 серп. 13:00** | time-reveal |
| 13 | 34.4–36.2 | **Звідки ти виїжджаєш** — the departure pin | place-map |
| 14 | 36.2–38.2 | Яке місце? | place-vibe |
| 15 | 37.8–42.6 | **The date card.** Longest shot in the film | date-card |
| 16 | 42.1–45.4 | The mark | — |

**The phone does not move.** Centred, unrotated, 604 px wide in every shot. An
earlier cut slid it left and right and varied its size between beats for
compositional variety; that variety cost legibility — the eye re-finds the
screen on every cut instead of reading what is on it. All the interest now comes
from the camera push (1.03×–1.055× per shot, never above 1.08) and from what the
product is doing.

**Rhythm.** 2.2–2.8 s holds through the profile; **6.5 s** on the Type Radar,
taken from that clip's fast stretch (7.0–13.5 s) so five distinct faces pass —
its opening sits on one man for 3.5 s, which reads as a screenshot of a feature
rather than as the AI learning a taste; 2.0–2.2 s cuts through the planning
burst; 4.8 s on the card.

**Three dissolves only** — into the match decision, into the date card, into the
mark. Each is a 14-frame overlap in which **only the incoming shot fades**:
sequences are layered in array order, so an incoming fade over a fully-opaque
outgoing is a clean cross-dissolve, while fading both at once dips the picture to
roughly 60 % mid-transition. The other twelve transitions are hard cuts.

**Text.** None, apart from the wordmark and one line under it —
**«Твій AI-метчмейкер»**. The closing line is already on the date card and is
not repeated.

## F. Technical strategy

**Every shot is RECORDING.** No production component is rendered directly, and
nothing is rebuilt. The one new element is the end card (Priority 3 — a brand
animation, not a product screen).

**One crop profile**, applied at extraction: **576×1196 @ y=84** — the whole
phone screen minus the iOS status bar, and nothing else.

**The footage plays inside a drawn iPhone** (`ui/Iphone.tsx`). A screen
recording shown as a bare rectangle reads as a screenshot; inside a handset it
reads as somebody using the product, which is the claim the film is making. It
is drawn rather than composited from a stock mockup because no mockup asset
exists here, a drawn one stays sharp at any size, and it can use the design
system's own palette. Two details are load-bearing:

- **The status bar is ours.** The recorded one carries the red screen-recording
  pill. It is cropped away and a clean one drawn back — OS chrome, not Gennety
  UI, so this does not breach the no-redrawing rule.
- **The screen aperture is sized from the clip's real geometry** (`CLIP_W` /
  `CLIP_H`), so footage is never stretched to fit a handset that does not match
  it.

`scripts/extract-hero-footage.sh` is the derivation and reproduces all 15 clips
byte-identically.

**One scene component, not fifteen.** Every beat is the same object — a captured
screen, framed — differing only in composition, camera and timing, all of which
is data in `timeline.ts`. Fifteen near-identical files would hide the cut; one
page that can be read top to bottom expresses it.

---

## G. Audio

**The film renders silent.** No licensed track exists in this workspace, the
recordings carry only incidental phone audio, and this follows the workspace's
stated convention (`README.md`: *sound direction is chosen after the visual cut
is approved*).

`<Audio>` is wired behind a `musicVolume` prop defaulting to `0`, envelope
already shaped. Adding a track is one file at `public/audio/score.m4a` plus
`musicVolume: 0.8`. Time it against the cut's four accents: **15.6 s** (Type
Radar), **23.2 s** (the decision), **31.0 s** (the butterfly / 13:00), **37.8 s**
(the date card).

No SFX. Taps and confirmations would have to be synthesised from nothing, and
invented UI sound over real product footage is the template-motion-graphics tell
the brief rules out.

---

## H. Open items

1. **No music.** The one genuinely missing deliverable; needs a licensed track.
2. **No "problem" act.** Nothing in these recordings covers the visual intro
   (the statistics and competitor cards). A capture of it would let the film
   open on *why*, which is the strongest thing it currently lacks.
3. **No real-world ending.** Lifestyle footage would let the film cut out of the
   app at 41 s and land on two people meeting — the literal argument of the date
   card's own line.
4. **576×1280 source.** A production-bot capture at native resolution would
   remove the only compromise in the film's framing.
5. **`Gennety DEMO`, not production.** Cropped out of frame, but worth knowing
   before this is described as a production capture anywhere public.
