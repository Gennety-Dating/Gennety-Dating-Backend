/**
 * The photographs behind the "who do you want to meet?" screen
 * (`PreferenceColumn` in onboarding-basics.tsx).
 *
 * One set per gender, in `preference/photo/{men,women}/`: ordinary photographs,
 * scattered and tilted inside the button, unframed and opaque, a few spilling
 * past its sides. They must be **9:16** — the tile states that ratio and fills
 * it (`object-fit: cover`), so another shape is cropped rather than letterboxed.
 *
 * (A second design held ONE background-removed group image per side in a
 * `cutout/` folder. The founder settled on this design on 2026-08-07 and both
 * the folder and the code that read it were deleted.)
 *
 * The files are enumerated at build time with `import.meta.glob` rather than
 * listed in a manifest, so adding or removing a photo is dropping a file in —
 * there is no second place to update and therefore no way for the list to
 * disagree with the folder. They live under `src/` rather than `public/` for
 * exactly that reason: `public/` is copied verbatim and cannot be globbed.
 *
 * Prepared by `~/Desktop/gennety-preference-photos/prepare.mjs`, which resizes
 * and re-encodes the originals — 2–6 MB PNGs — into what actually ships. Never
 * copy an original in by hand.
 *
 * An empty folder falls back to the demo profile deck in `public/profiles/`, so
 * the screen stays reviewable rather than rendering two bare gradients. That is
 * a safety net, not a supported state: the deck is not prepared at 9:16, so it
 * IS cropped by the tile.
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

/** The photographs, in the order the scatter's slots consume them. */
export function photoSet(side: PreferenceSide): string[] {
  return side === "men"
    ? orderedAssets(photoMen, PLACEHOLDER_MEN)
    : orderedAssets(photoWomen, PLACEHOLDER_WOMEN);
}

let warmed = false;

/**
 * Pull both sets into the cache ahead of the screen that shows them.
 *
 * This is the real fix for the screen assembling itself in front of the user
 * (preference-reveal.ts): ~530 kB across twelve files is a good half second on
 * a phone, and it used to start at the exact moment the screen appeared. Called
 * when the profile screens BEGIN — a name, an age and a gender tap earlier —
 * the download happens while the user is busy and the screen arrives finished.
 *
 * `img.src =` alone only starts the fetch, so `decode()` is what actually
 * leaves a paintable bitmap behind; same reasoning, same idiom as the
 * competitor icons warmed at boot in onboarding.tsx. Best-effort by
 * construction — the screen's own gate is what it waits on, so losing this race
 * delays the photographs rather than breaking anything.
 *
 * Idempotent: called from a render path that re-runs whenever the step changes.
 */
export function warmPreferencePhotos(): void {
  if (warmed) return;
  warmed = true;
  // Absent outside a browser (the tests run in node, and this module is
  // imported for `orderedAssets`).
  if (typeof Image !== "function") return;
  for (const src of [...photoSet("men"), ...photoSet("women")]) {
    const img = new Image();
    img.src = src;
    try {
      void img.decode().catch(() => {
        // Warming is best-effort; the screen's gate is what the reveal waits on.
      });
    } catch {
      // No decode() on this WebView — the fetch above still warms the cache.
    }
  }
}
