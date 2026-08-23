/**
 * The cut. **Only the cut** — this file no longer owns any motion.
 *
 * Every shot is a real capture of the running product, played inside a drawn
 * iPhone. `from`/`durationInFrames` are composition frames at 30 fps; `trim` is
 * frames into the source clip, measured against the filmstrips in
 * `video-production-plan.md` §B — do not nudge one without re-reading the clip.
 *
 * **The phone does not move, and neither does the shot.** The handset is a
 * single physical object at world (0, 0), the same size for the whole film; a
 * shot is a video that plays on its screen. Everything the viewer reads as
 * movement is one continuous camera, defined for the whole 50 seconds in
 * `camera.ts`, which does not know where these boundaries are.
 *
 * That is a change of ownership rather than a change of policy, and it
 * deliberately keeps half of the 2026-08-16 founder decision recorded in
 * DECISIONS.md while reversing the other half. Kept: the handset is never slid
 * sideways or rotated per beat, because the eye then re-finds the screen on
 * every cut instead of reading what is on it. Reversed: its apparent size and
 * framing DO change, continuously, because that is what a camera is — and the
 * old per-shot `push` was the thing that made a cut look like a jump, since
 * every shot restarted it at exactly 1.0 (`../../motion-audit.md` §3).
 *
 * So `push` and `y` are gone from `Shot`, not merely unused. A per-shot
 * transform is the bug; leaving the field would leave the way back to it.
 *
 * ## Two cuts, one component (2026-08-23)
 *
 * `SHOTS` is keyed by language. The English cut is the SAME FILM — same shape,
 * same acts, same two dissolves, same camera grammar — rebuilt from English
 * recordings, because every screen in it is a capture and a capture cannot be
 * re-lettered. It is a localisation of the EDIT, not a second film: where a beat
 * differs it is because the footage forced it, and the reason is written on the
 * shot.
 *
 * Copying this file to `hero-en/` was the obvious move and would have been the
 * wrong one — about 1700 lines of load-bearing reasoning duplicated, and two
 * cuts guaranteed to drift the first time either was touched. `GennetyAd.tsx`
 * already localises by parameter and the workspace's own convention says to.
 *
 * A `Shot` carries its own `src`, so the English clips simply live under
 * `public/footage/en/` and say so: `ScreenClip` builds `footage/${src}.mp4` and
 * the subfolder falls out of the data with no component change at all.
 *
 * Overlapping `from` values are the ONLY thing that produces a dissolve, and a
 * dissolve now crossfades the SCREEN inside one unmoving handset rather than
 * two handsets over each other. There are **two**, both at a change of
 * register: into the match decision, and into the date card. (This comment said
 * "three" until 2026-08-19; counted against the data it was never three.)
 *
 * Everything else is a hard cut, and stays one. Nine of them additionally carry
 * a 6-9 frame `fadeIn` — not to soften the edit, but to take out a measured
 * one-frame jump in BRIGHTNESS. See the field's own note.
 */

export const FPS = 30;

/**
 * The two cuts of the film. Ukrainian is the original; English is the same edit
 * rebuilt from English captures — see the note at the top of this file.
 */
export type Lang = "uk" | "en";

/**
 * The phone's screen width in WORLD px. Constant for the whole film.
 *
 * It is also the resolution budget: the source clips are 576 px wide, so 604 is
 * a 1.05x blow-up — effectively native — and the camera's zoom range in
 * `camera.ts` (0.88 … 1.24) is chosen so the worst upscale anywhere is ~1.30x.
 * Raising this number spends that budget.
 */
export const SCREEN_WIDTH = 604;

export type Shot = {
  from: number;
  durationInFrames: number;
  /** Clip under public/footage/, without the extension. */
  src: string;
  /** Frames into that clip. */
  trim: number;
  /**
   * Crossfade IN over this many frames — screen content only, never the phone.
   *
   * The film guarantees the outgoing clip is still playing underneath for the
   * whole fade: either the two shots already overlap (the two dissolves), or
   * `GennetyHero` extends the outgoing shot to cover it. So only the incoming
   * ever fades, over something fully opaque, and the picture cannot dip.
   *
   * Nine shots carry a SHORT one (6-9 frames) and they are not dissolves — they
   * are still hard cuts, with the one-frame brightness step taken out of them.
   * Measured on the render: those boundaries jumped the frame's mean
   * luminance by 8-23 points in a single frame («рост» -> chat was 11.6 -> 34.2),
   * and on a black page inside a motionless handset that reads as a flash. The
   * reference does not have the problem because its screens change with real
   * iOS transitions; six frames of ramp is the honest stand-in. A cut between
   * two similarly-lit screens gets nothing, because it needs nothing.
   */
  fadeIn?: number;
  fadeOut?: number;
  /** Editorial note — why this shot is in the film at all. */
  beat: string;
};

const SHOTS_UK: Shot[] = [
  {
    beat: "Твоє ім'я — the quietest way into the product.",
    from: 0,
    durationInFrames: 78,
    src: "basics-name",
    trim: 18,
  },
  {
    beat: "Скільки тобі років — the slider settling. A control, not a form field.",
    from: 78,
    durationInFrames: 66,
    src: "basics-age",
    trim: 12,
  },
  {
    beat: "The gender question, and the burst the tap throws — flowers, hearts, a crown.",
    from: 144,
    durationInFrames: 78,
    src: "basics-gender",
    trim: 6,
  },
  {
    beat: "Кого ти хочеш бачити — two columns of real photographs.",
    from: 222,
    durationInFrames: 84,
    src: "basics-preference",
    trim: 15,
    fadeIn: 6,
  },
  {
    beat: "The height drum, spinning. A control that behaves like an object.",
    from: 306,
    durationInFrames: 72,
    src: "basics-height",
    trim: 33,
    fadeIn: 6,
  },
  {
    beat:
      "An honest question, an honest answer. The whole product in one exchange " +
      "— and since 2026-08-21 the exchange COMPLETES on camera: «Вечеря на даху " +
      "з бокалом гарного вина» is sent, and «Обмірковую…» appears under it. The " +
      "previous take stopped while the sentence was still in the input bar, so " +
      "the film asked its best question and never showed it landing.",
    from: 378,
    durationInFrames: 90,
    src: "chat-question",
    trim: 3,
    fadeIn: 9,
  },
  {
    beat:
      "Type Radar. 6.4s, and WHICH 6.4s was decided face by face rather than " +
      "by length — the founder vetoed specific profiles twice. The clip's " +
      "opening holds one man for 3.5s (a screenshot of a feature, not an AI " +
      "learning a taste); its middle carries a mirror selfie with the phone " +
      "across the face; and one particular profile was named and excluded. " +
      "This window is the radar's LAST stretch: four distinct men, none of " +
      "them vetoed, closing on the «Що зачепило?» tags — the POSITIVE ones, " +
      "which are the better beat anyway, because they show the AI being told " +
      "what WORKED rather than counting rejections. See extract-hero-footage.sh.",
    from: 468,
    durationInFrames: 192,
    src: "radar-swipe",
    trim: 6,
    fadeIn: 6,
  },
  {
    beat: "Готово — it saved what it learned. Short, on purpose.",
    from: 660,
    durationInFrames: 48,
    src: "radar-done",
    trim: 30,
    fadeIn: 6,
  },
  {
    beat: "Хочеш піти з ним на побачення? The turn the film pivots on.",
    from: 694,
    durationInFrames: 108,
    src: "match-decision",
    trim: 6,
    fadeIn: 12,
  },
  // ---------------------------------------------------------------------------
  // The calendar act (re-shot 2026-08-21 from IMG_2772, all three from one take).
  //
  // The previous take (IMG_2604) locked неділя, 16 серпня — a date that had
  // passed by the time anyone would watch this, which is a product film opening
  // on a promise already behind the viewer. That, not a rendering fault, is why
  // it was replaced; the shots themselves were fine.
  //
  // It is also the film's ONLY statement of a date and time, by construction:
  // the venue act carries none, and `date-card` is trimmed to stop before its
  // own date line. So this act cannot be contradicted by anything downstream.
  // ---------------------------------------------------------------------------
  {
    beat:
      "The calendar opens on three days carrying a МЕТЧ badge. Planning starts, " +
      "and the cuts tighten.",
    from: 802,
    durationInFrames: 54,
    src: "cal-dates",
    trim: 6,
    fadeIn: 9,
  },
  {
    beat:
      "17:00 — the slot both sides marked. The ЗБІГ toggle goes on and «Зберегти» " +
      "becomes «Підтвердити», which is the whole negotiation: nobody argued, the " +
      "overlap just existed. The 2s of dead hold before this is elided by the cut.",
    from: 856,
    durationInFrames: 48,
    src: "cal-overlap",
    trim: 3,
    fadeIn: 6,
  },
  {
    beat:
      "Зберігаємо… then the butterfly, then вівторок, 25 серп. 17:00. The " +
      "product's own brand moment, and the one place in the film a date is " +
      "stated at all.",
    from: 904,
    durationInFrames: 76,
    src: "time-reveal",
    trim: 4,
  },
  // ---------------------------------------------------------------------------
  // The venue act (rebuilt 2026-08-19 from IMG_2730 / IMG_2731).
  //
  // It used to be 3.4s: a departure pin, then an EMPTY "Яке місце?" form with a
  // keyboard under it. That showed the screen the concierge works on and never
  // the work — the one field the whole feature turns on was blank on camera.
  // Four shots now carry the actual sequence: you search a real address, the pin
  // lands, you say what you want in your own words, and the product reads it
  // back to you as structure. 9.3s, and it is the reason the film is 4.5s longer.
  // ---------------------------------------------------------------------------
  {
    beat:
      "Звідки ти виїжджаєш — the departure point, as a real search. Typing " +
      "«Володимирська» and watching Places answer is what makes it a product " +
      "rather than a map screenshot; the previous take had no query in it at all.",
    from: 980,
    durationInFrames: 78,
    src: "place-search",
    trim: 12,
    fadeIn: 6,
  },
  {
    beat:
      "The pin lands on the picked address and «Підтвердити» is there to press. " +
      "Short on purpose — it is the receipt for the search above it, and the " +
      "source only holds it steady for ~1.7s before the next screen slides in.",
    from: 1058,
    durationInFrames: 51,
    src: "place-map",
    trim: 5,
  },
  {
    beat:
      "Яке місце? — and this time somebody answers it. «Ресторан на даху с " +
      "гарним видом» finishes typing, «Далі» is pressed, and the button becomes " +
      "«Зчитую вайб…». The keyboard leaves with it, so the shot ends calmer " +
      "than it started — which is the handover to the concierge.",
    from: 1109,
    durationInFrames: 96,
    src: "place-vibe",
    trim: 12,
    fadeIn: 6,
  },
  {
    beat:
      "«Ось що я вловив» — the free text parsed back into chips, with the ones " +
      "it picked already ticked. Nobody reads the labels at this size and they " +
      "do not need to: the frame says the sentence was UNDERSTOOD, which is the " +
      "concierge's whole claim and the one thing the old venue beat never showed.",
    from: 1205,
    durationInFrames: 54,
    src: "place-chips",
    trim: 3,
    fadeIn: 6,
  },
  {
    beat:
      "The date card: Error 404 — Chat not found. Try real life — with the venue " +
      "block sitting under it the whole hold: 📍 Hey Guys, вулиця Дмитрівська 60, " +
      "and the grounded blurb. That is why this take replaced the old one; it " +
      "ends the venue story instead of ending on a poster.\n\n" +
      "It STOPS before its own date line, and the number is measured: at 3.65s " +
      "of the source the scroll brings «чт, 20 серпня о 13:00» into frame, and " +
      "this take is from the 20-серпня run while the calendar above is from the " +
      "25-серпня one. Ending short is what keeps the film stating a date exactly " +
      "once. The cost is the card's three actions, which arrive after that line — " +
      "recoverable the moment a date card exists from the IMG_2772 run.",
    from: 1245,
    durationInFrames: 78,
    src: "date-card",
    trim: 3,
    fadeIn: 14,
  },
];


/**
 * The ENGLISH cut. Same eighteen beats, same order, same two dissolves.
 *
 * Windows and reasoning: `scripts/extract-hero-footage-en.sh`. Every number
 * below was measured against a filmstrip of the English sources on 2026-08-23,
 * not converted from the Ukrainian ones — the recordings are different takes of
 * the same product and share no timing.
 *
 * **Where the two cuts differ in LENGTH, the footage forced it and the shot says
 * so.** There are three such places and no others:
 *
 *   1. `basics-preference` is 43 frames against Ukrainian's 84. The screen only
 *      exists for 1.45s in the source. Its 41 frames went to `basics-height`
 *      and `basics-age`, which have the source to carry them — never to the
 *      film's total, because the camera's beats are anchored to act boundaries.
 *   2. The Type Radar is two shots and three cards, not one shot and four,
 *      because the founder capped it (see `radar-first`).
 *   3. `date-card` is 96 frames against 78, and this is the one place the
 *      English cut is deliberately LONGER — it can afford the card's own date
 *      line, which the Ukrainian one could not. See that shot.
 *
 * The world therefore ends at 1266 rather than 1323: 42.2s against 44.1s. The
 * missing 1.6s is almost entirely the radar, which is what the founder asked for.
 *
 * ## `fadeIn` is re-derived here, not copied
 *
 * The Ukrainian fades exist to absorb a MEASURED one-frame jump in brightness
 * at nine specific cuts (see the field's own note), so carrying the same nine
 * across would have been cargo cult: these are different screens in a different
 * order. Every boundary below was measured on the extracted clips — mean
 * luminance of the outgoing shot's last frame against the incoming shot's
 * first — and a fade was put only where the step is large. Screen-level step,
 * and the frame-level step it works out to once the handset's share of the
 * frame is accounted for:
 *
 *     name -> age                 3.8    1.5   —
 *     age -> gender              15.0    5.9   —   (the incoming clip opens on
 *                                                   the tail of iOS's own
 *                                                   transition, which already
 *                                                   ramps)
 *     gender -> preference       22.9    8.9   6
 *     preference -> height       29.0   11.3   6
 *     height -> chat-question    61.6   24.0   9
 *     chat-question -> radar     25.8   10.1   6
 *     radar-first -> radar-last  15.2    5.9   —   (a hard cut, deliberately:
 *                                                   see `radar-last`)
 *     radar-last -> radar-done   66.4   25.9   9
 *     radar-done -> decision     60.7   23.7  12   (dissolve)
 *     decision -> cal-dates      48.5   18.9   9
 *     cal-dates -> cal-overlap    0.3    0.1   —
 *     cal-overlap -> time-reveal  7.8    3.0   —
 *     time-reveal -> search       2.4    0.9   —
 *     search -> map               0.1    0.0   —
 *     map -> vibe                10.7    4.2   —
 *     vibe -> chips               1.4    0.5   —
 *     chips -> date-card         50.4   19.7  14   (dissolve)
 *
 * Seven boundaries carry a fade against the Ukrainian cut's nine, and five of
 * the Ukrainian ones' English counterparts get nothing — the venue act in
 * particular is four consecutive cuts between screens of near-identical
 * brightness. A cut between two similarly-lit screens gets nothing, because it
 * needs nothing.
 */
const SHOTS_EN: Shot[] = [
  {
    beat:
      "Your name — the quietest way into the product. The window starts at 9.80s " +
      "of the source and that is not a stylistic choice: 5.5-9.3s carries a " +
      "ЙЦУКЕН keyboard, and 9.3-9.9s has «English & Français» printed across the " +
      "spacebar while the language switches. Measured, the label is gone by " +
      "9.88s. Both would have been fatal to an English cut and neither is " +
      "recoverable by trimming a few frames.",
    from: 0,
    durationInFrames: 78,
    src: "en/basics-name",
    trim: 3,
  },
  {
    beat:
      "How old are you — the slider settling on 21. A control, not a form field. " +
      "12 frames longer than the Ukrainian shot; this source holds it for 3.0s " +
      "and the act has frames to place.",
    from: 78,
    durationInFrames: 78,
    src: "en/basics-age",
    trim: 3,
  },
  {
    beat:
      "The gender question, the cards flipping to photographs at 16.5s, and the " +
      "burst the tap throws. 72 frames rather than 78 because that is all the " +
      "clean screen there is — the next one replaces it at 18.57s.",
    from: 156,
    durationInFrames: 72,
    src: "en/basics-gender",
    trim: 3,
  },
  {
    beat:
      "Who do you want to meet — two columns of real photographs.\n\n" +
      "**1.43s, against the Ukrainian shot's 2.8s, and it is not stretched.** " +
      "The screen settles at 18.85s of the source and is gone at 20.33s; there " +
      "is no more of it. Looping it or slowing it would both be visible on two " +
      "grids of photographs, and the alternative — dropping the shot and letting " +
      "the gender question carry the whole preference beat — costs the act one " +
      "of its few frames that is not type on black. So it runs short, and the " +
      "41 frames are spent on its neighbours.",
    from: 228,
    durationInFrames: 43,
    src: "en/basics-preference",
    trim: 2,
    fadeIn: 6,
  },
  {
    beat:
      "The height drum, spinning 175 -> 167. A control that behaves like an " +
      "object. 12 frames longer than the Ukrainian shot, which is where half of " +
      "`basics-preference`'s shortfall went. It stops at 23.75s of the source " +
      "rather than 24.60s: what is left there is a 1.6s dead hold on a settled " +
      "drum, and taking all of it would have made the act's longest shot its " +
      "emptiest.",
    from: 271,
    durationInFrames: 84,
    src: "en/basics-height",
    trim: 3,
    fadeIn: 6,
  },
  {
    beat:
      "An honest question, an honest answer, and — as in the Ukrainian re-shoot " +
      "— the exchange COMPLETES on camera: «A private high floor pant house in " +
      "Tokyo on a rainy night» is sent at 19.8s and «Thinking…» appears under it. " +
      "Same length as the Ukrainian shot, from a source that holds 3.7s.",
    from: 355,
    durationInFrames: 90,
    src: "en/chat-question",
    trim: 3,
    fadeIn: 9,
  },
  {
    beat:
      "Type Radar, first card. The source holds TWELVE, and the founder capped " +
      "the film at four drawn only from the first two and the last two " +
      "(2026-08-23): «точно не больше четырёх. Используй либо первые две, либо " +
      "последние две». Three ship, not four — fewer is explicitly allowed and " +
      "the cap exists because they want this act shorter.\n\n" +
      "The rule also excludes, for free, the mirror selfie with the phone across " +
      "the frame that sits at card 4 — the exact shot the Ukrainian cut vetoed " +
      "by hand.\n\n" +
      "This shot closes on the «What caught your eye?» tags, the POSITIVE ones, " +
      "for the reason the Ukrainian cut chose them: they show the AI being told " +
      "what WORKED rather than counting rejections.",
    from: 445,
    durationInFrames: 80,
    src: "en/radar-first",
    trim: 3,
    fadeIn: 6,
  },
  {
    beat:
      "The radar's last two cards — card 11 with its own positive tags, the " +
      "swipe, and card 12.\n\n" +
      "**A second clip rather than a splice inside one**, and that is the whole " +
      "reason this is two shots. The head and the tail are eleven seconds apart " +
      "in the source; joining them inside a swipe animation would ask the viewer " +
      "to believe a continuity that is not there, and a bad join inside a moving " +
      "card is visible. A hard cut between two radar cards is the film's own " +
      "grammar — it cuts sixteen times.",
    from: 525,
    durationInFrames: 78,
    src: "en/radar-last",
    trim: 3,
  },
  {
    beat: "All set — it saved what it learned. Short, on purpose.",
    from: 603,
    durationInFrames: 48,
    src: "en/radar-done",
    trim: 3,
    fadeIn: 9,
  },
  {
    beat:
      "Want to go on a date with him? The turn the film pivots on: the question, " +
      "«Yes», «Love that ✨ Confirm below — and I'll take care of the rest», and " +
      "«Yes, I'm going».\n\n" +
      "**It stops at 8.07s of the source and the number is measured.** At 8.27s " +
      "the bot prints «Passed to Артём, waiting for an answer» — Cyrillic, on an " +
      "English card. It also starts at 4.60s rather than at 3.65s where the " +
      "question lands, because that stretch is 2.07s of dead hold with a keyboard " +
      "under it.\n\n" +
      "The Date Ticket act that follows in this recording — It's a match, Claim " +
      "your Date Ticket, Ticket secured — is deliberately NOT in this film. It " +
      "does not exist in the Ukrainian cut and this is a localisation; the cut " +
      "straight to the calendar elides it exactly the way the Ukrainian cut " +
      "elides two seconds of dead hold. Recorded in DECISIONS.md so the next " +
      "session does not «discover» it and add it back.",
    from: 637,
    durationInFrames: 104,
    src: "en/match-decision",
    trim: 2,
    fadeIn: 12,
  },
  // ---------------------------------------------------------------------------
  // The calendar act (IMG_2795, all three from one take).
  //
  // As in the Ukrainian cut this is the film's ONLY statement of a date — but
  // for the opposite reason. There, `date-card` had to be trimmed short to keep
  // it that way, because the card was from a different run than the calendar.
  // Here they are from the SAME run: the calendar locks Wednesday 26 August
  // 17:00 and the card says «Wed 26 August at 17:00». Nothing downstream can
  // contradict it, so nothing downstream has to be cut to protect it.
  // ---------------------------------------------------------------------------
  {
    beat:
      "The calendar opens on three days carrying a MATCH badge. Planning starts, " +
      "and the cuts tighten. 39 frames against the Ukrainian 54: the list paints " +
      "at 30.47s and the slot sheet covers it at 31.67s. The 15 frames went to " +
      "`cal-overlap` below, which has 3.0s of source and needs 2.1.",
    from: 741,
    durationInFrames: 39,
    src: "en/cal-dates",
    trim: 3,
    fadeIn: 9,
  },
  {
    beat:
      "17:00 — the slot both sides marked. The badge goes from MATCH to BOTH and " +
      "«Save» becomes «Confirm», which is the whole negotiation: nobody argued, " +
      "the overlap just existed.",
    from: 780,
    durationInFrames: 63,
    src: "en/cal-overlap",
    trim: 3,
  },
  {
    beat:
      "Saving… then the butterfly, then the tick, over «Wednesday 26 Aug 17:00». " +
      "The product's own brand moment, and the one place in the film a date is " +
      "stated at all.",
    from: 843,
    durationInFrames: 76,
    src: "en/time-reveal",
    trim: 3,
  },
  {
    beat:
      "Where are you setting off from — the departure point, as a real search. " +
      "Typing «TSUM» and watching Places answer with Khreschatyk St is what makes " +
      "it a product rather than a map screenshot.",
    from: 919,
    durationInFrames: 78,
    src: "en/place-search",
    trim: 3,
  },
  {
    beat:
      "The pin sits on the picked address and «Confirm →» is there to press. " +
      "Short on purpose — it is the receipt for the search above it.",
    from: 997,
    durationInFrames: 51,
    src: "en/place-map",
    trim: 3,
  },
  {
    beat:
      "What kind of spot? — and this time somebody answers it. «Cafe» is in the " +
      "field, Continue is pressed, and the button becomes «Reading your vibe…» " +
      "and then «Thinking…». Two states where the Ukrainian shot had one, which " +
      "is the handover to the concierge said twice.\n\n" +
      "**It stops on «Thinking…», one frame before the answer lands.** The " +
      "source keeps rolling and the chip grid scrolls into this very screen at " +
      "17.03s — the first cut of this act ran 8 frames past that, and the render " +
      "showed why it was wrong: the shot delivered the payoff itself, so the cut " +
      "that followed had nothing left to deliver and read as a scroll rather " +
      "than an edit. The result belongs to `place-chips`.",
    from: 1048,
    durationInFrames: 82,
    src: "en/place-vibe",
    trim: 3,
  },
  {
    beat:
      "«Here's what I picked up — tap to fine-tune» — the free text parsed back " +
      "into chips, with «Coffee & treats» already ticked. Nobody reads the labels " +
      "at this size and they do not need to: the frame says the sentence was " +
      "UNDERSTOOD, which is the concierge's whole claim.",
    from: 1130,
    durationInFrames: 54,
    src: "en/place-chips",
    trim: 3,
  },
  {
    beat:
      "The date card, and the one shot in the film that is LONGER than its " +
      "Ukrainian counterpart — 96 frames against 78, deliberately.\n\n" +
      "The Ukrainian card had to stop before its own date line, because that take " +
      "was from the 20-серпня run while its calendar was from the 25-серпня one, " +
      "and a film that states two different dates contradicts itself. The cost " +
      "was the card's three actions, which arrive after that line.\n\n" +
      "**This card has no such problem and therefore keeps all of it.** It opens " +
      "on the bottom of the card — «Wed 26 August at 17:00», Open in Maps, " +
      "Change venue, Share this card — then the view rises to *Error 404: Chat " +
      "not found. Try real life.* with the venue block under it: 📍 One Tea Tree, " +
      "Reitarska St 30, and the grounded blurb. Same run as the calendar, same " +
      "date, so the film still states it exactly once.\n\n" +
      "It settles at 73.1s and holds for 1.5s. That hold is the handover to the " +
      "title act and the closest the camera ever gets.",
    from: 1170,
    durationInFrames: 96,
    src: "en/date-card",
    trim: 3,
    fadeIn: 14,
  },
];

export const SHOTS: Record<Lang, Shot[]> = {uk: SHOTS_UK, en: SHOTS_EN};

/**
 * The last frame any footage is on screen — i.e. where the WORLD ends.
 *
 * Everything after it is the drawn title act (`titles.ts`), which has no phone
 * in it and therefore no camera. This is what `camera.ts`'s last beat is
 * anchored to and what `camera.probe.ts` measures over: before the title act
 * existed, "the film" and "the world" were the same span and the distinction
 * cost nothing. They are 543 frames apart now, and measuring the camera's
 * rhythm across seventeen seconds it does not govern would report a camera that
 * had gone quiet rather than one that had finished.
 */
export const WORLD_END = (lang: Lang): number => {
  const last = SHOTS[lang][SHOTS[lang].length - 1];
  return last.from + last.durationInFrames; // uk 1323, en 1266
};
