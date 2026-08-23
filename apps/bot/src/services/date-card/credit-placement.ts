import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createCanvas, GlobalFonts } from "@napi-rs/canvas";
import {
  CARD_W,
  CARD_PADDING_X,
  CREDIT_TEXT,
  CREDIT_FONT_PX,
  ADDRESS_FONT_PX,
  type CreditPlacement,
} from "./template.js";

/**
 * Where the "made with Gennety" credit goes on this particular card.
 *
 * It sits beside the venue address when the address leaves room, and drops into
 * the hero photo's lower-left corner when it does not — which is the ordinary
 * case for a long address (see `template.ts` → `photoCredit`).
 *
 * The 2026-08-20 pass made the photo corner unconditional, on the stated
 * grounds that "satori exposes no text metrics before a render, so 'does it
 * fit' cannot be answered honestly". The first half is true and the conclusion
 * was not: satori has no metrics API, but `@napi-rs/canvas` — already a
 * dependency, already used by this renderer for the duotone, the grain and the
 * face blur — measures the SAME font file satori is handed. Measured against
 * satori's own laid-out advance width over Latin and Cyrillic addresses at both
 * sizes, canvas agrees to within **2px and 0.45%**, and always UNDER-reports
 * (satori rounds up to whole pixels). The minimum gap below is thirteen times
 * that worst error.
 *
 * Measured over the real curated catalog, the address goes inline for 95.6% of
 * Kyiv's venues (79.6% across all three launched-city files — Odesa and Kharkiv
 * addresses carry an oblast name and run longer), so the photo corner is the
 * long tail rather than the common case it became on 2026-08-20.
 *
 * The safety of the layout does not rest on that measurement anyway, and that
 * is the point worth keeping: in the inline branch the address is clipped to a
 * FIXED width, so the credit's box is decided before the address is read and no
 * address length can push it — the 2026-08-20 failure (a credit laid out past
 * the canvas edge) is impossible in both branches. A wrong measurement can only
 * ellipsize an address a few characters early, never clip the credit away.
 */
export type { CreditPlacement };

/** Card width minus the card's own horizontal padding — the text column. */
export const CONTENT_W = CARD_W - 2 * CARD_PADDING_X;

/**
 * Clear air between the end of the address and the credit, at the tightest.
 *
 * A little over one 30px character. Below ~24px the two read as one run of
 * text; above ~48px the inline branch stops covering the common address (each
 * extra 8px costs roughly half a percent of the real catalog). It doubles as
 * the measurement's error budget — see the module comment.
 */
export const CREDIT_MIN_GAP = 40;

const FONT_ALIAS = "GennetyDateCardRoboto";
let fontReady: boolean | null = null;

/** Register the bundled Roboto under a private alias, once. */
function ensureFont(): boolean {
  if (fontReady !== null) return fontReady;
  try {
    const data = readFileSync(
      fileURLToPath(new URL("../../assets/fonts/Roboto-Regular.ttf", import.meta.url)),
    );
    fontReady = Boolean(GlobalFonts.register(data, FONT_ALIAS));
  } catch {
    fontReady = false;
  }
  return fontReady;
}

/**
 * Advance width of `text` in the bundled Roboto at `px`, or `null` when the
 * font could not be registered.
 *
 * A glyph Roboto does not carry is measured in whatever canvas falls back to,
 * which is not what satori would draw — but that address is already a broken
 * render, and the reserved-width structure bounds the damage to an early
 * ellipsis, so it is not worth a cmap scan to detect.
 */
export function measureRoboto(text: string, px: number): number | null {
  if (!ensureFont()) return null;
  try {
    const ctx = createCanvas(1, 1).getContext("2d");
    ctx.font = `${px}px ${FONT_ALIAS}`;
    const w = ctx.measureText(text).width;
    return Number.isFinite(w) ? w : null;
  } catch {
    return null;
  }
}

/** Width of the credit itself — a constant string, so measured once. */
let cachedCreditW: number | null | undefined;
function creditWidth(): number | null {
  if (cachedCreditW === undefined) cachedCreditW = measureRoboto(CREDIT_TEXT, CREDIT_FONT_PX);
  return cachedCreditW;
}

/**
 * Decide the credit's placement for one card. Falls back to the photo corner —
 * the placement that needs no measurement — whenever the address does not
 * comfortably fit or the measurement is unavailable.
 */
export function resolveCreditPlacement(venueAddress: string): CreditPlacement {
  const credit = creditWidth();
  if (credit === null) return { kind: "photo" };

  const addressWidth = CONTENT_W - credit - CREDIT_MIN_GAP;
  if (addressWidth <= 0) return { kind: "photo" };

  const measured = measureRoboto(venueAddress, ADDRESS_FONT_PX);
  if (measured === null || measured > addressWidth) return { kind: "photo" };

  return { kind: "inline", addressWidth: Math.floor(addressWidth) };
}
