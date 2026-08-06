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

/**
 * What the review screen shows. `"both"` stacks the two designs one under the
 * other on one scrolling page, so an edit to either can be checked against the
 * other without a reload in between — which is the whole point of building two.
 * Dev-only: production has no such view, it renders `LIVE_VARIANT` and nothing
 * else.
 */
export type PreferenceView = PreferenceVariant | "both";

/** The one production renders. Flip after the two have been compared. */
export const LIVE_VARIANT: PreferenceVariant = 1;

/** The stacking order of the review page, and the order the toggle lists. */
export const ALL_VARIANTS: readonly PreferenceVariant[] = [1, 2];

export function parseVariant(raw: string | null): PreferenceVariant | null {
  if (raw === "1") return 1;
  if (raw === "2") return 2;
  return null;
}

export function parseView(raw: string | null): PreferenceView | null {
  if (raw === "both") return "both";
  return parseVariant(raw);
}

/** Dev-only: `?v=2` or `?v=both`; anything else is the live design alone. */
export function preferenceView(search: string = location.search): PreferenceView {
  if (!import.meta.env.DEV) return LIVE_VARIANT;
  return parseView(new URLSearchParams(search).get("v")) ?? LIVE_VARIANT;
}

/**
 * The concrete design behind a view. `"both"` is a review page rather than a
 * design, so it resolves to the live one — nothing downstream of here should
 * have to handle "both" as something to draw.
 */
export function variantOf(view: PreferenceView): PreferenceVariant {
  return view === "both" ? LIVE_VARIANT : view;
}

/** Dev-only: the URL for one of the review views, keeping the rest intact. */
export function viewHref(view: PreferenceView, href: string = location.href): string {
  const url = new URL(href);
  url.searchParams.set("v", String(view));
  return url.toString();
}
