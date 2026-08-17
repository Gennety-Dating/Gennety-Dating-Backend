/**
 * The cut.
 *
 * Every shot is a real capture of the running product, played inside a drawn
 * iPhone. `from`/`durationInFrames` are composition frames at 30 fps; `trim` is
 * frames into the source clip, measured against the filmstrips in
 * `video-production-plan.md` §B — do not nudge one without re-reading the clip.
 *
 * **The phone does not move.** It is centred, unrotated and the same size in
 * every shot. An earlier cut slid it left and right between beats for
 * compositional variety, and that variety cost legibility: the eye re-finds the
 * screen on every cut instead of reading what is on it. Interest comes from the
 * camera push and from what the product is doing, not from where the handset
 * sits. `y` exists for a shot that needs a vertical nudge; there is deliberately
 * no horizontal equivalent.
 *
 * Overlapping `from` values are the ONLY thing that produces a dissolve. There
 * are three, all at a change of register. Everything else is a hard cut.
 */

export const FPS = 30;

/** The phone is this wide in every shot. Constant on purpose — see above. */
export const SCREEN_WIDTH = 604;

export type Shot = {
  from: number;
  durationInFrames: number;
  /** Clip under public/footage/, without the extension. */
  src: string;
  /** Frames into that clip. */
  trim: number;
  /** Camera push: [start, end] scale. Never above 1.08. */
  push?: [number, number];
  /** Vertical nudge only. Horizontal movement is deliberately not available. */
  y?: number;
  glow?: number;
  /** Fade edges in frames. 0 = hard cut on that side. */
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
    push: [1.0, 1.04],
    glow: 0.85,
    fadeIn: 20,
    fadeOut: 0,
  },
  {
    beat: "Скільки тобі років — the slider settling. A control, not a form field.",
    from: 78,
    durationInFrames: 66,
    src: "basics-age",
    trim: 12,
    push: [1.0, 1.035],
    glow: 0.85,
  },
  {
    beat: "The gender question, and the burst the tap throws — flowers, hearts, a crown.",
    from: 144,
    durationInFrames: 78,
    src: "basics-gender",
    trim: 6,
    push: [1.0, 1.04],
    glow: 0.85,
  },
  {
    beat: "Кого ти хочеш бачити — two columns of real photographs.",
    from: 222,
    durationInFrames: 84,
    src: "basics-preference",
    trim: 15,
    push: [1.0, 1.045],
    glow: 0.8,
  },
  {
    beat: "The height drum, spinning. A control that behaves like an object.",
    from: 306,
    durationInFrames: 72,
    src: "basics-height",
    trim: 33,
    push: [1.0, 1.035],
    glow: 0.85,
  },
  {
    beat: "An honest question, an honest answer. The whole product in one exchange.",
    from: 378,
    durationInFrames: 90,
    src: "chat-question",
    trim: 336,
    push: [1.0, 1.04],
    glow: 0.7,
  },
  {
    beat:
      "Type Radar. Held 6.5s, taken from the clip's fast stretch (7.0–13.5s) so " +
      "FIVE faces go past. The opening of that clip sits on one man for 3.5s, " +
      "which reads as a screenshot of a feature; several faces read as the AI " +
      "learning a taste, which is the actual claim.",
    from: 468,
    durationInFrames: 195,
    src: "radar-swipe",
    trim: 210,
    push: [1.0, 1.05],
    glow: 0.8,
  },
  {
    beat: "Готово — it saved what it learned. Short, on purpose.",
    from: 663,
    durationInFrames: 48,
    src: "radar-done",
    trim: 30,
    push: [1.0, 1.03],
    glow: 0.85,
  },
  {
    beat: "Хочеш піти з ним на побачення? The turn the film pivots on.",
    from: 697,
    durationInFrames: 108,
    src: "match-decision",
    trim: 6,
    push: [1.0, 1.045],
    glow: 0.75,
    fadeIn: 12,
  },
  {
    beat: "The calendar opens. Planning starts, and the cuts tighten.",
    from: 805,
    durationInFrames: 60,
    src: "cal-dates",
    trim: 36,
    push: [1.0, 1.035],
    glow: 0.8,
  },
  {
    beat: "13:00 lights up — the slot both sides marked. Nobody negotiated it.",
    from: 865,
    durationInFrames: 66,
    src: "cal-overlap",
    trim: 30,
    push: [1.0, 1.045],
    glow: 0.8,
  },
  {
    beat: "The butterfly, then неділя, 16 серп. 13:00. The product's own brand moment.",
    from: 931,
    durationInFrames: 102,
    src: "time-reveal",
    trim: 18,
    push: [1.0, 1.045],
    glow: 1,
  },
  {
    beat:
      "Звідки ти виїжджаєш — the departure pin. Cut from an earlier version and " +
      "restored: without it the venue simply appears, and the point is that the " +
      "concierge picks somewhere both people can actually reach. Trimmed to " +
      "1.5–3.3s of its clip: before that the Mini App is still loading, after it " +
      "a browser geolocation prompt covers the screen.",
    from: 1033,
    durationInFrames: 54,
    src: "place-map",
    trim: 45,
    push: [1.0, 1.04],
    glow: 0.8,
  },
  {
    beat: "Яке місце? — the last thing a human says before the concierge takes over.",
    from: 1087,
    durationInFrames: 60,
    src: "place-vibe",
    trim: 30,
    push: [1.0, 1.035],
    glow: 0.8,
  },
  {
    beat:
      "The date card: Error 404 — Chat not found. Try real life. " +
      "The product closes its own film.",
    from: 1133,
    durationInFrames: 144,
    src: "date-card",
    trim: 78,
    push: [1.0, 1.055],
    glow: 0.9,
    fadeIn: 14,
  },
];

/** The end card is the one shot that is not footage; it lives in its own scene. */
export const MARK: {from: number; durationInFrames: number} = {
  from: 1263,
  durationInFrames: 96,
};

export const HERO_DURATION_IN_FRAMES = MARK.from + MARK.durationInFrames; // 1359 = 45.3s
