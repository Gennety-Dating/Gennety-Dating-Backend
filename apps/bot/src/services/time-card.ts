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

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import satori from "satori";
import { Resvg } from "@resvg/resvg-js";
import type { Language } from "@gennety/shared";
import { LOCALE_TAGS, RENDER_TZ } from "./datetime-entity.js";

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

type SatoriFonts = Parameters<typeof satori>[1]["fonts"];
let cachedFonts: SatoriFonts | null = null;

/**
 * Roboto for the label, Unbounded 700 for the two headline lines.
 *
 * Two font gotchas are baked into this list:
 *
 * 1. Archivo Black (the date-card headline face) is Latin-only, so a Cyrillic
 *    date would fall back mid-word. Unbounded covers both scripts.
 * 2. Satori does NOT fall through *within* a family — it takes the first font
 *    registered under the requested name and resolves missing glyphs from the
 *    OTHER families, in array order. Registering the two Unbounded subsets
 *    under one name therefore breaks every mixed string: a Russian date is
 *    Cyrillic words (cyr subset) plus digits (latin subset only), so half the
 *    line silently drops to Roboto.
 *
 * This used to navigate (2) by registering `unbounded-lat-700` as "Unbounded"
 * and `unbounded-cyr-700` as its own family ahead of Roboto — correct for
 * Latin and Cyrillic, but it left a third script out: Polish's Ą Ł Ż Ś Ć Ź Ń Ę
 * are in Google's `latin-ext` subset, which NEITHER file carries. A Polish date
 * ("WRZEŚNIA", "PAŹDZIERNIKA", "ŚR") rendered those letters in Roboto mid-word,
 * and satori reports nothing when it substitutes a glyph, so it failed silently.
 * Loading the FULL `unbounded-700.woff` under a single name covers all three
 * scripts and removes the ordering hazard in (2) altogether — the same call,
 * and the same asset, as `services/expiry-card.ts`.
 */
/** Exported as a test seam: the registration SHAPE is the thing that broke. */
export function loadFonts(): SatoriFonts {
  if (cachedFonts) return cachedFonts;
  const read = (file: string) =>
    readFileSync(fileURLToPath(new URL(`../assets/fonts/${file}`, import.meta.url)));
  cachedFonts = [
    { name: "Unbounded", data: read("unbounded-700.woff"), weight: 700, style: "normal" },
    { name: "Roboto", data: read("Roboto-Medium.ttf"), weight: 500, style: "normal" },
  ];
  return cachedFonts;
}

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
      fontFamily: "Roboto",
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
          fontFamily: "Unbounded",
          fontWeight: 700,
          fontSize: "62px",
          lineHeight: 1.1,
          color: p.ink,
        },
        formatDate(input.agreedTime, input.language),
      ),
      el(
        "div",
        {
          display: "flex",
          marginTop: "10px",
          fontFamily: "Unbounded",
          fontWeight: 700,
          fontSize: "132px",
          lineHeight: 1.1,
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
      { width: TIME_CARD_W, height: TIME_CARD_H, fonts: loadFonts() },
    );
    const png = new Resvg(svg, {
      fitTo: { mode: "width", value: TIME_CARD_W },
      background: palette(input.theme).bg,
    })
      .render()
      .asPng();
    return Buffer.from(png);
  } catch (err) {
    console.warn("[time-card] render failed:", err);
    return null;
  }
}
