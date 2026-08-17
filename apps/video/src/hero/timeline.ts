/**
 * The cut.
 *
 * `from`/`duration` are composition frames at 30 fps. Overlapping `from`
 * values are the only place a dissolve can come from — a scene whose `from`
 * lands before the previous scene ends cross-fades with it; everything else is
 * a hard cut. Overlaps are deliberately rare (three of nine transitions),
 * because the reference film cuts hard and dissolves only where the emotion
 * changes register.
 *
 * `trim` values are frames into the source clip, measured against the contact
 * sheets in `video-production-plan.md` §B. They are the reason each shot starts
 * on the beat it does — do not nudge one without re-reading the clip.
 */

export const FPS = 30;

export type Shot = {from: number; duration: number};

export const TIMELINE = {
  /** Rain, night, walking alone. The problem, stated without a word of UI. */
  alone: {from: 0, duration: 122},
  /**
   * 75 hours → 9,500 swipes → $200. The product counts the cost itself.
   * 210 frames, not fewer: each number counts UP, and a shorter shot cuts away
   * mid-count so the figure the scene exists for never actually lands.
   */
  cost: {from: 110, duration: 210},
  /** The competitor carousel rotating through faces like a feed. */
  friction: {from: 320, duration: 150},
  /** "So we built Gennety" → the brand mark. The pivot. */
  turn: {from: 470, duration: 118},
  /** The promise, typing itself out one line at a time. */
  promise: {from: 588, duration: 166},
  /** One real question the AI asks. HD, screen only. */
  understanding: {from: 754, duration: 76},
  /** The AI handoff orb. The most beautiful frame in the capture. */
  handoff: {from: 830, duration: 118},
  /** The outcome chain, cut as a burst. */
  datePlan: {from: 948, duration: 168},
  /** Phone gone. Sunset, field, festival. */
  realLife: {from: 1106, duration: 172},
  /** Butterfly, wordmark, one line. */
  mark: {from: 1268, duration: 112},
} as const satisfies Record<string, Shot>;

export const HERO_DURATION_IN_FRAMES =
  TIMELINE.mark.from + TIMELINE.mark.duration; // 1380 = 46.0s

/** Frames into each source clip where its shot begins. */
export const TRIM = {
  alone: 45,
  /** 1.5s in — past the "what does it cost?" question, onto the first figure. */
  cost: 45,
  friction: 30,
  turn: 81,
  promise: 36,
  /** 0.4s in — the question is settled from ~0.6s and holds for 3s. */
  understanding: 12,
  handoff: 42,
  benchIn: 30,
  fieldIn: 24,
  festivalIn: 45,
} as const;

/**
 * Scene 8 is the film's one deliberate burst — four cards of the outcome chain
 * in 5.6s, mirroring the six-cuts-in-2.1s acceleration measured in the
 * reference at 37.6–39.7s. Each entry is a trim into `intro-date.mp4`.
 */
export const DATE_CUTS: {trim: number; duration: number}[] = [
  {trim: 90, duration: 48}, // "Skip straight to the date"
  {trim: 150, duration: 48}, // "You both said yes"
  {trim: 210, duration: 40}, // "You pick when"
  {trim: 300, duration: 32}, // "Time and place are set"
];

/** Scene 9, warm and accelerating into the mark. */
export const LIFE_CUTS: {src: string; trim: number; duration: number}[] = [
  {src: "footage/life-bench.mp4", trim: TRIM.benchIn, duration: 70},
  {src: "footage/life-field.mp4", trim: TRIM.fieldIn, duration: 42},
  {src: "footage/life-festival.mp4", trim: TRIM.festivalIn, duration: 60},
];
