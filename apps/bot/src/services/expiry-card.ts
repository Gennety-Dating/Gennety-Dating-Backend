/**
 * Expiry card (PRODUCT_SPEC §3.4) — the PNG that accompanies the "your 24h
 * decision window closed" DM.
 *
 * Why it exists: the expiry notice is one of the few genuinely emotional beats
 * in the product (you ghosted someone who said yes; someone ghosted you), and
 * it was the driest surface we ship — a bare `sendMessage` with no visual at
 * all. The card gives the moment a face without adding any state: it is a pure
 * layout + rasterize (tens of ms, no network, no photos), so callers need no
 * "working…" status beat and nothing can wedge the expiry sweep.
 *
 * Four variants, one per branch of §3.4's asymmetry, each with its own vector
 * motif so the scenario is legible before a single word is read:
 *   - `expired`      — you stayed silent, first offence (warning only)
 *   - `penalty`      — you stayed silent again, Elo actually dropped
 *   - `peer_ignored` — you answered, your match never did
 *   - `missed_date`  — you stayed silent AND they had accepted (the real loss)
 *
 * DELIBERATELY photo-free. The partner's photos are `protect_content` wherever
 * they appear with a clear face (§3.7a), and re-surfacing them on a terminal
 * match would be both a privacy step backwards and a network dependency on a
 * path that must never fail. The motifs carry the emotion instead.
 *
 * Rendered text is emoji-free: the bundled fonts carry no color-emoji glyphs
 * and satori drops them. Emoji live in the Telegram caption instead.
 *
 * Never throws — returns `null` on any failure so the caller degrades to the
 * plain text notice that ships today.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import satori from "satori";
import { Resvg } from "@resvg/resvg-js";
import { butterflyPng, type ButterflyMark } from "./match-card/collage.js";
import { grainPng } from "./date-card/image.js";

/** Square poster: dominant enough for an emotional beat, lighter than the 1350 keepsake date card. */
export const EXPIRY_CARD_W = 1080;
export const EXPIRY_CARD_H = 1080;

export type ExpiryCardTheme = "light" | "dark";

export type ExpiryCardVariant = "expired" | "penalty" | "peer_ignored" | "missed_date";

interface Palette {
  bg: string;
  ink: string;
  muted: string;
  accent: string;
}

/**
 * One accent per theme, not two. The canonical burgundy `#8B253B` muddies at
 * motif stroke weights against the date card's near-black `#030303`, so the
 * dark variant lifts it — the same call `time-card.ts` documents for its own
 * dark ground. Light keeps the canonical pair.
 */
function palette(theme: ExpiryCardTheme): Palette {
  return theme === "light"
    ? { bg: "#F5F5F5", ink: "#1D1D1D", muted: "#6B6670", accent: "#8B253B" }
    : { bg: "#030303", ink: "#F2EFF7", muted: "#8E8895", accent: "#A82D48" };
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
  extra?: Record<string, unknown>,
): CardNode {
  return {
    type,
    props: { style, ...(extra ?? {}), ...(children !== undefined ? { children } : {}) },
  };
}

function dataUri(buffer: Buffer): string {
  return `data:image/png;base64,${buffer.toString("base64")}`;
}

/* ------------------------------------------------------------------ */
/* Motifs                                                              */
/* ------------------------------------------------------------------ */

/**
 * Each motif is authored as SVG and rasterized by resvg BEFORE satori sees it,
 * so the full SVG feature set (strokes, dash arrays, bezier paths, nested
 * transforms, smooth gradients) is available — satori itself would support
 * almost none of it.
 *
 * The burgundy glow is baked in here rather than laid behind the mark as a
 * satori `radial-gradient` div for exactly that reason: satori's gradient
 * banding leaves a visible circular edge, which reads as a maroon disc rather
 * than light. The date card gets away with it only because a photo covers the
 * seam. Authored in SVG, resvg resolves the falloff cleanly to zero alpha.
 *
 * Art is drawn in a 300×300 space and inset inside a 480×480 canvas so the
 * glow has room to fade out without clipping.
 */
const MOTIF_BOX = 460;
const MOTIF_ART_INSET = 90;
/** Rendered size of the whole glow canvas; the art itself lands at ~404px. */
const MOTIF_DISPLAY = 620;
/** Transparent glow margin around the art, in display px — clawed back by negative margins. */
const GLOW_BLEED = Math.round((MOTIF_DISPLAY * MOTIF_ART_INSET) / MOTIF_BOX);

function motifSvg(variant: ExpiryCardVariant, accent: string, muted: string, theme: ExpiryCardTheme): string {
  const body = (() => {
    switch (variant) {
      /* Hourglass, every grain already fallen: the window simply closed. */
      case "expired":
        return `
          <rect x="70" y="24" width="160" height="14" rx="7" fill="${accent}"/>
          <rect x="70" y="262" width="160" height="14" rx="7" fill="${accent}"/>
          <path d="M88 38 L212 38 L158 148 L142 148 Z" fill="none" stroke="${accent}"
                stroke-width="9" stroke-linejoin="round"/>
          <path d="M142 152 L158 152 L212 262 L88 262 Z" fill="none" stroke="${accent}"
                stroke-width="9" stroke-linejoin="round"/>
          <path d="M118 204 L182 204 L202 254 L98 254 Z" fill="${accent}"/>
          <circle cx="150" cy="168" r="6" fill="${accent}" opacity="0.55"/>`;

      /* Bars stepping down under a descending arrow: the rating actually moved. */
      case "penalty":
        return `
          <rect x="28" y="126" width="46" height="146" rx="10" fill="${muted}" opacity="0.30"/>
          <rect x="94" y="166" width="46" height="106" rx="10" fill="${muted}" opacity="0.45"/>
          <rect x="160" y="206" width="46" height="66" rx="10" fill="${accent}" opacity="0.70"/>
          <rect x="226" y="240" width="46" height="32" rx="10" fill="${accent}"/>
          <path d="M40 66 L252 190" stroke="${accent}" stroke-width="12"
                stroke-linecap="round" fill="none"/>
          <path d="M252 190 L206 182 M252 190 L244 144" stroke="${accent}" stroke-width="12"
                stroke-linecap="round" stroke-linejoin="round" fill="none"/>`;

      /* You closed your side (solid check), theirs never closed (dashed, empty). */
      case "peer_ignored":
        return `
          <circle cx="88" cy="150" r="54" fill="${accent}"/>
          <path d="M62 150 L80 169 L115 130" stroke="#FFFFFF" stroke-width="13"
                stroke-linecap="round" stroke-linejoin="round" fill="none"/>
          <circle cx="216" cy="150" r="54" fill="none" stroke="${muted}" stroke-width="9"
                  stroke-dasharray="16 19" opacity="0.6"/>`;

      /* Heart split in two: one half solid (their yes was real), one half hollow (you). */
      case "missed_date":
        return `
          <g transform="translate(50,66) scale(2)">
            <path d="M50 88 C 20 65, 0 45, 0 28 C 0 12, 12 0, 28 0 C 38 0, 46 6, 50 13 Z"
                  fill="${accent}" transform="translate(-13,3) rotate(-9 50 50)"/>
            <path d="M50 13 C 54 6, 62 0, 72 0 C 88 0, 100 12, 100 28 C 100 45, 80 65, 50 88 Z"
                  fill="none" stroke="${accent}" stroke-width="6" stroke-linejoin="round"
                  opacity="0.45" transform="translate(13,3) rotate(9 50 50)"/>
          </g>`;
    }
  })();

  // A burgundy haze on the cream ground reads as a stain, so the light theme
  // gets a much fainter one.
  const g = theme === "light" ? [0.14, 0.06, 0.02] : [0.42, 0.18, 0.05];

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${MOTIF_BOX} ${MOTIF_BOX}" width="${MOTIF_BOX}" height="${MOTIF_BOX}">
    <defs>
      <radialGradient id="glow" cx="50%" cy="50%" r="50%">
        <stop offset="0%" stop-color="${accent}" stop-opacity="${g[0]}"/>
        <stop offset="45%" stop-color="${accent}" stop-opacity="${g[1]}"/>
        <stop offset="72%" stop-color="${accent}" stop-opacity="${g[2]}"/>
        <stop offset="100%" stop-color="${accent}" stop-opacity="0"/>
      </radialGradient>
    </defs>
    <circle cx="${MOTIF_BOX / 2}" cy="${MOTIF_BOX / 2}" r="${MOTIF_BOX / 2}" fill="url(#glow)"/>
    <g transform="translate(${MOTIF_ART_INSET},${MOTIF_ART_INSET})">${body}</g>
  </svg>`;
}

/** Motifs are pure functions of (variant, theme) — rasterize each at most once. */
const motifCache = new Map<string, Buffer | null>();

function motifPng(variant: ExpiryCardVariant, theme: ExpiryCardTheme): Buffer | null {
  const key = `${variant}:${theme}`;
  const hit = motifCache.get(key);
  if (hit !== undefined) return hit;
  const p = palette(theme);
  let png: Buffer | null = null;
  try {
    png = Buffer.from(
      new Resvg(motifSvg(variant, p.accent, p.muted, theme), {
        fitTo: { mode: "width", value: MOTIF_BOX * 2 },
      })
        .render()
        .asPng(),
    );
  } catch (err) {
    console.warn("[expiry-card] motif render failed:", err);
  }
  motifCache.set(key, png);
  return png;
}

/* ------------------------------------------------------------------ */
/* Shared chrome                                                       */
/* ------------------------------------------------------------------ */

let cachedGrain: Buffer | null = null;
function grainTile(): Buffer {
  if (!cachedGrain) cachedGrain = grainPng(EXPIRY_CARD_W, EXPIRY_CARD_H, 9);
  return cachedGrain;
}

let cachedLogo: ButterflyMark | null | undefined;
async function loadLogo(): Promise<ButterflyMark | null> {
  if (cachedLogo !== undefined) return cachedLogo;
  cachedLogo = await butterflyPng(600);
  return cachedLogo;
}

type SatoriFonts = Parameters<typeof satori>[1]["fonts"];
let cachedFonts: SatoriFonts | null = null;

/**
 * Headlines are Unbounded 700, not the date card's Archivo Black: these lines
 * are localized and Archivo Black is Latin-only, so a Cyrillic headline would
 * fall back mid-word.
 *
 * This uses the FULL Unbounded (`unbounded-700.woff`), not the two subset files
 * every other card loads. Those are the Google Fonts `latin` + `cyrillic`
 * subsets, and Polish lives in neither: `latin-ext` carries Ą Ł Ż Ś Ć Ź Ń Ę.
 * Rendering "CZAS MINĄŁ" against the subsets drops ĄŁ into Roboto *mid-word* —
 * verified, not theoretical — which is exactly the failure the other card
 * renderers document and then walk into anyway for `pl`. (German is fine: ÄÖÜ
 * are Latin-1, inside the `latin` subset.)
 *
 * One file also deletes the hazard rather than navigating it: satori does NOT
 * fall through *within* a family, so the subset setup depends on registration
 * order — the Latin subset must own the requested family name and the Cyrillic
 * one must be a separate family listed before Roboto. With full coverage under
 * a single name there is no fallback to order and no way to get it wrong.
 *
 * Costs +144 KB of asset over the 42 KB pair, which is not worth optimizing for
 * a server-side render that loads it once per process.
 */
function loadFonts(): SatoriFonts {
  if (cachedFonts) return cachedFonts;
  const read = (file: string) =>
    readFileSync(fileURLToPath(new URL(`../assets/fonts/${file}`, import.meta.url)));
  cachedFonts = [
    { name: "Unbounded", data: read("unbounded-700.woff"), weight: 700, style: "normal" },
    { name: "Roboto", data: read("Roboto-Regular.ttf"), weight: 400, style: "normal" },
    { name: "Roboto", data: read("Roboto-Medium.ttf"), weight: 500, style: "normal" },
    { name: "Archivo Black", data: read("ArchivoBlack-Regular.ttf"), weight: 400, style: "normal" },
  ];
  return cachedFonts;
}

/* ------------------------------------------------------------------ */
/* Layout                                                              */
/* ------------------------------------------------------------------ */

export interface ExpiryCardInput {
  variant: ExpiryCardVariant;
  /** Small letterspaced context line above the headline. */
  overline: string;
  /** Headline; split on `\n` into stacked lines, last line accented. */
  headline: string;
  /** Explanation / what happens next; split on `\n` into stacked lines. */
  subline: string;
  /** Recipient's chosen theme — drives the light/dark chrome. */
  theme: ExpiryCardTheme;
}

interface BuildInput extends ExpiryCardInput {
  motif: Buffer | null;
  logo: ButterflyMark | null;
  grain: Buffer | null;
}

export function buildExpiryCardElement(input: BuildInput): CardNode {
  const p = palette(input.theme);
  const headlineLines = input.headline.split("\n");

  return el(
    "div",
    {
      display: "flex",
      flexDirection: "column",
      width: `${EXPIRY_CARD_W}px`,
      height: `${EXPIRY_CARD_H}px`,
      padding: "72px 76px",
      backgroundColor: p.bg,
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
                width: `${EXPIRY_CARD_W}px`,
                height: `${EXPIRY_CARD_H}px`,
                opacity: 0.5,
              },
              undefined,
              { src: dataUri(input.grain) },
            ),
          ]
        : []),

      // Wordmark. Latin-only string, so Archivo Black is safe here.
      el(
        "div",
        { display: "flex", fontFamily: "Archivo Black", fontSize: "34px", color: p.ink },
        "Gennety",
      ),
      ...(input.logo ? [logoImg(input.logo)] : []),

      el("div", { display: "flex", flexGrow: 10, minHeight: "0px" }),

      // Motif (glow baked in). The negative margins claw back the transparent
      // glow margin baked into the PNG, so the mark optically sits on the text
      // column's left edge and its real footprint is the art, not the canvas.
      ...(input.motif
        ? [
            el(
              "img",
              {
                width: `${MOTIF_DISPLAY}px`,
                height: `${MOTIF_DISPLAY}px`,
                marginLeft: `${-GLOW_BLEED}px`,
                marginTop: `${-GLOW_BLEED}px`,
                marginBottom: `${-GLOW_BLEED}px`,
              },
              undefined,
              { src: dataUri(input.motif) },
            ),
          ]
        : []),

      el("div", { display: "flex", flexGrow: 9, minHeight: "0px" }),

      // Overline, led by a short burgundy rule.
      el("div", { display: "flex", alignItems: "center", marginBottom: "26px" }, [
        el("div", {
          display: "flex",
          width: "44px",
          height: "6px",
          borderRadius: "3px",
          backgroundColor: p.accent,
          marginRight: "20px",
        }),
        el(
          "div",
          {
            display: "flex",
            fontFamily: "Roboto",
            fontSize: "24px",
            fontWeight: 500,
            letterSpacing: "5px",
            color: p.muted,
          },
          input.overline,
        ),
      ]),

      el(
        "div",
        {
          display: "flex",
          flexDirection: "column",
          fontFamily: "Unbounded",
          fontWeight: 700,
          fontSize: "92px",
          lineHeight: 1.04,
          letterSpacing: "-1px",
        },
        headlineLines.map((line, i) =>
          el(
            "div",
            { display: "flex", color: i === headlineLines.length - 1 ? p.accent : p.ink },
            line,
          ),
        ),
      ),

      el(
        "div",
        {
          display: "flex",
          flexDirection: "column",
          marginTop: "34px",
          fontFamily: "Roboto",
          fontSize: "31px",
          lineHeight: 1.42,
          color: p.muted,
        },
        input.subline.split("\n").map((line) => el("div", { display: "flex" }, line)),
      ),
    ],
  );
}

/** Brand butterfly, top-right and slightly tilted — mirrors the date card. */
function logoImg(logo: ButterflyMark): CardNode {
  const displayW = 250;
  const displayH = Math.round(displayW * (logo.height / logo.width));
  return el(
    "img",
    {
      position: "absolute",
      top: "58px",
      right: "40px",
      width: `${displayW}px`,
      height: `${displayH}px`,
      transform: "rotate(13deg)",
    },
    undefined,
    { src: dataUri(logo.png) },
  );
}

export async function renderExpiryCard(input: ExpiryCardInput): Promise<Buffer | null> {
  try {
    const element = buildExpiryCardElement({
      ...input,
      motif: motifPng(input.variant, input.theme),
      logo: await loadLogo(),
      // The dark film grain would dirty the cream light card — skip it there.
      grain: input.theme === "light" ? null : grainTile(),
    });

    const svg = await satori(element as unknown as Parameters<typeof satori>[0], {
      width: EXPIRY_CARD_W,
      height: EXPIRY_CARD_H,
      fonts: loadFonts(),
    });
    const png = new Resvg(svg, {
      fitTo: { mode: "width", value: EXPIRY_CARD_W },
      background: palette(input.theme).bg,
    })
      .render()
      .asPng();
    return Buffer.from(png);
  } catch (err) {
    console.warn("[expiry-card] render failed:", err);
    return null;
  }
}
