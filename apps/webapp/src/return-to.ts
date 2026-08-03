/**
 * Cross-page "back" inside the Mini App WebView.
 *
 * Some pages hand off to another page of the SAME Mini App with an ordinary
 * same-origin navigation (`location.href = "premium.html?…"`). The board's
 * premium CTA is the case this exists for: it left the user on the Premium
 * screen with no way back, so someone who looked at the price and decided
 * against it had to close the Mini App and reopen "Change venue" from the chat.
 *
 * The rule this module encodes is the one that makes that safe to fix: a back
 * affordance appears **only when the page was actually navigated to from
 * another page**, never when it was opened cold from a chat button — there is
 * no previous screen then, and a back button would either dead-end or drop the
 * user somewhere they never were.
 *
 * The target is carried explicitly rather than via `history.back()`, for two
 * reasons. A page opened cold has no history entry to go back to, so
 * `history.length` would have to be trusted — and it is not reliable inside a
 * WebView. And the return trip should be a FRESH load: after a subscription the
 * board has to re-read `pairPremiumActive` to unlock its premium cards, which a
 * bfcached history entry would not do.
 */

/**
 * Pages that may be returned to. An allowlist, not a free-form URL: the return
 * target arrives in a query string the user can edit, and turning that into an
 * arbitrary navigation would be an open redirect inside the WebView.
 */
const RETURN_PAGES = {
  "venue-change": "venue-change.html",
} as const;

export type ReturnPage = keyof typeof RETURN_PAGES;

/** Query keys — prefixed so they cannot collide with a page's own params. */
const PAGE_KEY = "backTo";
const MATCH_KEY = "backMatch";
const LANG_KEY = "lang";

/**
 * The query parameters a departing page appends so the destination can offer a
 * way back. `match` is the board's own identifier — `venue-change.html` reads
 * `?match=`, and a page reached from a chat `web_app` button has no
 * `start_param` to fall back on, so it must be carried explicitly.
 */
export function returnParams(page: ReturnPage, opts: { match?: string; lang?: string }): string {
  const params = new URLSearchParams();
  params.set(PAGE_KEY, page);
  if (opts.match) params.set(MATCH_KEY, opts.match);
  if (opts.lang) params.set(LANG_KEY, opts.lang);
  return params.toString();
}

/**
 * The URL to go back to, or `null` when this page was not navigated to from
 * another one (opened cold from chat) or names a page that is not returnable.
 * `search` is injectable so this is testable without a DOM.
 */
export function returnHref(search: string = location.search): string | null {
  const params = new URLSearchParams(search);
  const page = params.get(PAGE_KEY);
  if (!page || !Object.hasOwn(RETURN_PAGES, page)) return null;

  const target = new URLSearchParams();
  const match = params.get(MATCH_KEY);
  if (match) target.set("match", match);
  const lang = params.get(LANG_KEY);
  if (lang) target.set("lang", lang);

  const query = target.toString();
  return query ? `${RETURN_PAGES[page as ReturnPage]}?${query}` : RETURN_PAGES[page as ReturnPage];
}

interface BackButtonLike {
  show?: () => void;
  hide?: () => void;
  onClick?: (cb: () => void) => void;
}

/**
 * Wire Telegram's native BackButton to the return target, or hide it when there
 * is nothing to go back to.
 *
 * Hiding is not merely tidiness. The BackButton belongs to the Mini App session
 * rather than to the page, so one left visible by the previous screen (the
 * board shows it on a venue's detail page) survives the navigation and would
 * otherwise sit there with no handler — a button that does nothing, which is
 * its own bug. Native-only, matching how `verification.ts` and the board itself
 * already do back navigation.
 */
export function wireReturnBackButton(
  backButton: BackButtonLike | undefined,
  search: string = location.search,
  navigate: (href: string) => void = (href) => {
    location.href = href;
  },
): boolean {
  const href = returnHref(search);
  if (!backButton) return false;
  if (!href) {
    backButton.hide?.();
    return false;
  }
  backButton.onClick?.(() => navigate(href));
  backButton.show?.();
  return true;
}
