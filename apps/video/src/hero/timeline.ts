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
    beat: "An honest question, an honest answer. The whole product in one exchange.",
    from: 378,
    durationInFrames: 90,
    src: "chat-question",
    trim: 336,
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
  {
    beat: "The calendar opens. Planning starts, and the cuts tighten.",
    from: 802,
    durationInFrames: 60,
    src: "cal-dates",
    trim: 36,
    fadeIn: 9,
  },
  {
    beat: "13:00 lights up — the slot both sides marked. Nobody negotiated it.",
    from: 862,
    durationInFrames: 66,
    src: "cal-overlap",
    trim: 30,
  },
  {
    beat: "The butterfly, then неділя, 16 серп. 13:00. The product's own brand moment.",
    from: 928,
    durationInFrames: 102,
    src: "time-reveal",
    trim: 18,
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
    from: 1030,
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
    from: 1108,
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
    from: 1159,
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
    from: 1255,
    durationInFrames: 54,
    src: "place-chips",
    trim: 3,
    fadeIn: 6,
  },
  {
    beat:
      "The date card: Error 404 — Chat not found. Try real life. Then the shot " +
      "scrolls off it to what is underneath — 📍 Hey Guys, вулиця Дмитрівська 60, " +
      "the grounded blurb, and Open in Maps / Change venue / Share. That scroll " +
      "is why this take replaced the old one: it ends the venue story instead of " +
      "ending on a poster.",
    from: 1295,
    durationInFrames: 114,
    src: "date-card",
    trim: 3,
    fadeIn: 14,
  },
];

/** The end card is the one shot that is not footage; it lives in its own scene. */
export const MARK: {from: number; durationInFrames: number} = {
  from: 1395,
  durationInFrames: 96,
};

export const HERO_DURATION_IN_FRAMES = MARK.from + MARK.durationInFrames; // 1491 = 49.7s
