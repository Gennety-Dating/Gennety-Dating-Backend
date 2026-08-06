/**
 * Tap-point particle burst for the two tap-to-answer onboarding screens
 * (gender, "who you're looking for" — see `ChoiceScreen` in
 * onboarding-basics.tsx).
 *
 * Those two screens are the only ones in the set where the answer is committed
 * by a single tap: there is no slider to drag, no drum to spin, no pill to
 * press afterwards. So the tap is the whole interaction, and it had no reaction
 * of its own beyond a 1.5% scale — the screen simply swapped. This gives that
 * one moment a payoff themed to what was picked, thrown from the point the
 * finger actually landed on.
 *
 * Three deliberate constraints:
 *
 *  - **Authored vectors, never emoji.** Same rule as `icons.ts`: a platform
 *    emoji is Apple's art on iOS, Google's on Android and a font glyph on
 *    desktop, and scaling/rotating that glyph rasterizes it. These are drawn on
 *    a flat grid so a spinning particle stays crisp at any size.
 *  - **The palette stays on brand.** Colours are pulled from the button's own
 *    gradient (blue on the male rows, burgundy on the female ones) plus one
 *    warm gold. Rainbow party-popper confetti would read cheap next to the rest
 *    of the flow.
 *  - **It is decoration and behaves like it.** The burst lives in `document.body`,
 *    not in the React tree, so the screen advancing mid-flight can't cut it off;
 *    it never blocks a pointer, never gates the save, and is skipped entirely
 *    under `prefers-reduced-motion` or on a client with no Web Animations API.
 */

export type BurstTone = "male" | "female" | "neutral";

/** viewBox of the shared drawing grid, unless a glyph overrides it. */
const GRID = "0 0 24 24";

interface Glyph {
  /** Filled with the particle's colour. */
  d: string[];
  /** Drawn over the body in a translucent dark — ball patches, wheel hubs. */
  shade?: string[];
  /** Fixed colour, when the object has one (a trophy is gold, not blue). */
  color?: string;
  /** Non-default viewBox, for art authored on another grid. */
  box?: string;
  /** Relative size; a dumbbell wants more width than a heart. */
  scale?: number;
}

/* ── The objects ─────────────────────────────────────────────────────────── */

const FOOTBALL: Glyph = {
  color: "#f4f2f0",
  d: ["M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18Z"],
  shade: [
    "M12 7.4l3.42 2.49-1.31 4.02H9.89L8.58 9.89 12 7.4Z",
    "M12 3.05l2.75 2-.75.95L12 4.85l-2 1.15-.75-.95L12 3.05Z",
    "M4.35 8.6l2.7 1.9-.62 1.1-2.85-.5.77-2.5Z",
    "M19.65 8.6l.77 2.5-2.85.5-.62-1.1 2.7-1.9Z",
  ],
};

/**
 * Mitten wider than it is tall, thumb below-left, cuff narrower than both.
 *
 * Two things carry it at 26px, both learned by rendering it wrong first: the
 * fist must NOT be a dome (a dome plus a cuff is a mushroom, whatever the
 * thumb does), and the thumb needs a dark notch between it and the fist —
 * same fill on two overlapping shapes reads as one blob without it.
 */
const BOXING_GLOVE: Glyph = {
  color: "#b6304f",
  d: [
    "M11 4h5a4.5 4.5 0 0 1 4.5 4.5A4.5 4.5 0 0 1 16 13h-5a4.5 4.5 0 0 1-4.5-4.5A4.5 4.5 0 0 1 11 4Z",
    "M6.6 9.3a2.7 2.7 0 1 0 0 5.4h3V9.3H6.6Z",
    "M9.4 12.4h7.6v4a2.2 2.2 0 0 1-2.2 2.2h-3.2a2.2 2.2 0 0 1-2.2-2.2v-4Z",
  ],
  shade: [
    "M9.3 9.3h1.2v5.4H9.3z",
    "M10 14.6h6.4v1.2H10z",
  ],
};

/**
 * Side-on single-seater: low body, cockpit notch, and a rear wing on its own
 * support. Without the wing the silhouette is just "a car" — the wing is the
 * one feature that says which kind.
 */
const RACE_CAR: Glyph = {
  scale: 1.12,
  d: [
    // Rear wing. Its support runs deep INTO the body rather than stopping at
    // the sloping rear deck — ending it at the outline left the wing floating
    // beside the car like a road sign.
    "M2.6 8.3h5v1.6h-5z",
    "M4.4 9.9h1.6v5.4H4.4z",
    "M2.8 15.6l1.4-2.4c.4-.6 1-1 1.8-1h1.5l1.5-1.8c.4-.5 1-.7 1.6-.7h2.4c.7 0 1.4.4 1.7 1.1l1 2.2 2.5.9c.7.3 1.2.9 1.2 1.7v.5c0 .6-.5 1-1.1 1H3.9c-.6 0-1.1-.4-1.1-1.1v-.4Z",
    "M7.9 14.4a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5Z",
    "M16.8 14.4a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5Z",
  ],
  shade: [
    "M7.9 15.9a1.1 1.1 0 1 1 0 2.2 1.1 1.1 0 0 1 0-2.2Z",
    "M16.8 15.9a1.1 1.1 0 1 1 0 2.2 1.1 1.1 0 0 1 0-2.2Z",
    "M11.3 10.6h2.2c.3 0 .6.2.8.5l.7 1.3h-4.9l1.2-1.8Z",
  ],
};

const TROPHY: Glyph = {
  color: "#e3b45c",
  d: [
    "M7.2 3.4h9.6v4.9a4.8 4.8 0 0 1-9.6 0V3.4Z",
    "M7.2 4.6H5.9a2.9 2.9 0 0 0 0 5.8h1.6V8.9H6a1.4 1.4 0 0 1 0-2.8h1.2V4.6Z",
    "M16.8 4.6h1.3a2.9 2.9 0 0 1 0 5.8h-1.6V8.9H18a1.4 1.4 0 0 0 0-2.8h-1.2V4.6Z",
    "M11 12.9v3.2H8.6a1 1 0 0 0-1 1v1.9h8.8v-1.9a1 1 0 0 0-1-1H13v-3.2h-2Z",
  ],
  shade: ["M12 4.8l.79 1.66 1.81.27-1.3 1.29.3 1.83L12 9.05l-1.6.8.3-1.83-1.3-1.29 1.81-.27L12 4.8Z"],
};

const DUMBBELL: Glyph = {
  color: "#ccd4dd",
  scale: 1.05,
  d: [
    "M9 10.8h6v2.4H9z",
    "M6.1 8.4h2.6v7.2H6.1z",
    "M15.3 8.4h2.6v7.2h-2.6z",
    "M3.4 10.1h2.1v3.8H3.4z",
    "M18.5 10.1h2.1v3.8h-2.1z",
  ],
};

const GAMEPAD: Glyph = {
  d: [
    "M8.4 6.9h7.2a4.8 4.8 0 0 1 4.7 3.9l.8 4.4a2.7 2.7 0 0 1-4.9 2l-1.4-2.1H9.2l-1.4 2.1a2.7 2.7 0 0 1-4.9-2l.8-4.4a4.8 4.8 0 0 1 4.7-3.9Z",
  ],
  shade: [
    "M6.5 9.9H8v1.4h1.4v1.5H8v1.4H6.5v-1.4H5.1v-1.5h1.4V9.9Z",
    "M15.9 10.4a1.15 1.15 0 1 1 0 2.3 1.15 1.15 0 0 1 0-2.3Z",
    "M18.1 12.6a1.15 1.15 0 1 1 0 2.3 1.15 1.15 0 0 1 0-2.3Z",
  ],
};

/**
 * The brand butterfly, redrawn for this size — NOT the logo path.
 *
 * `apps/bot/src/assets/brand/butterfly-logo.svg` is one continuous curve tuned
 * for a card-sized mark; rendered at ~28px it collapses into a bow tie, because
 * nothing separates the upper wings from the lower ones. This version keeps the
 * brand's colour and its four-lobe silhouette but states the wings as separate
 * shapes with a body between them, which is what survives the shrink.
 */
const BUTTERFLY: Glyph = {
  color: "#b6304f",
  // The upper wings are sized so they still overlap the body at the height the
  // body's head reaches. Smaller wings left a background-coloured gap on each
  // side of the head that read as a pair of eyes.
  d: [
    "M8.3 4.2a4.4 4.4 0 1 1 0 8.8 4.4 4.4 0 0 1 0-8.8Z",
    "M15.7 4.2a4.4 4.4 0 1 1 0 8.8 4.4 4.4 0 0 1 0-8.8Z",
    "M9.2 12a3.4 3.4 0 1 1 0 6.8 3.4 3.4 0 0 1 0-6.8Z",
    "M14.8 12a3.4 3.4 0 1 1 0 6.8 3.4 3.4 0 0 1 0-6.8Z",
    "M12 4.6a1.15 1.15 0 0 1 1.15 1.15v11.6a1.15 1.15 0 0 1-2.3 0V5.75A1.15 1.15 0 0 1 12 4.6Z",
    "M11.5 5.1L9 2.2l-1 .85 2.5 2.9 1-.85Z",
    "M12.5 5.1L15 2.2l1 .85-2.5 2.9-1-.85Z",
  ],
  // Deliberately no wing spots: a dark dot at the centre of each upper wing
  // sits exactly where eyes would, and the whole thing reads as a face.
};

const FLOWER: Glyph = {
  color: "#c8506d",
  d: [
    "M12 5.05a2.95 2.95 0 1 1 0 5.9 2.95 2.95 0 0 1 0-5.9Z",
    "M16.09 8.02a2.95 2.95 0 1 1 0 5.9 2.95 2.95 0 0 1 0-5.9Z",
    "M14.53 12.83a2.95 2.95 0 1 1 0 5.9 2.95 2.95 0 0 1 0-5.9Z",
    "M9.47 12.83a2.95 2.95 0 1 1 0 5.9 2.95 2.95 0 0 1 0-5.9Z",
    "M7.91 8.02a2.95 2.95 0 1 1 0 5.9 2.95 2.95 0 0 1 0-5.9Z",
  ],
  shade: ["M12 10.3a2 2 0 1 1 0 4 2 2 0 0 1 0-4Z"],
};

const HEART: Glyph = {
  color: "#a23350",
  // Shared with the solid heart in icons.ts, so the two never drift apart.
  d: [
    "M12 20.3s-7.4-4.6-9.1-9.2C1.7 7.7 3.6 4.5 6.8 4.5c2 0 3.6 1.1 4.4 2.7l.8 1.5.8-1.5c.8-1.6 2.4-2.7 4.4-2.7 3.2 0 5.1 3.2 3.9 6.6-1.7 4.6-9.1 9.2-9.1 9.2Z",
  ],
};

const DIAMOND: Glyph = {
  color: "#f0e6ea",
  d: ["M8.4 3.6h7.2l3.8 4.6L12 20.4 4.6 8.2l3.8-4.6Z"],
  shade: ["M8.4 3.6h7.2l1.7 4.6H6.7l1.7-4.6Z"],
};

const CROWN: Glyph = {
  color: "#e3b45c",
  d: [
    "M3.9 8.1l3.6 2.8L12 4.5l4.5 6.4 3.6-2.8-1.6 9a1.4 1.4 0 0 1-1.4 1.2H6.9a1.4 1.4 0 0 1-1.4-1.2l-1.6-9Z",
  ],
  shade: [
    "M12 12.5a1.15 1.15 0 1 1 0 2.3 1.15 1.15 0 0 1 0-2.3Z",
    "M8 13.1a1 1 0 1 1 0 2 1 1 0 0 1 0-2Z",
    "M16 13.1a1 1 0 1 1 0 2 1 1 0 0 1 0-2Z",
  ],
};

const SPARKLE: Glyph = {
  color: "#f4ecd8",
  d: [
    "M12 2.6c.6 3.6 1.6 5.9 3.2 7.2 1.3 1.1 3.2 1.8 6.2 2.2-3 .4-4.9 1.1-6.2 2.2-1.6 1.3-2.6 3.6-3.2 7.2-.6-3.6-1.6-5.9-3.2-7.2-1.3-1.1-3.2-1.8-6.2-2.2 3-.4 4.9-1.1 6.2-2.2 1.6-1.3 2.6-3.6 3.2-7.2Z",
  ],
};

/**
 * What each option throws. The male set is the "standard attributes" list from
 * the brief; the female set answers it with the brand butterfly leading, so the
 * two read as a matched pair rather than one themed screen and one generic one.
 * "Both" gets the shared symbols only — it must not look like a third gender.
 */
export const BURST_SETS: Record<BurstTone, { glyphs: Glyph[]; palette: string[] }> = {
  male: {
    glyphs: [FOOTBALL, BOXING_GLOVE, RACE_CAR, TROPHY, DUMBBELL, GAMEPAD],
    palette: ["#4d86c4", "#3a6ea6", "#2e5c8c", "#dfe8f2"],
  },
  female: {
    glyphs: [BUTTERFLY, FLOWER, HEART, DIAMOND, CROWN, SPARKLE],
    palette: ["#c8506d", "#a23350", "#b6304f", "#f2e3e6"],
  },
  neutral: {
    glyphs: [HEART, SPARKLE, BUTTERFLY, DIAMOND],
    palette: ["#ffffff", "#c8506d", "#e3b45c", "#d8d5d4"],
  },
};

/* ── Flight ──────────────────────────────────────────────────────────────── */

/** How many objects are thrown, plus the small dots mixed in between them. */
const GLYPH_COUNT = 14;
const DOT_COUNT = 9;

/** px/s². Real-ish, so the arc looks thrown rather than tweened. */
const GRAVITY = 1500;
/** Air-drag time constant, seconds. Terminal fall speed is GRAVITY × this. */
const DRAG_TAU = 0.4;
/** Trajectory samples per particle. Enough that the arc reads as a curve. */
const SAMPLES = 18;

/**
 * A wide speed range on purpose. Narrow it and the particles all reach the same
 * radius at the same moment, which reads as an expanding RING rather than a
 * burst — the giveaway that the whole thing is one tween.
 */
const MIN_SPEED = 300;
const MAX_SPEED = 1020;
const MIN_LIFE_MS = 1050;
const MAX_LIFE_MS = 1550;

/**
 * Position at `t` seconds for a particle launched at (`vx`, `vy`) px/s, under
 * gravity with linear air drag.
 *
 * Solving `v' = g − v/τ` gives `p(t) = gτt + (v₀ − gτ)τ(1 − e^(−t/τ))`, which is
 * what makes the shape right: a fast launch that the drag flattens out, then
 * gravity taking over into a settled fall. A plain parabola shoots out at a
 * constant sideways speed and reads like a tween; ease-out on a straight line
 * loses the fall entirely.
 *
 * Exported for the unit test — it is the one part of this module with a right
 * answer rather than a taste.
 */
export function flightAt(
  vx: number,
  vy: number,
  t: number,
  gravity = GRAVITY,
  tau = DRAG_TAU,
): { x: number; y: number } {
  const decay = 1 - Math.exp(-t / tau);
  return {
    x: vx * tau * decay,
    y: vy * tau * decay + gravity * tau * (t - tau * decay),
  };
}

/* ── Rendering ───────────────────────────────────────────────────────────── */

function svgFor(glyph: Glyph, color: string, size: number): string {
  const body = glyph.d.map((d) => `<path d="${d}"/>`).join("");
  const shade = glyph.shade?.length
    ? `<g fill="rgba(0,0,0,.26)">${glyph.shade.map((d) => `<path d="${d}"/>`).join("")}</g>`
    : "";
  return (
    `<svg viewBox="${glyph.box ?? GRID}" width="${size}" height="${size}" ` +
    `fill="${color}" aria-hidden="true">${body}${shade}</svg>`
  );
}

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function pick<T>(items: T[], index: number): T {
  return items[index % items.length]!;
}

function canAnimate(): boolean {
  if (typeof document === "undefined") return false;
  if (typeof Element === "undefined" || typeof Element.prototype.animate !== "function") {
    return false;
  }
  return !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Throws one burst from a viewport point. Fire-and-forget: it mounts its own
 * layer, animates, and removes itself. Returns silently when the client can't
 * animate or the user asked for reduced motion.
 */
export function burstAt(x: number, y: number, tone: BurstTone): void {
  if (!canAnimate()) return;

  const set = BURST_SETS[tone];
  const layer = document.createElement("div");
  layer.className = "ob-burst";
  layer.setAttribute("aria-hidden", "true");

  // The whole burst is built as one markup string and parsed once, rather than
  // ~25 separate createElement calls on the frame the user is waiting on. Every
  // value below is an authored constant — nothing here comes from the user.
  const parts: string[] = [];

  // Two staggered rings under the objects: the tap point should flash before
  // anything has had time to travel, so the burst reads as coming FROM the
  // finger rather than merely appearing near it.
  parts.push(`<i class="ob-burst-ring" style="--ring:${pick(set.palette, 0)}"></i>`);
  parts.push(`<i class="ob-burst-ring ob-burst-ring--late" style="--ring:${pick(set.palette, 1)}"></i>`);

  for (let i = 0; i < GLYPH_COUNT; i += 1) {
    const glyph = pick(set.glyphs, i);
    const color = glyph.color ?? pick(set.palette, i);
    const size = Math.round(rand(24, 38) * (glyph.scale ?? 1));
    parts.push(`<span class="ob-burst-bit">${svgFor(glyph, color, size)}</span>`);
  }
  for (let i = 0; i < DOT_COUNT; i += 1) {
    const size = Math.round(rand(4, 8));
    parts.push(
      `<span class="ob-burst-bit ob-burst-dot" style="--dot:${pick(set.palette, i + 1)};` +
        `width:${size}px;height:${size}px"></span>`,
    );
  }

  layer.innerHTML = parts.join("");
  layer.style.setProperty("--burst-x", `${x}px`);
  layer.style.setProperty("--burst-y", `${y}px`);
  document.body.appendChild(layer);

  const bits = layer.querySelectorAll<HTMLElement>(".ob-burst-bit");
  let longest = 0;

  bits.forEach((bit, index) => {
    // Spread the launch angles evenly around the circle and jitter each one, so
    // the fan has no visible spokes and no bald patch. The upward bias is in
    // the speed, not the angle: everything is thrown, gravity sorts out which
    // ones come back down first.
    const angle = ((index + rand(-0.35, 0.35)) / bits.length) * Math.PI * 2;
    const upward = -Math.sin(angle); // 1 straight up, −1 straight down
    const speed = rand(MIN_SPEED, MAX_SPEED) * (1 + 0.28 * Math.max(0, upward));
    const vx = Math.cos(angle) * speed;
    const vy = -Math.sin(angle) * speed;
    const life = rand(MIN_LIFE_MS, MAX_LIFE_MS);
    const spin = rand(-620, 620);
    const delay = rand(0, 110);

    const frames: Keyframe[] = [];
    for (let s = 0; s <= SAMPLES; s += 1) {
      const progress = s / SAMPLES;
      const at = flightAt(vx, vy, (life / 1000) * progress);
      // Pop to full size over the first beat, hold, then shrink as it fades —
      // a particle that vanishes at full size reads as a dropped frame.
      const scale =
        progress < 0.12
          ? 0.35 + (progress / 0.12) * 0.8
          : 1.15 - Math.min(1, (progress - 0.12) / 0.88) * 0.35;
      frames.push({
        offset: progress,
        transform: `translate3d(${at.x.toFixed(1)}px, ${at.y.toFixed(1)}px, 0) rotate(${(
          spin * progress
        ).toFixed(1)}deg) scale(${scale.toFixed(3)})`,
        opacity: progress < 0.06 ? 0 : progress > 0.62 ? (1 - progress) / 0.38 : 1,
      });
    }

    bit.animate(frames, { duration: life, delay, easing: "linear", fill: "forwards" });
    longest = Math.max(longest, life + delay);
  });

  // Kept small and quick: this is the impact at the fingertip, not an event of
  // its own. Scaled up far enough it stops reading as a flash and becomes a
  // slow hoop drawn around the button.
  layer.querySelectorAll<HTMLElement>(".ob-burst-ring").forEach((ring, index) => {
    const life = 380 + index * 120;
    ring.animate(
      [
        { offset: 0, transform: "scale(0.25)", opacity: 0.6 },
        { offset: 1, transform: `scale(${2.1 + index * 0.9})`, opacity: 0 },
      ],
      { duration: life, delay: index * 80, easing: "cubic-bezier(.16,.84,.44,1)", fill: "forwards" },
    );
    longest = Math.max(longest, life + index * 80);
  });

  // Timer rather than `Animation.finished`: that promise rejects when an
  // animation is cancelled (a background tab, a client that drops the layer),
  // and a rejected cleanup would leave the layer in the DOM for good.
  window.setTimeout(() => layer.remove(), longest + 120);
}

/**
 * Convenience for a click handler: bursts from the pointer if there was one,
 * and from the middle of the activated element otherwise (keyboard, screen
 * reader, or a synthetic click — all of which report a 0,0 pointer).
 */
export function burstFromEvent(
  event: { clientX: number; clientY: number; currentTarget: EventTarget | null },
  tone: BurstTone,
): void {
  let { clientX: x, clientY: y } = event;
  if (!x && !y && event.currentTarget instanceof Element) {
    const box = event.currentTarget.getBoundingClientRect();
    x = box.left + box.width / 2;
    y = box.top + box.height / 2;
  }
  burstAt(x, y, tone);
}
