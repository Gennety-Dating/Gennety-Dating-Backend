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

export const SHOTS: Shot[] = [
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
export const WORLD_END =
  SHOTS[SHOTS.length - 1].from + SHOTS[SHOTS.length - 1].durationInFrames; // 1323
