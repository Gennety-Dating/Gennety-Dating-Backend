/**
 * Deferring a venue photo until its tile is near the screen — the testable
 * half, with the DOM adapter beside it.
 *
 * **This is a billing mechanism, not a perf tweak.** A board tile paints its
 * photograph as a CSS `background-image` fed by `new Image()`, never as an
 * `<img>`, so `loading="lazy"` — which exists only on `<img>` — has never
 * applied to it. Every tile the board built therefore bought its picture the
 * instant it was constructed, and each of those is one Google **Place Photo**
 * request. A board is 21 cards on a list roughly four deep, so ~16 of those
 * requests were for cards the user had not scrolled to and, on most boards,
 * never would.
 *
 * Same split, and same reason, as `photo-retry.ts`: the policy takes an
 * injected observer factory so a test needs a five-line fake instead of a DOM
 * impersonation, and the one function that touches the browser is the adapter
 * at the bottom.
 */

/** Minimal shape of what this needs from an `IntersectionObserver`. */
export interface DeferObserver {
  observe: (target: Element) => void;
  disconnect: () => void;
}

export interface DeferDeps {
  /**
   * Build an observer that calls `onVisible` when the target is near the
   * viewport. `null` means the environment has no observer to build — an old
   * webview, or a node test — and the caller must load eagerly rather than
   * never.
   */
  createObserver: ((onVisible: () => void) => DeferObserver) | null;
}

/**
 * How far ahead of the viewport a tile starts loading. One full viewport, so a
 * photo is fetched a screen before it is needed and still arrives decoded — the
 * saving comes from the tiles nobody ever scrolls to, not from making anyone
 * wait for the ones they do.
 */
export const PHOTO_DEFER_ROOT_MARGIN = "100% 0px";

/**
 * Run `start` once, when `target` is near the viewport.
 *
 * Guarantees, in the order they matter:
 *
 *  1. `start` runs **at most once**, however many times the observer fires.
 *  2. Without an observer, `start` runs **immediately** — eager loading is the
 *     previous behaviour, while a photo that never loads is a blank board.
 *  3. The observer disconnects as soon as it has fired, so a long-lived board
 *     does not accumulate one live observer per tile.
 */
export function loadWhenVisible(
  target: Element,
  start: () => void,
  deps: DeferDeps,
): void {
  if (!deps.createObserver) {
    start();
    return;
  }
  let started = false;
  const observer = deps.createObserver(() => {
    if (started) return;
    started = true;
    observer.disconnect();
    start();
  });
  observer.observe(target);
}

/**
 * The real adapter. Returns `null` where `IntersectionObserver` is missing,
 * which is what routes such an environment to eager loading above.
 */
export function domObserverFactory(): DeferDeps["createObserver"] {
  if (typeof IntersectionObserver === "undefined") return null;
  return (onVisible) =>
    new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) onVisible();
      },
      { rootMargin: PHOTO_DEFER_ROOT_MARGIN },
    );
}
