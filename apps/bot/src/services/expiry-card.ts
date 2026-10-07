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

import satori from "satori";
import { Resvg } from "@resvg/resvg-js";
import { butterflyPng, type ButterflyMark } from "./match-card/collage.js";
import { hourglassArt } from "./expiry-card-hourglass.js";
import { grainPng, svgToPng} from "./date-card/image.js";
import { cardFonts, DISPLAY_FAMILY, BODY_FAMILY } from "./card-fonts.js";
import { wordmarkPng, wordmarkNode, type WordmarkImage } from "./brand-wordmark.js";

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
 * Art is drawn in a 300×300 space and inset inside a 460×460 canvas so the
 * glow has room to fade out without clipping.
 */
const MOTIF_BOX = 460;
const MOTIF_ART_INSET = 90;
/** Rendered size of the whole glow canvas; the art itself lands at ~404px. */
const MOTIF_DISPLAY = 620;
/** Transparent glow margin around the art, in display px — clawed back by negative margins. */
const GLOW_BLEED = Math.round((MOTIF_DISPLAY * MOTIF_ART_INSET) / MOTIF_BOX);

function motifSvg(
  variant: ExpiryCardVariant,
  accent: string,
  muted: string,
  bg: string,
  theme: ExpiryCardTheme,
): string {
  const body = (() => {
    switch (variant) {
      /* Hourglass: the 24h window ran out. Drawn artwork rather than
         primitives, so it lives in its own module — see expiry-card-hourglass.ts. */
      case "expired":
        return hourglassArt(accent, bg);

      /* Bars stepping down under a descending arrow: the rating actually moved. */
      case "penalty":
        return `
          <rect x="28" y="126" width="46" height="146" rx="10" fill="${muted}" opacity="0.30"/>
          <rect x="94" y="166" width="46" height="106" rx="10" fill="${muted}" opacity="0.45"/>
          <rect x="160" y="206" width="46" height="66" rx="10" fill="${accent}" opacity="0.70"/>
          <rect x="226" y="240" width="46" height="32" rx="10" fill="${accent}"/>
          <path d="M40 66 L252 190" stroke="${accent}" stroke-width="12"
                stroke-linecap="round" fill="none"/>
          <path d="M252 190 L205 191 M252 190 L230 148" stroke="${accent}" stroke-width="12"
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
      new Resvg(motifSvg(variant, p.accent, p.muted, p.bg, theme), {
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

/**
 * Headlines are Gennety Display 800 (`card-fonts.ts` — one file per weight with
 * full ru/uk/en/de/pl coverage, so "CZAS MINĄŁ" never drops a letter into
 * Roboto mid-word, the failure the old Unbounded subsets had). 98px keeps the
 * cap height the card was designed with at Unbounded 700 / 92px.
 */
const HEADLINE_PX = 98;
const WORDMARK_W = 140;

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
  /** Drawn logotype tinted to the ink; `null` → the word set in Gennety Display. */
  wordmark: WordmarkImage | null;
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
      fontFamily: BODY_FAMILY,
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

      wordmarkNode(input.wordmark, WORDMARK_W, p.ink),
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

      // Overline, led by a short burgundy rule. An empty overline drops the
      // whole row (copy audit 2026-10-01: most variants carry none).
      ...(input.overline
        ? [
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
            fontFamily: BODY_FAMILY,
            fontSize: "24px",
            fontWeight: 500,
            letterSpacing: "5px",
            color: p.muted,
          },
          input.overline,
        ),
      ]),
          ]
        : []),

      el(
        "div",
        {
          display: "flex",
          flexDirection: "column",
          fontFamily: DISPLAY_FAMILY,
          fontWeight: 800,
          fontSize: `${HEADLINE_PX}px`,
          lineHeight: 1.02,
          letterSpacing: "-1.5px",
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
          fontFamily: BODY_FAMILY,
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
      wordmark: await wordmarkPng(palette(input.theme).ink),
      // The dark film grain would dirty the cream light card — skip it there.
      grain: input.theme === "light" ? null : grainTile(),
    });

    const svg = await satori(element as unknown as Parameters<typeof satori>[0], {
      width: EXPIRY_CARD_W,
      height: EXPIRY_CARD_H,
      fonts: cardFonts(),
    });
    // Растеризация уехала в рабочий поток: на главном она блокировала
    // весь процесс (см. `services/render/pool.ts`).
    return await svgToPng(svg, EXPIRY_CARD_W, palette(input.theme).bg);
  } catch (err) {
    console.warn("[expiry-card] render failed:", err);
    return null;
  }
}
