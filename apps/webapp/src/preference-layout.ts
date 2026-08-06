/**
 * Where the photos sit on the "who do you want to meet?" buttons
 * (`PreferenceGallery` in onboarding-basics.tsx).
 *
 * The placements are AUTHORED, not random. A layout re-rolled per render would
 * shuffle under the user's finger and would make a design review impossible —
 * you would never be looking at the same screen twice. What the brief calls a
 * chaotic scatter is a fixed composition that reads as chaotic: uneven tilts,
 * uneven sizes, and tiles deliberately hanging past the button's edge.
 *
 * This is variant 1 only. Variant 2 has no layout to speak of: its people
 * arrive as ONE finished image, already arranged and already cut off at its own
 * left and right edges, and the button is fitted to those edges. Its
 * composition lives in the artwork, so placing anything in code would be
 * second-guessing it.
 *
 * The array is in PRIORITY order: with fewer photos than slots, the prefix is
 * what renders, so it is ordered so any prefix is still a composition. Photos
 * past the last slot are not shown.
 */

/** A framed photo, tilted, its centre at (x, y). All units are % of the button. */
export interface ScatterSlot {
  /** Horizontal centre, % of button width. */
  x: number;
  /** Vertical centre, % of button height. */
  y: number;
  /**
   * Tile width, % of button width. Height follows from the photo's own 9:16,
   * so a wider tile is a taller one — the frames show a whole person, never a
   * crop of one, and width is the only handle on their size.
   */
  w: number;
  /** Tilt in degrees. */
  rot: number;
  /**
   * Paint order within the button. Higher is nearer the viewer.
   *
   * It matters more than it used to. The tiles are OPAQUE — a photograph shown
   * through another photograph reads as a rendering fault rather than as depth
   * — so where they overlap, z is the whole of what you see, and the stack runs
   * bottom-of-the-button nearest, like prints dropped one on top of the next.
   */
  z: number;
}

/**
 * Variant 1, read from the bottom up: two small, one large, two small, one
 * large-ish at the top. Four bands of full-length photographs, overlapping,
 * because six 9:16 frames at a readable size add up to more height than the
 * column has — and that overlap is what makes it a collage instead of a grid.
 *
 * Sideways overshoot always points AWAY from the screen's centre once mirroring
 * is applied, so the two columns never spill into the same gutter and collide.
 *
 * How far a tile may hang out is set by the SCREEN edge, not the button's: on a
 * 390px phone the page's own 24px margin is all the room there is, and a tilt
 * eats several more px of it. Overshoot is therefore a few % of the button's
 * width — clearly outside the edge, still whole. Measured, not guessed: at 12%
 * the frame was being cut by the viewport.
 */
export const SCATTER_SLOTS: readonly ScatterSlot[] = [
  // The anchor: the large one in the middle band.
  { x: 44, y: 60, w: 62, rot: 4, z: 4 },
  // The large-ish one at the top.
  { x: 54, y: 15, w: 56, rot: -5, z: 1 },
  // The upper pair.
  { x: 22, y: 38, w: 45, rot: 7, z: 3 },
  { x: 72, y: 36, w: 42, rot: -6, z: 2 },
  // The bottom pair. Its inner tile is the last slot on purpose: a set of five
  // renders the prefix, which leaves the bottom row single rather than half of
  // some other band, and the sixth photo fills the corner it left — bottom
  // RIGHT on the men's column, bottom LEFT on the women's once mirrored, which
  // is what was asked for.
  { x: 23, y: 84, w: 47, rot: -6, z: 5 },
  { x: 70, y: 82, w: 44, rot: 7, z: 6 },
];

/**
 * The photos' own aspect ratio, and the frame's — `.ob-pref-shot` in
 * onboarding.css states the same `9 / 16`, and the two must agree or a tile's
 * real height stops matching what this file reasons about.
 *
 * It is here because a tilted tile is WIDER than its own box, and by how much
 * depends on its height: rotating a 9:16 frame about its centre pushes each
 * side out by `(height / 2) · sin|rot|`. With six full-length photos the tiles
 * are tall enough that this is several percent of the column — the difference
 * between "sits just inside the edge" and "crosses the gutter into the other
 * button", which is exactly what it did before the numbers above were redone.
 */
export const PHOTO_ASPECT = 9 / 16;

/**
 * A slot's true horizontal extent, tilt included, in % of the button's width.
 *
 * The bounding box of a rotated rectangle is `(w·cos|θ| + h·sin|θ|)` across,
 * not `w` — and for these tiles `h` is nearly twice `w`, so the tilt term is
 * the one that decides whether a tile stays inside its button. Both terms are
 * expressed in % of the column's WIDTH (the height follows from the width via
 * the photo's aspect), which is why nothing here needs to know how tall the
 * column happens to be.
 *
 * Verified against the rendered page rather than derived and trusted: at
 * 390×844 this predicts the men's outer tiles reaching 15px from the screen
 * edge, which is what the browser reports.
 */
export function slotSpanX(slot: ScatterSlot): { left: number; right: number } {
  const height = slot.w / PHOTO_ASPECT;
  const radians = (Math.abs(slot.rot) * Math.PI) / 180;
  const half = (slot.w * Math.cos(radians) + height * Math.sin(radians)) / 2;
  return { left: slot.x - half, right: slot.x + half };
}

/**
 * The right-hand column is the left one mirrored, so the pair reads as a
 * symmetrical fork rather than two unrelated collages — and, more practically,
 * so every sideways overhang points outward, at the screen's own margin,
 * instead of into the 12px gutter the two buttons share.
 */
export function mirrorScatter(slot: ScatterSlot): ScatterSlot {
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
