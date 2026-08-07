/**
 * The photo sets behind the "who do you want to meet?" screen
 * (`PreferenceGallery` in onboarding-basics.tsx).
 *
 * Two sets per gender, one per design variant:
 *
 *  - `photo/`  — ordinary photographs, scattered and tilted inside the button,
 *    unframed and opaque, a few spilling past its sides (variant 1). They must
 *    be 9:16: the tile states that ratio and fills it, so another shape is
 *    cropped rather than letterboxed.
 *  - `cutout/` — ONE finished image per side: the whole group of people already
 *    standing together, background removed, white contour already drawn, and
 *    the outermost figures cut off at the image's own left and right edges.
 *    Those cut edges are the whole point — the button is fitted to them, so the
 *    figures end exactly where the border does. Alpha is mandatory; a JPG here
 *    renders as a rectangle and the idea collapses.
 *
 * The files are enumerated at build time with `import.meta.glob` rather than
 * listed in a manifest, so adding or removing a photo is dropping a file in
 * (`~/Desktop/gennety-preference-photos/sync.sh`) — there is no second place to
 * update and therefore no way for the list to disagree with the folder. They
 * live under `src/` rather than `public/` for exactly that reason: `public/` is
 * copied verbatim and cannot be globbed.
 *
 * The framed set falls back to the demo profile deck in `public/profiles/` while
 * its folder is empty, so variant 1 stays reviewable. The cutout has NO
 * fallback: a stand-in with a background is not a cutout, and a variant 2
 * rendered from one would be a picture of the wrong idea. It renders the plain
 * bordered panel instead.
 *
 * Both are prepared by `~/Desktop/gennety-preference-photos/prepare.mjs`, which
 * is also what crops the cutout to its own alpha bounding box — the crop is
 * what makes "the figures end at the border" true rather than approximate.
 */

/** Demo deck, gender-split exactly as `PROFILE_CARDS` documents it. */
const PLACEHOLDER_MEN = [
  "/profiles/1.jpg",
  "/profiles/2.jpg",
  "/profiles/4.jpg",
  "/profiles/5.jpg",
  "/profiles/7.jpg",
  "/profiles/8.jpg",
];
const PLACEHOLDER_WOMEN = ["/profiles/3.jpg", "/profiles/6.jpg", "/profiles/9.jpg"];

const photoMen = import.meta.glob("./preference/photo/men/*.{jpg,jpeg,png,webp}", {
  eager: true,
  import: "default",
});
const photoWomen = import.meta.glob("./preference/photo/women/*.{jpg,jpeg,png,webp}", {
  eager: true,
  import: "default",
});
const cutoutMen = import.meta.glob("./preference/cutout/men/*.{png,webp}", {
  eager: true,
  import: "default",
});
const cutoutWomen = import.meta.glob("./preference/cutout/women/*.{png,webp}", {
  eager: true,
  import: "default",
});

/** Framed photographs, in the order the scatter's slots consume them. */

/**
 * Glob results come back keyed by path in unspecified order, so sort by key:
 * the layout slots are authored in order, and "which photo lands in the big
 * centre slot" must not change between builds. Alphabetical by filename is also
 * something the person dropping the files in can actually control.
 */
export function orderedAssets(
  globbed: Record<string, unknown>,
  fallback: string[],
): string[] {
  const urls = Object.keys(globbed)
    .sort()
    .map((key) => globbed[key])
    .filter((value): value is string => typeof value === "string" && value.length > 0);
  return urls.length > 0 ? urls : fallback;
}

export type PreferenceSide = "men" | "women";

/** Framed photographs for variant 1. */
export function photoSet(side: PreferenceSide): string[] {
  return side === "men"
    ? orderedAssets(photoMen, PLACEHOLDER_MEN)
    : orderedAssets(photoWomen, PLACEHOLDER_WOMEN);
}

/**
 * The finished group image for variant 2, or null while none is supplied.
 * Exactly one per side: extra files in the folder are ignored rather than
 * stacked, because the composition is inside the artwork, not in the layout.
 */
export function groupCutout(side: PreferenceSide): string | null {
  const globbed = side === "men" ? cutoutMen : cutoutWomen;
  return orderedAssets(globbed, [])[0] ?? null;
}

/** True while variant 1 is still drawing the demo deck rather than real photos. */
export function isPlaceholderPhotoSet(side: PreferenceSide): boolean {
  return Object.keys(side === "men" ? photoMen : photoWomen).length === 0;
}
