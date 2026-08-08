/**
 * "Invite a friend instead" — the referral cross-promo affordance shared by
 * every paying Mini App screen (PRODUCT_SPEC §3.9 → cross-promo entry points):
 * the Premium sales screen, the Date Ticket gate, the ticket store, and both
 * places on the venue board where a non-premium user is asked to pay.
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
 * read, which is the whole brief — the sales pitch lives on the referral screen
 * this hands off to, not here.
 */

import "./referral-hint.css";
import { icon } from "./icons";

export type ReferralLang = "en" | "ru" | "uk" | "de" | "pl";

/**
 * One string for every surface, on purpose. Context-specific wording ("get
 * Premium free" / "get a ticket free") reads more precisely but needs five
 * variants per language and pushes several of them back over the one-line
 * budget — and the screen the user is standing on already supplies the context.
 */
const COPY: Record<ReferralLang, string> = {
  en: "Invite a friend instead",
  ru: "Пригласи друга вместо оплаты",
  uk: "Запроси друга замість оплати",
  de: "Freund einladen statt zahlen",
  pl: "Zaproś znajomego zamiast płacić",
};

export function referralHintText(lang: ReferralLang): string {
  return COPY[lang] ?? COPY.en;
}

export interface ReferralChipOptions {
  lang: ReferralLang;
  /** Runs on tap — the call site owns the hand-off (it knows its return trail). */
  onTap: () => void;
  /** Sits directly under another tappable row; halves the top gap. */
  tight?: boolean | undefined;
}

/** The chip, for the vanilla-TS apps (Premium, venue board). */
export function referralChip({ lang, onTap, tight }: ReferralChipOptions): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = tight ? "gn-referral gn-referral--tight" : "gn-referral";
  const span = document.createElement("span");
  span.textContent = referralHintText(lang);
  btn.append(icon("letter", "icon gn-referral-ico"), span);
  btn.addEventListener("click", onTap);
  return btn;
}
