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

export type MatchCardTheme = "light" | "dark";

interface PaperPalette {
  cardBg: string;
  panelBg: string;
  /** Name + tagline ink. */
  name: string;
  body: string;
  /** The neutral halftone-dot cluster (dark on the light card, light on dark). */
  dotNeutral: string;
}

/**
 * The paper card set is a light "torn polaroid" design; this maps it onto the
 * recipient's theme (the burgundy accent, the white photo frames and the wine
 * dots stay — only the card/panel surfaces + text ink flip).
 */
export function paperPalette(theme: MatchCardTheme): PaperPalette {
  return theme === "dark"
    ? { cardBg: "#0A0A0A", panelBg: "#17171A", name: "#F2EFF7", body: BODY_SOFT, dotNeutral: SOFT }
    : { cardBg: SOFT, panelBg: "#FFFFFF", name: GRAPHITE, body: BODY_INK, dotNeutral: GRAPHITE };
}

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
  taglineSize?: number;
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
        fontSize: `${s.taglineSize ?? 30}px`,
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
/* Variant: paper — torn polaroid collage, sent as a SET of cards.     */
/* Every card carries TWO tilted photos at (near-)native aspect — no   */
/* harsh crops. An odd photo count leaves the final card with ONE      */
/* photo, and that card takes the text panel (it has the room); an     */
/* even count puts the panel on the first card. The panel never sits   */
/* on a person: photos are laid out to keep faces clear of it.         */
/* ------------------------------------------------------------------ */

function brandSignature(layers: CardLayers, texts: MatchCardTexts): CardNode {
  return el(
    "div",
    { display: "flex", alignItems: "center", gap: "10px", marginTop: "26px", alignSelf: "flex-end" },
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

interface PanelGeom {
  left: number;
  top: number;
  width: number;
  padding: string;
  nameSize: number;
  bodySize: number;
  textWidth: number;
}

function paperPanel(
  texts: MatchCardTexts,
  layers: CardLayers,
  geom: PanelGeom,
  pal: PaperPalette,
): CardNode {
  return el(
    "div",
    {
      display: "flex",
      flexDirection: "column",
      position: "absolute",
      left: `${geom.left}px`,
      top: `${geom.top}px`,
      width: `${geom.width}px`,
      padding: geom.padding,
      backgroundColor: pal.panelBg,
      borderRadius: "28px",
      boxShadow: "0 24px 60px rgba(0,0,0,0.34)",
    },
    [
      ...textBlock(texts, {
        eyebrowColor: WINE,
        nameColor: pal.name,
        taglineColor: pal.name,
        bodyColor: pal.body,
        nameSize: geom.nameSize,
        bodySize: geom.bodySize,
        taglineSize: 26,
        width: geom.textWidth,
      }),
      brandSignature(layers, texts),
    ],
  );
}

/** Two tilted polaroids per card; `withPanel` compacts them to clear the panel. */
export function paperDuoCard(
  texts: MatchCardTexts,
  layers: CardLayers,
  withPanel: boolean,
  pal: PaperPalette,
): CardNode {
  return el(
    "div",
    { display: "flex", width: `${CARD_W}px`, height: `${CARD_H}px`, backgroundColor: pal.cardBg },
    [
      fullBleed(layers.collage),
      ...(withPanel
        ? [
            paperPanel(
              texts,
              layers,
              {
                left: 60,
                top: 780,
                width: 480,
                padding: "38px 42px 34px 42px",
                nameSize: 46,
                bodySize: 23,
                textWidth: 396,
              },
              pal,
            ),
          ]
        : []),
      ...(layers.grain ? [fullBleed(layers.grain)] : []),
    ],
  );
}

/** Final odd card: one tilted photo on top, the text panel standing below it. */
export function paperSoloCard(
  texts: MatchCardTexts,
  layers: CardLayers,
  pal: PaperPalette,
): CardNode {
  return el(
    "div",
    { display: "flex", width: `${CARD_W}px`, height: `${CARD_H}px`, backgroundColor: pal.cardBg },
    [
      fullBleed(layers.collage),
      paperPanel(
        texts,
        layers,
        {
          left: 90,
          top: 985,
          width: 900,
          padding: "40px 46px 34px 46px",
          nameSize: 50,
          bodySize: 24,
          textWidth: 808,
        },
        pal,
      ),
      ...(layers.grain ? [fullBleed(layers.grain)] : []),
    ],
  );
}

/**
 * Two-photo collage: staggered diagonal polaroids at near-native 4:5 aspect
 * (no harsh crops), tilted a few degrees. The `withPanel` variant compacts
 * both photos upward/rightward so the bottom-left panel never covers a face.
 */
export function paperDuoSpec(withPanel: boolean, dotNeutral: string = GRAPHITE): CollageSpec {
  const base = { cutout: { paper: "#FFFFFF", border: 15, tearAmp: 11, focusY: 0.24 } };
  if (withPanel) {
    return {
      ...base,
      slots: [
        { cx: 330, cy: 375, w: 580, h: 720, angle: -4.5 },
        { cx: 765, cy: 865, w: 580, h: 720, angle: 3.5 },
      ],
      dots: [
        { x: 800, y: 120, cols: 5, rows: 4, r: 5, gap: 24, color: WINE, alpha: 0.45 },
        { x: 930, y: 1290, cols: 4, rows: 2, r: 5, gap: 24, color: dotNeutral, alpha: 0.3 },
      ],
      butterflies: [
        { cx: 985, cy: 235, size: 96, angle: -14, alpha: 1 },
        { cx: 1006, cy: 545, size: 58, angle: 18, alpha: 0.85, tint: "#FFFFFF", above: true },
      ],
    };
  }
  return {
    ...base,
    slots: [
      { cx: 350, cy: 420, w: 640, h: 800, angle: -5 },
      { cx: 730, cy: 930, w: 640, h: 800, angle: 4 },
    ],
    dots: [
      { x: 830, y: 120, cols: 5, rows: 4, r: 5, gap: 24, color: WINE, alpha: 0.45 },
      { x: 90, y: 1120, cols: 4, rows: 4, r: 5, gap: 24, color: dotNeutral, alpha: 0.3 },
    ],
    butterflies: [
      { cx: 955, cy: 295, size: 96, angle: -14, alpha: 1 },
      { cx: 150, cy: 1005, size: 62, angle: 16, alpha: 0.6, tint: WINE },
      { cx: 82, cy: 782, size: 54, angle: -18, alpha: 0.7, tint: "#FFFFFF", above: true },
    ],
  };
}

/** Single-photo collage for the odd final card: photo on top, panel space below. */
export function paperSoloSpec(dotNeutral: string = GRAPHITE): CollageSpec {
  return {
    cutout: { paper: "#FFFFFF", border: 15, tearAmp: 11, focusY: 0.24 },
    slots: [{ cx: 555, cy: 480, w: 750, h: 940, angle: -3 }],
    dots: [
      { x: 66, y: 210, cols: 3, rows: 5, r: 5, gap: 24, color: WINE, alpha: 0.45 },
      { x: 964, y: 700, cols: 3, rows: 4, r: 5, gap: 24, color: dotNeutral, alpha: 0.3 },
    ],
    butterflies: [
      { cx: 1002, cy: 130, size: 100, angle: -14, alpha: 1 },
      { cx: 238, cy: 905, size: 58, angle: 18, alpha: 0.8, tint: "#FFFFFF", above: true },
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
      return paperSoloSpec();
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
      return paperSoloCard(texts, layers, paperPalette("light"));
    case "graphite":
      return graphiteCard(texts, layers);
    case "wine":
      return wineCard(texts, layers);
  }
}
