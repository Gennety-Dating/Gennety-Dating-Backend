import type { Theme } from "@gennety/db";
import type { Language } from "@gennety/shared";
import { env } from "../config.js";

export type MiniAppPage =
  | "calendar"
  | "feedback"
  | "location"
  | "onboarding"
  | "verification"
  | "ticket"
  | "tickets"
  | "venue-change";

const PAGE_FILES: Record<Exclude<MiniAppPage, "calendar">, string> = {
  feedback: "feedback.html",
  location: "location.html",
  onboarding: "onboarding.html",
  verification: "verification.html",
  ticket: "ticket.html",
  tickets: "tickets.html",
  "venue-change": "venue-change.html",
};

export interface BuildMiniAppUrlOptions {
  lang: Language;
  theme: Theme;
  /** Defaults to the canonical Mini App host. A page-specific override may
   * point directly at that page (for example WEBAPP_FEEDBACK_URL). */
  baseUrl?: string;
  query?: Readonly<Record<string, string | number | boolean | null | undefined>>;
}

/**
 * Build a Telegram Mini App URL with the user's current language and theme.
 * Existing base query parameters are preserved, while authoritative runtime
 * values replace stale `lang`/`theme` values. Non-calendar pages are appended
 * below WEBAPP_URL unless `baseUrl` already points at the requested HTML file.
 */
export function buildMiniAppUrl(
  page: MiniAppPage,
  options: BuildMiniAppUrlOptions,
): string {
  const url = new URL(options.baseUrl ?? env.WEBAPP_URL);

  if (page === "calendar") {
    url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  } else {
    const file = PAGE_FILES[page];
    const currentFile = url.pathname.split("/").filter(Boolean).at(-1);
    if (currentFile !== file) {
      url.pathname = `${url.pathname.replace(/\/+$/, "")}/${file}`;
    }
  }

  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value === null || value === undefined) continue;
    url.searchParams.set(key, String(value));
  }
  url.searchParams.set("lang", options.lang);
  // Prisma guarantees the enum in production; the fallback also keeps links
  // usable for legacy fixtures/rows passed through partially-typed adapters.
  url.searchParams.set("theme", options.theme === "light" ? "light" : "dark");
  return url.toString();
}
