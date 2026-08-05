/**
 * Cross-page "back" inside the Mini App WebView.
 *
 * Some pages hand off to another page of the SAME Mini App with an ordinary
 * same-origin navigation (`location.href = "premium.html?…"`). The board's
 * premium CTA was the original case this exists for: it left the user on the
 * Premium screen with no way back, so someone who looked at the price and
 * decided against it had to close the Mini App and reopen "Change venue" from
 * the chat. The same shape now also carries the referral cross-promo link
 * ("invite a friend instead") from the Ticket Store, the Date Ticket gate, and
 * Premium into `referral.html`.
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
 *
 * **It carries the whole chain, not just the last hop (2026-08-05).** The first
 * version stored a single target, so each hand-off OVERWROTE the previous one:
 * board → Premium → referral left `backTo=premium` and nothing else, and going
 * back landed on a Premium screen that now believed it had been opened cold —
 * no button, chain gone, the only way out being to close the Mini App and
 * reopen the board from chat. Back worked exactly once, however deep you went.
 * The trail is now a stack, so every screen returns to the one that actually
 * sent the user there, all the way down to the page opened from chat.
 */

/**
 * Pages that may be returned to. An allowlist, not a free-form URL: the return
 * target arrives in a query string the user can edit, and turning that into an
 * arbitrary navigation would be an open redirect inside the WebView.
 */
const RETURN_PAGES = {
  "venue-change": "venue-change.html",
  "ticket-store": "tickets.html",
  "ticket-gate": "ticket.html",
  "premium": "premium.html",
} as const;

export type ReturnPage = keyof typeof RETURN_PAGES;

/** Query keys — prefixed so they cannot collide with a page's own params. */
const PAGE_KEY = "backTo";
const MATCH_KEY = "backMatch";
const STACK_KEY = "backStack";
const LANG_KEY = "lang";

/**
 * How deep the trail may get. Unreachable in practice — there are four
 * returnable pages and `push` collapses a revisit rather than stacking it — so
 * this exists only to bound a hand-edited or malformed URL. Overflow drops the
 * OLDEST entries: the recent hops are the ones the user actually remembers.
 */
const MAX_DEPTH = 6;

/**
 * A match id is a UUID. Anything outside this shape is dropped (the page is
 * kept) rather than trusted: it both corrupts the `:`/`,` stack encoding below
 * and would be echoed straight back into a URL.
 */
const MATCH_RE = /^[A-Za-z0-9_-]{1,64}$/;

interface Entry {
  page: ReturnPage;
  match?: string;
}

/** `location` is absent under the node test environment. */
function currentSearch(): string {
  return typeof location === "undefined" ? "" : location.search;
}

function isReturnPage(value: string | null): value is ReturnPage {
  return !!value && Object.hasOwn(RETURN_PAGES, value);
}

function entryOf(page: string | null, match: string | null): Entry | null {
  if (!isReturnPage(page)) return null;
  return match && MATCH_RE.test(match) ? { page, match } : { page };
}

/**
 * The trail below the top entry, oldest first. `page` or `page:match` joined by
 * commas — both separators are outside a UUID's alphabet, and an entry naming a
 * page that is not on the allowlist is dropped rather than failing the parse,
 * so a truncated or tampered value degrades to a shorter trail.
 */
function parseStack(raw: string | null): Entry[] {
  if (!raw) return [];
  const out: Entry[] = [];
  for (const chunk of raw.split(",")) {
    const sep = chunk.indexOf(":");
    const entry =
      sep === -1
        ? entryOf(chunk, null)
        : entryOf(chunk.slice(0, sep), chunk.slice(sep + 1));
    if (entry) out.push(entry);
  }
  return out;
}

function encodeStack(entries: Entry[]): string {
  return entries.map((e) => (e.match ? `${e.page}:${e.match}` : e.page)).join(",");
}

/**
 * The full trail that led to the page owning `search`, oldest first. The top
 * entry stays in the original `backTo`/`backMatch` keys so a client still
 * running the pre-stack bundle keeps its one working level instead of losing
 * back entirely.
 */
function readTrail(search: string): Entry[] {
  const params = new URLSearchParams(search);
  const top = entryOf(params.get(PAGE_KEY), params.get(MATCH_KEY));
  if (!top) return [];
  return [...parseStack(params.get(STACK_KEY)), top];
}

/**
 * Append a page to the trail. A page already in the trail is a RETURN to it,
 * not a new level, so the trail truncates there — otherwise a loop between two
 * screens would grow the URL forever and make "back" replay a path the user
 * never took.
 */
function push(trail: Entry[], entry: Entry): Entry[] {
  const seen = trail.findIndex((e) => e.page === entry.page);
  const base = seen === -1 ? trail : trail.slice(0, seen);
  const next = [...base, entry];
  return next.length > MAX_DEPTH ? next.slice(next.length - MAX_DEPTH) : next;
}

function writeTrail(trail: Entry[], lang: string | undefined): string {
  const params = new URLSearchParams();
  const top = trail[trail.length - 1];
  if (top) {
    params.set(PAGE_KEY, top.page);
    if (top.match) params.set(MATCH_KEY, top.match);
    const below = trail.slice(0, -1);
    if (below.length) params.set(STACK_KEY, encodeStack(below));
  }
  if (lang) params.set(LANG_KEY, lang);
  return params.toString();
}

/**
 * The query parameters a departing page appends so the destination can offer a
 * way back. `page`/`match` describe the DEPARTING page — `venue-change.html`
 * reads `?match=`, and a page reached from a chat `web_app` button has no
 * `start_param` to fall back on, so it must be carried explicitly.
 *
 * The departing page's own trail (read from `search`) is carried along, so the
 * destination can walk all the way back rather than only one hop.
 */
export function returnParams(
  page: ReturnPage,
  opts: { match?: string; lang?: string },
  search: string = currentSearch(),
): string {
  const entry: Entry = opts.match && MATCH_RE.test(opts.match) ? { page, match: opts.match } : { page };
  return writeTrail(push(readTrail(search), entry), opts.lang);
}

/**
 * The URL to go back to, or `null` when this page was not navigated to from
 * another one (opened cold from chat) or names a page that is not returnable.
 * `search` is injectable so this is testable without a DOM.
 *
 * The returned URL carries the REST of the trail, which is what makes the next
 * back tap work: the page we return to is handed the chain that led to it.
 */
export function returnHref(search: string = currentSearch()): string | null {
  const trail = readTrail(search);
  const target = trail[trail.length - 1];
  if (!target) return null;

  const params = new URLSearchParams();
  if (target.match) params.set("match", target.match);

  const rest = trail.slice(0, -1);
  const parent = rest[rest.length - 1];
  if (parent) {
    params.set(PAGE_KEY, parent.page);
    if (parent.match) params.set(MATCH_KEY, parent.match);
    const below = rest.slice(0, -1);
    if (below.length) params.set(STACK_KEY, encodeStack(below));
  }

  const lang = new URLSearchParams(search).get(LANG_KEY);
  if (lang) params.set(LANG_KEY, lang);

  const query = params.toString();
  return query ? `${RETURN_PAGES[target.page]}?${query}` : RETURN_PAGES[target.page];
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
  search: string = currentSearch(),
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
