import {Easing} from "remotion";

/**
 * The camera. One of them, for the whole film.
 *
 * This module is the entire motion system of `GennetyHero`. Everything the
 * viewer sees move is a value read out of the table below at an **absolute
 * composition frame** — never a scene-local one, because a scene-local camera is
 * exactly what produced the reset this replaced (see `../../motion-audit.md`).
 *
 * The rule that matters, and the reason the architecture is shaped this way:
 *
 *   THE CAMERA DOES NOT KNOW WHERE THE CUTS ARE.
 *
 * `cameraAt()` takes a frame and nothing else. It cannot special-case a shot
 * boundary, so `camera(last frame of A) === camera(first frame of B)` holds by
 * construction rather than by anyone remembering to keep two numbers in step.
 *
 * The phone does not move. It sits at world (0, 0) at a constant size, and the
 * camera moves relative to it — which is why `Iphone` has no `scale` or `y`
 * prop and `Shot` has no `push` or `y` field.
 *
 * ---
 *
 * ## Why this is a table of HOLDS rather than a curve
 *
 * The first version of this file was a continuous spline: the camera drifted on
 * every one of the 1356 frames and never stood still. That fixed the reset and
 * got the rhythm wrong, which the founder's reference (Ditto's iMessage promo)
 * settles by measurement rather than taste. Tracking the handset's width through
 * that film frame by frame:
 *
 *   - it is **dead still ~52% of the time**, in holds of 1.5–5.0 s;
 *   - the moves between holds are large (0.55x–2.7x) and short (0.3–0.7 s);
 *   - "continuous" there means the framing NEVER SNAPS BACK, not that something
 *     is always moving.
 *
 * So this is a list of framings the camera holds, and the moves are what happens
 * between them. Motion is the exception; stillness is the default. A held frame
 * is also the only way a viewer can actually read a screen, which is the whole
 * job of a product film.
 */

/** A point in the film's one and only coordinate system. */
export type CameraState = {
  /** World x at the centre of the frame. Positive = camera looks right. */
  x: number;
  /** World y at the centre of the frame. Positive = camera looks down. */
  y: number;
  /**
   * Zoom. At 1.0 the phone screen renders 604 px wide — a 1.05x blow-up of the
   * 576 px source. The film runs 0.86 … 1.25, so the worst upscale is ~1.31x.
   *
   * That range is bounded by a founder decision, not by taste: the handset is
   * never cropped by the frame. The reference crops it in 85% of its frames,
   * which is how it affords a 5x zoom range; keeping the phone whole caps us at
   * roughly 1.45x, and the ceiling is the frame height, not the resolution.
   */
  scale: number;
  /**
   * Roll, degrees. **Always 0.** The reference does roll its handset on at
   * least one beat; ours does not, because the 2026-08-16 founder decision
   * (DECISIONS.md) is that the phone is never tilted per beat. The field exists
   * so the seam is there if that is ever revisited.
   */
  rotate: number;
};

/**
 * The move between two holds.
 *
 * **Fitted to the reference, not chosen.** Its two cleanest camera moves were
 * tracked frame by frame, normalised, and a cubic-bezier easing was
 * least-squares fitted to them over a constrained, monotone search. The winner
 * is this curve at RMS 0.053; for comparison, cubic-out scores 0.086, the
 * film's own `ease` (0.22, 1, 0.36, 1) scores 0.178 and a symmetric ease-in-out
 * scores 0.251 — the worst of everything tried.
 *
 * The number that explains the feel is the **initial slope: 0.20/0.20 = 1.00**.
 * The move leaves the hold at exactly the average speed of the whole move —
 * no launch, no jerk — and then decelerates for the rest of it. Our old curve
 * starts at 4.5x average speed, which is the "рывок" this replaces.
 *
 * So the camera does not snap. It sets off, eases down, and lands.
 */
const EASE_OUT = Easing.bezier(0.2, 0.2, 0.2, 0.92);

type Beat = {
  /** The camera is DEAD STILL across this inclusive frame range. */
  hold: readonly [number, number];
  x: number;
  y: number;
  scale: number;
  /** Halo strength — held and moved with the framing, not stepped per shot. */
  glow: number;
  note: string;
};

/**
 * The film's framings. Nine held shots plus the outro.
 *
 * Roughly 60% of the film is held and 40% is moving, against the reference's
 * 52/48 — close, and deliberately a touch stiller, because our handset is never
 * cropped so a move of the same size covers more of the frame.
 *
 * Where the moves sit is a choice worth stating: they are placed to CROSS a cut
 * rather than to start on one. A move that begins exactly when the screen
 * changes reads as the cut having caused it. Four of the nine moves cross a
 * boundary mid-flight (144, 378, 862, 1084) and the rest happen inside a single
 * shot, so the two systems stay visibly independent.
 *
 * Framing is bounded rather than guessed: the phone body is 634 x 1372 px at
 * scale 1 in a 1080 x 1920 frame, so the tightest hold here (1.24 with y=-12)
 * still leaves ~95 px of vertical air. `camera.probe.ts` fails under 40.
 */
const BEATS = [
  {
    hold: [0, 130],
    x: 0,
    y: -34,
    scale: 0.86,
    glow: 0.76,
    note: "Establish. The whole handset with air around it — «Твоє ім'я».",
  },
  {
    hold: [190, 330],
    x: -26,
    y: 6,
    scale: 1.02,
    glow: 0.8,
    note: "In on the controls: the gender tap burst and the preference columns.",
  },
  {
    hold: [392, 560],
    x: 14,
    y: 26,
    scale: 0.92,
    glow: 0.74,
    note: "Back out. The honest question is a tall conversation; you want all of it.",
  },
  {
    hold: [624, 708],
    x: 34,
    y: -2,
    scale: 1.14,
    glow: 0.86,
    note: "Close on the radar's «Що зачепило?» tags, and «Готово».",
  },
  {
    hold: [768, 806],
    x: 0,
    y: -12,
    scale: 1.24,
    glow: 0.9,
    note: "The closest framing in the film — «Хочеш піти з ним на побачення?»",
  },
  {
    hold: [874, 958],
    x: -18,
    y: 24,
    scale: 0.88,
    glow: 0.76,
    note: "The big breath out: planning opens and 13:00 lights up.",
  },
  {
    hold: [1014, 1046],
    x: 6,
    y: -20,
    scale: 1.04,
    glow: 1.0,
    note: "The butterfly and «неділя, 16 серп. 13:00» — the brand moment.",
  },
  {
    hold: [1102, 1156],
    x: 30,
    y: 14,
    scale: 0.96,
    glow: 0.8,
    note: "Back out again for the departure map and «Яке місце?».",
  },
  {
    hold: [1216, 1300],
    x: 0,
    y: -8,
    scale: 1.2,
    glow: 0.92,
    note: "The date card and its line. The last held framing.",
  },
  {
    hold: [1356, 1356],
    x: 0,
    y: -18,
    scale: 1.25,
    glow: 0.98,
    note: "Still travelling as the mark takes over — the film does not park.",
  },
] as const satisfies readonly Beat[];

/** Where `frame` sits: inside a hold, or `t` of the way through a move. */
const locate = (frame: number) => {
  if (frame <= BEATS[0].hold[1]) return {a: 0, b: 0, t: 0};
  for (let i = 0; i < BEATS.length - 1; i++) {
    if (frame <= BEATS[i].hold[1]) return {a: i, b: i, t: 0};
    const from = BEATS[i].hold[1];
    const to = BEATS[i + 1].hold[0];
    if (frame < to) return {a: i, b: i + 1, t: EASE_OUT((frame - from) / (to - from))};
  }
  return {a: BEATS.length - 1, b: BEATS.length - 1, t: 0};
};

const mix = (a: number, b: number, t: number) => a + (b - a) * t;

/** The camera at an absolute composition frame. The film's only source of motion. */
export const cameraAt = (frame: number): CameraState => {
  const {a, b, t} = locate(frame);
  return {
    x: mix(BEATS[a].x, BEATS[b].x, t),
    y: mix(BEATS[a].y, BEATS[b].y, t),
    scale: mix(BEATS[a].scale, BEATS[b].scale, t),
    rotate: 0,
  };
};

/**
 * The halo behind the handset.
 *
 * It used to be a per-shot constant, which stepped the light on a supposedly
 * stationary object at eight of the fourteen cuts. It rides the beats now, so
 * it is as still as the camera is and moves only when the camera does.
 */
export const glowAt = (frame: number): number => {
  const {a, b, t} = locate(frame);
  return mix(BEATS[a].glow, BEATS[b].glow, t);
};

/** Frame ranges the camera is completely still for. Read by the probe. */
export const CAMERA_HOLDS = BEATS.map((b) => b.hold);

/**
 * The camera's motion RELATIVE to a frame, as a ready-made CSS transform.
 *
 * The end card is not part of the world — it is not the phone — but the camera
 * must not stop for it. Wrapping the mark in this makes it inherit the same
 * push and tilt the world is under, so the film ends with the camera still
 * travelling rather than parking on a static card.
 */
export const relativeCameraTransform = (frame: number, since: number): string => {
  const now = cameraAt(frame);
  const then = cameraAt(since);
  const dx = then.x * then.scale - now.x * now.scale;
  const dy = then.y * then.scale - now.y * now.scale;
  return `translate(${dx.toFixed(3)}px, ${dy.toFixed(3)}px) scale(${(
    now.scale / then.scale
  ).toFixed(5)})`;
};
