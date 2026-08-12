/**
 * The dating-app icons crumbling away on intro scene 1 ("we burn out before we
 * find our person").
 *
 * The three competitor icons rise on scene 0 and now persist into scene 1 (they
 * live in a shell-level overlay, like the Pivot logo). Once that line finishes
 * typing they break into tiles and fall — the copy says these apps wear you
 * down, and the icons acting it out is the one beat the screen had nothing to
 * show for itself.
 *
 * Four constraints, each of which decided something below:
 *
 *  - **Frame 0 must be the intact icon.** The icons are PNGs, so a tile is a
 *    crop of the same bitmap: `background-size` blows the image up by the grid
 *    dimensions and `background-position` picks the tile. Assembled at rest the
 *    tiles ARE the icon, pixel for pixel, so swapping the <img> for the tile
 *    grid is invisible. That is the whole reason this approach was picked over
 *    a canvas particle sim — there is no cross-fade to hide a seam.
 *  - **Deterministic, never `Math.random()`.** Same rule `preference-layout.ts`
 *    states for the preference scatter: a pattern re-rolled per render can
 *    never be reviewed twice, and no test can pin it. Every value here comes
 *    from an integer hash of (icon, column, row), so the same crumble plays
 *    every time and a regression is visible in a diff.
 *  - **Gravity, not an explosion.** Sideways drift is a few px; the fall is
 *    ~10x that. The icons crumble where they stand, they do not blow apart.
 *  - **Top to bottom.** The delay is a function of the row, so the icon erodes
 *    from its top edge down. That wave is the effect; without it this is just
 *    30 tiles leaving at once.
 *
 * Rendering (`AppIconRow` in onboarding.tsx) only reads these numbers into CSS
 * custom properties — all motion is one keyframe in onboarding.css, so the
 * tiles animate on the compositor and this module stays testable with no DOM.
 */

/** Tiles across and down one icon. 5x6 puts ~18x15px crumbs on an 88px icon. */
export const CRUMBLE_COLS = 5;
export const CRUMBLE_ROWS = 6;

/** Delay added per row, so the icon erodes downward rather than all at once. */
const ROW_STEP_MS = 88;
/** Random spread on top of the row's delay, so the wave is not a straight edge. */
const ROW_JITTER_MS = 70;

/**
 * Per-tile fall duration and distance, drawn from SEPARATE noise on purpose.
 * Tie them to one draw and every tile ends up at the same average speed, so the
 * crumbs stay in a clump and land as one horizontal smear (visible in the first
 * render of this). Independent draws give real velocity spread and the debris
 * trails out the way falling rubble does.
 */
const FALL_MS_MIN = 820;
const FALL_MS_MAX = 1080;

/** Fall distance in px. Fixed rather than relative: gravity does not scale. */
const FALL_PX_MIN = 96;
const FALL_PX_MAX = 210;

/** Sideways splay for the outer columns, px, at the edge of the icon. */
const SPLAY_PX = 9;
/** Extra per-tile sideways drift, px, either direction. */
const DRIFT_PX = 7;

/** Tumble, degrees: a fixed outward bias plus a per-tile amount either way. */
const ROT_BIAS_DEG = 11;
const ROT_JITTER_DEG = 28;

/** Tiles shrink slightly as they dissolve. */
const END_SCALE_MIN = 0.72;
const END_SCALE_MAX = 0.92;

/**
 * Head start per icon, mirroring the arc the three sit on: the middle icon is
 * raised (`--ty: -10px` against `+22px` for the sides — see `.app-icon-slot`),
 * so a wave falling down the whole composition reaches it first. Without this
 * the three erode in lockstep and read as three separate animations rather
 * than one thing happening to the row.
 */
const ICON_LEAD_MS = [110, 0, 110];

/**
 * One tile of one icon: which cell it is, and how it falls.
 *
 * The cell is deliberately just `col`/`row` — placing and cropping it is CSS's
 * job, because the icon is sized `clamp(66px, 20vw, 88px)` and this module has
 * no idea what that resolves to. It matters that CSS does it in absolute px
 * rather than percentages of the tile: a tile is a fractional number of pixels
 * wide, and a background sized as a percentage of THAT rounds per tile, so the
 * crops drift apart and the icon shows a grid of hairline seams before it has
 * even started to fall (measured, on the tilted outer icons especially).
 */
export interface Shard {
  col: number;
  row: number;
  delayMs: number;
  durationMs: number;
  /** End of the fall, relative to the tile's resting place. */
  dxPx: number;
  dyPx: number;
  rotDeg: number;
  endScale: number;
}

/**
 * Deterministic [0,1) from three small integers.
 *
 * `Math.imul` rather than `*`: the multipliers overflow 32 bits, and a plain
 * `*` would silently go through float mantissa rounding, so the same inputs
 * could hash differently across engines. imul is exact 32-bit everywhere.
 */
function noise(a: number, b: number, c: number): number {
  let h = Math.imul(a + 1, 374761393) ^ Math.imul(b + 1, 668265263) ^ Math.imul(c + 1, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 4294967296;
}

function lerp(min: number, max: number, t: number): number {
  return min + (max - min) * t;
}

/** Rounds to 2dp so the emitted inline styles stay short and diff cleanly. */
function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Every tile of one icon, in reading order (top-left to bottom-right).
 *
 * `iconIndex` is the icon's place in the row (0..2) — it both seeds the pattern
 * and picks the head start above, so the three icons crumble differently but
 * identically on every replay.
 */
export function crumbleShards(iconIndex: number): Shard[] {
  const shards: Shard[] = [];
  const lead = ICON_LEAD_MS[iconIndex] ?? 0;
  // Distance from the icon's centre column, -1 (left edge) .. 1 (right edge).
  // `?: 0` covers a single-column grid, where there is no outward direction.
  const centre = (CRUMBLE_COLS - 1) / 2;

  for (let row = 0; row < CRUMBLE_ROWS; row += 1) {
    for (let col = 0; col < CRUMBLE_COLS; col += 1) {
      const spread = centre === 0 ? 0 : (col - centre) / centre;
      const nDelay = noise(iconIndex, col, row);
      const nFall = noise(iconIndex + 7, col, row);
      const nDrift = noise(iconIndex + 13, col, row);
      const nRot = noise(iconIndex + 23, col, row);
      const nScale = noise(iconIndex + 31, col, row);
      const nDur = noise(iconIndex + 43, col, row);

      shards.push({
        col,
        row,
        delayMs: Math.round(lead + row * ROW_STEP_MS + nDelay * ROW_JITTER_MS),
        durationMs: Math.round(lerp(FALL_MS_MIN, FALL_MS_MAX, nDur)),
        dxPx: round(spread * SPLAY_PX + (nDrift - 0.5) * 2 * DRIFT_PX),
        dyPx: round(lerp(FALL_PX_MIN, FALL_PX_MAX, nFall)),
        rotDeg: round(spread * ROT_BIAS_DEG + (nRot - 0.5) * 2 * ROT_JITTER_DEG),
        endScale: round(lerp(END_SCALE_MIN, END_SCALE_MAX, nScale)),
      });
    }
  }

  return shards;
}

/** The three icons' tiles, index 0..2, in row order. */
export const CRUMBLE_ICON_SHARDS: Shard[][] = ICON_LEAD_MS.map((_, i) => crumbleShards(i));

/**
 * When the last crumb finishes, measured rather than guessed — the scene holds
 * exactly this long before advancing, so retuning any constant above moves the
 * hold with it instead of leaving the screen to cut the tail off.
 */
export const CRUMBLE_TOTAL_MS: number = CRUMBLE_ICON_SHARDS.reduce(
  (max, shards) =>
    shards.reduce((inner, shard) => Math.max(inner, shard.delayMs + shard.durationMs), max),
  0,
);
