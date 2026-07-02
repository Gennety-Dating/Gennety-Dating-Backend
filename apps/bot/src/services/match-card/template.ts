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
import { CARD_W, CARD_H, type ButterflyMark, type CollageSpec } from "./collage.js";

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
  /** Alpha-trimmed butterfly mark (real aspect ratio) for wordmark rows. Optional. */
  butterfly: ButterflyMark | null;
}

/** Butterfly <img> sized by display height, preserving the mark's real ratio. */
function butterflyImg(mark: ButterflyMark, displayH: number): CardNode {
  const w = Math.round((mark.width / mark.height) * displayH);
  return el("img", { width: `${w}px`, height: `${displayH}px` }, undefined, {
    src: dataUri(mark.png),
    width: w,
    height: displayH,
  });
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
  if (layers.butterfly) children.push(butterflyImg(layers.butterfly, 38));
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
  // No eyebrow copy → a short wine accent bar keeps the top of the panel
  // composed without extra words.
  const lead = texts.eyebrow
    ? el(
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
      )
    : el("div", {
        display: "flex",
        width: "68px",
        height: "8px",
        borderRadius: "4px",
        backgroundColor: s.eyebrowColor,
      });
  const nodes: CardNode[] = [
    lead,
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
/* Variant: paper — photo-first torn collage, sent as a SET of cards.  */
/* Card 1 (lead): two photos + the opaque rounded text panel.          */
/* Cards 2+ (gallery): photos only, small brand pill, no copy.         */
/* ------------------------------------------------------------------ */

function brandSignature(layers: CardLayers, texts: MatchCardTexts): CardNode {
  return el(
    "div",
    { display: "flex", alignItems: "center", gap: "10px", marginTop: "30px", alignSelf: "flex-end" },
    [
      ...(layers.butterfly ? [butterflyImg(layers.butterfly, 26)] : []),
      el(
        "div",
        { display: "flex", fontFamily: "Unbounded", fontSize: "21px", fontWeight: 700, color: WINE },
        texts.wordmark,
      ),
    ],
  );
}

function paperCard(texts: MatchCardTexts, layers: CardLayers): CardNode {
  return el(
    "div",
    { display: "flex", width: `${CARD_W}px`, height: `${CARD_H}px`, backgroundColor: SOFT },
    [
      fullBleed(layers.collage),
      el(
        "div",
        {
          display: "flex",
          flexDirection: "column",
          position: "absolute",
          left: "70px",
          top: "470px",
          width: "500px",
          padding: "44px 46px 38px 46px",
          backgroundColor: "#FFFFFF",
          borderRadius: "28px",
          boxShadow: "0 24px 60px rgba(17,17,17,0.26)",
        },
        [
          ...textBlock(texts, {
            eyebrowColor: WINE,
            nameColor: GRAPHITE,
            taglineColor: GRAPHITE,
            bodyColor: BODY_INK,
            nameSize: 54,
            bodySize: 24,
            width: 408,
          }),
          brandSignature(layers, texts),
        ],
      ),
      ...(layers.grain ? [fullBleed(layers.grain)] : []),
    ],
  );
}

/** Photos-only follow-up card: full-bleed collage + a small brand pill. */
export function paperGalleryCard(texts: MatchCardTexts, layers: CardLayers): CardNode {
  return el(
    "div",
    { display: "flex", width: `${CARD_W}px`, height: `${CARD_H}px`, backgroundColor: SOFT },
    [
      fullBleed(layers.collage),
      el(
        "div",
        {
          display: "flex",
          alignItems: "center",
          gap: "10px",
          position: "absolute",
          right: "44px",
          bottom: "44px",
          padding: "12px 22px",
          backgroundColor: "#FFFFFF",
          borderRadius: "999px",
          boxShadow: "0 12px 32px rgba(17,17,17,0.28)",
        },
        [
          ...(layers.butterfly ? [butterflyImg(layers.butterfly, 24)] : []),
          el(
            "div",
            { display: "flex", fontFamily: "Unbounded", fontSize: "19px", fontWeight: 700, color: WINE },
            texts.wordmark,
          ),
        ],
      ),
      ...(layers.grain ? [fullBleed(layers.grain)] : []),
    ],
  );
}

/** Lead-card collage: one or two near-full-bleed torn photos around the panel. */
export function paperLeadSpec(photoCount: number): CollageSpec {
  const base = { cutout: { paper: "#FFFFFF", border: 15, tearAmp: 11, focusY: 0.24 } };
  if (photoCount <= 1) {
    return {
      ...base,
      // Photo shifted right so the face clears the text panel on the left.
      slots: [{ cx: 700, cy: 675, w: 940, h: 1360, angle: -2 }],
      dots: [{ x: 46, y: 290, cols: 3, rows: 6, r: 5, gap: 22, color: WINE, alpha: 0.45 }],
      butterflies: [
        { cx: 1004, cy: 140, size: 110, angle: -14, alpha: 1, above: true },
        { cx: 150, cy: 1280, size: 64, angle: 18, alpha: 0.85, tint: "#FFFFFF", above: true },
      ],
    };
  }
  return {
    ...base,
    slots: [
      { cx: 620, cy: 320, w: 1010, h: 650, angle: -3, focusY: 0.4 },
      { cx: 640, cy: 1040, w: 1010, h: 640, angle: 2.5, focusY: 0.34 },
    ],
    dots: [
      { x: 700, y: 664, cols: 8, rows: 3, r: 5, gap: 24, color: WINE, alpha: 0.5 },
      { x: 42, y: 1050, cols: 3, rows: 5, r: 5, gap: 22, color: GRAPHITE, alpha: 0.32 },
    ],
    butterflies: [
      { cx: 156, cy: 66, size: 104, angle: -14, alpha: 1, above: true },
      { cx: 1002, cy: 1298, size: 64, angle: 18, alpha: 0.85, tint: "#FFFFFF", above: true },
      { cx: 46, cy: 700, size: 54, angle: -20, alpha: 0.5, tint: WINE },
    ],
  };
}

/** Gallery-card collage: photos own the whole frame. */
export function paperGallerySpec(photoCount: number): CollageSpec {
  const base = { cutout: { paper: "#FFFFFF", border: 15, tearAmp: 11, focusY: 0.24 } };
  if (photoCount <= 1) {
    return {
      ...base,
      slots: [{ cx: 540, cy: 675, w: 1110, h: 1400, angle: -1.5 }],
      dots: [],
      butterflies: [
        { cx: 990, cy: 120, size: 96, angle: -14, alpha: 1, above: true },
        { cx: 80, cy: 1240, size: 64, angle: 18, alpha: 0.85, tint: "#FFFFFF", above: true },
      ],
    };
  }
  return {
    ...base,
    slots: [
      { cx: 505, cy: 350, w: 1070, h: 705, angle: -2.5, focusY: 0.3 },
      { cx: 575, cy: 1030, w: 1070, h: 685, angle: 3, focusY: 0.4 },
    ],
    dots: [{ x: 40, y: 726, cols: 4, rows: 3, r: 5, gap: 24, color: WINE, alpha: 0.45 }],
    butterflies: [
      { cx: 1008, cy: 96, size: 92, angle: -14, alpha: 1, above: true },
      { cx: 72, cy: 1312, size: 60, angle: 18, alpha: 0.85, tint: "#FFFFFF", above: true },
    ],
  };
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
      return paperLeadSpec(2);
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
