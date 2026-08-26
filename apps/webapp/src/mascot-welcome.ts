/**
 * The welcome mascot — the Gennety butterfly, with eyes and round hands,
 * shuffling through profiles while the Mini App boots.
 *
 * ## What the picture says
 *
 * The loop IS the loading state: he is flipping through profiles, back to us,
 * because that is literally what the server is doing. When state arrives he
 * notices he is being watched, turns, peers, rocks back, winks — and then pulls
 * the screen aside like a curtain, revealing the first real screen underneath.
 * The transition is not a cut; his hand and the curtain edge read the same
 * number, so one motion hands over to the product.
 *
 * ## Why this one is drawn per frame
 *
 * The two existing marks (`butterfly-loader.ts`, `butterfly-success.ts`) are
 * pure CSS keyframes, and that is the house convention. This one breaks it
 * deliberately, because three of its properties cannot be authored as
 * keyframes at all:
 *
 * - **The hands are drawn on a curve.** The arm is a quadratic band that
 *   thins as it stretches, and the hand takes the curve's tangent at the
 *   wrist. The tangent used to rotate a five-fingered glove; getting that
 *   angle even slightly wrong made the hand read as a sticker dragged around
 *   the screen, so on 2026-08-23 the hand became a plain circle (founder
 *   decision, DECISIONS.md) and the tangent now only aims its squash. That is
 *   an error the shape can no longer make.
 * - **The hands grab real cards.** A hand flies to where a specific card *will*
 *   be at the moment of contact, closes on it, pulls it OUT of the stream, holds
 *   it still while the rest keep flowing, and puts it back where the stream has
 *   got to by then. The cards move on their own clock, so every one of those
 *   positions is solved per frame rather than baked.
 * - **Hands lag the body.** Each hand is anchored in the body's own coordinate
 *   space and samples that transform ~60ms late, which is what gives the
 *   rock-back its whip.
 *
 * Everything that CAN be a curve still is: `track()` evaluates real CSS
 * `cubic-bezier()` by Newton iteration, so the easings here are the same
 * easings a stylesheet would have.
 *
 * ## One grab is a whole gesture, not a tap
 *
 * The first version ran a grab every 190ms and never took a card out of the
 * stream: the hand flew to a card and rode it along. On screen that reads as
 * tapping at the cards rather than looking at them, which is exactly how it was
 * reported (founder, 2026-08-23). A cycle is now `CYC`, spent on
 * reach → close → lift out → examine → put back → release (`PHASE`), with the
 * card following the HAND for the middle three rather than the other way round.
 * The two hands run at a deliberately un-round phase offset, so part of the time
 * both are holding one card each and the rhythm never reads as a metronome.
 *
 * ## Body shape
 *
 * `MASCOT_BODY` is the logo with its lower wings converged on a single point.
 * The shipped logo (`brand-butterfly.ts`, and the five other copies) keeps the
 * 4-unit horizontal bar between them and is deliberately NOT changed — founder
 * decision 2026-08-23, DECISIONS.md. The reference copy of the corrected shape
 * lives at `apps/bot/src/assets/brand/butterfly-logo-v2.svg` and nothing
 * imports it; it exists so the two shapes can be compared.
 *
 * Sizing, colour and the fade live in `onboarding.css` (`.mw-*`), following the
 * loader's split: this module only answers what moves and where.
 */

/** Stage coordinates. The body occupies roughly x 15..85, y 24..77. */
export const VIEWBOX = { x: -50, y: -28, width: 200, height: 156 } as const;

/**
 * The logo with both lower wings converged on (50, 65).
 *
 * The shipped logo has `L 52 65` there — a 4-unit bar where the top joins at a
 * single point. Only the mascot uses this corrected form today.
 */
export const MASCOT_BODY =
  "M 50 35 C 20 0, -10 30, 15 55 C -5 75, 25 100, 50 65 " +
  "C 75 100, 105 75, 85 55 C 110 30, 80 0, 50 35 Z";

/**
 * Greeting length, measured from the moment `/state` resolves to the curtain
 * clearing the screen.
 *
 * This is real added time on the onboarding funnel's very first screen, so it
 * is pinned by a test rather than left to drift one retune at a time — the same
 * treatment `SUCCESS_TOTAL_MS` gets.
 */
export const GREET_MS = 4710;

/**
 * Minimum loop before the greeting may start.
 *
 * A turn-around only reads as "he noticed you" if there was something to
 * interrupt. `/state` often answers in a few hundred milliseconds, so without a
 * floor the mascot would spin round before the audience has seen him working.
 *
 * Sized in GESTURES rather than picked as a round number, and it has gone up
 * twice for the same reason: what the audience is meant to read is "he is
 * working THROUGH profiles", plural, and one pick-up does not say that. At
 * `CYC` = 1400 this is roughly five examinations across the two hands — the
 * founder asked for at least four (2026-08-26), and `examinations()` measures
 * the real number rather than trusting this arithmetic.
 *
 * It is a FLOOR, not an addition: `finishWelcome` spends only the shortfall
 * against the `/state` fetch the loop is covering anyway. So the worst case is
 * the whole two seconds and the typical case is close to it, since the fetch
 * usually answers in a few hundred milliseconds.
 */
export const LOOP_FLOOR_MS = 4000;

/** Fade used when the greeting is skipped or not played at all. */
export const FADE_MS = 240;

/**
 * Beat boundaries inside the greeting, in ms from its start.
 *
 * Roughly 2× their first values. The turn was the loud one: `gScaleX` used to
 * squeeze the body flat in 80ms and pop it back in 82, which is a cut rather
 * than a turn — it read as him snapping round, and that is how it came back
 * (founder, 2026-08-23). It is 360ms in and 220 out now, about what a real head
 * turn costs, and every other beat was stretched with it so the performance has
 * one tempo rather than a slow middle between two snaps.
 *
 * Duration was only half of it, and the smaller half. Measured per 60Hz frame,
 * the first stretch (300/170) still moved **30% of the whole swing in a single
 * frame**, right at the crossing — because `EI` ends fast and `EO` begins at
 * 3.09× its own average, so the two halves met at full speed. On the SAME
 * durations, swapping both for the rest-to-rest curve halves that to 17%; at
 * 360/220 it is 13%. Same measurement, same conclusion, and the same curve as
 * the keyboard easing (DECISIONS.md 2026-08-18): what reads as "too fast" is
 * usually one frame of jump, not the length of the move.
 */
export const BEATS = {
  turn: 360,
  peer: 730,
  hold: 1290,
  rock: 1730,
  wink: 2490,
  reach: 3090,
  grip: 3410,
  pull: 3590,
} as const;

const NS = "http://www.w3.org/2000/svg";

/* ---------------------------------------------------------------- easing */

type Ease = (p: number) => number;

/** Real CSS `cubic-bezier()`, solved by Newton iteration on the x axis. */
export function bezier(x1: number, y1: number, x2: number, y2: number): Ease {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const fx = (t: number): number => ((ax * t + bx) * t + cx) * t;
  const dx = (t: number): number => (3 * ax * t + 2 * bx) * t + cx;
  return (p) => {
    let t = p;
    for (let i = 0; i < 6; i++) {
      const e = fx(t) - p;
      const d = dx(t);
      if (Math.abs(e) < 1e-5 || d === 0) break;
      t -= e / d;
    }
    return ((ay * t + by) * t + cy) * t;
  };
}

const EO = bezier(0.22, 0.68, 0.3, 1);
/**
 * Rest to rest — the same shape `--kb-ease` uses in the stylesheet, chosen for
 * the same reason and by the same measurement.
 *
 * A cubic-bezier leaves at `y1 / x1` times its own average speed, so `EO`
 * starts at **3.09×**. On a 96-unit flight across a 200-unit stage that is 23%
 * of the distance in the first frame followed by a crawl — a snap and then a
 * glide, which is what "the whole thing moves too fast" describes once you look
 * at it frame by frame rather than end to end. This one starts at rest,
 * accelerates, and comes back to rest, so the hand's fastest moment is 2× its
 * average instead of 3.09× and it happens in the middle where the eye expects
 * it. Used for every travel in the loop; the greeting's own beats keep `EO`,
 * where a little attack is the point.
 */
const MOVE_E = bezier(0.42, 0, 0.58, 1);
const SNAP = bezier(0.3, 1.3, 0.45, 1);
const PULL_E = bezier(0.55, 0.03, 0.5, 1);
const EDGE_E = bezier(0.5, 0.05, 0.3, 1);
const LIN: Ease = (p) => p;

type Key = [number, number] | [number, number, Ease];

/** Keyframe track: `[time, value, ease?]`, held flat outside its range. */
export function track(keys: Key[]): (t: number) => number {
  return (t) => {
    const first = keys[0]!;
    if (t <= first[0]) return first[1];
    for (let i = 1; i < keys.length; i++) {
      const cur = keys[i]!;
      if (t <= cur[0]) {
        const prev = keys[i - 1]!;
        const span = cur[0] - prev[0];
        const p = span === 0 ? 1 : (t - prev[0]) / span;
        return prev[1] + (cur[1] - prev[1]) * (cur[2] ?? LIN)(p);
      }
    }
    return keys[keys.length - 1]![1];
  };
}

const clamp = (v: number, a: number, b: number): number => Math.min(b, Math.max(a, v));
const mix = (a: number, b: number, p: number): number => a + (b - a) * p;
const rad = (d: number): number => (d * Math.PI) / 180;

/* ------------------------------------------------------------------ cards */

interface Card {
  ph: number;
  y: number;
  r: number;
  sp: number;
  o: number;
  s: number;
}

/**
 * Authored, not random. A scatter re-rolled per render can never be reviewed
 * twice and would shuffle under the user's finger.
 *
 * Sixteen rather than nine (2026-08-26, founder): nine spread over the 268-unit
 * travel left ~30 units between cards, so at any moment the stage held about
 * six and read as a trickle rather than as a stack he is working through. The
 * extra seven are interleaved into the phase gaps and carry the same depth
 * correlation as the rest — a card that is smaller is also fainter, which is
 * the only thing making this a stream with depth rather than a flat scatter.
 */
export const CARDS: readonly Card[] = [
  { ph: 0.0, y: 10, r: -8, sp: 0.135, o: 0.62, s: 1.05 },
  { ph: 0.07, y: 58, r: 4, sp: 0.122, o: 0.36, s: 0.76 },
  { ph: 0.14, y: 96, r: 7, sp: 0.15, o: 0.5, s: 0.92 },
  { ph: 0.21, y: 30, r: -5, sp: 0.128, o: 0.42, s: 0.82 },
  { ph: 0.29, y: 68, r: 8, sp: 0.14, o: 0.56, s: 0.98 },
  { ph: 0.36, y: 12, r: 4, sp: 0.119, o: 0.33, s: 0.73 },
  { ph: 0.43, y: 74, r: -6, sp: 0.14, o: 0.58, s: 1.0 },
  { ph: 0.5, y: 40, r: 9, sp: 0.131, o: 0.45, s: 0.86 },
  { ph: 0.56, y: 4, r: 9, sp: 0.125, o: 0.38, s: 0.78 },
  { ph: 0.63, y: 86, r: -3, sp: 0.144, o: 0.52, s: 0.94 },
  { ph: 0.69, y: 104, r: -4, sp: 0.132, o: 0.54, s: 0.96 },
  { ph: 0.76, y: 44, r: 6, sp: 0.118, o: 0.34, s: 0.74 },
  { ph: 0.82, y: 22, r: -7, sp: 0.137, o: 0.48, s: 0.9 },
  { ph: 0.87, y: 62, r: -9, sp: 0.146, o: 0.46, s: 0.88 },
  { ph: 0.92, y: 100, r: 5, sp: 0.123, o: 0.31, s: 0.72 },
  { ph: 0.96, y: 20, r: 3, sp: 0.128, o: 0.4, s: 0.8 },
];

const frac = (v: number): number => ((v % 1) + 1) % 1;

/** Where a card is born, and where it dies. */
const SPAWN_X = -78;
const DESPAWN_X = 190;

/** The band a phone actually shows: the viewBox, and nothing either side. */
const BAND_L = VIEWBOX.x;
const BAND_R = VIEWBOX.x + VIEWBOX.width;

/**
 * Right edge of the curtain clip while the loop runs (`renderLoop` writes it).
 * Nothing past it is painted at all, so a card reaching it is guillotined.
 */
const LOOP_EDGE = 160;

const smoothstep = (p: number): number => p * p * (3 - 2 * p);

/** Where a card sits at time `t`. Continuous and periodic — the loop is seamless. */
export function cardX(card: Card, t: number): number {
  return SPAWN_X + frac((t / 1000) * card.sp + card.ph) * (DESPAWN_X - SPAWN_X);
}

/**
 * How visible a card is at `x`, 0..1 — it dissolves in and out instead of
 * appearing from nowhere and being cut in half on the way out.
 *
 * The stream ran at a flat opacity for its whole travel, so a card simply
 * MATERIALISED at `SPAWN_X` and was guillotined by the curtain clip at
 * `LOOP_EDGE`. Both events are invisible on a phone — the SVG is fitted with
 * `meet`, so at a phone's aspect it exactly fills the width and the whole of a
 * card's life outside the viewBox happens off-screen. In a browser the same
 * fitting leaves letterbox on either side, `.mw-svg` is `overflow: visible`,
 * and the spawn point lands inside the window. Reported that way, too: "в
 * веб-версии в браузере мне не нравится, как выглядит" (founder, 2026-08-26).
 *
 * So the two ramps ARE the off-viewBox margins, and that is the whole design:
 * on a phone they sit entirely off-screen and nothing about the stream changes,
 * while in a browser they are exactly the stretch that was showing the seam.
 * They are deliberately different widths — 28 units on the left, 10 on the
 * right — because the margins are: the left one runs from the spawn point to
 * the stage edge, the right one from the stage edge to the curtain. Matching
 * them would mean either spawning further out or fading a card while it is
 * still mid-screen on a phone.
 *
 * Eased rather than linear, for the reason the gender screen's photo fade
 * already states (DECISIONS 2026-08-22): a two-stop linear alpha ramp has a
 * visible kink where it begins, and the eye reads that line as the edge of the
 * thing being faded — which is the seam this exists to remove.
 */
export function cardFade(x: number): number {
  if (x <= SPAWN_X || x >= LOOP_EDGE) return 0;
  if (x < BAND_L) return smoothstep((x - SPAWN_X) / (BAND_L - SPAWN_X));
  if (x > BAND_R) return smoothstep((LOOP_EDGE - x) / (LOOP_EDGE - BAND_R));
  return 1;
}

/**
 * One whole gesture: reach, close, lift out, examine, put back, release.
 *
 * It was 190ms, which is not a length a gesture can be — at that rate the hand
 * could only ever flick at a passing card, and that is what it looked like.
 */
export const CYC = 1400;

/**
 * Phase boundaries inside a gesture, as fractions of `CYC`.
 *
 * The three middle phases are the ones that make it a pick-up rather than a
 * touch: the card leaves the stream, stops dead while everything else keeps
 * flowing, and is put back where the stream has got to by then.
 */
export const PHASE = {
  /** Flying to the card. Contact is booked for this instant. */
  reach: 0.2,
  /** On the card, closing. It is still in the stream. */
  close: 0.28,
  /** Drawing it out of the stream. */
  lift: 0.44,
  /** Held still, being looked at. */
  hold: 0.64,
  /** Returned to wherever the stream has got to. */
  back: 0.82,
  /** Opening; the card streams on. */
  open: 0.9,
} as const;

/**
 * How far the right hand's gesture leads the left's, in cycles.
 *
 * Picked by sweeping it rather than by eye, because the two things it trades
 * off pull in opposite directions and neither is guessable. A hand holds a card
 * for `close..back` — 54% of a cycle — so the two hands always overlap somewhat;
 * antiphase is simply the setting where they overlap LEAST. Measured over 80
 * cycles: at 0.48 both hands hold at once 4% of the time, at 0.04 it is 39% and
 * the mascot looks like he only ever works in pairs.
 *
 * 0.72 sits where both readings are true at once — both hands hold a card each
 * ~17% of the time, and at least one hand is holding ~71%, the highest the
 * sweep reaches. It also produces the beat as described: the left lifts one
 * out, the right lifts another, the left puts hers back while the right is
 * still looking at his. The two reaches stay a third of a cycle apart, so it
 * reads as a stagger rather than as two hands moving in unison.
 */
export const HAND_PHASE_R = 0.72;

/**
 * A hand's reachable band and its home position. A card passing BEHIND the
 * silhouette or above the top wing cannot be believably grabbed — the arm
 * would have to cross the logo, which reads as a hand on his own head.
 */
const HAND_BAND: readonly [number, number][] = [
  [-35, 42],
  [58, 135],
];
const HAND_HOME: readonly [number, number][] = [
  [16, 66],
  [84, 66],
];

/**
 * Is this contact point behind the mascot's own silhouette?
 *
 * The reachable bands above are about the ARM's path; this is about the HAND's
 * destination. They are not the same constraint: the left band runs to x = 42,
 * which is comfortably inside the body's lower-left wing, so a card drifting
 * through there passed the band and still put the glove on his own chest.
 *
 * Deliberately an ellipse rather than the real path. It is a hair tighter than
 * the drawn shape at the wings' tips and a hair looser at the two notches, and
 * either way the answer is only ever "pick a different card" — a false
 * positive costs one hover beat, a false negative costs a hand on his face.
 */
export function isBehindBody(x: number, y: number): boolean {
  return ((x - 50) / 35) ** 2 + ((y - 50) / 27) ** 2 < 1;
}

export interface HandTarget {
  card: number;
  pos: [number, number];
  miss: boolean;
}

/**
 * Where a hand sits relative to the card centre it is holding.
 *
 * Kept as one pair of numbers because two places need it in opposite
 * directions — `gripPoint` puts the hand on a card, and `handFor` puts the hand
 * on a card the hand is carrying. Two copies would drift and the card would
 * float a few units out of the grip.
 */
const HAND_DX = 6.5;
const HAND_DY = -10;

/**
 * How big a card gets while it is being looked at.
 *
 * A fixed size rather than a multiple of the card's own: holding something up
 * to read it does not depend on how far away it was, and the deck's own scales
 * run 0.74..1.05, so a multiple made some examined cards smaller than their
 * neighbours in the stream. Against that spread, 1.5 is unmistakably the one he
 * is reading.
 */
export const HELD_SCALE = 1.5;

/**
 * The hand's offset from the card centre, as the card leaves the stream.
 *
 * It has to move, and that is not decoration. On the stream the hand takes the
 * near top corner of a card drawn at ~1.0; held, the card is at `HELD_SCALE`
 * and the same offset lands the hand in the MIDDLE of it — measured on the
 * render, a white disc sitting over the photo and half the text of the one card
 * he is supposed to be reading.
 *
 * Held, it grips the OUTER BOTTOM corner, and the vertical sign is the load-
 * bearing half. Gripping the top puts the card between the viewer and the arm:
 * the shoulder sits inside the body at x 66, the hand beyond the card at 109,
 * so the whole 43 units of arm run behind a card drawn on top of it and the
 * hand goes back to reading as a floating disc — which is the complaint the
 * burgundy arm was introduced to answer (DECISIONS.md 2026-08-23). From below,
 * the arm runs along the card's bottom edge and is visible end to end, and the
 * card rests above the hand the way something held up to be read does.
 */
function handOffset(hand: 0 | 1, lift: number): [number, number] {
  const s = hand === 0 ? -1 : 1;
  const heldDx = 10 * HELD_SCALE * 0.6;
  const heldDy = 13.5 * HELD_SCALE + 8;
  return [s * mix(HAND_DX, heldDx, lift), mix(HAND_DY, heldDy, lift)];
}

/** The hand position for a card centred at `c`, `lift` out of the stream. */
function handFor(c: readonly [number, number], hand: 0 | 1, lift = 0): [number, number] {
  const [dx, dy] = handOffset(hand, lift);
  return [c[0] + dx, c[1] + dy];
}

/**
 * Where a card is taken to be looked at.
 *
 * CLEAR of the body — the wings end at x 15..85 and a card held at `HELD_SCALE`
 * is 30 wide, so 0 and 100 put it just past them. That is not framing: with the
 * card over a wing the arm has nothing to cross, so it renders as a stub behind
 * the body and the hand reads as a disc stuck to the card (measured on the
 * render — hand at x 93 against a shoulder at 66). Out here the arm is 40-60
 * units of visible reach, which is the whole difference between holding
 * something up and touching it.
 *
 * The height is derived from the card's own so four gestures in a row do not
 * all happen at the same spot. It is a WORLD point: he sways, his arm
 * stretches, the card stays put, which is what holding something steady looks
 * like.
 */
export function examineAt(card: Card, hand: 0 | 1): [number, number] {
  return [hand === 0 ? 0 : 100, mix(card.y, 40, 0.75)];
}

/**
 * Which card this hand books for the contact at `tc`.
 *
 * The right hand never books the card the left one is on (`depth` breaks the
 * mutual recursion), and a cycle with no card in reach is a deliberate MISS —
 * the hand hovers open at home, which reads as searching rather than as noise.
 */
/**
 * Where a hand meets a card.
 *
 * Deliberately the card's near TOP CORNER, not its centre. The hand renders
 * ~24 stage units across against a card ~18 wide, so a hand centred on a card
 * simply covers it and reads as a ball resting on top; taking the corner
 * leaves most of the card visible and reads as holding it. The five-fingered
 * glove this replaced could sit centred because its fingers closed *around*
 * the card — a circle has to solve the same problem with placement.
 */
export function gripPoint(card: Card, t: number, hand: 0 | 1): [number, number] {
  return handFor([cardX(card, t), card.y], hand);
}

export function targetFor(hand: 0 | 1, tc: number, depth = 0): HandTarget {
  const band = HAND_BAND[hand]!;
  const home = HAND_HOME[hand]!;
  const excl = new Set<number>();
  if (hand === 1 && depth === 0) {
    // Exclude the left hand's card for any of ITS cycles whose hold OVERLAPS
    // this one's — not the cycle it happens to be in. A gesture keeps its card
    // for `back - close` of a cycle, so two holds overlap only when their
    // starts are closer than that, which is at most two left cycles and usually
    // one. The first version bucketed by `floor(tc / CYC)` and excluded two
    // unconditionally: one of them never overlapped, so it cost the right hand
    // a candidate for nothing, and that hand is the one that can least afford
    // it — the stream flows away from its band, so its choices are thinnest.
    const w = PHASE.back - PHASE.close;
    const u0 = tc / CYC - PHASE.reach;
    for (let j = Math.ceil(u0 - w); j <= Math.floor(u0 + w); j++) {
      excl.add(targetFor(0, (j + PHASE.reach) * CYC, 1).card);
    }
  }
  let best = -1;
  let bs = Infinity;
  for (let i = 0; i < CARDS.length; i++) {
    if (excl.has(i)) continue;
    const card = CARDS[i]!;
    const [x, y] = gripPoint(card, tc, hand);
    // The floor is the STAGE, not the body — `isBehindBody` already owns the
    // silhouette. It was y >= 30, which is where the top wing sits, and that
    // put FOUR of the nine cards permanently out of reach: measured, a hand
    // found nothing to grab in a quarter of its cycles. At 190ms a barren
    // cycle was invisible; at 1400 it is a second and a half of a hand hovering
    // over nothing, which is the "he does not really do anything" this whole
    // rework is about. Reaching above his own head for a card is a normal thing
    // to do; reaching off the top of the screen is not.
    if (y < 4 || x < band[0] || x > band[1]) continue;
    if (isBehindBody(x, y)) continue;
    // He only takes a card he can still PUT BACK. A gesture holds its card for
    // most of a cycle while the stream keeps moving underneath, so a card taken
    // at the far edge has to be returned to wherever it has got to by then —
    // measured at up to x = 165 on a stage that ends at 150, i.e. an arm
    // shooting off the side of the screen to replace a card nobody can see.
    //
    // The two rules that matter at the return are the same two that matter at
    // the pickup — off his own silhouette, and on the stage — rather than the
    // reach band, which is about the arm's PATH and is far too tight here: at
    // the return the arm is coming back from beside the body, not across it,
    // and using the band starved the right hand into a barren cycle half the
    // time (39% against 26%; the stream flows rightward, so cards drift OUT of
    // that band during the gesture and into the left one).
    //
    // `xr < x` is the wrap: a card that has looped round to the far left reads
    // as being behind where it was taken from. That is the constraint the old
    // ride-along code spelled out separately, now covered for free.
    const [xr, yr] = gripPoint(card, tc + CYC * (PHASE.back - PHASE.reach), hand);
    if (xr < x || xr < -42 || xr > 140 || isBehindBody(xr, yr)) continue;
    const s = Math.abs(x - home[0]) + Math.abs(y - home[1]) * 0.7;
    if (s < bs) {
      bs = s;
      best = i;
    }
  }
  if (best < 0) {
    return { card: -1, pos: hoverAt(hand, tc), miss: true };
  }
  const card = CARDS[best]!;
  return { card: best, pos: gripPoint(card, tc, hand), miss: false };
}

function hoverAt(hand: 0 | 1, t: number): [number, number] {
  const home = HAND_HOME[hand]!;
  return [home[0] + Math.sin(t * 0.011) * 3.2, home[1] + Math.cos(t * 0.014) * 2.4];
}

export interface HandState {
  pos: [number, number];
  /** 0..1, how closed the hand is. Only ever changes its SIZE, never its shape. */
  grip: number;
  /** The card this hand is on, or -1. */
  card: number;
  /**
   * Where the card's centre must be drawn, or null to leave it in the stream.
   *
   * This is the whole difference between a pick-up and a touch: for the middle
   * three phases the CARD follows the HAND, so it stops while the others keep
   * flowing past it.
   */
  hold: [number, number] | null;
  /** 0..1, how far out of the stream the card is. Drives its size and opacity. */
  lift: number;
}

/**
 * How far the hand has drifted home by the end of a gesture.
 *
 * The reach of the NEXT cycle starts from exactly this, which is what makes the
 * cycle boundary invisible: at `f = 1` the retreat has travelled `RETREAT` of
 * the way to the hover point, and at `f = 0` the next `release` is that same
 * mix evaluated at the same instant.
 */
const RETREAT = 0.55;

/**
 * The loop's hand solver, and the one place the gesture is described.
 *
 * Purely a function of `t` — the loop runs for however long `/state` takes, so
 * nothing here may depend on when it started.
 */
export function handWork(t: number, hand: 0 | 1, off: number): HandState {
  const u = t / CYC + off;
  const k = Math.floor(u);
  const f = u - k;
  const t0 = (k - off) * CYC;
  const now = targetFor(hand, t0 + CYC * PHASE.reach);
  const prev = targetFor(hand, t0 - CYC + CYC * PHASE.reach);
  // Where the previous gesture actually left the hand, evaluated at THIS
  // instant rather than remembered — a remembered position would be stale by a
  // whole cycle and the hand would jump at every boundary.
  const hover = hoverAt(hand, t0);
  const release: [number, number] = prev.miss
    ? hover
    : (() => {
        const g = gripPoint(CARDS[prev.card]!, t0, hand);
        return [mix(g[0], hover[0], RETREAT), mix(g[1], hover[1], RETREAT)];
      })();

  // Nothing in reach this cycle: drift home and hover, which reads as searching.
  if (now.miss) {
    const p = MOVE_E(clamp(f / PHASE.reach, 0, 1));
    const h = hoverAt(hand, t);
    return {
      pos: [mix(release[0], h[0], p), mix(release[1], h[1], p)],
      grip: 0,
      card: -1,
      hold: null,
      lift: 0,
    };
  }

  const card = CARDS[now.card]!;
  const ex = examineAt(card, hand);

  // Reach — flying to where the card WILL be at contact.
  if (f < PHASE.reach) {
    const p = MOVE_E(f / PHASE.reach);
    return {
      pos: [
        mix(release[0], now.pos[0], p),
        mix(release[1], now.pos[1], p) - 11 * Math.sin(Math.PI * p),
      ],
      grip: 0,
      card: -1,
      hold: null,
      lift: 0,
    };
  }
  // Close — on the card, still streaming with it.
  if (f < PHASE.close) {
    const p = (f - PHASE.reach) / (PHASE.close - PHASE.reach);
    return { pos: gripPoint(card, t, hand), grip: EO(p), card: now.card, hold: null, lift: 0 };
  }
  // Lift — out of the stream. From here the card follows the hand.
  if (f < PHASE.lift) {
    const p = MOVE_E((f - PHASE.close) / (PHASE.lift - PHASE.close));
    const c: [number, number] = [mix(cardX(card, t), ex[0], p), mix(card.y, ex[1], p)];
    return { pos: handFor(c, hand, p), grip: 1, card: now.card, hold: c, lift: p };
  }
  // Examine — held still while everything else keeps flowing past.
  if (f < PHASE.hold) {
    const p = (f - PHASE.lift) / (PHASE.hold - PHASE.lift);
    const c: [number, number] = [ex[0], ex[1] + Math.sin(p * Math.PI * 2) * 1.6];
    return { pos: handFor(c, hand, 1), grip: 1, card: now.card, hold: c, lift: 1 };
  }
  // Back — returned to wherever the stream has got to by now, not to where it
  // was taken from. That gap IS the read: the others moved on without it.
  if (f < PHASE.back) {
    const p = MOVE_E((f - PHASE.hold) / (PHASE.back - PHASE.hold));
    const c: [number, number] = [mix(ex[0], cardX(card, t), p), mix(ex[1], card.y, p)];
    return { pos: handFor(c, hand, 1 - p), grip: 1, card: now.card, hold: c, lift: 1 - p };
  }
  // Open — letting go, the card streaming on under the hand.
  if (f < PHASE.open) {
    const p = (f - PHASE.back) / (PHASE.open - PHASE.back);
    return { pos: gripPoint(card, t, hand), grip: 1 - EO(p), card: now.card, hold: null, lift: 0 };
  }
  // Retreat — drifting back, ready to reach again.
  const p = MOVE_E((f - PHASE.open) / (1 - PHASE.open)) * RETREAT;
  const g = gripPoint(card, t, hand);
  const h = hoverAt(hand, t);
  return {
    pos: [mix(g[0], h[0], p), mix(g[1], h[1], p)],
    grip: 0,
    card: -1,
    hold: null,
    lift: 0,
  };
}

/** Body sway during the loop. Periodic by construction — no loop seam. */
export function loopSway(t: number): number {
  return Math.sin((t / 1400) * Math.PI * 2) * 7;
}

/* ------------------------------------------------------------------ glove */

/**
 * Hand radius, in stage units. Sized against the arm it sits on rather than
 * picked by eye: the band is ~2 units of half-width at the wrist, so a radius
 * near four times that reads as a hand on an arm instead of the arm merely
 * getting thicker.
 */
export const HAND_R = 11;

export interface ArmResult {
  /** Filled band — a stroked line cannot taper. */
  d: string;
  /**
   * The curve's tangent at the wrist, as a rotation: local +Y points back
   * along the arm. A circular hand has no orientation of its own, so this is
   * what tells the squash which way "along the arm" is.
   */
  ang: number;
}

/**
 * The arm, and the axis its hand squashes along.
 *
 * The band thins as it stretches — cheap mass conservation, but felt. The
 * tangent used to rotate a five-fingered glove, which is where the whole
 * "hand as a sticker" defect lived; with a round hand it survives only to
 * aim the deformation, and can never look wrong.
 */
export function armGlove(
  o: readonly [number, number],
  h: readonly [number, number],
  bend: number,
): ArmResult {
  const dx = h[0] - o[0];
  const dy = h[1] - o[1];
  const L = Math.hypot(dx, dy) || 1;
  const c: [number, number] = [
    (o[0] + h[0]) / 2 - (dy / L) * bend,
    (o[1] + h[1]) / 2 + (dx / L) * bend,
  ];
  const k = clamp(Math.sqrt(34 / L), 0.82, 1.05);
  const w0 = 8.4 * k;
  const w1 = 7.0 * k;
  const N = 22;
  const A: [number, number][] = [];
  const B: [number, number][] = [];
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const u = 1 - t;
    const px = u * u * o[0] + 2 * u * t * c[0] + t * t * h[0];
    const py = u * u * o[1] + 2 * u * t * c[1] + t * t * h[1];
    const gx = 2 * u * (c[0] - o[0]) + 2 * t * (h[0] - c[0]);
    const gy = 2 * u * (c[1] - o[1]) + 2 * t * (h[1] - c[1]);
    const m = Math.hypot(gx, gy) || 1;
    const w = (w0 + (w1 - w0) * t) / 2;
    A.push([px - (gy / m) * w, py + (gx / m) * w]);
    B.push([px + (gy / m) * w, py - (gx / m) * w]);
  }
  const tx = h[0] - c[0];
  const ty = h[1] - c[1];
  const tl = Math.hypot(tx, ty) || 1;
  const pts = A.concat(B.reverse())
    .map((p) => `${p[0].toFixed(2)} ${p[1].toFixed(2)}`)
    .join(" L ");
  return { d: `M ${pts} Z`, ang: (Math.atan2(tx / tl, -ty / tl) * 180) / Math.PI };
}

/* ------------------------------------------------------------------ tracks */

const B = BEATS;

const gTx = track([
  [0, 4],
  [B.turn + 140, 0, EO],
  [B.reach, 0],
  [B.grip, 3, EO],
  [B.pull, 3],
  [GREET_MS - 60, -172, PULL_E],
]);
const gScale = track([
  [0, 0.92],
  [B.turn + 140, 1.02, EO],
  [B.peer, 1, EO],
  [B.hold, 1.14, EO],
  [B.rock, 1.14],
  [B.rock + 320, 0.93, EO],
  [B.rock + 540, 1.035, EO],
  [B.rock + 740, 1, EO],
]);
/**
 * The turn itself: squeezed edge-on, then widened back out.
 *
 * 300ms in and 170 out. It was 80 and 82, which is not enough frames for the
 * eye to read a rotation at all — it landed as a cut, and came back as "he
 * turns round far too fast". The ease-in is kept: a turn should still start
 * slow and whip through the flat, it just needs the anticipation to exist.
 */
/**
 * The turn, as a horizontal squash of the whole body.
 *
 * Exported only so a test can walk the real curve. The complaint it answers is
 * about a single frame, so a test that rebuilt the track from constants could
 * pass while this one snapped.
 */
export const gScaleX = track([
  [0, 1],
  [B.turn, 0.05, MOVE_E],
  [B.turn + 220, 1.06, MOVE_E],
  [B.peer, 1, EO],
]);
const gRot = track([
  [0, 0],
  [B.rock, 0],
  [B.rock + 320, 4.5, EO],
  [B.rock + 700, 0, EO],
  [B.wink, 0],
  [B.wink + 200, -8, EO],
  [B.wink + 560, -8],
  [B.reach, 0, EO],
  [B.grip, 2.2, EO],
  [B.pull, 2.2],
  [B.pull + 140, -5, EO],
]);
const gShade = track([
  [0, 0.24],
  [B.turn - 1, 0.24],
  [B.turn, 0, LIN],
]);
const gFace = track([
  [0, 0],
  [B.turn - 1, 0, LIN],
  [B.turn, 1, LIN],
]);
const gRy = track([
  [B.turn, 12],
  [B.hold, 4, EO],
  [B.rock, 4],
  [B.rock + 380, 14.6, SNAP],
  [B.rock + 700, 13.4, EO],
]);
const gRx = track([
  [B.turn, 7],
  [B.hold, 6.4, EO],
  [B.rock, 6.4],
  [B.rock + 380, 7.6, EO],
]);
/**
 * The wink, stretched least of all the beats. A blink is genuinely quick, and
 * a slow one reads as sleepy rather than as a wink — so this got ~30% where
 * everything around it got ~70%.
 */
const gWink = track([
  [B.wink, 0],
  [B.wink + 170, 1, EO],
  [B.wink + 470, 1],
  [B.wink + 610, 0, EO],
]);
const gEyeX = track([
  [0, 0],
  [B.reach + 20, 0],
  [B.reach + 220, 2.4, EO],
]);
const gCards = track([
  [0, 1],
  [B.turn + 60, 0, EO],
]);
/**
 * The curtain edge starts 90ms AFTER the body starts pulling — the yank first,
 * the load follows. The hand and the clip edge still read the same number,
 * which is what makes it look like dragging rather than racing.
 */
const gEdge = track([
  [0, 150],
  [B.pull + 90, 150],
  [GREET_MS - 80, -53, EDGE_E],
]);

const gBraceY = track([
  [0, 0],
  [B.peer, 0],
  [B.hold, 2.2, EO],
  [B.rock, 2.2],
  [B.rock + 300, -4.5, EO],
  [B.rock + 520, -4.5],
  [B.rock + 800, 0, EO],
]);
const gBendL = track([
  [0, 13],
  [B.peer + 140, -15, EO],
]);
const gBendR = track([
  [0, -13],
  [B.peer + 140, 15, EO],
  [B.reach, 15],
  [B.grip, 5, EO],
]);

/**
 * Where the hands rest once he has turned around. Pushed out and down from
 * (10, 76) when the hand became a circle: a 24-unit disc parked there sat in
 * the middle of the lower wing and read as a hole in it, where the old glove's
 * fingers had broken the overlap up.
 */
const REST_L: readonly [number, number] = [5, 81];
const REST_R: readonly [number, number] = [95, 81];

/* ----------------------------------------------------------------- markup */

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const GRADIENT_ID = "gnt-mw-wing";

/**
 * Static skeleton. Every per-frame value is written as an attribute by
 * `render()`; nothing here encodes a pose.
 *
 * The background rect is deliberately far larger than the viewBox: the SVG is
 * fitted with `meet`, so on a tall phone there is letterbox above and below
 * that still has to read as the page rather than as a hole.
 */
function cardMarkup(): string {
  const w = 20;
  const h = 27;
  return (
    `<g class="mw-card-g">` +
    `<rect class="mw-card" x="${-w / 2}" y="${-h / 2}" width="${w}" height="${h}" rx="3.2"/>` +
    `<circle class="mw-card-line" cy="${-h * 0.17}" r="${w * 0.19}"/>` +
    `<rect class="mw-card-line" x="${-w * 0.28}" y="${h * 0.11}" width="${w * 0.56}" height="1.8" rx=".9"/>` +
    `<rect class="mw-card-line" x="${-w * 0.19}" y="${h * 0.25}" width="${w * 0.38}" height="1.8" rx=".9"/>` +
    `</g>`
  );
}

export function mascotWelcomeMarkup(ariaLabel: string): string {
  const cards = CARDS.map(cardMarkup).join("");
  // One spare card per hand, painted ABOVE the body. A card he is holding up to
  // look at has to be in front of him, and the stream is behind him — so the
  // held one is a different node rather than the same node re-parented every
  // frame. Its stream twin is hidden while it is out.
  const held = `${cardMarkup()}${cardMarkup()}`;

  return (
    `<div class="mw" role="status" aria-label="${escapeHtml(ariaLabel)}">` +
    `<svg class="mw-svg" viewBox="-50 -28 200 156" aria-hidden="true" focusable="false">` +
    `<defs>` +
    `<radialGradient id="${GRADIENT_ID}" gradientUnits="userSpaceOnUse" cx="32.27" cy="82.51" r="77.07">` +
    `<stop offset="0%" stop-color="#FF00FF"/><stop offset="30%" stop-color="#C82356"/>` +
    `<stop offset="70%" stop-color="#8B253B"/><stop offset="100%" stop-color="#3B0B1E"/>` +
    `</radialGradient>` +
    `<linearGradient id="gnt-mw-edge" x1="0" y1="0" x2="1" y2="0">` +
    `<stop offset="0%" stop-color="#000" stop-opacity="0"/>` +
    `<stop offset="100%" stop-color="#000" stop-opacity=".45"/>` +
    `</linearGradient>` +
    `<clipPath id="gnt-mw-wipe"><rect class="mw-wipe" x="-260" y="-238" width="420" height="576"/></clipPath>` +
    `</defs>` +
    `<g class="mw-stage" clip-path="url(#gnt-mw-wipe)">` +
    `<rect class="mw-bg" x="-260" y="-238" width="620" height="576"/>` +
    `<g class="mw-cards">${cards}</g>` +
    `<g class="mw-arms"><path class="mw-arm mw-arm-l"/><path class="mw-arm mw-arm-r"/></g>` +
    `<g class="mw-body"><g class="mw-turner">` +
    `<path class="mw-wings" fill="url(#${GRADIENT_ID})" d="${MASCOT_BODY}"/>` +
    `<path class="mw-shade" d="${MASCOT_BODY}"/>` +
    `<g class="mw-face">` +
    `<ellipse class="mw-eye mw-eye-l"/><path class="mw-lid"/><ellipse class="mw-eye mw-eye-r"/>` +
    `</g></g></g>` +
    `<g class="mw-held">${held}</g>` +
    `<g class="mw-gloves"></g>` +
    `</g>` +
    `<rect class="mw-edge" y="-238" height="576" width="14" fill="url(#gnt-mw-edge)" opacity="0"/>` +
    `<g class="mw-grab"></g>` +
    `</svg></div>`
  );
}

/* ---------------------------------------------------------------- runtime */

export interface MascotHandle {
  /** Start (or resume) the loading loop. */
  startLoop(): void;
  /** Play the greeting once, resolving when the curtain has cleared. */
  playGreeting(): Promise<void>;
  /** Cut the greeting short; the promise from `playGreeting` still resolves. */
  skip(): void;
  /** Fade the whole overlay out (no greeting), resolving when it is gone. */
  fadeOut(): Promise<void>;
  /** Draw one deterministic frame. `phase` picks the loop or the greeting. */
  renderAt(phase: "loop" | "greet", t: number): void;
  destroy(): void;
}

interface HandParts {
  g: SVGGElement;
}

/**
 * The hand: one circle, and nothing else.
 *
 * It replaced a five-digit glove (cuff ellipse, four two-segment fingers, a
 * palm painted last to bury their roots) on 2026-08-23. That rig had to solve
 * a problem a circle does not have — which way the palm faces — and every
 * frame where it got that even slightly wrong read as a sticker dragged
 * across the screen rather than a hand. A circle is orientation-free by
 * construction, so the class of defect is gone rather than tuned away.
 */
function buildHand(parent: Element): HandParts {
  const g = document.createElementNS(NS, "g");
  const palm = document.createElementNS(NS, "ellipse");
  palm.setAttribute("rx", String(HAND_R));
  palm.setAttribute("ry", String(HAND_R));
  palm.setAttribute("class", "mw-hand");
  g.appendChild(palm);
  parent.appendChild(g);
  return { g };
}

/** Drawn size of the hand. Kept apart from `HAND_R` so squash is readable. */
const HAND_S = 1.12;

/**
 * Hand scale, as `[across, along]` the arm.
 *
 * Two signals, deliberately NOT the same one — they used to be, and it was
 * wrong (founder, 2026-08-23):
 *
 * - **`grip`** — holding a card. It only ever changes SIZE: the hand closes a
 *   little and stays a circle. A hand that went oval every time it touched a
 *   card read as a blob squashing against the screen rather than as fingers
 *   closing, which is the one thing a circle genuinely cannot mime.
 * - **`pinch`** — the curtain, and nothing else in the whole piece. That is the
 *   single beat where taking hold of an edge is the point, so the deformation
 *   is spent there and is legible precisely because it happens once.
 *
 * The oval stays under 1.4:1 either way: past ~20% a circle stops reading as a
 * hand and starts reading as a bouncing ball.
 */
export function handScale(grip: number, pinch = 0): [number, number] {
  const s = HAND_S * (1 - grip * 0.11);
  return [s * (1 + pinch * 0.14), s * (1 - pinch * 0.17)];
}

/**
 * Place the hand, size it by `grip`, and deform it by `pinch`.
 *
 * The deformation axis comes from the arm's own tangent, so the hand that grabs
 * the curtain flattens along the reach with no extra bookkeeping.
 */
function setHand(
  parts: HandParts,
  x: number,
  y: number,
  ang: number,
  grip: number,
  pinch = 0,
): void {
  const [across, along] = handScale(grip, pinch);
  parts.g.setAttribute(
    "transform",
    `translate(${x.toFixed(2)} ${y.toFixed(2)}) rotate(${ang.toFixed(2)}) ` +
      `scale(${across.toFixed(3)} ${along.toFixed(3)})`,
  );
}

export function mountMascotWelcome(host: HTMLElement, ariaLabel: string): MascotHandle {
  host.innerHTML = mascotWelcomeMarkup(ariaLabel);
  const root = host.firstElementChild as HTMLElement;
  const q = <T extends Element>(sel: string): T => root.querySelector(sel) as T;

  const turner = q<SVGGElement>(".mw-turner");
  const bodyG = q<SVGGElement>(".mw-body");
  const shade = q<SVGPathElement>(".mw-shade");
  const face = q<SVGGElement>(".mw-face");
  const eyeL = q<SVGEllipseElement>(".mw-eye-l");
  const eyeR = q<SVGEllipseElement>(".mw-eye-r");
  const lid = q<SVGPathElement>(".mw-lid");
  const armL = q<SVGPathElement>(".mw-arm-l");
  const armR = q<SVGPathElement>(".mw-arm-r");
  const cardsG = q<SVGGElement>(".mw-cards");
  const heldG = q<SVGGElement>(".mw-held");
  const glovesG = q<SVGGElement>(".mw-gloves");
  const grabG = q<SVGGElement>(".mw-grab");
  const wipe = q<SVGRectElement>(".mw-wipe");
  const edge = q<SVGRectElement>(".mw-edge");
  const cardNodes = Array.from(cardsG.children) as SVGGElement[];
  const heldNodes = Array.from(heldG.children) as SVGGElement[];

  const gL = buildHand(glovesG);
  const gR = buildHand(glovesG);
  const gGrab = buildHand(grabG);

  let raf = 0;
  let loopStart = 0;
  let greetStart = -1;
  /**
   * The loop time the greeting takes over from.
   *
   * The greeting blends its hands out of whatever pose the loop was in, and a
   * gesture now takes 1400ms — so blending from a fixed `handWork(0, …)`, which
   * is what this used to do, would snap the hands across half a stage at the
   * moment of the turn. It was invisible at 190ms per grab and would not be now.
   */
  let handoffT = 0;
  let skipAt = -1;
  let resolveGreet: (() => void) | null = null;
  let destroyed = false;

  const breath = (t: number): number =>
    t > B.rock + 740 ? 1 + 0.007 * Math.sin(((t - B.rock - 740) * Math.PI * 2) / 2600) : 1;

  /**
   * Map a body-local point through the SAME transform chain the body group
   * uses, so hands and shoulders stay glued through every lean and the pull.
   */
  function bodyMap(t: number, px: number, py: number, pinch: boolean): [number, number] {
    const tx = gTx(t);
    const sc = gScale(t) * breath(t);
    const sx = pinch ? gScaleX(t) : 1;
    const r = rad(gRot(t));
    const c = Math.cos(r);
    const s = Math.sin(r);
    const vx = px - 50;
    const vy = py - 50;
    return [50 + tx + (vx * c - vy * s) * sx * sc, 50 + (vx * s + vy * c) * sc];
  }

  /** Follow-through: the hand rides the body transform ~60ms late, capped. */
  function anchor(t: number, lx: number, ly: number): [number, number] {
    const now = bodyMap(t, lx, ly, false);
    const past = bodyMap(Math.max(0, t - 60), lx, ly, false);
    let dx = past[0] - now[0];
    let dy = past[1] - now[1];
    const d = Math.hypot(dx, dy);
    if (d > 14) {
      dx *= 14 / d;
      dy *= 14 / d;
    }
    return [now[0] + dx, now[1] + dy];
  }

  /**
   * Draw the stream, and the one or two cards currently out of it.
   *
   * A held card is drawn by its own node in `.mw-held` (above the body) and its
   * stream twin is hidden, so the same card is never painted twice.
   */
  function drawCards(t: number, opacity: number, hands: readonly [HandState, HandState]): void {
    cardsG.setAttribute("opacity", String(opacity));
    heldG.setAttribute("opacity", String(opacity));

    for (let i = 0; i < CARDS.length; i++) {
      const c = CARDS[i]!;
      const node = cardNodes[i]!;
      const out = hands.some((h) => h.hold !== null && h.card === i);
      if (out) {
        node.setAttribute("opacity", "0");
        continue;
      }
      // Touched but not yet lifted: it brightens under the hand, which is what
      // says the hand landed on THIS one out of the stream.
      const touched = hands.some((h) => h.card === i);
      const x = cardX(c, t);
      node.setAttribute(
        "transform",
        `translate(${x.toFixed(2)} ${c.y}) rotate(${c.r.toFixed(1)}) scale(${c.s.toFixed(3)})`,
      );
      const lit = touched ? Math.min(0.82, c.o + 0.2) : c.o;
      node.setAttribute("opacity", (lit * cardFade(x)).toFixed(3));
    }

    for (let h = 0; h < 2; h++) {
      const hand = hands[h]!;
      const node = heldNodes[h]!;
      if (hand.hold === null || hand.card < 0) {
        node.setAttribute("opacity", "0");
        continue;
      }
      const c = CARDS[hand.card]!;
      const lift = hand.lift;
      // Bigger, straighter and far more opaque than the stream it left: the one
      // he is reading is the only vivid thing on screen. It converges on a FIXED
      // size rather than a multiple of its own — see `HELD_SCALE`.
      const s = mix(c.s, HELD_SCALE, lift);
      const r = mix(c.r, h === 0 ? -7 : 7, lift);
      node.setAttribute(
        "transform",
        `translate(${hand.hold[0].toFixed(2)} ${hand.hold[1].toFixed(2)}) ` +
          `rotate(${r.toFixed(1)}) scale(${s.toFixed(3)})`,
      );
      // The fade applies to the held one too. It is 1 across the whole examine
      // spot, so this only bites while the card is being PUT BACK: the stream
      // has moved on under him, and a card returned near the right margin has
      // to leave the same way its neighbours do rather than blinking out when
      // the twin takes over.
      node.setAttribute("opacity", (mix(c.o, 0.95, lift) * cardFade(hand.hold[0])).toFixed(3));
    }
  }

  /** The loop: back to us, working. Periodic, so any length is seamless. */
  function renderLoop(t: number): void {
    const tx = loopSway(t);
    bodyG.setAttribute("transform", `translate(${tx.toFixed(3)} 0)`);
    turner.setAttribute(
      "transform",
      `translate(50 50) scale(0.92 0.92) rotate(${(tx * 0.42).toFixed(3)}) translate(-50 -50)`,
    );
    shade.setAttribute("opacity", "0.24");
    face.setAttribute("opacity", "0");

    const a = handWork(t, 0, 0);
    const b = handWork(t, 1, HAND_PHASE_R);
    // The SHOULDERS sway with him; the hands do not. A hand resting on a card
    // has to be exactly where that card is, and the cards are not attached to
    // him — adding the sway to both put the hand up to 7 units off its own
    // grip. The arm simply stretches a little as he leans, which is what an arm
    // holding something steady actually does.
    const hL = a.pos;
    const hR = b.pos;

    // The bow flips while a card is held, and that is the last thing standing
    // between the burgundy arm and a floating white dot. At rest the arm bows
    // UP, which is right for a reach; holding, the hand grips the card's bottom
    // corner and the up-bow puts the arm's whole belly behind a card drawn on
    // top of it — the shoulder end is already inside the body, so nothing at
    // all is left on screen (measured: 0 of 43 units visible). Bowed down it
    // runs along the card's lower edge, out in the open.
    const A = armGlove([34 + tx, 68], hL, mix(13, -13, a.lift));
    const Bm = armGlove([66 + tx, 68], hR, mix(-13, 13, b.lift));
    armL.setAttribute("d", A.d);
    armR.setAttribute("d", Bm.d);
    setHand(gL, hL[0], hL[1], A.ang, a.grip);
    setHand(gR, hR[0], hR[1], Bm.ang, b.grip);
    gR.g.setAttribute("opacity", "1");
    gGrab.g.setAttribute("opacity", "0");

    drawCards(t, 1, [a, b]);
    // Derived, not written twice: `cardFade` ramps a card to nothing exactly
    // here, so a clip edge moved without moving that constant would start
    // guillotining cards again — the seam this pair exists to close.
    wipe.setAttribute("x", "-260");
    wipe.setAttribute("width", String(LOOP_EDGE + 260));
    edge.setAttribute("opacity", "0");
  }

  /** The greeting: turn, peer, rock back, wink, and pull the curtain. */
  function renderGreet(t: number): void {
    const tx = gTx(t);
    const sc = gScale(t) * breath(t);
    const sx = gScaleX(t);
    bodyG.setAttribute("transform", `translate(${tx.toFixed(3)} 0)`);
    turner.setAttribute(
      "transform",
      `translate(50 50) scale(${(sc * sx).toFixed(4)} ${sc.toFixed(4)}) rotate(${gRot(t).toFixed(3)}) translate(-50 -50)`,
    );
    shade.setAttribute("opacity", String(gShade(t)));
    face.setAttribute("opacity", String(gFace(t)));

    const cy = 50;
    const dx = 11;
    const ry = gRy(t);
    const rx = gRx(t);
    const wink = gWink(t);
    const ex = gEyeX(t);
    const lRy = ry + (0.55 - ry) * wink;
    const arcOn = clamp((wink - 0.55) / 0.45, 0, 1);
    eyeL.setAttribute("cx", String(50 - dx + ex));
    eyeL.setAttribute("cy", String(cy));
    eyeL.setAttribute("rx", String(rx));
    eyeL.setAttribute("ry", String(Math.max(0.4, lRy)));
    eyeL.setAttribute("opacity", String(1 - arcOn));
    eyeR.setAttribute("cx", String(50 + dx + ex));
    eyeR.setAttribute("cy", String(cy));
    eyeR.setAttribute("rx", String(rx));
    eyeR.setAttribute("ry", String(ry));
    const ax = 50 - dx + ex;
    const w = rx * 1.06;
    lid.setAttribute("d", `M ${ax - w} ${cy + 2.07} Q ${ax} ${cy - 4.37} ${ax + w} ${cy + 2.07}`);
    lid.setAttribute("opacity", String(arcOn));

    // Hands settle from the loop's last pose into the rest stance.
    const settle = EO(clamp(t / 520, 0, 1));
    const fA = handWork(handoffT, 0, 0);
    const fB = handWork(handoffT, 1, HAND_PHASE_R);
    const rl = anchor(t, REST_L[0], REST_L[1]);
    const rr = anchor(t, REST_R[0], REST_R[1]);
    const by = gBraceY(t);
    const on = clamp((t - (B.rock + 780)) / 600, 0, 1);
    let hL: [number, number] = [
      mix(fA.pos[0], rl[0] + Math.sin(t / 560) * 0.6 * on, settle),
      mix(fA.pos[1], rl[1] + by + Math.cos(t / 760) * 0.7 * on, settle),
    ];
    let hR: [number, number] = [
      mix(fB.pos[0], rr[0] + Math.sin(t / 560 + 1.4) * 0.6 * on, settle),
      mix(fB.pos[1], rr[1] + by + Math.cos(t / 760 + 0.9) * 0.7 * on, settle),
    ];

    // Counterpose: as the right arm shoots right, the left swings out.
    if (t >= B.reach) {
      const v = EO(clamp((t - B.reach) / (B.grip - B.reach), 0, 1));
      hL = [hL[0] - 3.5 * v, hL[1] + 1.6 * v];
    }
    const ed = gEdge(t);
    if (t >= B.reach) {
      const p = EO(clamp((t - B.reach) / (B.grip - B.reach), 0, 1));
      hR = [mix(hR[0], 146.8, p), mix(hR[1], 50, p) - 12 * Math.sin(Math.PI * p) * 0.7];
    }
    // The hand and the curtain edge read the SAME number from here on.
    if (t >= B.grip) hR = [ed - 3.2, 50];

    const shL = bodyMap(t, 34, 68, true);
    const shR = bodyMap(t, 66, 68, true);
    const A = armGlove(shL, hL, gBendL(t));
    const Bm = armGlove(shR, hR, gBendR(t));
    armL.setAttribute("d", A.d);
    armR.setAttribute("d", Bm.d);

    // Grip is still just size — he lets go of whatever the loop left him
    // holding. `pinch` is the ONLY oval in the piece, and it belongs to the one
    // beat that is about taking hold of an edge.
    const gripL = fA.grip * (1 - settle);
    let gripR = fB.grip * (1 - settle);
    let pinchR = 0;
    if (t >= B.reach) gripR = 0;
    if (t >= B.grip) {
      gripR = 0;
      pinchR = EO(clamp((t - B.grip) / 180, 0, 1));
    }

    const swap = t >= B.grip;
    setHand(gL, hL[0], hL[1], A.ang, gripL);
    setHand(gR, hR[0], hR[1], Bm.ang, gripR, pinchR);
    gR.g.setAttribute("opacity", swap ? "0" : "1");
    setHand(gGrab, hR[0], hR[1], Bm.ang, gripR, pinchR);
    // The grabbing hand rides OUTSIDE the curtain clip — that is what lets it
    // hold the edge rather than be cut by it — so nothing else stops it being
    // drawn once the edge has left the stage (the SVG keeps `overflow:
    // visible` to paint the letterbox bands). It fades out over the last
    // stretch instead, so it leaves with the curtain rather than hanging on
    // the screen's left margin.
    gGrab.g.setAttribute(
      "opacity",
      swap ? clamp((ed + 50) / 20, 0, 1).toFixed(3) : "0",
    );

    // The stream carries on from where the loop left it (`handoffT + t`, not
    // `t` — the greeting's clock starts at zero and the cards' does not), while
    // whatever he was holding stays frozen at the pose he abandoned and fades
    // with the rest. Both matter now that the fade takes 360ms and a held card
    // is the brightest thing on screen: released, it would snap back across the
    // stage in full view.
    drawCards(handoffT + t, gCards(t), [fA, fB]);

    // The stage keeps everything LEFT of the curtain edge; what is right of it
    // is simply not painted, so the real screen shows through. The rect's left
    // side stays pinned far off-canvas — only its right edge moves.
    wipe.setAttribute("x", "-260");
    wipe.setAttribute("width", Math.max(0, ed + 260).toFixed(2));
    edge.setAttribute("x", (ed - 14).toFixed(2));
    edge.setAttribute("opacity", ed < 150 && ed > -53 ? "1" : "0");
  }

  function frame(now: number): void {
    if (destroyed) return;
    if (greetStart < 0) {
      renderLoop(now - loopStart);
      raf = requestAnimationFrame(frame);
      return;
    }
    const t = now - greetStart;
    if (skipAt >= 0) {
      // A skip does not jump the animation — it fades the overlay from
      // wherever it is, so the last thing the eye saw is still on screen.
      renderGreet(Math.min(t, GREET_MS));
      if (now - skipAt >= 200) {
        finishGreet();
        return;
      }
      raf = requestAnimationFrame(frame);
      return;
    }
    if (t >= GREET_MS) {
      renderGreet(GREET_MS);
      finishGreet();
      return;
    }
    renderGreet(t);
    raf = requestAnimationFrame(frame);
  }

  function finishGreet(): void {
    cancelAnimationFrame(raf);
    raf = 0;
    const done = resolveGreet;
    resolveGreet = null;
    done?.();
  }

  return {
    startLoop() {
      if (destroyed || raf) return;
      loopStart = performance.now();
      raf = requestAnimationFrame(frame);
    },
    playGreeting() {
      if (destroyed) return Promise.resolve();
      greetStart = performance.now();
      handoffT = loopStart ? greetStart - loopStart : 0;
      skipAt = -1;
      if (!raf) raf = requestAnimationFrame(frame);
      return new Promise<void>((resolve) => {
        resolveGreet = resolve;
      });
    },
    skip() {
      if (greetStart < 0 || skipAt >= 0) return;
      skipAt = performance.now();
      root.classList.add("is-leaving");
    },
    fadeOut() {
      root.classList.add("is-leaving");
      return new Promise<void>((resolve) => {
        setTimeout(resolve, FADE_MS);
      });
    },
    renderAt(phase, t) {
      cancelAnimationFrame(raf);
      raf = 0;
      if (phase === "loop") renderLoop(t);
      else renderGreet(clamp(t, 0, GREET_MS));
    },
    destroy() {
      destroyed = true;
      cancelAnimationFrame(raf);
      raf = 0;
      resolveGreet?.();
      resolveGreet = null;
      host.innerHTML = "";
    },
  };
}
