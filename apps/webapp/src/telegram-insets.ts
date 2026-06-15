/**
 * Mirror Telegram's content safe-area inset into CSS custom properties.
 *
 * In Bot API 8.0+ fullscreen mode Telegram floats the close × / menu ⋯
 * controls over the web app, and `env(safe-area-inset-top)` does NOT include
 * them — content slides under the chrome. `contentSafeAreaInset` reports the
 * real reserve, which we expose as `--tg-content-top` / `--tg-content-bottom`
 * for CSS to pad around. Re-applied on `contentSafeAreaChanged` because the
 * value changes when the user toggles fullscreen or the keyboard appears.
 *
 * Mirrors the Calendar Mini App's inline logic in `main.ts`; shared so the
 * ticket Mini Apps don't slide under the chrome either. CSS must define a
 * sensible fallback (`--tg-content-top`) for older clients that never fire the
 * event.
 */
export function wireContentInsets(app: TelegramWebApp | undefined): void {
  if (!app) return;

  const apply = (): void => {
    const inset = app.contentSafeAreaInset;
    if (!inset) return;
    if (typeof inset.top === "number" && inset.top > 0) {
      document.documentElement.style.setProperty("--tg-content-top", `${inset.top}px`);
    }
    if (typeof inset.bottom === "number" && inset.bottom >= 0) {
      document.documentElement.style.setProperty("--tg-content-bottom", `${inset.bottom}px`);
    }
  };

  apply();
  try {
    app.onEvent?.("contentSafeAreaChanged", apply);
  } catch {
    // Older clients without the event — the fallback CSS value still applies.
  }
}
