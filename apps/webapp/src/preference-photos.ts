/**
 * The photo sets behind the "who do you want to meet?" screen
 * (`PreferenceGallery` in onboarding-basics.tsx).
 *
 * Two sets per gender, one per design variant:
 *
 *  - `photo/`  — ordinary framed photographs, scattered and tilted inside the
 *    button, semi-transparent, a few spilling past its edge (variant 1).
 *  - `cutout/` — background-removed PNGs of people, standing in a tight cluster
 *    above a heavy word (variant 2). These MUST carry an alpha channel; a JPG
 *    here renders as a rectangle and the whole idea collapses.
 *
 * The files are enumerated at build time with `import.meta.glob` rather than
 * listed in a manifest, so adding or removing a photo is dropping a file in
 * (`~/Desktop/gennety-preference-photos/sync.sh`) — there is no second place to
 * update and therefore no way for the list to disagree with the folder. They
 * live under `src/` rather than `public/` for exactly that reason: `public/` is
 * copied verbatim and cannot be globbed.
 *
 * Until real photos land, every set falls back to the demo profile deck already
 * in `public/profiles/`, so the layout is reviewable on day one. That fallback
 * is honest for variant 1 and a placeholder only for variant 2 — those frames
 * have backgrounds, which is the one thing variant 2 is defined by not having.
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

/** Background-removed people for variant 2. */
export function cutoutSet(side: PreferenceSide): string[] {
  return side === "men"
    ? orderedAssets(cutoutMen, PLACEHOLDER_MEN)
    : orderedAssets(cutoutWomen, PLACEHOLDER_WOMEN);
}

/** True while a set is still the demo deck — variant 2 cannot be judged then. */
export function isPlaceholder(side: PreferenceSide, variant: 1 | 2): boolean {
  const globbed =
    variant === 1
      ? side === "men"
        ? photoMen
        : photoWomen
      : side === "men"
        ? cutoutMen
        : cutoutWomen;
  return Object.keys(globbed).length === 0;
}
