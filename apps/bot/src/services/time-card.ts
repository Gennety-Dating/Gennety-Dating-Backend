/**
 * Time card (PRODUCT_SPEC §3.6) — the minimal PNG banner that announces the
 * LOCKED date/time right before the venue concierge asks for a departure
 * point.
 *
 * Why it exists: the calendar locks a slot automatically the moment the two
 * availability sets intersect, so the side that didn't tap last never
 * explicitly saw *which* slot won — the very next thing they get is the
 * location Mini App prompt. In a chat that already carries a stack of
 * back-to-back messages, a plain text line disappears; a wide, near-empty
 * card with two big lines does not.
 *
 * Deliberately minimal: a small label, the localized date, and the time in
 * the burgundy accent. No photos, no network calls — the render is pure
 * layout + rasterize (tens of ms), so callers need no "working…" status beat.
 *
 * Rendered text is emoji-free: the bundled fonts carry no color-emoji glyphs
 * (satori drops them). Emoji live in the Telegram caption instead.
 *
 * Never throws — returns `null` on any failure so the caller degrades to a
 * plain text confirmation. The concierge flow must never wedge on a render.
 */

import satori from "satori";
import type { Language } from "@gennety/shared";
import { LOCALE_TAGS, RENDER_TZ } from "./datetime-entity.js";
import { svgToPng } from "./date-card/image.js";
import { cardFonts, DISPLAY_FAMILY, BODY_FAMILY } from "./card-fonts.js";

/** Wide banner: Telegram renders a ~2.4:1 photo as a compact strip, not a wall. */
export const TIME_CARD_W = 1000;
export const TIME_CARD_H = 420;

export type TimeCardTheme = "light" | "dark";

interface Palette {
  bg: string;
  ink: string;
  muted: string;
  accent: string;
}

/**
 * The brand burgundy `#8B253B` sits too close to the date card's near-black
 * `#030303` to survive a chat-thumbnail preview, so the dark variant uses a
 * graphite ground and a lifted burgundy. Light keeps the canonical pair.
 */
function palette(theme: TimeCardTheme): Palette {
  return theme === "light"
    ? { bg: "#F5F5F5", ink: "#1D1D1D", muted: "#6B6670", accent: "#8B253B" }
    : { bg: "#16161A", ink: "#F2EFF7", muted: "#8E8895", accent: "#B8324F" };
}

/** Minimal satori-compatible node (cast to satori's ReactNode at the call site). */
interface CardNode {
  type: string;
  props: {
    style?: Record<string, unknown>;
    children?: (CardNode | string)[] | CardNode | string;
    [key: string]: unknown;
  };
}

function el(
  type: string,
  style: Record<string, unknown>,
  children?: (CardNode | string)[] | CardNode | string,
): CardNode {
  return { type, props: { style, ...(children !== undefined ? { children } : {}) } };
}

/**
 * Roboto for the label, Gennety Display 800 for the two headline lines
 * (`card-fonts.ts`). One file per weight covers Cyrillic, digits and Polish's
 * latin-ext ("WRZEŚNIA", "PAŹDZIERNIKA", "ŚR"), so no part of a date drops into
 * Roboto mid-word — the trap the Unbounded subsets used to set here. Sizes keep
 * the cap height the banner was designed with at Unbounded 700 (62 / 132px).
 */
const DATE_PX = 66;
const TIME_PX = 140;

/**
 * Both sides always see the SAME figures, so the card renders in the product's
 * canonical `Europe/Kyiv` (identical to the scheduled confirmation and the
 * `date_time` entity). The entity in the caption is what resolves to each
 * user's own timezone when tapped.
 */
function formatDate(when: Date, language: Language): string {
  const locale = LOCALE_TAGS[language];
  return new Intl.DateTimeFormat(locale, {
    weekday: "short",
    day: "numeric",
    month: "long",
    timeZone: RENDER_TZ,
  })
    .format(when)
    .toLocaleUpperCase(locale);
}

function formatTime(when: Date, language: Language): string {
  return new Intl.DateTimeFormat(LOCALE_TAGS[language], {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: RENDER_TZ,
  }).format(when);
}

export interface TimeCardInput {
  agreedTime: Date;
  language: Language;
  /** Recipient's chosen theme — drives the light/dark chrome. */
  theme: TimeCardTheme;
  /** Small uppercase label above the date (localized by the caller). */
  label: string;
}

export function buildTimeCardElement(input: TimeCardInput): CardNode {
  const p = palette(input.theme);
  return el(
    "div",
    {
      display: "flex",
      flexDirection: "column",
      justifyContent: "center",
      width: `${TIME_CARD_W}px`,
      height: `${TIME_CARD_H}px`,
      padding: "0 72px",
      backgroundColor: p.bg,
      fontFamily: BODY_FAMILY,
    },
    [
      el(
        "div",
        {
          display: "flex",
          fontSize: "26px",
          fontWeight: 500,
          letterSpacing: "6px",
          color: p.muted,
        },
        input.label,
      ),
      el(
        "div",
        {
          display: "flex",
          marginTop: "26px",
          fontFamily: DISPLAY_FAMILY,
          fontWeight: 800,
          fontSize: `${DATE_PX}px`,
          lineHeight: 1.1,
          letterSpacing: "-0.5px",
          color: p.ink,
        },
        formatDate(input.agreedTime, input.language),
      ),
      el(
        "div",
        {
          display: "flex",
          marginTop: "10px",
          fontFamily: DISPLAY_FAMILY,
          fontWeight: 800,
          fontSize: `${TIME_PX}px`,
          lineHeight: 1.1,
          letterSpacing: "-2px",
          color: p.accent,
        },
        formatTime(input.agreedTime, input.language),
      ),
    ],
  );
}

export async function renderTimeCard(input: TimeCardInput): Promise<Buffer | null> {
  try {
    const svg = await satori(
      buildTimeCardElement(input) as unknown as Parameters<typeof satori>[0],
      { width: TIME_CARD_W, height: TIME_CARD_H, fonts: cardFonts() },
    );
    const png = await svgToPng(svg, TIME_CARD_W, palette(input.theme).bg);
    return Buffer.from(png);
  } catch (err) {
    console.warn("[time-card] render failed:", err);
    return null;
  }
}
