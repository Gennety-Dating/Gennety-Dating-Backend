/**
 * The cut.
 *
 * Every shot is a real capture of the running product. `from`/`duration` are
 * composition frames at 30 fps; `trim` is frames into the source clip, measured
 * against the filmstrips in `video-production-plan.md` §B — do not nudge one
 * without re-reading the clip it points at.
 *
 * Overlapping `from` values are the ONLY thing that produces a dissolve. There
 * are three, all at a change of register: into the match decision, into the
 * date card, and into the mark. Everything else is a hard cut.
 *
 * Rhythm is an accelerando with a long payoff — calm 2.4–2.8s holds through the
 * profile, a 4.4s hold on the Type Radar (the film's "the AI is reading me"
 * beat), then 2.2s cuts through the planning burst, and 5s on the date card.
 */

export const FPS = 30;

/** Screen aspect ratios of the two crop profiles (see the extraction script). */
export const RATIO_MINIAPP = 576 / 1100; // Mini App: nav row cropped away
export const RATIO_CHAT = 576 / 860; // Telegram chat: header + pinned + translate cropped

export type Shot = {
  /** Composition frame this shot starts on. */
  from: number;
  durationInFrames: number;
  /** Clip under public/footage/, without the extension. */
  src: string;
  /** Frames into that clip. */
  trim: number;
  ratio: number;
  /** Panel width in composition px. Sets the upscale — the sources are 576 wide. */
  width: number;
  x?: number;
  y?: number;
  rotate?: number;
  /** Camera push: [start, end] scale. Never above 1.08. */
  push?: [number, number];
  glow?: number;
  /** Fade edges in frames. 0 = hard cut on that side. */
  fadeIn?: number;
  fadeOut?: number;
  /** Editorial note — why this shot is in the film at all. */
  beat: string;
};

export const SHOTS: Shot[] = [
  {
    beat: "Хто ти — the name field, and the quietest way into the product.",
    from: 0,
    durationInFrames: 84,
    src: "basics-name",
    trim: 18,
    ratio: RATIO_MINIAPP,
    width: 596,
    push: [1.0, 1.045],
    glow: 0.85,
    fadeIn: 20,
    fadeOut: 0,
  },
  {
    beat: "Скільки тобі років — the slider settling. A control, not a form field.",
    from: 84,
    durationInFrames: 72,
    src: "basics-age",
    trim: 12,
    ratio: RATIO_MINIAPP,
    width: 654,
    push: [1.0, 1.04],
    glow: 0.85,
    fadeIn: 0,
    fadeOut: 0,
  },
  {
    beat: "The gender question — and the burst the tap throws — flowers, hearts, a crown.",
    from: 156,
    durationInFrames: 78,
    src: "basics-gender",
    trim: 6,
    ratio: RATIO_MINIAPP,
    width: 654,
    x: -76,
    rotate: -1.1,
    push: [1.0, 1.04],
    glow: 0.85,
    fadeIn: 0,
    fadeOut: 0,
  },
  {
    beat: "Кого ти хочеш бачити — two columns of real photographs, the most striking screen in onboarding.",
    from: 234,
    durationInFrames: 84,
    src: "basics-preference",
    trim: 15,
    ratio: RATIO_MINIAPP,
    width: 862,
    push: [1.0, 1.05],
    glow: 0.7,
    fadeIn: 0,
    fadeOut: 0,
  },
  {
    beat: "The height drum, spinning. A control that behaves like an object.",
    from: 318,
    durationInFrames: 72,
    src: "basics-height",
    trim: 33,
    ratio: RATIO_MINIAPP,
    width: 654,
    x: 82,
    rotate: 1.1,
    push: [1.0, 1.04],
    glow: 0.85,
    fadeIn: 0,
    fadeOut: 0,
  },
  {
    beat: "The bot asks an honest question and gets an honest answer. The whole product in one exchange.",
    from: 390,
    durationInFrames: 96,
    src: "chat-question",
    trim: 336,
    ratio: RATIO_CHAT,
    width: 792,
    push: [1.0, 1.04],
    glow: 0.6,
    fadeIn: 0,
    fadeOut: 0,
  },
  {
    beat: "Type Radar. The film's hero AI beat — held longest of the middle shots.",
    from: 486,
    durationInFrames: 132,
    src: "radar-swipe",
    trim: 60,
    ratio: RATIO_MINIAPP,
    width: 878,
    push: [1.01, 1.06],
    glow: 0.75,
    fadeIn: 0,
    fadeOut: 0,
  },
  {
    beat: "Готово — it saved what it learned. Short, on purpose.",
    from: 618,
    durationInFrames: 54,
    src: "radar-done",
    trim: 30,
    ratio: RATIO_MINIAPP,
    width: 566,
    push: [1.0, 1.03],
    glow: 0.85,
    fadeIn: 0,
    fadeOut: 12,
  },
  {
    beat: "Verified, then: хочеш піти з ним на побачення? The turn the film pivots on.",
    from: 662,
    durationInFrames: 114,
    src: "match-decision",
    trim: 6,
    ratio: RATIO_CHAT,
    width: 792,
    push: [1.0, 1.05],
    glow: 0.7,
    fadeIn: 12,
    fadeOut: 0,
  },
  {
    beat: "The calendar opens. Planning starts, and the cuts tighten.",
    from: 776,
    durationInFrames: 66,
    src: "cal-dates",
    trim: 36,
    ratio: RATIO_MINIAPP,
    width: 668,
    x: -70,
    rotate: -1,
    push: [1.0, 1.04],
    glow: 0.8,
    fadeIn: 0,
    fadeOut: 0,
  },
  {
    beat: "13:00 lights up — the slot both sides marked. Nobody negotiated it.",
    from: 842,
    durationInFrames: 72,
    src: "cal-overlap",
    trim: 30,
    ratio: RATIO_MINIAPP,
    width: 668,
    x: 70,
    rotate: 1,
    push: [1.0, 1.05],
    glow: 0.8,
    fadeIn: 0,
    fadeOut: 0,
  },
  {
    beat: "The butterfly, then неділя 16 серп. 13:00. The product's own brand moment — the peak.",
    from: 914,
    durationInFrames: 108,
    src: "time-reveal",
    trim: 18,
    ratio: RATIO_MINIAPP,
    width: 826,
    push: [1.0, 1.05],
    glow: 1,
    fadeIn: 0,
    fadeOut: 0,
  },
  {
    beat: "Яке місце? — the last thing a human has to say before the concierge takes over.",
    from: 1022,
    durationInFrames: 66,
    src: "place-vibe",
    trim: 30,
    ratio: RATIO_MINIAPP,
    width: 620,
    push: [1.0, 1.04],
    glow: 0.8,
    fadeIn: 0,
    fadeOut: 14,
  },
  {
    beat: "The date card: Error 404 — Chat not found. Try real life. The product closes its own film.",
    from: 1078,
    durationInFrames: 150,
    src: "date-card",
    trim: 78,
    ratio: RATIO_CHAT,
    width: 886,
    push: [1.0, 1.07],
    glow: 0.9,
    fadeIn: 14,
    fadeOut: 16,
  },
];

/** The end card is the one shot that is not footage; it lives in its own scene. */
export const MARK: {from: number; durationInFrames: number} = {
  from: 1218,
  durationInFrames: 102,
};

export const HERO_DURATION_IN_FRAMES = MARK.from + MARK.durationInFrames; // 1320 = 44.0s
