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
 * movement is one continuous camera, defined for the whole 45 seconds in
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
 * two handsets over each other. There are three, all at a change of register.
 *
 * Everything else is a hard cut, and stays one. Six of them additionally carry
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
   * whole fade: either the two shots already overlap (the three dissolves), or
   * `GennetyHero` extends the outgoing shot to cover it. So only the incoming
   * ever fades, over something fully opaque, and the picture cannot dip.
   *
   * Six shots carry a SHORT one (6-9 frames) and they are not dissolves — they
   * are still hard cuts, with the one-frame brightness step taken out of them.
   * Measured on the render: those six boundaries jumped the frame's mean
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
  {
    beat:
      "Звідки ти виїжджаєш — the departure pin. Cut from an earlier version and " +
      "restored: without it the venue simply appears, and the point is that the " +
      "concierge picks somewhere both people can actually reach. Trimmed to " +
      "1.5–3.3s of its clip: before that the Mini App is still loading, after it " +
      "a browser geolocation prompt covers the screen.",
    from: 1030,
    durationInFrames: 54,
    src: "place-map",
    trim: 45,
    fadeIn: 6,
  },
  {
    beat: "Яке місце? — the last thing a human says before the concierge takes over.",
    from: 1084,
    durationInFrames: 60,
    src: "place-vibe",
    trim: 30,
  },
  {
    beat:
      "The date card: Error 404 — Chat not found. Try real life. " +
      "The product closes its own film.",
    from: 1130,
    durationInFrames: 144,
    src: "date-card",
    trim: 78,
    fadeIn: 14,
  },
];

/** The end card is the one shot that is not footage; it lives in its own scene. */
export const MARK: {from: number; durationInFrames: number} = {
  from: 1260,
  durationInFrames: 96,
};

export const HERO_DURATION_IN_FRAMES = MARK.from + MARK.durationInFrames; // 1356 = 45.2s
