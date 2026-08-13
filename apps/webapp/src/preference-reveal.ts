/**
 * When the "who do you want to meet?" photographs are allowed on screen
 * (`PreferenceScreen` in onboarding-basics.tsx).
 *
 * That screen carries twelve photographs (~530 kB) and used to create them the
 * instant it mounted, so on anything short of a warm cache the user watched the
 * composition assemble itself: a few prints landing, dark tiles where the rest
 * would be, the last one arriving half a second later.
 *
 * Two things fix that, and only the first is the actual fix.
 *
 *  1. `warmPreferencePhotos` (preference-photos.ts) starts the fetch AND the
 *     decode when the profile screens BEGIN — three screens earlier — so by the
 *     time this one mounts the bitmaps are already in hand. That is the common
 *     case, and it costs the user nothing to look at because it happens while
 *     they are typing a name.
 *
 *  2. This gate is the insurance for when they are not: someone resumed
 *     straight onto this screen, or a connection slow enough that a name, an
 *     age and a gender tap were not head start enough. Then the columns arrive
 *     as their own gradients — which is a finished-looking button carrying its
 *     label, not a hole — and the photographs fade in together once every one
 *     of them is ready.
 *
 * **The tally spans BOTH columns, deliberately.** Per photo would be the same
 * progressive assembly with softer edges; per column would populate one half of
 * the screen and then the other, which is the same complaint one step smaller.
 * The screen is one composition and it arrives as one.
 */

/**
 * How long the gate may hold the photographs back.
 *
 * `decode()` settles on failure as well as success, so the only thing this
 * bounds is a request that neither answers nor errors — but a column left
 * permanently bare would be a worse bug than the flicker the gate exists to
 * remove. Past the cap the layer is shown and whatever is still in flight pops
 * in as it always did.
 */
export const PREF_REVEAL_CAP_MS = 2600;

export interface RevealTally {
  /**
   * Records one photograph as painted-or-failed; true once every one is in.
   *
   * Idempotent, and that is load-bearing rather than tidy: a ref callback can
   * fire more than once for the same element, and a repeat that counted twice
   * would stand in for a photograph still on the wire — revealing exactly the
   * half-built screen this module exists to prevent.
   */
  settle(src: string): boolean;
  /** Photographs still outstanding. Zero means the screen may reveal. */
  readonly outstanding: number;
}

/**
 * `sources` must be the photographs actually RENDERED, not the folder — the
 * scatter truncates to its slot count, and a photo that is never mounted has no
 * element to decode, so counting it would hold the screen back until the cap.
 */
export function revealTally(sources: readonly string[]): RevealTally {
  const pending = new Set(sources);
  return {
    settle(src: string): boolean {
      pending.delete(src);
      return pending.size === 0;
    },
    get outstanding(): number {
      return pending.size;
    },
  };
}
