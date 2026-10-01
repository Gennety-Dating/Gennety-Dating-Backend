/**
 * TRIAL ONLY — branch `trial/rubik-type`, never merged to main.
 *
 * The display-face trial's switch (see type-trial.css): each display-face
 * shell copies `?type=unbounded | wix | sharp50 | sharp0` onto
 * `<html data-type>` before first paint, and this module reads it back.
 *
 * Unbounded is a wide face: even at the same cap height (size-adjust 93.3 %)
 * a label runs ~18 % longer than in Gennety Display. Primary CTA labels that
 * then wrap or overflow at a 360px-wide viewport — and only those, measured in
 * all five languages against the button's real available width — get a short
 * per-language form here. Nothing changes for `wix`, for `sharp50` / `sharp0`
 * (Gennety Display itself at a lower Sharpness: only C c С с Є Э 1 run a few %
 * wider) or without the parameter: `withShortLabels` then returns the table it
 * was given.
 *
 * Measured at 360×780 with the prices production shows (ticket 250 ⭐ /
 * both 500 ⭐, venue change 150 ⭐); a four-digit price would need rechecking.
 */

type Lang = "en" | "ru" | "uk" | "de" | "pl";
export type TypeVariant = "unbounded" | "wix" | "sharp50" | "sharp0";
type Page = "ticket" | "radar" | "venue-change";
type Label = string | ((stars: number) => string);

export function typeVariant(): TypeVariant | null {
  if (typeof document === "undefined") return null;
  const t = document.documentElement?.dataset?.type;
  return t === "unbounded" || t === "wix" || t === "sharp50" || t === "sharp0" ? t : null;
}

// Only labels that take MORE lines in Unbounded than in main's build at
// 360px (main already wraps 28 of 130 — those that stay at main's line count
// are left alone). Words dropped, meaning kept: the price on a pay button
// already says "pay", "2 tickets" already says "you and your date".
const SHORT: Record<Page, Partial<Record<Lang, Record<string, Label>>>> = {
  ticket: {
    en: {
      usePartner: "Ticket for your date 🎟️",
      payPartner: "For your date — {amount}",
    },
    ru: {
      useBoth: "Использовать 2\u00A0билета\u00A0🎟️🎟️",
      paySelfOnly: "Свой билет — {amount}",
      payPartner: "За пару — {amount}",
      goToScheduling: "Перейти к планированию",
    },
    uk: {
      useBoth: "Використати 2\u00A0квитки\u00A0🎟️🎟️",
      paySelfOnly: "Свій квиток — {amount}",
      payPartner: "За пару — {amount}",
    },
    pl: {
      paySelfOnly: "Swój bilet — {amount}",
    },
  },
  radar: {
    de: { notMyType: "Eher nicht" },
  },
  "venue-change": {
    en: {
      premiumMark: "Premium · Suggest",
      expressBtn: (stars) => `Change now — ${stars}`,
    },
    ru: {
      expressBtn: (stars) => `Сменить сразу — ${stars}`,
    },
    uk: {
      ctaKeepSuggest: "Запропонувати лишитись",
    },
    pl: {
      premiumMark: "Premium · Zaproponuj",
    },
  },
};

/** The page's string table, with the Unbounded short labels laid over it. */
export function withShortLabels<T extends object>(page: Page, lang: Lang, table: T): T {
  if (typeVariant() !== "unbounded") return table;
  const short = SHORT[page][lang];
  return short ? ({ ...table, ...short } as T) : table;
}

/** A short label that has no key of its own in the page table (a composed one). */
export function shortLabel(page: Page, lang: Lang, key: string): string | null {
  if (typeVariant() !== "unbounded") return null;
  const label = SHORT[page][lang]?.[key];
  return typeof label === "string" ? label : null;
}
