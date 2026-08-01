/**
 * Pre-date coordination card layout, as a plain satori element tree (no JSX, so
 * the bot's tsconfig needs no React/JSX support).
 *
 * One skeleton, five variants (see `copy.ts`). Every variant renders the SAME
 * white polaroid frame in the same place — only what sits inside it changes:
 *
 *   offer / ask / shared → a real profile photo
 *   declined             → a clock face  ("not now, but soon")
 *   proxy                → a burgundy halftone field + the brand butterfly,
 *                          i.e. the portrait deliberately withheld — the
 *                          anonymity of the relay made visual, in the exact
 *                          frame the contact cards use for a face.
 *
 * Composition follows the newest brand card (services/referral-card): centred
 * column, brand lockup at the top, display headline whose LAST line takes the
 * burgundy accent, one muted sentence pinned to the bottom.
 *
 * Rendered text is emoji-free on purpose — the bundled fonts carry no
 * color-emoji glyphs and satori drops them. Emoji live in the Telegram caption.
 *
 * Pure layout: photo decoding, grain, and the butterfly raster happen upstream
 * in `index.ts` and arrive here as ready PNG buffers.
 */

import type { CoordCardCopy, CoordCardVariant } from "./copy.js";

export const CARD_W = 900;
export const CARD_H = 1040;

const BURGUNDY = "#8B253B";
/** Lifted burgundy — the canonical one sinks into the near-black dark ground. */
const BURGUNDY_LIFTED = "#B8324F";

export type CoordCardTheme = "light" | "dark";

interface Palette {
  /** Card ground (a gradient on dark, flat cream on light). */
  bg: string;
  ink: string;
  muted: string;
  accent: string;
  /**
   * Alpha (hex pair) of the burgundy glow behind the polaroid. The dark ground
   * swallows it, so it has to be strong there; over cream the same value reads
   * as bubblegum pink, so light gets roughly a third of it.
   */
  glowAlpha: string;
}

function palette(theme: CoordCardTheme): Palette {
  return theme === "light"
    ? {
        bg: "linear-gradient(158deg, #FFFFFF 0%, #F5F1F1 46%, #EFE2E5 100%)",
        ink: "#1D1D1D",
        muted: "#6B6670",
        accent: BURGUNDY,
        glowAlpha: "1F",
      }
    : {
        bg: "linear-gradient(158deg, #0B0406 0%, #17090D 44%, #4A1421 100%)",
        ink: "#F2EFF7",
        muted: "#9A8F96",
        accent: BURGUNDY_LIFTED,
        glowAlpha: "59",
      };
}

/** Minimal satori-compatible node (cast to satori's ReactNode at the call site). */
export interface CardNode {
  type: string;
  props: {
    style?: Record<string, unknown>;
    children?: (CardNode | string)[] | CardNode | string;
    [key: string]: unknown;
  };
}

/** Rasterized brand mark with its real, alpha-trimmed pixel size. */
export interface LogoMark {
  png: Buffer;
  width: number;
  height: number;
}

function el(
  type: string,
  style: Record<string, unknown>,
  children?: (CardNode | string)[] | CardNode | string,
  extra?: Record<string, unknown>,
): CardNode {
  return {
    type,
    props: { style: { display: "flex", ...style }, ...(extra ?? {}), ...(children !== undefined ? { children } : {}) },
  };
}

function dataUri(buffer: Buffer): string {
  return `data:image/png;base64,${buffer.toString("base64")}`;
}

/* ------------------------------------------------------------------ */
/* The polaroid frame — the family's constant                          */
/* ------------------------------------------------------------------ */

/** Inner picture area. Every emblem below fills exactly this box. */
const PHOTO_W = 268;
const PHOTO_H = 324;

function polaroid(children: CardNode): CardNode {
  return el(
    "div",
    {
      flexDirection: "column",
      padding: "14px 14px 54px 14px",
      borderRadius: "10px",
      backgroundColor: "#FFFFFF",
      transform: "rotate(-5deg)",
      boxShadow: "0 30px 70px rgba(0,0,0,0.45)",
    },
    [children],
  );
}

function photoInner(photo: Buffer): CardNode {
  return el(
    "img",
    { width: `${PHOTO_W}px`, height: `${PHOTO_H}px`, objectFit: "cover", borderRadius: "4px" },
    undefined,
    { src: dataUri(photo) },
  );
}

/**
 * "Not now, but soon" — a clock reading 3 o'clock, drawn from divs.
 *
 * The hands point straight up and straight right SPECIFICALLY so no rotation is
 * needed: satori rotates an element about its own centre, which cannot pivot a
 * hand around the dial's centre, so any other hour would need a transform-origin
 * satori doesn't fully honour.
 */
function clockInner(accent: string): CardNode {
  const ringBorder = 10;
  const dial = 148;
  // `position: absolute` offsets are measured from the parent's padding edge,
  // i.e. INSIDE the ring's own border — so the usable dial is the content box.
  const inner = dial - ringBorder * 2;
  const c = inner / 2;
  return el(
    "div",
    {
      width: `${PHOTO_W}px`,
      height: `${PHOTO_H}px`,
      borderRadius: "4px",
      alignItems: "center",
      justifyContent: "center",
      backgroundImage: "linear-gradient(160deg, #F6EAEC 0%, #E7D2D7 100%)",
    },
    [
      el(
        "div",
        {
          position: "relative",
          width: `${dial}px`,
          height: `${dial}px`,
          borderRadius: "999px",
          border: `${ringBorder}px solid ${accent}`,
        },
        [
          // Minute hand → 12.
          el("div", {
            position: "absolute",
            left: `${c - 4.5}px`,
            top: `${c - 44}px`,
            width: "9px",
            height: "44px",
            borderRadius: "5px",
            backgroundColor: accent,
          }),
          // Hour hand → 3.
          el("div", {
            position: "absolute",
            left: `${c}px`,
            top: `${c - 4.5}px`,
            width: "36px",
            height: "9px",
            borderRadius: "5px",
            backgroundColor: accent,
          }),
          el("div", {
            position: "absolute",
            left: `${c - 8}px`,
            top: `${c - 8}px`,
            width: "16px",
            height: "16px",
            borderRadius: "999px",
            backgroundColor: accent,
          }),
        ],
      ),
    ],
  );
}

/**
 * The withheld portrait: a burgundy halftone field where the face would be,
 * with the brand mark reading through it. Dots are emitted as divs because
 * satori supports neither `background-repeat` nor `background-size` well enough
 * to tile a pattern.
 */
function redactedInner(logo: LogoMark | null): CardNode {
  const dots: CardNode[] = [];
  const step = 24;
  let row = 0;
  for (let y = 14; y < PHOTO_H - 6; y += step) {
    const offset = row % 2 === 0 ? 0 : step / 2;
    for (let x = 14 + offset; x < PHOTO_W - 6; x += step) {
      dots.push(
        el("div", {
          position: "absolute",
          left: `${x}px`,
          top: `${y}px`,
          width: "6px",
          height: "6px",
          borderRadius: "999px",
          backgroundColor: "rgba(247,236,236,0.22)",
        }),
      );
    }
    row++;
  }

  const markW = 132;
  const mark = logo
    ? [
        el(
          "img",
          {
            position: "absolute",
            left: `${Math.round((PHOTO_W - markW) / 2)}px`,
            top: `${Math.round((PHOTO_H - markW * (logo.height / logo.width)) / 2)}px`,
            width: `${markW}px`,
            height: `${Math.round(markW * (logo.height / logo.width))}px`,
            opacity: 0.85,
          },
          undefined,
          { src: dataUri(logo.png) },
        ),
      ]
    : [];

  return el(
    "div",
    {
      position: "relative",
      width: `${PHOTO_W}px`,
      height: `${PHOTO_H}px`,
      borderRadius: "4px",
      backgroundImage: "linear-gradient(150deg, #2A0E17 0%, #6E1B2E 100%)",
    },
    [...dots, ...mark],
  );
}

/* ------------------------------------------------------------------ */
/* The card                                                            */
/* ------------------------------------------------------------------ */

export interface CoordCardElementInput {
  variant: CoordCardVariant;
  copy: CoordCardCopy;
  /** Profile photo PNG for the photo variants; null → the frame stays empty. */
  photo: Buffer | null;
  /** Brand butterfly, tinted for the header lockup. */
  logo: LogoMark | null;
  /** Brand butterfly tinted cream, for the redacted (`proxy`) frame. */
  logoCream: LogoMark | null;
  /** Film-grain overlay tile (full-card PNG); dark theme only. */
  grain: Buffer | null;
  /** `@handle` pill under the headline — the `shared` variant's payload. */
  handle: string | null;
  /** Display family for the headline (Latin vs Cyrillic — see index.ts). */
  headlineFamily: string;
  theme: CoordCardTheme;
}

export function buildCoordCardElement(input: CoordCardElementInput): CardNode {
  const p = palette(input.theme);
  const centered = { width: "100%", justifyContent: "center", textAlign: "center" } as const;

  const frameContent =
    input.variant === "declined"
      ? clockInner(BURGUNDY)
      : input.variant === "proxy"
        ? redactedInner(input.logoCream)
        : input.photo
          ? photoInner(input.photo)
          : // No photo available for a photo variant: keep the frame, fill it with
            // the brand ground rather than collapsing the layout.
            el("div", {
              width: `${PHOTO_W}px`,
              height: `${PHOTO_H}px`,
              borderRadius: "4px",
              backgroundImage: `linear-gradient(150deg, #2A0E17 0%, ${BURGUNDY} 100%)`,
            });

  // The mark keeps its natural aspect ratio — a square box squishes the
  // butterfly (the source SVG's canvas is square with transparent margins,
  // which `butterflyPng` alpha-trims away).
  const markH = 52;
  const markW = input.logo ? Math.round((input.logo.width / input.logo.height) * markH) : markH;

  return el(
    "div",
    {
      position: "relative",
      flexDirection: "column",
      alignItems: "center",
      width: `${CARD_W}px`,
      height: `${CARD_H}px`,
      padding: "64px 72px 72px 72px",
      backgroundImage: p.bg,
      fontFamily: "Roboto",
      color: p.ink,
    },
    [
      ...(input.grain
        ? [
            el(
              "img",
              {
                position: "absolute",
                top: 0,
                left: 0,
                width: `${CARD_W}px`,
                height: `${CARD_H}px`,
                opacity: 0.5,
              },
              undefined,
              { src: dataUri(input.grain) },
            ),
          ]
        : []),

      // --- Brand lockup: butterfly + wordmark, side by side. ---
      el("div", { alignItems: "center" }, [
        ...(input.logo
          ? [
              el(
                "img",
                { width: `${markW}px`, height: `${markH}px`, marginRight: "16px" },
                undefined,
                { src: dataUri(input.logo.png) },
              ),
            ]
          : []),
        el(
          "div",
          { fontFamily: "Archivo Black", fontSize: "34px", letterSpacing: "-1px", color: p.ink },
          "Gennety",
        ),
      ]),

      el("div", { flexGrow: 1, minHeight: "24px" }),

      // --- Polaroid, with a soft burgundy glow behind it. ---
      el(
        "div",
        { position: "relative", alignItems: "center", justifyContent: "center" },
        [
          el("div", {
            position: "absolute",
            left: "-124px",
            top: "-46px",
            width: "560px",
            height: "480px",
            borderRadius: "999px",
            backgroundImage: `radial-gradient(closest-side, ${BURGUNDY}${p.glowAlpha}, rgba(139,37,59,0))`,
          }),
          polaroid(frameContent),
        ],
      ),

      el("div", { flexGrow: 1, minHeight: "40px" }),

      // --- Kicker → headline → optional handle pill. ---
      el(
        "div",
        {
          ...centered,
          fontSize: "24px",
          fontWeight: 700,
          letterSpacing: "4px",
          color: p.accent,
        },
        input.copy.kicker,
      ),
      el(
        "div",
        {
          width: "100%",
          flexDirection: "column",
          alignItems: "center",
          marginTop: "18px",
          fontFamily: input.headlineFamily,
          fontSize: "58px",
          lineHeight: 1.06,
          letterSpacing: "-1px",
        },
        [
          el("div", { ...centered, color: p.ink }, input.copy.head[0]),
          el("div", { ...centered, color: p.accent }, input.copy.head[1]),
        ],
      ),
      ...(input.handle
        ? [
            el(
              "div",
              {
                marginTop: "26px",
                alignItems: "center",
                justifyContent: "center",
                padding: "16px 34px",
                borderRadius: "999px",
                backgroundColor: `${BURGUNDY_LIFTED}2E`,
                border: `2px solid ${BURGUNDY_LIFTED}73`,
                fontSize: "32px",
                fontWeight: 700,
                color: p.ink,
              },
              input.handle,
            ),
          ]
        : []),

      el("div", { flexGrow: 1, minHeight: "28px" }),

      el(
        "div",
        {
          ...centered,
          maxWidth: "660px",
          fontSize: "27px",
          lineHeight: 1.4,
          color: p.muted,
        },
        input.copy.sub,
      ),
    ],
  );
}
