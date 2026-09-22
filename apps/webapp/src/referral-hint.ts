/**
 * "Invite a friend · earn a ticket" — the referral cross-promo affordance
 * (PRODUCT_SPEC §3.9 → cross-promo entry points).
 *
 * The referral program pays out Date Tickets only (founder decision
 * 2026-09-22: no Premium in any form, and no money value attached to a
 * referral). So the chip appears ONLY at ticket bottlenecks — the Date Ticket
 * gate (when the wallet is empty) and the ticket store — plus the program's own
 * hub it hands off to. It must never appear on a Premium funnel: it used to sit
 * on the Premium sales screen and at both places on the venue board where a
 * non-premium user is asked to pay, and all three placements are gone. It is
 * not an "instead of paying" alternative any more; it is a second way to fill
 * the ticket wallet, next to the bundles.
 *
 * It used to be four hand-copied full-width rows of sentence-length text — one
 * per app, four identical CSS blocks under four class names — and that shape
 * was the problem, in three separate ways:
 *
 *  1. **On Premium it lived inside the pinned action bar**, so it grew that
 *     footer by ~39px and pushed the subscribe CTA and its price line up the
 *     screen. It is the only surface where the hint sat in the action zone
 *     rather than in the content, and the only one where it MOVED the thing the
 *     user came to tap. Hence the standing rule below.
 *  2. **The copy wrapped.** The Premium string ran 59 characters at 13px/600 —
 *     ~415px against ~350px of usable width on a 390px phone, i.e. two lines on
 *     every device in existence. A two-line row is a paragraph, not a link.
 *  3. **On the venue board two of them stacked**, the Premium counterfactual
 *     and this one, at identical width, weight and type — reading as a list of
 *     options rather than "the offer, plus a footnote".
 *
 * So: one module, one chip. Two rules it exists to enforce —
 *
 *  - **Never in an action bar, never full width.** This is a tail-of-content
 *    object. A caller appending it to a pinned footer is reintroducing (1).
 *  - **One line of copy.** Every string here is ≤31 characters, which at
 *    12.5px/600 plus the chip's own 44px of chrome fits inside a 320px screen.
 *    A longer translation turns the chip back into a block.
 *
 * The chip is deliberately *findable but weightless*: a 30px pill against a
 * 52px hero CTA, muted text, no border. It stays visible without asking to be
 * read, which is the whole brief — the pitch lives on the referral hub this
 * hands off to, not here.
 */

import "./referral-hint.css";

export type ReferralLang = "en" | "ru" | "uk" | "de" | "pl";

/**
 * One string for every surface, on purpose: every placement is a ticket
 * bottleneck, so "earn a ticket" is true wherever the chip is drawn, and the
 * screen the user is standing on already supplies the rest of the context.
 */
const COPY: Record<ReferralLang, string> = {
  en: "Invite a friend · earn a ticket",
  ru: "Пригласи друга — получи билет",
  uk: "Запроси друга — отримай квиток",
  de: "Freund einladen, Ticket holen",
  pl: "Zaproś znajomego, zdobądź bilet",
};

export function referralHintText(lang: ReferralLang): string {
  return COPY[lang] ?? COPY.en;
}

// The vanilla-TS `referralChip()` builder lived here too, for Premium and the
// venue board. Both placements are gone (they were Premium funnels), so the
// only rail left is the React twin in `referral-hint-react.tsx`; it imports this
// module for the copy and, through it, the stylesheet.
