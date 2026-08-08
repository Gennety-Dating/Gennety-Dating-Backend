import type { ReactElement } from "react";

/**
 * Authored vector marks for the Ticket Mini App — the React twins of the board's
 * `icons.ts`. Never platform emoji: an emoji renders as Apple's art on iOS and
 * Google's on Android, and blurs the moment it is scaled or animated (the
 * drifting hearts on the partner-paid screen did exactly that).
 *
 * They inherit `currentColor`, so colour stays the caller's decision — which is
 * the whole point of the palette: white means "you", burgundy means "them".
 */

const BOX = "0 0 24 24";

/** Solid heart — the affection beat on the covered/partner-paid screens. */
export function HeartMark(): ReactElement {
  return (
    <svg viewBox={BOX} aria-hidden="true" focusable="false" shapeRendering="geometricPrecision">
      <path
        d="M12 20.3s-7.4-4.6-9.1-9.2C1.7 7.7 3.6 4.5 6.8 4.5c2 0 3.6 1.1 4.4 2.7l.8 1.5.8-1.5c.8-1.6 2.4-2.7 4.4-2.7 3.2 0 5.1 3.2 3.9 6.6-1.7 4.6-9.1 9.2-9.1 9.2Z"
        fill="currentColor"
      />
    </svg>
  );
}

/**
 * Envelope with a heart seal — the "invite a friend instead" referral
 * cross-promo link (React twin of `icons.ts`'s `letter`, same path data).
 */
export function LetterMark(): ReactElement {
  return (
    <svg viewBox={BOX} aria-hidden="true" focusable="false" shapeRendering="geometricPrecision">
      <path
        d="M3.6 6.8h16.8v10.4H3.6V6.8Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M3.6 7.2 12 13l8.4-5.8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M12 18.6c-1.6-1-2.6-1.9-2.6-3 0-.8.6-1.4 1.4-1.4.5 0 .9.2 1.2.6.3-.4.7-.6 1.2-.6.8 0 1.4.6 1.4 1.4 0 1.1-1 2-2.6 3Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * Ticket outline — the wallet count printed on the card's stub.
 *
 * It exists because that count used to be a `🎟️` inside a localized sentence
 * ("Твой кошелёк: 2 🎟️") sitting in an ordinary pill BELOW the card. On the card
 * itself a platform emoji is not an option (see the note above), and a bare
 * "× 2" beside a barcode reads as a quantity of nothing in particular.
 *
 * Drawn at the same 1.6 stroke weight as `LetterMark` so the two read as one
 * family. The notches are exact semicircles (radius = half the chord), which is
 * what makes the silhouette a ticket at 13px rather than a rounded rectangle.
 */
export function TicketMark(): ReactElement {
  return (
    <svg viewBox={BOX} aria-hidden="true" focusable="false" shapeRendering="geometricPrecision">
      <path
        d="M4.4 6.4h15.2a1.8 1.8 0 0 1 1.8 1.8v2a1.8 1.8 0 0 0 0 3.6v2a1.8 1.8 0 0 1-1.8 1.8H4.4a1.8 1.8 0 0 1-1.8-1.8v-2a1.8 1.8 0 0 0 0-3.6v-2a1.8 1.8 0 0 1 1.8-1.8Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M15.4 8.6v6.8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeDasharray="1.7 1.7"
      />
    </svg>
  );
}

/** Check — the "paid" seal. */
export function CheckMark(): ReactElement {
  return (
    <svg viewBox={BOX} aria-hidden="true" focusable="false" shapeRendering="geometricPrecision">
      <path
        d="M4.8 12.6 9.6 17.4l9.6-10.8"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * The brand butterfly — the mark stamped inside the ticket itself.
 *
 * Same path as `apps/bot/src/assets/brand/butterfly-logo.svg` (the one the date
 * and match cards carry), but painted with `currentColor` instead of the brand
 * gradient, so the ticket can render it flat white and it reads as punched out
 * of the ticket rather than pasted on top of it.
 */
export function ButterflyMark(): ReactElement {
  return (
    <svg
      viewBox="0 0 100 100"
      aria-hidden="true"
      focusable="false"
      shapeRendering="geometricPrecision"
    >
      <path
        d="M 50 35 C 20 0, -10 30, 15 55 C -5 75, 25 100, 48 65 L 52 65 C 75 100, 105 75, 85 55 C 110 30, 80 0, 50 35 Z"
        fill="currentColor"
      />
    </svg>
  );
}
