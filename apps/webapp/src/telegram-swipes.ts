/**
 * Keep the Mini App open when the user drags down (Bot API 7.7+).
 *
 * Telegram reads a downward drag that starts at the top of the page (or on a
 * page with no scroll of its own) as "minimise / close me", so simply
 * scrolling back up a screen pulled the whole sheet down. Every Mini App entry
 * turns that off right after `ready()` / `expand()`, once, for the life of the
 * page — nothing turns it back on (decision 2026-09-29). The ways out stay:
 * the header Close / ⋯ menu and a swipe on Telegram's own header.
 *
 * Older clients have no such method and simply keep swipe-to-close; a client
 * that throws is ignored — boot must never fail over chrome behaviour.
 */
export function keepOpenOnVerticalSwipe(
  app: Pick<TelegramWebApp, "disableVerticalSwipes"> | null | undefined,
): void {
  try {
    app?.disableVerticalSwipes?.();
  } catch {
    /* best-effort — an older client simply keeps its swipe-to-close */
  }
}
