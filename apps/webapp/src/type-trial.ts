/**
 * TRIAL ONLY — branch `trial/rubik-type`, never merged to main.
 *
 * The Rubik type trial's switch (see type-trial.css): each display-face shell
 * copies `?type=rubik | rubik-caps` onto `<html data-type>` before first paint,
 * and this module reads it back.
 *
 * In `rubik-caps` primary CTA labels are UPPERCASE 16px/700/+0.06em, and some
 * no longer fit one line at a 360px-wide viewport. Those — and only those, as
 * measured in all five languages against the button's real available width —
 * get a short per-language form here. Nothing changes for `rubik` or without
 * the parameter: `withCapsLabels` then returns the table it was given.
 *
 * Measured at 360×780 with the prices production shows (ticket 250 ⭐ /
 * both 500 ⭐, venue change 150 ⭐); a four-digit price would need rechecking.
 */

type Lang = "en" | "ru" | "uk" | "de" | "pl";
export type TypeVariant = "rubik" | "rubik-caps";
type Page = "ticket" | "radar" | "venue-change";
type Label = string | ((stars: number) => string);

export function typeVariant(): TypeVariant | null {
  if (typeof document === "undefined") return null;
  const t = document.documentElement?.dataset?.type;
  return t === "rubik" || t === "rubik-caps" ? t : null;
}

const SHORT: Record<Page, Partial<Record<Lang, Record<string, Label>>>> = {
  ticket: {
    en: {
      useBoth: "Use 2 tickets",
      usePartner: "Ticket for your date",
      payBoth: "Pay both — {amount}",
      payBothWithTicket: "Both — 🎟️ + {amount}",
      payPartner: "Your date — {amount}",
    },
    ru: {
      useBoth: "2 билета на двоих",
      useSelf: "Использовать билет",
      usePartner: "Билет за пару",
      payBoth: "За двоих — {amount}",
      payBothWithTicket: "Двоим — 🎟️ + {amount}",
      paySelfOnly: "Свой билет — {amount}",
      payPartner: "За пару — {amount}",
      goToScheduling: "К планированию",
    },
    uk: {
      useBoth: "2 квитки на двох",
      useSelf: "Використати квиток",
      usePartner: "Квиток за пару",
      payBoth: "За двох — {amount}",
      payBothWithTicket: "Двом — 🎟️ + {amount}",
      paySelfOnly: "Свій квиток — {amount}",
      payPartner: "За пару — {amount}",
      goToScheduling: "До планування",
    },
    de: {
      useBoth: "2 Tickets nutzen",
      usePartner: "Ticket fürs Date",
      payBoth: "Für beide — {amount}",
      payBothWithTicket: "Beide — 🎟️ + {amount}",
      payPartner: "Fürs Date — {amount}",
    },
    pl: {
      useBoth: "Użyj 2 biletów",
      usePartner: "Bilet za randkę",
      payBoth: "Za oboje — {amount}",
      payBothWithTicket: "Oboje — 🎟️ + {amount}",
      paySelfOnly: "Swój bilet — {amount}",
      payPartner: "Za randkę — {amount}",
      goToScheduling: "Do planowania",
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
      premiumMark: "Premium · Предложить",
      ctaKeepSuggest: "Предложить остаться",
      paySelfBtn: (stars) => `Закреплю сама — ${stars}`,
    },
    uk: {
      premiumMark: "Premium · Позначити",
      ctaKeepSuggest: "Запропонувати лишитись",
    },
    de: {
      premiumMark: "Premium · Vorschlagen",
      ctaWithdraw: "Markierungen löschen",
    },
    pl: {
      premiumMark: "Premium · Zaproponuj",
      paySelfBtn: (stars) => `Zatwierdzę sama — ${stars}`,
    },
  },
};

/** The page's string table, with the caps-variant short labels laid over it. */
export function withCapsLabels<T extends object>(page: Page, lang: Lang, table: T): T {
  if (typeVariant() !== "rubik-caps") return table;
  const short = SHORT[page][lang];
  return short ? ({ ...table, ...short } as T) : table;
}

/** A short label that has no key of its own in the page table (a composed one). */
export function capsLabel(page: Page, lang: Lang, key: string): string | null {
  if (typeVariant() !== "rubik-caps") return null;
  const label = SHORT[page][lang]?.[key];
  return typeof label === "string" ? label : null;
}
