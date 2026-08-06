/**
 * Which design of the "who do you want to meet?" screen is live.
 *
 * Two were built to be compared side by side (PRODUCT_SPEC §1.3):
 *
 *  1. **Scatter** — two tall rounded columns, ordinary photographs tilted and
 *     semi-transparent inside them, a few hanging past the edge.
 *  2. **Cutout** — the same two columns, thin-bordered over near-black, holding
 *     background-removed people in a tight cluster above a heavy white word.
 *
 * Production ships exactly one, named by `LIVE_VARIANT`. The `?v=` override is
 * `import.meta.env.DEV`-gated, so the production bundle constant-folds the
 * branch away and the query param does not exist there — the same treatment
 * `?preview=basics` gets in onboarding.tsx.
 */

export type PreferenceVariant = 1 | 2;

/** The one production renders. Flip after the two have been compared. */
export const LIVE_VARIANT: PreferenceVariant = 1;

export function parseVariant(raw: string | null): PreferenceVariant | null {
  if (raw === "1") return 1;
  if (raw === "2") return 2;
  return null;
}

/** Dev-only: `?v=2` picks the other design; anything else is the live one. */
export function preferenceVariant(search: string = location.search): PreferenceVariant {
  if (!import.meta.env.DEV) return LIVE_VARIANT;
  return parseVariant(new URLSearchParams(search).get("v")) ?? LIVE_VARIANT;
}

/** Dev-only: the URL for the other variant, for the review toggle. */
export function otherVariantHref(
  current: PreferenceVariant,
  href: string = location.href,
): string {
  const url = new URL(href);
  url.searchParams.set("v", current === 1 ? "2" : "1");
  return url.toString();
}
