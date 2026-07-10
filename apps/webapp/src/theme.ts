/**
 * Shared theme helper for the Mini Apps.
 *
 * Source of truth is `User.theme` on the server (returned in the onboarding
 * `/state` payload and other bootstraps). To avoid a wrong-theme flash before
 * that value arrives, each *.html sets `data-theme` from `localStorage`
 * synchronously in an inline boot snippet (see `THEME_BOOT_SNIPPET`), and we
 * reconcile with the server value once it loads.
 *
 * All Mini Apps share the same origin (`dating-calendar.gennety.com`), so a
 * single `localStorage` key is shared across every screen. Telegram
 * `CloudStorage` mirrors the choice across devices best-effort.
 */

export type Theme = "light" | "dark";

export const DEFAULT_THEME: Theme = "dark";
export const THEME_STORAGE_KEY = "gennety-theme";

/** The exact inline snippet each *.html must run in <head> before first paint. */
export const THEME_BOOT_SNIPPET = `(function(){try{var t=localStorage.getItem('${THEME_STORAGE_KEY}');document.documentElement.dataset.theme=(t==='light'||t==='dark')?t:'${DEFAULT_THEME}';}catch(e){document.documentElement.dataset.theme='${DEFAULT_THEME}';}})();`;

function isTheme(v: unknown): v is Theme {
  return v === "light" || v === "dark";
}

/** Current theme from the DOM attribute (set pre-paint), falling back to cache. */
export function getTheme(): Theme {
  const attr = document.documentElement.dataset.theme;
  if (isTheme(attr)) return attr;
  try {
    const cached = localStorage.getItem(THEME_STORAGE_KEY);
    if (isTheme(cached)) return cached;
  } catch {
    /* ignore */
  }
  return DEFAULT_THEME;
}

/** Apply a theme to the document (no persistence). */
export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  // Legacy: some CSS still keys off `.dark`; keep it in sync.
  document.documentElement.classList.toggle("dark", theme === "dark");
  document.documentElement.classList.toggle("light", theme === "light");
}

/** Apply + persist a theme (localStorage + best-effort Telegram CloudStorage). */
export function setTheme(theme: Theme): void {
  applyTheme(theme);
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    /* ignore */
  }
  try {
    const cloud = (
      window as unknown as {
        Telegram?: { WebApp?: { CloudStorage?: { setItem?: (k: string, v: string) => void } } };
      }
    ).Telegram?.WebApp?.CloudStorage;
    cloud?.setItem?.(THEME_STORAGE_KEY, theme);
  } catch {
    /* ignore */
  }
}

/**
 * Reconcile the cached theme with the server's authoritative value once a
 * bootstrap payload (e.g. `/state`) has loaded. No-op when the server value is
 * absent or already matches.
 */
export function reconcileTheme(serverTheme: unknown): void {
  if (isTheme(serverTheme) && serverTheme !== getTheme()) {
    setTheme(serverTheme);
  }
}
