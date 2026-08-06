/**
 * Where the photos sit on the "who do you want to meet?" buttons
 * (`PreferenceGallery` in onboarding-basics.tsx).
 *
 * The placements are AUTHORED, not random. A layout re-rolled per render would
 * shuffle under the user's finger and would make a design review impossible —
 * you would never be looking at the same screen twice. What the brief calls a
 * chaotic scatter is a fixed composition that reads as chaotic: uneven tilts,
 * uneven sizes, uneven opacities, and three tiles deliberately hanging past the
 * button's edge.
 *
 * Two coordinate systems, because the two variants size their subjects on
 * different axes:
 *
 *  - **Scatter (variant 1)** — framed photographs, cropped 3:4. Sized by WIDTH,
 *    positioned by their centre, so a tile's height follows from its own width
 *    and every frame keeps the same crop.
 *  - **Cluster (variant 2)** — background-removed people. Sized by HEIGHT and
 *    stood on a common baseline, so the figures share a scale no matter how
 *    wide each cutout happens to be. Sizing THOSE by width would make a
 *    broad-shouldered crop short and a narrow one tall.
 *
 * Both arrays are in PRIORITY order: with fewer photos than slots, the prefix
 * is what renders, so each array is ordered so that any prefix is still a
 * composition. Extra photos beyond the last slot are not shown.
 */

/** A framed photo, tilted, its centre at (x, y). All units are % of the button. */
export interface ScatterSlot {
  /** Horizontal centre, % of button width. */
  x: number;
  /** Vertical centre, % of button height. */
  y: number;
  /** Tile width, % of button width; height follows from the 3:4 crop. */
  w: number;
  /** Tilt in degrees. */
  rot: number;
  /** Per-tile transparency — the brief's "slight transparency", varied so the
   *  scatter has depth instead of reading as one flat sheet. */
  opacity: number;
  /** Paint order within the button. Higher is nearer the viewer. */
  z: number;
}

/** A standing cutout, sized by height, resting on a baseline `bottom`. */
export interface ClusterSlot {
  /** Horizontal centre, % of button width. */
  x: number;
  /** Baseline (the figure's feet), % of button height from the bottom. */
  bottom: number;
  /** Figure height, % of button height; width follows from the cutout. */
  h: number;
  rot: number;
  z: number;
}

/**
 * Variant 1. Seven placements: one large near the middle, one across the top,
 * and the rest working down the edges.
 *
 * Slots 3, 4 and 6 are the ones that hang past the button — 3 and 4 sideways,
 * 6 past the bottom. Sideways overshoot always points AWAY from the screen's
 * centre once mirroring is applied, so the two columns never spill into the
 * same gutter and collide.
 *
 * How far they may hang is set by the SCREEN edge, not the button's: on a
 * 390px phone the page's own 24px margin is all the room there is, and a tilt
 * eats several more px of it (a 110px-tall frame turned 7° reaches ~7px wider
 * than its own box). Overshoot is therefore ~9% of the button's width — clearly
 * outside the edge, still whole. Measured, not guessed: at 12% the frame was
 * being cut by the viewport.
 */
export const SCATTER_SLOTS: readonly ScatterSlot[] = [
  { x: 44, y: 58, w: 66, rot: 4, opacity: 0.78, z: 4 },
  { x: 52, y: 18, w: 62, rot: -6, opacity: 0.7, z: 3 },
  { x: 18, y: 33, w: 50, rot: 7, opacity: 0.56, z: 2 },
  { x: 20, y: 82, w: 54, rot: -5, opacity: 0.62, z: 5 },
  { x: 78, y: 44, w: 46, rot: -8, opacity: 0.5, z: 1 },
  { x: 76, y: 88, w: 48, rot: 9, opacity: 0.54, z: 6 },
  { x: 84, y: 70, w: 38, rot: -11, opacity: 0.44, z: 7 },
];

/**
 * Variant 2. Three figures shoulder to shoulder, the middle one nearest and a
 * touch taller, the outer two set back — the brief's "very close to each
 * other". Their baselines sit just above the word, close enough that the group
 * and the word read as one block rather than as two things sharing a box.
 */
export const CLUSTER_SLOTS: readonly ClusterSlot[] = [
  { x: 50, bottom: 16, h: 62, rot: 0, z: 3 },
  { x: 27, bottom: 19, h: 54, rot: -4, z: 2 },
  { x: 73, bottom: 19, h: 51, rot: 4, z: 1 },
];

/**
 * The right-hand column is the left one mirrored, so the pair reads as a
 * symmetrical fork rather than two unrelated collages — and, more practically,
 * so every sideways overhang points outward, at the screen's own margin,
 * instead of into the 12px gutter the two buttons share.
 */
export function mirrorScatter(slot: ScatterSlot): ScatterSlot {
  return { ...slot, x: 100 - slot.x, rot: -slot.rot };
}

export function mirrorCluster(slot: ClusterSlot): ClusterSlot {
  return { ...slot, x: 100 - slot.x, rot: -slot.rot };
}

/**
 * Pairs each photo with its placement. Fewer photos than slots uses the prefix;
 * more photos than slots drops the tail, because the extra tiles have nowhere
 * composed to go — silently stacking them somewhere would be worse than not
 * showing them.
 */
export function placeScatter(
  photos: readonly string[],
  mirror: boolean,
): { src: string; slot: ScatterSlot }[] {
  return photos.slice(0, SCATTER_SLOTS.length).map((src, index) => {
    const slot = SCATTER_SLOTS[index] as ScatterSlot;
    return { src, slot: mirror ? mirrorScatter(slot) : slot };
  });
}

export function placeCluster(
  photos: readonly string[],
  mirror: boolean,
): { src: string; slot: ClusterSlot }[] {
  return photos.slice(0, CLUSTER_SLOTS.length).map((src, index) => {
    const slot = CLUSTER_SLOTS[index] as ClusterSlot;
    return { src, slot: mirror ? mirrorCluster(slot) : slot };
  });
}
