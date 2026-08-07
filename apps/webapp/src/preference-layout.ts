/**
 * Where the photos sit on the "who do you want to meet?" buttons
 * (`PreferenceGallery` in onboarding-basics.tsx).
 *
 * The placements are AUTHORED, not random. A layout re-rolled per render would
 * shuffle under the user's finger and would make a design review impossible —
 * you would never be looking at the same screen twice. What the brief calls a
 * chaotic scatter is a fixed composition that reads as chaotic: uneven tilts,
 * uneven sizes, and tiles deliberately hanging past the button's SIDE edges.
 * Sideways only: downward there is a word to keep clear of (`maxCentreY`).
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

/**
 * A photo, tilted, its centre at (x, y). All units are % of the PHOTO AREA —
 * `.ob-pref-art`, which is the button minus the strip its label occupies, not
 * the button itself. The distinction is the whole reason nothing lands on the
 * word: y = 100 is the floor of the picture, and the word lives below it.
 */
export interface ScatterSlot {
  /** Horizontal centre, % of the photo area's width. */
  x: number;
  /**
   * Vertical centre, % of the photo area's height.
   *
   * Bounded from below by `maxCentreY` — a tile is sized from the area's WIDTH
   * while y is measured against its HEIGHT, so how much room is left under a
   * given y depends on how tall the column happens to be, and the column is
   * elastic (`flex: 1`, 15–32rem). The bottom band is authored to clear the
   * floor at the SHORTEST column, not the one that was screenshotted.
   */
  y: number;
  /**
   * Tile width, % of the photo area's width. Height follows from the photo's
   * own 9:16, so a wider tile is a taller one — the tiles show a whole person,
   * and width is the only handle on their size. That "whole person" holds
   * because the tile states the ratio the photos are prepared at; the CSS fills
   * the tile edge to edge (`object-fit: cover`) rather than fitting inside it,
   * so a photo dropped in at some other shape is cropped, not letterboxed.
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
  { x: 54, y: 17, w: 56, rot: -5, z: 1 },
  // The upper pair.
  { x: 22, y: 38, w: 45, rot: 7, z: 3 },
  { x: 72, y: 36, w: 42, rot: -6, z: 2 },
  // The bottom pair. Its inner tile is the last slot on purpose: a set of five
  // renders the prefix, which leaves the bottom row single rather than half of
  // some other band, and the sixth photo fills the corner it left — bottom
  // RIGHT on the men's column, bottom LEFT on the women's once mirrored, which
  // is what was asked for.
  //
  // These two are the ones the label constrains (see the note below): they used
  // to sit at 84/82, which put them through the button's floor and behind the
  // word on every screen.
  { x: 23, y: 79, w: 47, rot: -6, z: 5 },
  { x: 70, y: 78, w: 44, rot: 7, z: 6 },
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
 * How tall the photo area is compared to its own width, at the TIGHTEST column
 * the layout produces — measured, not assumed: the pair is `flex: 1` between
 * 15rem and 32rem, so the button's proportions move with the screen (h/w ≈ 2.51
 * at 320×568, ≈ 3.10 at 390×844), and `.ob-pref-art` is that button minus the
 * label strip.
 *
 * A short column is the hard case, and the counter-intuitive one: tiles are
 * sized from the area's WIDTH, so on a short column they take up MORE of its
 * height, and a y that clears the floor on a tall phone runs through it on a
 * small one. This is the number the bottom band is authored against.
 */
export const TIGHTEST_AREA_RATIO = 2.17;

/**
 * The lowest a tile's centre may sit and still keep the whole frame inside the
 * photo area — i.e. off the label underneath it.
 *
 * Tilt is in it because a rotated tile is TALLER than its own box by the same
 * argument `slotSpanX` makes about width: the bounding box is
 * `h·cos|θ| + w·sin|θ|`. At these sizes that is several percent, which is the
 * difference between "sits on the floor" and "its bottom corner crosses the
 * word".
 */
export function maxCentreY(slot: ScatterSlot, areaRatio = TIGHTEST_AREA_RATIO): number {
  const radians = (Math.abs(slot.rot) * Math.PI) / 180;
  // Both terms as % of the area's HEIGHT: the tile's own height is its width
  // divided by the photo aspect, and either is converted from width-% to
  // height-% by dividing by the area's ratio.
  const spanY = (slot.w / areaRatio) * (Math.cos(radians) / PHOTO_ASPECT + Math.sin(radians));
  return 100 - spanY / 2;
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
