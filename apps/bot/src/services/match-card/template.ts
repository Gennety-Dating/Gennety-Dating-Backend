/**
 * Match-card layout — plain satori element trees (no JSX), one builder per
 * design variant. All photographic work (torn cutouts, shadows, butterflies,
 * halftone dots, the wine variant's torn sheet) is baked upstream into a
 * single transparent collage PNG by collage.ts; this file only stacks flat
 * layers and typography.
 *
 * Brand palette (finalized 2026-07-02): graphite #111111, deep wine #8B253B,
 * soft white #F5F5F5. Headlines use Unbounded (Cyrillic + Latin subsets are
 * bundled); body is Roboto. Card text stays emoji-free — the bundled fonts
 * have no color-emoji glyphs and satori would drop them.
 */
import { CARD_W, CARD_H, type CollageSpec } from "./collage.js";

export const GRAPHITE = "#111111";
export const WINE = "#8B253B";
export const SOFT = "#F5F5F5";
const BODY_INK = "#3B3538";
const BODY_SOFT = "#CFC7CA";

export type MatchCardVariant = "paper" | "graphite" | "wine";

export const MATCH_CARD_VARIANTS: readonly MatchCardVariant[] = ["paper", "graphite", "wine"];

export interface MatchCardTexts {
  /** Small caps lead-in, e.g. «Твоё свидание с». */
  eyebrow: string;
  /** Display name (inflected to follow the eyebrow), e.g. «Марком». */
  name: string;
  /** Bold hook line, carries name + age in nominative. */
  tagline: string;
  /** 1–3 short body paragraphs from the pitch generator. */
  paragraphs: string[];
  wordmark: string;
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

function el(
  type: string,
  style: Record<string, unknown>,
  children?: (CardNode | string)[] | CardNode | string,
  extra?: Record<string, unknown>,
): CardNode {
  return { type, props: { style, ...(extra ?? {}), ...(children !== undefined ? { children } : {}) } };
}

function dataUri(buffer: Buffer): string {
  return `data:image/png;base64,${buffer.toString("base64")}`;
}

export interface CardLayers {
  /** Full-card transparent collage PNG (photos + accents). */
  collage: Buffer;
  /** Film-grain overlay tile. Optional. */
  grain: Buffer | null;
  /** Small butterfly mark for the wordmark row. Optional. */
  butterfly: Buffer | null;
}

function fullBleed(buffer: Buffer): CardNode {
  return el(
    "img",
    { position: "absolute", top: 0, left: 0, width: `${CARD_W}px`, height: `${CARD_H}px` },
    undefined,
    { src: dataUri(buffer), width: CARD_W, height: CARD_H },
  );
}

function wordmark(layers: CardLayers, texts: MatchCardTexts, ink: string, pos: Record<string, unknown>): CardNode {
  const children: (CardNode | string)[] = [];
  if (layers.butterfly) {
    children.push(
      el("img", { width: "54px", height: "44px" }, undefined, {
        src: dataUri(layers.butterfly),
        width: 54,
        height: 44,
      }),
    );
  }
  children.push(
    el(
      "div",
      { display: "flex", fontFamily: "Unbounded", fontSize: "30px", fontWeight: 700, color: ink, letterSpacing: "1px" },
      texts.wordmark,
    ),
  );
  return el("div", { display: "flex", position: "absolute", alignItems: "center", gap: "14px", ...pos }, children);
}

interface TextBlockStyle {
  eyebrowColor: string;
  nameColor: string;
  taglineColor: string;
  bodyColor: string;
  nameSize: number;
  bodySize: number;
  width: number;
}

function textBlock(texts: MatchCardTexts, s: TextBlockStyle): CardNode[] {
  const nodes: CardNode[] = [
    el(
      "div",
      {
        display: "flex",
        fontFamily: "Roboto",
        fontWeight: 700,
        fontSize: "23px",
        letterSpacing: "4px",
        textTransform: "uppercase",
        color: s.eyebrowColor,
      },
      texts.eyebrow,
    ),
    el(
      "div",
      {
        display: "flex",
        fontFamily: "Unbounded",
        fontWeight: 700,
        fontSize: `${s.nameSize}px`,
        color: s.nameColor,
        marginTop: "10px",
        lineHeight: 1.1,
      },
      texts.name,
    ),
    el(
      "div",
      {
        display: "flex",
        fontFamily: "Roboto",
        fontWeight: 700,
        fontSize: "30px",
        lineHeight: 1.3,
        color: s.taglineColor,
        marginTop: "26px",
        width: `${s.width}px`,
      },
      texts.tagline,
    ),
  ];
  for (const p of texts.paragraphs) {
    nodes.push(
      el(
        "div",
        {
          display: "flex",
          fontFamily: "Roboto",
          fontWeight: 400,
          fontSize: `${s.bodySize}px`,
          lineHeight: 1.42,
          color: s.bodyColor,
          marginTop: "20px",
          width: `${s.width}px`,
        },
        p,
      ),
    );
  }
  return nodes;
}

/* ------------------------------------------------------------------ */
/* Variant: paper — soft-white zine collage, clean white text panel    */
/* ------------------------------------------------------------------ */

function paperCard(texts: MatchCardTexts, layers: CardLayers): CardNode {
  return el(
    "div",
    { display: "flex", width: `${CARD_W}px`, height: `${CARD_H}px`, backgroundColor: SOFT },
    [
      fullBleed(layers.collage),
      wordmark(layers, texts, GRAPHITE, { top: "44px", right: "56px" }),
      el(
        "div",
        {
          display: "flex",
          flexDirection: "column",
          position: "absolute",
          left: "80px",
          top: "340px",
          width: "600px",
          padding: "52px 54px 56px 54px",
          backgroundColor: "#FFFFFF",
          borderRadius: "6px",
          boxShadow: "0 24px 60px rgba(17,17,17,0.20)",
        },
        textBlock(texts, {
          eyebrowColor: WINE,
          nameColor: GRAPHITE,
          taglineColor: GRAPHITE,
          bodyColor: BODY_INK,
          nameSize: 66,
          bodySize: 26,
          width: 492,
        }),
      ),
      ...(layers.grain ? [fullBleed(layers.grain)] : []),
    ],
  );
}

/* ------------------------------------------------------------------ */
/* Variant: graphite — dark editorial, full-bleed hero, centered text  */
/* ------------------------------------------------------------------ */

function graphiteCard(texts: MatchCardTexts, layers: CardLayers): CardNode {
  return el(
    "div",
    { display: "flex", width: `${CARD_W}px`, height: `${CARD_H}px`, backgroundColor: GRAPHITE },
    [
      fullBleed(layers.collage),
      // Fade the hero photo into the graphite field so text sits on solid ink.
      el("div", {
        display: "flex",
        position: "absolute",
        left: 0,
        top: "380px",
        width: `${CARD_W}px`,
        height: "300px",
        backgroundImage: "linear-gradient(180deg, rgba(17,17,17,0) 0%, #111111 94%)",
      }),
      wordmark(layers, texts, SOFT, { top: "44px", left: "56px" }),
      el(
        "div",
        {
          display: "flex",
          flexDirection: "column",
          position: "absolute",
          left: "260px",
          top: "655px",
          width: "560px",
          alignItems: "center",
          textAlign: "center",
        },
        textBlock(texts, {
          eyebrowColor: "#C86478",
          nameColor: SOFT,
          taglineColor: SOFT,
          bodyColor: BODY_SOFT,
          nameSize: 72,
          bodySize: 25,
          width: 560,
        }),
      ),
      ...(layers.grain ? [fullBleed(layers.grain)] : []),
    ],
  );
}

/* ------------------------------------------------------------------ */
/* Variant: wine — deep wine field, torn white letter, photos around   */
/* ------------------------------------------------------------------ */

function wineCard(texts: MatchCardTexts, layers: CardLayers): CardNode {
  return el(
    "div",
    {
      display: "flex",
      width: `${CARD_W}px`,
      height: `${CARD_H}px`,
      backgroundColor: WINE,
      backgroundImage: "radial-gradient(circle at 28% 18%, #A23350 0%, #8B253B 42%, #4A101F 100%)",
    },
    [
      fullBleed(layers.collage),
      wordmark(layers, texts, SOFT, { top: "40px", left: "0px", right: "0px", justifyContent: "center" }),
      el(
        "div",
        {
          display: "flex",
          flexDirection: "column",
          position: "absolute",
          left: "170px",
          top: "460px",
          width: "740px",
        },
        textBlock(texts, {
          eyebrowColor: WINE,
          nameColor: GRAPHITE,
          taglineColor: GRAPHITE,
          bodyColor: BODY_INK,
          nameSize: 64,
          bodySize: 25,
          width: 740,
        }),
      ),
      ...(layers.grain ? [fullBleed(layers.grain)] : []),
    ],
  );
}

/* ------------------------------------------------------------------ */
/* Collage specs per variant                                           */
/* ------------------------------------------------------------------ */

export function collageSpecFor(variant: MatchCardVariant): CollageSpec {
  switch (variant) {
    case "paper":
      return {
        cutout: { paper: "#FFFFFF", border: 15, tearAmp: 11, focusY: 0.24 },
        slots: [
          { cx: 250, cy: 165, w: 500, h: 400, angle: -4.5 },
          { cx: 880, cy: 470, w: 400, h: 600, angle: 3 },
          { cx: 205, cy: 1140, w: 440, h: 420, angle: 4 },
          { cx: 815, cy: 1160, w: 500, h: 390, angle: -3 },
        ],
        dots: [
          { x: 580, y: 90, cols: 7, rows: 4, r: 5, gap: 24, color: WINE, alpha: 0.5 },
          { x: 60, y: 890, cols: 4, rows: 6, r: 5, gap: 24, color: GRAPHITE, alpha: 0.35 },
          { x: 850, y: 830, cols: 6, rows: 3, r: 5, gap: 24, color: WINE, alpha: 0.45 },
        ],
        butterflies: [
          { cx: 742, cy: 302, size: 128, angle: -14, alpha: 1, above: true },
          { cx: 64, cy: 306, size: 72, angle: 16, alpha: 0.9, above: true },
          { cx: 545, cy: 242, size: 56, angle: -20, alpha: 0.35, tint: WINE },
        ],
      };
    case "graphite":
      return {
        cutout: { paper: "#FFFFFF", border: 16, tearAmp: 11, focusY: 0.24, shadow: "rgba(0,0,0,0.55)" },
        slots: [
          { cx: 540, cy: 320, w: 1080, h: 640, angle: 0, straight: true, border: 0, focusY: 0.46 },
          { cx: 100, cy: 1265, w: 320, h: 310, angle: 5 },
          { cx: 980, cy: 1270, w: 330, h: 320, angle: -4 },
        ],
        dots: [
          { x: 70, y: 760, cols: 5, rows: 4, r: 5, gap: 24, color: SOFT, alpha: 0.28 },
          { x: 890, y: 840, cols: 5, rows: 3, r: 5, gap: 24, color: "#C86478", alpha: 0.5 },
        ],
        butterflies: [
          { cx: 985, cy: 74, size: 118, angle: 12, alpha: 1, above: true },
          { cx: 108, cy: 930, size: 66, angle: -16, alpha: 0.55, tint: "#C86478" },
        ],
      };
    case "wine":
      return {
        cutout: { paper: "#FFFFFF", border: 15, tearAmp: 11, focusY: 0.24, shadow: "rgba(30,4,12,0.5)" },
        slots: [
          { cx: 205, cy: 195, w: 410, h: 370, angle: -4 },
          { cx: 855, cy: 180, w: 400, h: 340, angle: 3.5 },
          { cx: 225, cy: 1165, w: 430, h: 360, angle: 3 },
          { cx: 845, cy: 1175, w: 440, h: 380, angle: -4.5 },
        ],
        dots: [
          { x: 490, y: 300, cols: 6, rows: 3, r: 5, gap: 24, color: SOFT, alpha: 0.4 },
          { x: 80, y: 1000, cols: 4, rows: 3, r: 5, gap: 24, color: SOFT, alpha: 0.35 },
        ],
        butterflies: [
          { cx: 952, cy: 972, size: 78, angle: 18, alpha: 0.3, tint: WINE, above: true },
          { cx: 130, cy: 452, size: 60, angle: -22, alpha: 0.25, tint: WINE, above: true },
        ],
        panel: { x: 100, y: 400, w: 880, h: 640, paper: "#FDFCFB", tearAmp: 16 },
      };
  }
}

export function buildMatchCardElement(
  variant: MatchCardVariant,
  texts: MatchCardTexts,
  layers: CardLayers,
): CardNode {
  switch (variant) {
    case "paper":
      return paperCard(texts, layers);
    case "graphite":
      return graphiteCard(texts, layers);
    case "wine":
      return wineCard(texts, layers);
  }
}
