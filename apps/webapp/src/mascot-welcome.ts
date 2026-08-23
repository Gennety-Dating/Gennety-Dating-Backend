/**
 * The welcome mascot — the Gennety butterfly, with eyes and gloved hands,
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
 * - **The glove is oriented by the arm, not by a track.** The arm is a
 *   quadratic; the cuff takes the curve's tangent at the wrist, so the palm
 *   turns *with* the arm at every frame. A constant angle is what made an
 *   earlier version read as a sticker dragged around the screen.
 * - **The hands grab real cards.** A hand flies to where a specific card *will*
 *   be at the moment of contact and then rides it. The cards stream on their
 *   own clock, so the target is solved per frame, not baked.
 * - **Hands lag the body.** Each hand is anchored in the body's own coordinate
 *   space and samples that transform ~60ms late, which is what gives the
 *   rock-back its whip.
 *
 * Everything that CAN be a curve still is: `track()` evaluates real CSS
 * `cubic-bezier()` by Newton iteration, so the easings here are the same
 * easings a stylesheet would have.
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
export const GREET_MS = 3700;

/**
 * Minimum loop before the greeting may start.
 *
 * A turn-around only reads as "he noticed you" if there was something to
 * interrupt. `/state` often answers in a few hundred milliseconds, so without a
 * floor the mascot would spin round before the audience has seen him working.
 */
export const LOOP_FLOOR_MS = 1400;

/** Fade used when the greeting is skipped or not played at all. */
export const FADE_MS = 240;

/** Beat boundaries inside the greeting, in ms from its start. */
export const BEATS = {
  turn: 80,
  peer: 260,
  hold: 700,
  rock: 1050,
  wink: 1750,
  reach: 2300,
  grip: 2600,
  pull: 2760,
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
const EI = bezier(0.62, 0, 0.9, 0.42);
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
 */
export const CARDS: readonly Card[] = [
  { ph: 0.0, y: 10, r: -8, sp: 0.135, o: 0.62, s: 1.05 },
  { ph: 0.17, y: 92, r: 7, sp: 0.15, o: 0.5, s: 0.92 },
  { ph: 0.31, y: 26, r: 5, sp: 0.12, o: 0.44, s: 0.82 },
  { ph: 0.44, y: 74, r: -6, sp: 0.14, o: 0.58, s: 1.0 },
  { ph: 0.55, y: 4, r: 9, sp: 0.125, o: 0.38, s: 0.78 },
  { ph: 0.66, y: 104, r: -4, sp: 0.132, o: 0.54, s: 0.96 },
  { ph: 0.75, y: 44, r: 6, sp: 0.118, o: 0.34, s: 0.74 },
  { ph: 0.86, y: 62, r: -9, sp: 0.146, o: 0.46, s: 0.88 },
  { ph: 0.94, y: 20, r: 3, sp: 0.128, o: 0.4, s: 0.8 },
];

const frac = (v: number): number => ((v % 1) + 1) % 1;

/** Where a card sits at time `t`. Continuous and periodic — the loop is seamless. */
export function cardX(card: Card, t: number): number {
  return -78 + frac((t / 1000) * card.sp + card.ph) * 268;
}

/** One grab cycle. */
export const CYC = 190;
const RIDE_FROM = 0.42;

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
 * Which card this hand books for the contact at `tc`.
 *
 * The right hand never books the card the left one is on (`depth` breaks the
 * mutual recursion), and a cycle with no card in reach is a deliberate MISS —
 * the hand hovers open at home, which reads as searching rather than as noise.
 */
export function targetFor(hand: 0 | 1, tc: number, depth = 0): HandTarget {
  const band = HAND_BAND[hand]!;
  const home = HAND_HOME[hand]!;
  let excl = -1;
  if (hand === 1 && depth === 0) {
    const lk = Math.floor(tc / CYC);
    excl = targetFor(0, lk * CYC + CYC * RIDE_FROM, 1).card;
  }
  let best = -1;
  let bs = Infinity;
  for (let i = 0; i < CARDS.length; i++) {
    if (i === excl) continue;
    const card = CARDS[i]!;
    const x = cardX(card, tc);
    const y = card.y - 6;
    if (y < 30 || x < band[0] || x > band[1]) continue;
    if (isBehindBody(x, y)) continue;
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
  return { card: best, pos: [cardX(card, tc), card.y - 6], miss: false };
}

function hoverAt(hand: 0 | 1, t: number): [number, number] {
  const home = HAND_HOME[hand]!;
  return [home[0] + Math.sin(t * 0.011) * 3.2, home[1] + Math.cos(t * 0.014) * 2.4];
}

export interface HandState {
  pos: [number, number];
  grip: number;
  card: number;
  rideP: number;
}

/**
 * The loop's hand solver. Fly to the booked card, close on approach, ride it.
 * Purely a function of `t`, so the loop is seamless at any length.
 */
export function handWork(t: number, hand: 0 | 1, off: number): HandState {
  const u = t / CYC + off;
  const k = Math.floor(u);
  const f = u - k;
  const t0 = (k - off) * CYC;
  const tc = t0 + CYC * RIDE_FROM;
  const now = targetFor(hand, tc);
  const prev = targetFor(hand, t0 - CYC + CYC * RIDE_FROM);
  const release = prev.miss
    ? prev.pos
    : ([cardX(CARDS[prev.card]!, t0), CARDS[prev.card]!.y - 6] as [number, number]);

  if (f < RIDE_FROM) {
    const p = EO(f / RIDE_FROM);
    const grip = now.miss ? 0 : f < 0.12 ? 1 - EO(f / 0.12) : EO(clamp((f - 0.3) / 0.12, 0, 1));
    return {
      pos: [
        mix(release[0], now.pos[0], p),
        mix(release[1], now.pos[1], p) - 9 * Math.sin(Math.PI * p),
      ],
      grip,
      card: -1,
      rideP: 0,
    };
  }
  if (now.miss) return { pos: hoverAt(hand, t), grip: 0, card: -1, rideP: 0 };
  const card = CARDS[now.card]!;
  let x = cardX(card, t);
  if (Math.abs(x - now.pos[0]) > 60) x = now.pos[0];
  return { pos: [x, card.y - 6], grip: 1, card: now.card, rideP: (f - RIDE_FROM) / (1 - RIDE_FROM) };
}

/** Body sway during the loop. Periodic by construction — no loop seam. */
export function loopSway(t: number): number {
  return Math.sin((t / 1400) * Math.PI * 2) * 7;
}

/* ------------------------------------------------------------------ glove */

const F_ROOT: readonly [number, number][] = [
  [-2.5, -1.6],
  [0.2, -2.5],
  [2.9, -1.6],
];
const TH_ROOT: readonly [number, number] = [-3.0, 1.8];

/** Per digit: `[rootAngle, tipAngle, rootLen, tipLen]`. */
type Pose = number[][];

export const POSE: Record<"open" | "grip" | "flat", Pose> = {
  open: [
    [-104, -100, 5.4, 5.0],
    [-92, -89, 5.8, 5.4],
    [-80, -76, 5.3, 4.8],
    [-160, -140, 5.2, 4.4],
  ],
  grip: [
    [-88, -24, 4.8, 4.4],
    [-80, -14, 5.0, 4.6],
    [-70, -6, 4.6, 4.2],
    [-176, -118, 5.0, 4.2],
  ],
  flat: [
    [-99, -96, 5.6, 5.2],
    [-91, -90, 5.9, 5.5],
    [-83, -80, 5.5, 5.1],
    [-166, -158, 5.2, 4.6],
  ],
};

const mixPose = (a: Pose, b: Pose, p: number): Pose =>
  a.map((d, i) => d.map((v, j) => v + (b[i]![j]! - v) * p));

export interface ArmResult {
  /** Filled band — a stroked line cannot taper. */
  d: string;
  /** Cuff angle taken from the curve's tangent at the wrist. */
  ang: number;
}

/**
 * The arm, and the glove angle that keeps the cuff pointing back along it.
 *
 * This is what makes the palm turn with the arm rather than being a sticker.
 * The band also thins as it stretches — cheap mass conservation, but felt.
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
  const k = clamp(Math.sqrt(34 / L), 0.72, 1.05);
  const w0 = 7.4 * k;
  const w1 = 3.9 * k;
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
  [B.turn + 100, 0, EO],
  [B.reach, 0],
  [B.grip, 3, EO],
  [B.pull, 3],
  [GREET_MS - 60, -172, PULL_E],
]);
const gScale = track([
  [0, 0.92],
  [B.turn + 100, 1.02, EO],
  [B.peer, 1, EO],
  [B.hold, 1.14, EO],
  [B.rock, 1.14],
  [B.rock + 230, 0.93, EO],
  [B.rock + 390, 1.035, EO],
  [B.rock + 530, 1, EO],
]);
const gScaleX = track([
  [0, 1],
  [B.turn, 0.05, EI],
  [B.turn + 82, 1.06, EO],
  [B.peer, 1, EO],
]);
const gRot = track([
  [0, 0],
  [B.rock, 0],
  [B.rock + 230, 4.5, EO],
  [B.rock + 500, 0, EO],
  [B.wink, 0],
  [B.wink + 150, -8, EO],
  [B.wink + 430, -8],
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
  [B.rock + 280, 14.6, SNAP],
  [B.rock + 500, 13.4, EO],
]);
const gRx = track([
  [B.turn, 7],
  [B.hold, 6.4, EO],
  [B.rock, 6.4],
  [B.rock + 280, 7.6, EO],
]);
const gWink = track([
  [B.wink, 0],
  [B.wink + 130, 1, EO],
  [B.wink + 410, 1],
  [B.wink + 530, 0, EO],
]);
const gEyeX = track([
  [0, 0],
  [B.reach + 20, 0],
  [B.reach + 220, 2.4, EO],
]);
const gCards = track([
  [0, 1],
  [B.turn + 20, 0, EO],
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
  [B.rock + 220, -4.5, EO],
  [B.rock + 370, -4.5],
  [B.rock + 580, 0, EO],
]);
/** Wrist cock on top of the arm tangent: at rest the fingers point up. */
const gWristL = track([
  [0, 0],
  [B.peer + 90, 40, EO],
]);
const gWristR = track([
  [0, 0],
  [B.peer + 90, -40, EO],
]);
/** On the reach the hand stops being arm-driven and aligns to the curtain. */
const gAbsR = track([
  [0, 0],
  [B.reach, 0],
  [B.grip, 1, EO],
]);
const gBendL = track([
  [0, 13],
  [B.peer + 90, -15, EO],
]);
const gBendR = track([
  [0, -13],
  [B.peer + 90, 15, EO],
  [B.reach, 15],
  [B.grip, 5, EO],
]);

const REST_L: readonly [number, number] = [10, 76];
const REST_R: readonly [number, number] = [90, 76];

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
export function mascotWelcomeMarkup(ariaLabel: string): string {
  const cards = CARDS.map(() => {
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
  }).join("");

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

interface GloveParts {
  g: SVGGElement;
  segs: SVGLineElement[];
}

function buildGlove(parent: Element): GloveParts {
  const g = document.createElementNS(NS, "g");
  const cuff = document.createElementNS(NS, "ellipse");
  cuff.setAttribute("cy", "7.4");
  cuff.setAttribute("rx", "4.3");
  cuff.setAttribute("ry", "2.5");
  cuff.setAttribute("class", "mw-glove");
  g.appendChild(cuff);
  const segs: SVGLineElement[] = [];
  for (let d = 0; d < 4; d++) {
    for (let k = 0; k < 2; k++) {
      const l = document.createElementNS(NS, "line");
      l.setAttribute("class", "mw-digit");
      l.setAttribute("stroke-width", String(d === 3 ? (k ? 4.6 : 5.0) : k ? 4.05 : 4.4));
      g.appendChild(l);
      segs.push(l);
    }
  }
  // Palm LAST: it buries the digit roots, which is what keeps the valleys
  // between the fingers round instead of notched.
  const palm = document.createElementNS(NS, "ellipse");
  palm.setAttribute("rx", "6.4");
  palm.setAttribute("ry", "6.0");
  palm.setAttribute("class", "mw-glove");
  g.appendChild(palm);
  parent.appendChild(g);
  return { g, segs };
}

function setGlove(
  parts: GloveParts,
  pose: Pose,
  x: number,
  y: number,
  ang: number,
  s: number,
  flip: number,
): void {
  for (let d = 0; d < 4; d++) {
    const root = d === 3 ? TH_ROOT : F_ROOT[d]!;
    const [a1, a2, l1, l2] = pose[d] as [number, number, number, number];
    const kx = root[0] + Math.cos(rad(a1)) * l1;
    const ky = root[1] + Math.sin(rad(a1)) * l1;
    const tx = kx + Math.cos(rad(a2)) * l2;
    const ty = ky + Math.sin(rad(a2)) * l2;
    const s1 = parts.segs[d * 2]!;
    const s2 = parts.segs[d * 2 + 1]!;
    s1.setAttribute("x1", String(root[0]));
    s1.setAttribute("y1", String(root[1]));
    s1.setAttribute("x2", kx.toFixed(2));
    s1.setAttribute("y2", ky.toFixed(2));
    s2.setAttribute("x1", kx.toFixed(2));
    s2.setAttribute("y1", ky.toFixed(2));
    s2.setAttribute("x2", tx.toFixed(2));
    s2.setAttribute("y2", ty.toFixed(2));
  }
  parts.g.setAttribute(
    "transform",
    `translate(${x.toFixed(2)} ${y.toFixed(2)}) rotate(${ang.toFixed(2)}) scale(${(s * flip).toFixed(3)} ${s.toFixed(3)})`,
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
  const glovesG = q<SVGGElement>(".mw-gloves");
  const grabG = q<SVGGElement>(".mw-grab");
  const wipe = q<SVGRectElement>(".mw-wipe");
  const edge = q<SVGRectElement>(".mw-edge");
  const cardNodes = Array.from(cardsG.children) as SVGGElement[];

  const gL = buildGlove(glovesG);
  const gR = buildGlove(glovesG);
  const gGrab = buildGlove(grabG);

  let raf = 0;
  let loopStart = 0;
  let greetStart = -1;
  let skipAt = -1;
  let resolveGreet: (() => void) | null = null;
  let destroyed = false;

  const breath = (t: number): number =>
    t > B.rock + 530 ? 1 + 0.007 * Math.sin(((t - B.rock - 530) * Math.PI * 2) / 2600) : 1;

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

  function drawCards(t: number, opacity: number, rideL: number, rideR: number, rpL: number, rpR: number): void {
    cardsG.setAttribute("opacity", String(opacity));
    for (let i = 0; i < CARDS.length; i++) {
      const c = CARDS[i]!;
      const node = cardNodes[i]!;
      let s = c.s;
      let r = c.r;
      let o = c.o;
      const rp = i === rideL ? rpL : i === rideR ? rpR : -1;
      if (rp >= 0) {
        s *= 1.09;
        r += 3.5 * Math.sin(rp * Math.PI);
        o = Math.min(0.85, o + 0.25);
      }
      node.setAttribute(
        "transform",
        `translate(${cardX(c, t).toFixed(2)} ${c.y}) rotate(${r.toFixed(1)}) scale(${s.toFixed(3)})`,
      );
      node.setAttribute("opacity", String(o));
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
    const b = handWork(t, 1, 0.5);
    const hL: [number, number] = [a.pos[0] + tx, a.pos[1]];
    const hR: [number, number] = [b.pos[0] + tx, b.pos[1]];

    const A = armGlove([34 + tx, 68], hL, 13);
    const Bm = armGlove([66 + tx, 68], hR, -13);
    armL.setAttribute("d", A.d);
    armR.setAttribute("d", Bm.d);
    setGlove(gL, mixPose(POSE.open, POSE.grip, a.grip), hL[0], hL[1], A.ang, 1.12, 1);
    setGlove(gR, mixPose(POSE.open, POSE.grip, b.grip), hR[0], hR[1], Bm.ang, 1.12, -1);
    gR.g.setAttribute("opacity", "1");
    gGrab.g.setAttribute("opacity", "0");

    drawCards(t, 1, a.card, b.card, a.rideP, b.rideP);
    wipe.setAttribute("x", "-260");
    wipe.setAttribute("width", "420");
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
    const settle = EO(clamp(t / 300, 0, 1));
    const fA = handWork(0, 0, 0);
    const fB = handWork(0, 1, 0.5);
    const rl = anchor(t, REST_L[0], REST_L[1]);
    const rr = anchor(t, REST_R[0], REST_R[1]);
    const by = gBraceY(t);
    const on = clamp((t - (B.rock + 570)) / 500, 0, 1);
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

    const angL = A.ang + gWristL(t);
    const angR = mix(Bm.ang + gWristR(t), 90, gAbsR(t));

    const poseL = mixPose(POSE.open, POSE.grip, fA.grip * (1 - settle));
    let poseR = mixPose(POSE.open, POSE.grip, fB.grip * (1 - settle));
    if (t >= B.reach) {
      poseR = mixPose(POSE.open, POSE.flat, EO(clamp((t - B.reach) / (B.grip - B.reach), 0, 1)));
    }
    if (t >= B.grip) {
      poseR = mixPose(POSE.flat, POSE.grip, EO(clamp((t - B.grip) / 140, 0, 1)) * 0.55);
    }

    const swap = t >= B.grip;
    setGlove(gL, poseL, hL[0], hL[1], angL, 1.12, 1);
    setGlove(gR, poseR, hR[0], hR[1], angR, 1.12, -1);
    gR.g.setAttribute("opacity", swap ? "0" : "1");
    setGlove(gGrab, poseR, hR[0], hR[1], angR, 1.12, -1);
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

    drawCards(t, gCards(t), -1, -1, 0, 0);

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
