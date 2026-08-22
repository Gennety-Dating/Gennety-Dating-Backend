# Gennety — product film production plan (`GennetyHero`)

> Delivered: 1080×1920, 30 fps, H.264, **62.8 s**, `out/gennety-hero.mp4`.
> Its first 44 s are cut entirely from seven screen recordings of the running
> product; the last 19 s are the title act (§E.1), the only drawn part.
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
| `IMG_2604.MP4` | 576×1280 | 2:15 | 30 | Match decision → calendar → time lock → departure pin → venue → date card. **One shot survives** (see below) |
| `IMG_2730.MP4` | 576×**1248** | 0:32 | **60** | The venue step end to end: map → address search → pin → the vibe typed out → «Ось що я вловив» chips |
| `IMG_2731.MP4` | 576×1280 | 0:05 | 30 | The finished **date card** and its venue block |
| `IMG_2771.MP4` | 576×1280 | 0:06 | 30 | The ideal-Friday question, answered, **sent**, and «Обмірковую…» |
| `IMG_2772.MP4` | 576×1280 | 0:09 | 30 | The whole **calendar act**: dates → the shared 17:00 → the lock |
| `IMG_2775.MP4` | 576×1280 | 0:09 | 30 | Opening Telegram and finding Gennety already there — **holds cut, 1.35×** for the title act |

All seven are the **`Gennety DEMO`** bot, from four separate runs: 2026-08-16
(`2588`/`2590`/`2604`), 2026-08-19 (`2730`/`2731`) and 2026-08-21
(`2771`/`2772`/`2775`). Everything the product says is **Ukrainian**, except
`IMG_2775`, which is the bot before a language has been chosen and is therefore
English on screen — correctly, since that is the state a new arrival meets.
Total 5:22 of source, and the title act adds 18 s that were never shot.

**`IMG_2604` is down to one shot**, and that is a decision rather than attrition.
Its venue step and date card went to `IMG_2730`/`IMG_2731` on 2026-08-19 (§E),
and its calendar act — `cal-dates`, `cal-overlap`, `time-reveal`, all reading
**неділя, 16 серпня, 13:00** — went to `IMG_2772` on 2026-08-21, because that
date had passed. A product film that opens on a date already behind the viewer
reads as abandoned, and no amount of grading fixes it. Only `match-decision`
still comes from that run.

**`IMG_2730` is 576×1248 and 60 fps, and neither is a problem.** The frame rate
is halved at extraction like everything else. The height differs because it is a
different capture aspect, not a crop: its status bar sits at exactly the same
rows as the other six (the recording dot is x 176–195, y 36–53 in all seven,
measured), and only the content below it is laid out 32 px shorter. So the one
part that has to agree with the drawn island already does, and
`scale=576:1280` stretches it 2.56 % on one axis and nothing else — invisible on
a map, a keyboard and a form, and strictly better than the two alternatives
(see the comment on `cut_scaled` in `scripts/extract-hero-footage.sh`).

**The first three sources no longer exist on the founder's Desktop**, so the
extraction script cannot regenerate the eight clips they still own. It skips a
missing source with a warning instead of refusing to run (changed 2026-08-19),
which is what lets it regenerate the nine the four newer sources own. Those
eight committed clips are the only surviving copy of their windows.

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
| **1:05–1:30** | **Type Radar** — full-screen portraits, "Не моє" / "Мій типаж", optional tag chips (Обличчя, Фігура, Волосся, Стиль, Тату, Борода, Загальний вайб) | ✓ 80.9–88.2 — the LAST stretch; see §E for why |
| 1:30–1:33 | "Готово — ми зберегли твої вподобання" | ✓ 88.5–93 |
| 1:33–1:47 | Photo request | ✗ not needed |

### B.3 `IMG_2604.MP4` — the date journey

| Timecode | State | Used |
|---|---|---|
| 0:00–0:02 | Verification note + "Хочеш піти з ним на побачення?" + "Да" + green **"Так, іду на побачення"** | ✗ *see note* |
| 0:02–0:12 | Calendar, first pass — picking 18:00/18:30/19:00, "Запропонувати час" | — |
| 0:12–0:13 | "Збережено ✓ Чекаємо співрозмовника" | — |
| **0:13–0:20** | Same decision thread, **completely static for 7 s** | ✓ 13–20 |
| 0:26–0:31 | "Обери дату" — the date list | ✗ **retired** 2026-08-21 → `IMG_2772` |
| 0:31–0:35 | 13:00 lights up — the slot both sides marked, then "Підтвердити" | ✗ **retired** → `IMG_2772` |
| 0:35–0:39 | The butterfly, then "неділя, 16 серп. 13:00" | ✗ **retired** → `IMG_2772` |
| 0:39–0:46 | Locked-time card in chat, then the departure-point map | ✗ **retired** 2026-08-19 → `IMG_2730` |
| 0:46–0:48 | Browser geolocation permission dialog | ✗ dev artifact |
| 0:48–0:54 | "Яке місце?" — free-text vibe + "Далі", field EMPTY | ✗ **retired** → `IMG_2730` |
| 0:54–1:57 | Concierge working, repeated locked-time card | ✗ static repetition |
| 1:58–2:05 | The date card — "Très Branché" | ✗ **retired** 2026-08-19 → `IMG_2731` |
| 2:05–2:15 | Buttons: Відкрити в картах / Змінити місце / Поділитися карткою | — |

**Six of the eight windows this table used to claim are retired**, and the
reasons differ. The venue step and date card were replaced because a better take
existed (§E). The calendar act was replaced because its date expired — it is the
only case in this project where a shot became unusable without changing.

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
   demo". It is covered where it actually sits — one opaque black rounded rect
   over the pill's measured bounds — rather than cropped away, because the pill
   IS the Dynamic Island in its expanded recording state, so blacking it out
   leaves an island rather than a patch. Nothing else in the frame is touched:
   the clock, the signal bars, the wifi arc, the battery and the island are the
   device's own, in the device's own colours. See §F.
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

## E. The cut — 17 shots of footage, 0:00–0:44

| # | Time | Beat | Source clip | From |
|---|---|---|---|---|
| 1 | 0.0–2.6 | Твоє ім'я — the quietest way in | basics-name | `2588` |
| 2 | 2.6–4.8 | The age slider settling | basics-age | `2588` |
| 3 | 4.8–7.4 | Gender — and the burst the tap throws | basics-gender | `2588` |
| 4 | 7.4–10.2 | Кого ти хочеш бачити — two columns of real photographs | basics-preference | `2588` |
| 5 | 10.2–12.6 | The height drum | basics-height | `2588` |
| 6 | 12.6–15.6 | **An honest question, answered and SENT** — «Вечеря на даху з бокалом гарного вина», then «Обмірковую…» | chat-question | `2771` |
| 7 | 15.6–22.0 | **Type Radar** — four faces, then the «Що зачепило?» tags | radar-swipe | `2590` |
| 8 | 22.0–23.6 | Готово | radar-done | `2590` |
| 9 | 23.1–26.7 | **Хочеш піти з ним на побачення?** The turn | match-decision | `2604` |
| 10 | 26.7–28.5 | The calendar opens — three days carry a МЕТЧ badge | cal-dates | `2772` |
| 11 | 28.5–30.1 | **17:00 is the shared slot** — the ЗБІГ toggle goes on | cal-overlap | `2772` |
| 12 | 30.1–32.7 | **Butterfly → вівторок, 25 серп. 17:00** | time-reveal | `2772` |
| 13 | 32.7–35.3 | **Звідки ти виїжджаєш** — typing a real address, autocomplete answering | place-search | `2730` |
| 14 | 35.3–37.0 | The pin lands, «Підтвердити →» | place-map | `2730` |
| 15 | 37.0–40.2 | **Яке місце?** — «Ресторан на даху с гарним видом», then «Зчитую вайб…» | place-vibe | `2730` |
| 16 | 40.2–42.0 | **«Ось що я вловив»** — the sentence parsed back into chips | place-chips | `2730` |
| 17 | 41.5–44.1 | **The date card** and the venue block under it | date-card | `2731` |

**The film states a date and a time exactly once**, in shots 11–12, and that is
structural rather than lucky. The venue act carries no date at all — the windows
were chosen inside the Mini App, which never shows one — and shot 17 is trimmed
to stop 0.1 s before its own date line scrolls into frame (§H.0). So nothing
downstream can contradict the calendar, and re-shooting the calendar alone is
enough to move the film's date.

### E.1 The title act — 0:43.6–1:02.2

Five drawn cards. **The only typography in the film that is not the product's
own**, and the reason it earns the exception is the same reason the rest of the
film has none: the interface carries the story wherever it can, and here it
cannot. The slogan is an argument against the product's whole category, and no
screen in the app says it — no screen ever will.

| # | Time | Card | What it does |
|---|---|---|---|
| A | 43.6–48.0 | «Щоб бути щасливим, / тобі не треба завантажувати застосунок для знайомств» | The claim, in two parts with a 0.7 s beat between them |
| B | 48.2–51.8 | «Щоб бути щасливим, / **тобі треба їх видалити**» | The turn. The only burgundy in the act |
| C | 52.1–55.1 | «Кожного дня у тебе є шанс на побачення» | The promise. One part, no beat — it is a fact, not a construction |
| D | 54.6–60.0 | Gennety · «Вже в Telegram» · the app being opened | The proof, `IMG_2775`, holds cut, 1.35× |
| E | 59.0–62.2 | The mark | Unchanged |

**Cards A and B are separated by black, C and D are not.** The founder asked for
the text to disappear and be written again — «затем текст исчезает, и в центре
появляется снова текст» — so A and B do not overlap at all and five frames of
pure `INK` sit between them. That blink is what makes the repeat land as a
second sentence rather than as one line being edited in place. C into D is a
crossfade instead: "every day you have a chance" and "already in Telegram" are
one thought, and the act has already spent its budget for hard blinks.

**Four decisions in it are measured rather than chosen**, and each is recorded
next to the number it produced in `src/hero/titles.ts`:

1. **The line breaks.** Unbounded 700 is a wide face — «тобі не треба
   завантажувати» is 18.6 em, which as one line caps at 49 px inside a 936 px
   box, i.e. not "big bold text" on a 1080-wide frame by any reading. The breaks
   were chosen by summing the font's own advance widths; the widest surviving
   line is «завантажувати» and it is what sets the type size.
2. **Tracking is POSITIVE (0.03 em), which is the opposite of the reflex.** It
   shipped at −0.02 em and «Вже» rendered with the В fused to the ж and the ж
   fused to the е. Going to the font's own metrics did not fix it either: a
   column scan of the render put the В|ж junction at 2 rows of contact and ж|е
   at 8. Letters touching is normal in this face — «Кожного дня» has three such
   pairs and reads perfectly — but ж between В and е does not resolve the way ж
   between о and н does.
3. **Cards A and B anchor their first line to the same y**, rather than each
   centring its own block. They open on the same two words, and a centred block
   puts that shared line one whole line lower on B, which reads as the words
   having moved rather than returned.
4. **The first card fades in over 14 frames.** A card is an opaque `INK` fill
   drawn over the world, so without it the date card was replaced in a single
   frame — measured at 46.0 → 7.6 of mean luminance, the largest brightness step
   in the film by a factor of 1.6 over anything the product itself does.

**The Telegram card mounts the film's second `<Iphone>`**, and §F's "exactly
one" was narrowed rather than waived: that rule protects against per-shot
handsets disagreeing about scale at a cut, and this one is outside the world,
after the camera has ended, at a fixed size, with no transform of its own.

---

**The venue act was rebuilt on 2026-08-19** (shots 13–16). It used to be two
shots and 3.4 s — a departure pin and an EMPTY «Яке місце?» form — which showed
the screen the concierge works on and never the work: the one field the whole
feature turns on was blank on camera. It is 9.3 s now, off `IMG_2730`.

**The calendar act was re-shot on 2026-08-21** (shots 10–12, all three from one
9.5 s take) because its date had passed, and shot 6 came from the same run so
the profiling beat and the calendar beat share a session. Between them the film
went 49.7 s → 46.8 s: the new calendar take is 2.6 s tighter than the old one
and the date card lost 1.2 s to the trim above. The title act then added 15.4 s
on top, taking the film to 62.2 s.

**The phone does not move.** Centred, unrotated, 604 px wide in world space for
the whole film. An earlier cut slid it left and right between beats for
compositional variety; that variety cost legibility — the eye re-finds the
screen on every cut instead of reading what is on it.

**The camera does, and only along one axis.** One global camera holds six
distances and steps closer between them — no pan, no roll, and the zoom never
reverses (`motion-audit.md`, `src/hero/camera.ts`). Its cadence and easing are
measured off the founder's reference; the one-direction rule is his. The per-shot `push`
this section used to describe is gone: it restarted at scale 1.0 on the first
frame of all fifteen shots, which is the reset the rebuild exists to remove.

**Nine cuts additionally carry a 6-14 frame crossfade**, sized to a measured
one-frame jump in screen brightness (up to 11.6 -> 34.2). They are still hard
cuts; what was removed is a flash, not an edit. Measured on the 1405-frame
render, the worst brightness step across ANY of the seventeen boundaries is
**1.60** (at the name → age cut, rank 91 of 1404 frames), and the film's twelve
largest steps are all INSIDE a shot — the Type Radar swipe, the world → mark
handover, and one Mini App screen transition. Two cuts had to be re-fixed on
2026-08-21 after the new footage landed: the question → radar cut went to 3.85
(the new take ends with the keyboard gone, so it is darker than the old one) and
the dates → slot-sheet cut to 4.40. Six frames of ramp each took them to 0.01
and 0.13.

**Rhythm.** 2.2–2.8 s holds through the profile; **6.4 s** on the Type Radar;
2.0–2.2 s cuts through the planning burst; 4.8 s on the card.

**The Type Radar window is chosen face by face, not by length**, and it took
three attempts. The clip's opening holds one man for 3.5 s, which reads as a
screenshot of a feature rather than as the AI learning a taste. Its middle
(7.0–13.5 s of the old extraction) bought five faces and swept in a mirror
selfie with the phone held across the face. The founder then named one further
profile specifically, and it was the first face in the window that replaced it.
The shot now runs the radar's LAST stretch — source 81.1–87.5 — four distinct
men with neither vetoed profile, closing on the **«Що зачепило?»** tag row.

That closing beat is the reason this ended up better than where it started: the
earlier windows ended on «Що не сподобалось?», so the film showed the AI being
told what somebody did NOT like, while this one shows it being told what worked.
Only the veto pushed the search far enough down the clip to find it.

The stakes are specific to this shot: it is the one place the film claims the
product has taste, so a frame nobody would swipe right on is not neutral filler
— it argues against the claim being made over it.

**Three dissolves only** — into the match decision, into the date card, into the
mark. Each is a 14-frame overlap in which **only the incoming shot fades**:
sequences are layered in array order, so an incoming fade over a fully-opaque
outgoing is a clean cross-dissolve, while fading both at once dips the picture to
roughly 60 % mid-transition. The other twelve transitions are hard cuts.

**Text.** None, apart from the wordmark and one line under it —
**«Твій AI-метчмейкер»**. The closing line is already on the date card and is
not repeated.

### E.2 The real-world act — commissioned, not yet shot

**Status: the brief only.** The founder is generating the footage
(2026-08-22: «люди как будто бы вместе: они бегают, что-то снимают друг друга,
обнимаются, бегают по пляжу, кушают вместе мороженое, дурачатся, играют вместе
в теннис, падают на траву или на песок»). Nothing here is built; this section
exists so the generated clips arrive usable rather than nearly usable.

**Why the film wants it.** Every frame so far is a screen. The slogan argues
that the point is not the app — and then the last thing on screen is the app.
Cutting out to two people who are actually together is the one shot that makes
the argument instead of stating it. It is also §H item 5, open since the film
was first cut.

**Where it lands — two places, and they are different jobs.**

1. **Behind «Кожного дня у тебе є шанс на побачення»** (the promise card, the
   third slogan). Footage under the type, with a scrim so the words hold. This
   is the one card in the act that states a fact rather than building a
   construction, so it is the one that can carry a picture without the picture
   competing with a pause.
2. **A clean run of two or three shots with NO text**, immediately before the
   mark — the founder's «чтобы не закрывать картинку текстом». Placement is the
   one thing worth confirming: it can sit before the Telegram card (…promise →
   b-roll → Telegram → mark) or after it (…Telegram → b-roll → mark). The first
   keeps the product as the last thing you see; the second keeps the people.

**What to generate.** Six to eight clips is enough to choose from — expect half
to be unusable, which is normal and is why the count is not four.

| | |
|---|---|
| Aspect | **9:16 vertical**, ideally 1080×1920. Anything else gets cropped, and a crop is what puts a head half out of frame. |
| Length | 3–5 s each. Longer is fine; the cut takes 1.5–2.5 s from each. |
| Frame rate | Any — everything is resampled to 30 fps at extraction. |
| Grade | **Warm.** Golden hour, sunlit, film-like. The film's palette is near-black, burgundy and white; a cold teal grade fights it and cannot be corrected back without the skin going grey. |
| Motion | Slow and handheld. **No fast whips or crash zooms** — the camera in this film holds still 62 % of the time (`camera.probe.ts`), and a violent b-roll move reads as a different film spliced in. |
| Framing | Leave the centre and the lower third uncluttered on at least two clips; those are the ones that go under the type. |
| Never | On-screen text, watermarks, logos, brand-visible clothing, phones in shot. **A phone in a shot about not needing the app is the one thing that would actively hurt.** |

**Two things to expect once the clips exist**, both stated now so they are not
surprises:

- **The film gets longer.** Two or three clean shots at ~2 s is +4–6 s on top of
  62.8 s, i.e. **~67–69 s**. The b-roll behind the promise card costs nothing —
  it plays under a card that already exists.
- **Brightness.** Sunlit footage against a near-black film is the largest
  luminance step the cut will contain, by a wide margin. It will need a fade
  rather than a hard cut, sized against the measured step — the same treatment
  §F records for the world→title handover.

## F. Technical strategy

**Every shot is RECORDING.** No production component is rendered directly, and
nothing is rebuilt. The one new element is the end card (Priority 3 — a brand
animation, not a product screen).

**No crop at all** at extraction: the full **576×1280** phone screen, status bar
included. Two earlier versions cropped — first the app chrome as well, then just
the status bar — and both had to draw something back. Neither survived review.

**The footage plays inside a drawn iPhone** (`ui/Iphone.tsx`). A screen
recording shown as a bare rectangle reads as a screenshot; inside a handset it
reads as somebody using the product, which is the claim the film is making. The
BODY is drawn rather than composited from a stock mockup because no mockup asset
exists here, a drawn one stays sharp at any size, and it can use the design
system's own palette.

**Its proportions are measured, not eyeballed.** The first version read as a
generic handset — the founder's words were "a mockup of some unknown phone" —
and rebuilding it was a matter of taking real numbers off an iPhone 16 Pro
(402 pt wide) and expressing every dimension as a fraction of screen width:
screen corner radius 62/402 ≈ **0.145** (was 0.098, which is a rounded rectangle
rather than a squircle and is the single biggest tell); a ~0.017 black display
border with a ~0.008 titanium rail outside it, as two layers, because from the
front that rail is a bright hairline and one grey band reads as plastic.

**The SCREEN, status bar included, is entirely the recording** — and that took
three attempts to get right. The strip carries the red screen-recording pill, so
the first two builds cropped it away and drew a replacement: first over a flat
black band, then over the clip's own top rows mirrored and blurred. Both read as
pasted on, and the founder's diagnosis was exact — a drawn strip keeps its own
colour while the app behind it changes, so it announces itself as something
added at the end. The mirrored backdrop fixed the colour and not the fact that
the glyphs were ours.

Nothing is cropped now. The clock, the signal bars, the wifi arc and the battery
are the device's own, over the real app, because they ARE that frame. **The one
exception is the Dynamic Island**, and it took a fourth attempt (2026-08-22).

The third build laid an opaque black rounded rect over the recording indicator
at its measured bounds — x 156–417, y 14–75. That removed the red and kept an
island, but it reproduced the shape underneath, and **iOS expands the Dynamic
Island while it is recording the screen**: measured at **253 × 56** against a
classic ~181 × 52, i.e. 38% too wide, in every clip, because the phone was
recording in every clip. The cover then added ~11px of its own on top. The
founder's read — "не как сейчас… выглядит ненатурально" — was exact.

**The island is now erased from the footage and redrawn.** The erase
(`island_erase` in the extraction script) stretches a horizontal gradient
between the two columns immediately outside it — x 146 and x 427, the only
pixels in that band belonging to neither the island nor the clock/battery —
across the whole box. It works because what sits behind a status bar is always a
blur or a flat fill, carrying no horizontal structure to smear. `ISLAND` in
`ui/Iphone.tsx` then draws a correct one: 181 × 52 at y 17, the width taken as a
fraction of the screen (Apple specifies 125 pt on a 393–402 pt screen) because
these recordings are scaled and no device's pixel dimensions can be assumed.

**Redrawing it does not reopen the pasted-on failure**, and the distinction is
the point: a status BAR carries glyphs and colour that have to agree with the
app behind them; an island at rest is a featureless black pill.

Three things worth knowing before touching it:

- **The erase is mandatory on the dark clips too**, which is not obvious — on
  eleven of the eighteen the whole strip measures RGB ~(3,3,3) and neither the
  island nor a cover is visible at all. But the red recording DOT sits at
  **x 176–195**, near the island's LEFT end, so any centred pill narrow enough
  to look classic leaves it exposed. Measured at RGB (245,62,49) against black
  on all eighteen.
- **Thirteen clips were erased in place**, not re-cut, because their sources are
  gone from the founder's Desktop (`scripts/erase-island-in-place.sh`). That
  costs one extra H.264 generation on those thirteen — imperceptible on flat UI
  colour at CRF 17, and a reason not to re-run it for no gain.
- **The two erase implementations must stay byte-identical.** A clip erased by
  the extraction script and one erased in place have to line up under the same
  drawn island.

**What taking the real status bar costs, stated rather than discovered later:**
the clock reads 02:04 in `IMG_2588`, 02:05 in `IMG_2590`, 19:39 in `IMG_2604`
02:47 in `IMG_2771`, 02:53 in `IMG_2772`, 03:26 in `IMG_2730`/`IMG_2731` and
03:56 in `IMG_2775`,
and the battery runs a green charging 90 %, a red 11 % across the question and
the calendar, and 50 % across the venue act. That cut is shot 9, which is
exactly where the story jumps forward in time anyway, so the clock change reads
as intended. The red battery is the one genuine wart, and it is accepted:
drawing a replacement battery is the pasted-on problem again, one badge at a
time. **The pill cover was re-verified against all seven sources** on
2026-08-21 — a saturated-red scan (`r>170, g<95, b<95`, which excludes the brand
burgundy) puts the indicator at x 176–194, y 34–53 in every clip, comfortably
inside the drawn rect. That scan has to exclude the battery badge as well as the
brand burgundy — at 11 % it is a saturated red at x ≈ 500, well outside the
island — so it is run over the island band only.

**The chips screen scrolls the app's own burgundy button under the status bar**,
so for most of shot 16 the strip either side of the island is burgundy rather
than dark. That is not a fault and must not be "fixed": the island itself is
still black there, the cover paints black on black, and what is left reads as an
ordinary translucent iOS status bar over coloured content. Widening the cover to
"tidy" the burgundy would put a black bar across a real button.

**The screen aperture is sized from the clip's real geometry** (`CLIP_W` /
`CLIP_H`, now the full 576×1280), so footage is never stretched to fit a handset
that does not match it.

`scripts/extract-hero-footage.sh` is the derivation and reproduces all 15 clips
byte-identically.

**One scene component, not fifteen** — and, since the camera rebuild, one
handset rather than fifteen. Every beat is the same object: a captured screen
playing inside the film's single phone, differing only in which clip, where in
it and how long, all of which is data in `timeline.ts`. Composition and camera
are no longer per-beat at all; they live in `camera.ts`. Fifteen near-identical
files would hide the cut; one page that can be read top to bottom expresses it.

---

## G. Audio

**The film renders silent.** No licensed track exists in this workspace, the
recordings carry only incidental phone audio, and this follows the workspace's
stated convention (`README.md`: *sound direction is chosen after the visual cut
is approved*).

`<Audio>` is wired behind a `musicVolume` prop defaulting to `0`, envelope
already shaped. Adding a track is one file at `public/audio/score.m4a` plus
`musicVolume: 0.8`. Time it against the cut's five accents: **15.6 s** (Type
Radar), **23.1 s** (the decision), **30.7 s** (the butterfly / 17:00), **40.2 s**
(«Ось що я вловив»), **41.5 s** (the date card), and then the title act's own
five landings — **43.6**, **48.2**, **52.1**, **54.6**, **59.0 s**. The act is
the one stretch with no product audio to work against at all, so it is where a
track has the most to do and the least to fight.

No SFX. Taps and confirmations would have to be synthesised from nothing, and
invented UI sound over real product footage is the template-motion-graphics tell
the brief rules out.

---

## H. Open items

0. **The date agrees with itself (opened 2026-08-19, closed 2026-08-21).**
   Kept because the shape of the fix is a constraint on anything that touches
   these shots again.

   The film used to state a date twice, differently: the calendar act (`IMG_2604`)
   locked **неділя, 16 серпня** across three shots while the new date card
   (`IMG_2731`) read **чт, 20 серпня**. Then the first date passed outright,
   which made re-shooting the calendar necessary anyway — so `IMG_2772` replaced
   all three shots with **вівторок, 25 серпня, 17:00**, and that alone would have
   made the disagreement *worse*, because the new take differs from the card in
   the time as well (17:00 against 13:00).

   What closed it is the trim on shot 17. **The date line enters `IMG_2731` at
   3.65 s** — measured frame by frame, the last clean frame is 3.617 s — and the
   venue block it exists to show is on screen from 1.6 s. So the shot runs to
   3.55 s and the film simply never states a second date. What it costs is the
   card's three actions (Відкрити в картах / Змінити місце / Поділитися карткою),
   which arrive after that line.

   **Three rules follow, and each is easy to break by accident:**

   - **Do not extend shot 17 past 3.55 s of its clip** without a date card from
     the same run as the calendar act. The extra second reads as a bonus and is
     a contradiction.
   - **The venue act (13–16) must stay date-free.** Its windows sit inside the
     Mini App, which never shows one; a window that drifts back into the chat
     would pick up `IMG_2730`'s **чт, 20 серпня** header.
   - **A film date is perishable.** 25 серпня expires too. The only durable
     answer is a card and a calendar that state a weekday and time without a
     calendar date, which the product does not offer — so treat a re-shoot of
     shots 10–12 as routine maintenance rather than a defect.

1. **No music.** The one genuinely missing deliverable; needs a licensed track,
   and the title act (§E.1) is now 18 s of it with nothing else on the soundtrack.
2. **The film is 62 s.** It was 45 s before the venue act and the slogan were
   added, and every second of the growth was asked for. Worth knowing rather
   than fixing blind: 62 s is fine on a site or in a deck and long for paid
   social. The cheapest 8 s, if it is ever wanted, are the two slogan holds and
   the Telegram card's tail — not the footage.
3. **The app-launch flash inside the Telegram card — softened, not gone.** The
   iOS launch animation compresses into a couple of frames; at 2.4× it measured
   a 7.9-point step in mean luminance, and at the 1.35× the clip now runs at it
   measures **7.0**. It remains the largest step in the film that is not the
   Type Radar. It is the product doing what a product does, inside a 348 px
   handset, so it is left alone — and the cheap lever for it is gone now that
   the speed is set by the beats rather than by a length budget.
4. **No "problem" act.** Nothing in these recordings covers the visual intro
   (the statistics and competitor cards). A capture of it would let the film
   open on *why* — though the slogan act now says a good deal of it at the end
   instead, which is a different and arguably better place for it.
5. **No real-world ending — but it is now a commissioned gap rather than an
   open one.** Lifestyle footage lets the film cut out of the app and land on
   two people meeting, which is the literal argument of both the date card's
   line and the slogan. The founder is generating it (2026-08-22); the brief and
   the two places it lands are §E.2.
6. **576×1280 source.** A production-bot capture at native resolution would
   remove the only compromise in the film's framing.
7. **`Gennety DEMO`, not production.** Cropped out of frame, but worth knowing
   before this is described as a production capture anywhere public.
