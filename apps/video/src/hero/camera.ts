/**
 * The camera. One of them, for the whole film.
 *
 * This module is the entire motion system of `GennetyHero`. Everything the
 * viewer sees move is a value read out of the tables below at an **absolute
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
 * Retiming the cut cannot desynchronise the camera; the camera simply keeps
 * travelling and different content passes underneath it.
 *
 * The phone does not move. It sits at world (0, 0) at a constant size, and the
 * camera moves relative to it — which is why `Iphone` has no `scale` or `y`
 * prop any more and `Shot` has no `push` or `y` field. Reintroducing either
 * would reintroduce the bug.
 */

/** A point in the film's one and only coordinate system. */
export type CameraState = {
  /** World x at the centre of the frame. Positive = camera looks right. */
  x: number;
  /** World y at the centre of the frame. Positive = camera looks down. */
  y: number;
  /**
   * Zoom. At 1.0 the phone screen renders 604 px wide — a 1.05x blow-up of the
   * 576 px source, i.e. effectively native. The film runs 0.895 … 1.185, so the
   * worst upscale anywhere is ~1.21x.
   */
  scale: number;
  /**
   * Roll, degrees. **Always 0.** The field exists because a camera has one and
   * the track interpolates like the others, but a tilt on a 45-second film of a
   * handset is either invisible or reads as the phone leaning — which is the
   * failure the 2026-08-16 founder decision (DECISIONS.md) was about. This is
   * the seam if it is ever wanted, not a free knob.
   */
  rotate: number;
};

type Knot = readonly [frame: number, value: number];

/**
 * Monotone cubic Hermite (PCHIP) over keyframes.
 *
 * Deliberately not `interpolate()` with an easing: that is C⁰, so position
 * matches at a keyframe and *velocity* does not, and a velocity break is what
 * the eye reads as a snap even when the number is continuous.
 *
 * This gives four properties the film depends on:
 *
 *  - **C¹** — velocity is continuous everywhere, so the camera carries momentum
 *    through a keyframe instead of restarting an eased segment at it.
 *  - **No overshoot** — a monotone run never bulges past its keyframes. A
 *    Catmull-Rom spline would, and on a zoom that bulge reads as a bounce.
 *  - **Rest at a direction change** — a local extremum takes a zero tangent, so
 *    the camera decelerates into a turn and accelerates out of it.
 *  - **A real hold from two equal keyframes** — both tangents go to zero, so the
 *    camera actually stops rather than creeping through.
 *
 * Endpoint tangents are pinned to 0: the film opens and closes at rest.
 */
const pchip = (knots: readonly Knot[]) => {
  const n = knots.length;
  const t = knots.map((k) => k[0]);
  const v = knots.map((k) => k[1]);

  const h: number[] = [];
  const d: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    h[i] = t[i + 1] - t[i];
    d[i] = (v[i + 1] - v[i]) / h[i];
  }

  const m: number[] = new Array(n).fill(0);
  for (let i = 1; i < n - 1; i++) {
    // Sign change (a turn) or a flat neighbour (a hold) -> stop here.
    if (d[i - 1] * d[i] <= 0) continue;
    // Weighted harmonic mean of the two secants: the Fritsch-Carlson tangent,
    // which is what makes the segment monotone and therefore overshoot-free.
    const w1 = 2 * h[i] + h[i - 1];
    const w2 = h[i] + 2 * h[i - 1];
    m[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i]);
  }

  return (frame: number): number => {
    if (frame <= t[0]) return v[0];
    if (frame >= t[n - 1]) return v[n - 1];

    let i = 0;
    while (i < n - 2 && frame > t[i + 1]) i++;

    const s = (frame - t[i]) / h[i];
    const s2 = s * s;
    const s3 = s2 * s;

    return (
      (2 * s3 - 3 * s2 + 1) * v[i] +
      (s3 - 2 * s2 + s) * h[i] * m[i] +
      (-2 * s3 + 3 * s2) * v[i + 1] +
      (s3 - s2) * h[i] * m[i + 1]
    );
  };
};

/**
 * The camera timeline. Seventeen keyframes over 1356 frames (45.2s).
 *
 * Nine of them deliberately do NOT sit on a shot boundary: a camera move that
 * begins on a cut is a camera move the cut caused, and the whole point is that
 * the two are independent.
 *
 * The `scale` column changes direction six times and stands still twice. That,
 * rather than smaller moves, is how the brief's "do not constantly zoom in" is
 * met — there are three real pull-outs in the film, and the largest of them
 * (762 -> 862) is the frame breathing out as planning opens.
 *
 * Two entries share a `scale` with their neighbour on purpose:
 *   222/306   the zoom stops for 2.8s while the lateral drift keeps going;
 *   1084/1144 the same, over the venue question.
 * Two share an `x` (708/762) so the film's strongest push carries no sideways
 * drift at all.
 *
 * Framing is bounded rather than guessed: the phone body is 634 x 1372 px at
 * scale 1 in a 1080 x 1920 frame, so the widest keyframe here (1.185) still
 * leaves ~147 px of vertical air, and the furthest lateral offset (-84 at 378)
 * leaves ~220 px. Nothing here can crop the handset.
 */
const KEYFRAMES = [
  // frame,   x,    y,   scale   what it is
  [0, 0, -34, 0.895], //     establish — the whole handset, air around it
  [144, -32, -20, 0.952], // slow push begins; drift left
  [222, -52, -6, 0.98], //   push completes as the preference columns land
  [306, -70, 10, 0.98], //   HOLD: the zoom stops, the drift continues
  [378, -84, 26, 1.006], //  push resumes; the drift reaches its far left and turns
  [468, 4, 26, 1.032], //    sweeps back to centre as the radar opens
  [560, 44, 8, 1.128], //    strong push — the AI reading a taste
  [660, 22, -12, 1.092], //  easing off; the radar closes on «Готово»
  [708, 0, -18, 1.04], //    pull out; the film turns
  [762, 0, -6, 1.152], //    the strongest push — «піти з ним на побачення?»
  [862, -18, 22, 0.995], //  the biggest gesture: pull back as planning opens
  [912, -6, 22, 1.08], //    punch in on 13:00 lighting up
  [1000, 14, -26, 0.958], // pull out to let the brand moment breathe
  [1084, 48, 18, 1.014], //  drift right and down into the departure map
  [1144, 18, 34, 1.014], //  HOLD: the venue question; only the drift continues
  [1274, 0, -10, 1.136], //  the last push, onto the date card and its line
  [1356, 0, -30, 1.185], //  keeps travelling through the outro
] as const satisfies readonly (readonly [number, number, number, number])[];

const trackX = pchip(KEYFRAMES.map((k) => [k[0], k[1]] as const));
const trackY = pchip(KEYFRAMES.map((k) => [k[0], k[2]] as const));
const trackScale = pchip(KEYFRAMES.map((k) => [k[0], k[3]] as const));

/** The camera at an absolute composition frame. The film's only source of motion. */
export const cameraAt = (frame: number): CameraState => ({
  x: trackX(frame),
  y: trackY(frame),
  scale: trackScale(frame),
  rotate: 0,
});

/**
 * The halo behind the handset, on the same interpolator.
 *
 * It used to be a per-shot constant, which meant the light on a supposedly
 * stationary object stepped at eight of the fourteen cuts. It is a property of
 * the world's lighting, not of the clip: it rises with the pushes, peaks on the
 * butterfly/date reveal, and carries through every boundary.
 */
const trackGlow = pchip([
  [0, 0.76],
  [378, 0.72],
  [560, 0.84],
  [762, 0.88],
  [862, 0.74],
  [978, 1.0],
  [1084, 0.8],
  [1274, 0.92],
  [1356, 0.98],
]);

export const glowAt = (frame: number): number => trackGlow(frame);

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
