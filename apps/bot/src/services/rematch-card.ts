/**
 * Rematch offer card (PRODUCT_SPEC §3.11) — the PNG that leads the DM offering
 * a paid on-demand search.
 *
 * Why it exists: the offer arrives at a genuinely deflating moment ("no match
 * this drop", or "that one didn't work out"), and it was a bare `sendMessage`
 * with a button while every other emotional beat in the product — the expiry
 * notice, the coordination fork, the date card — already carries a rendered card.
 *
 * ONE card, not three. The three offer copies (`rematchOfferFamine` / `Failed` /
 * `Neutral`) stay the caption and say what just HAPPENED; the card says what is
 * being OFFERED. That split is the same rule §3.4 states for the expiry card —
 * nothing is said twice — and it is why a per-variant motif would be a step
 * backwards here rather than extra polish.
 *
 * The motif is abstract BY NECESSITY, not by taste: at offer time nobody has
 * been picked yet, so there is no partner to depict and no hint that could be
 * dropped without inventing one. It is the pool with one person lit up.
 *
 * It carries NO PRICE. A PNG is immutable and gets cached by Telegram, while the
 * price lives in env (`REMATCH_PRICE_USD_DISPLAY` / `REMATCH_STARS`) — a baked-in
 * figure would go stale silently, which is the one failure a screen asking for
 * money must not have. Price stays in the caption and on the button.
 *
 * Rendered text is emoji-free: the bundled fonts carry no color-emoji glyphs and
 * satori drops them. Emoji live in the Telegram caption instead.
 *
 * Never throws — returns `null` on any failure so the caller degrades to the
 * plain text offer that ships today.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import satori from "satori";
import { Resvg } from "@resvg/resvg-js";
import { butterflyPng, type ButterflyMark } from "./match-card/collage.js";
import { grainPng } from "./date-card/image.js";

/** Square poster, matching the expiry card — the offer belongs to that family. */
export const REMATCH_CARD_W = 1080;
export const REMATCH_CARD_H = 1080;

export type RematchCardTheme = "light" | "dark";

interface Palette {
  bg: string;
  ink: string;
  muted: string;
  accent: string;
}

/**
 * Same two palettes as `expiry-card.ts`, and for the same measured reason: the
 * canonical burgundy `#8B253B` sinks into the near-black ground at motif stroke
 * weights, so the dark variant lifts it.
 */
function palette(theme: RematchCardTheme): Palette {
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
/* Motif — the pool, with one picked out                               */
/* ------------------------------------------------------------------ */

const MOTIF_BOX = 460;
const MOTIF_ART_INSET = 90;
/** Rendered size of the whole glow canvas; the art itself lands at ~404px. */
const MOTIF_DISPLAY = 620;
/** Transparent glow margin around the art, in display px — clawed back by negative margins. */
const GLOW_BLEED = Math.round((MOTIF_DISPLAY * MOTIF_ART_INSET) / MOTIF_BOX);

/** Art box the rings are drawn in (the inset square inside the glow canvas). */
const ART = MOTIF_BOX - MOTIF_ART_INSET * 2;
const CX = ART / 2;
const CY = ART / 2;
const RINGS = [44, 88, 132] as const;

/**
 * Candidate dots, authored in polar coordinates rather than randomised.
 *
 * Same rule `preference-layout.ts` states: a pattern
 * re-rolled per render can never be reviewed twice and no test can pin it. These
 * angles were chosen so no dot collides with the chosen one and none sits on the
 * vertical axis, where it would read as a deliberate marker rather than as noise.
 */
const POOL_DOTS: readonly { deg: number; r: number; size: number }[] = [
  { deg: 18, r: 132, size: 5 },
  { deg: 74, r: 88, size: 4 },
  { deg: 131, r: 132, size: 5 },
  { deg: 168, r: 44, size: 4 },
  { deg: 205, r: 88, size: 5 },
  { deg: 249, r: 132, size: 4 },
  { deg: 297, r: 88, size: 5 },
  { deg: 338, r: 44, size: 4 },
];

/** The one the search picks out — larger, accented, ringed with a lock-on halo. */
const CHOSEN = { deg: 52, r: 88, size: 13 } as const;

function polar(deg: number, r: number): { x: number; y: number } {
  const rad = (deg * Math.PI) / 180;
  return { x: CX + Math.cos(rad) * r, y: CY - Math.sin(rad) * r };
}

function motifSvg(theme: RematchCardTheme): string {
  const p = palette(theme);
  const g = theme === "light" ? [0.14, 0.06, 0.02] : [0.42, 0.18, 0.05];
  const ringOpacity = theme === "light" ? 0.3 : 0.34;

  const rings = RINGS.map(
    (r) =>
      `<circle cx="${CX}" cy="${CY}" r="${r}" fill="none" stroke="${p.muted}" ` +
      `stroke-opacity="${ringOpacity}" stroke-width="2"/>`,
  ).join("");

  const dots = POOL_DOTS.map(({ deg, r, size }) => {
    const { x, y } = polar(deg, r);
    return (
      `<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="${size}" ` +
      `fill="${p.muted}" fill-opacity="0.55"/>`
    );
  }).join("");

  const c = polar(CHOSEN.deg, CHOSEN.r);
  const chosen =
    `<circle cx="${c.x.toFixed(2)}" cy="${c.y.toFixed(2)}" r="${CHOSEN.size + 13}" ` +
    `fill="none" stroke="${p.accent}" stroke-opacity="0.45" stroke-width="3"/>` +
    `<circle cx="${c.x.toFixed(2)}" cy="${c.y.toFixed(2)}" r="${CHOSEN.size}" fill="${p.accent}"/>`;

  // Centre mark: where the search is run FROM. Deliberately small — it anchors
  // the rings without competing with the chosen dot.
  const centre = `<circle cx="${CX}" cy="${CY}" r="4" fill="${p.accent}" fill-opacity="0.7"/>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${MOTIF_BOX} ${MOTIF_BOX}" width="${MOTIF_BOX}" height="${MOTIF_BOX}">
    <defs>
      <radialGradient id="glow" cx="50%" cy="50%" r="50%">
        <stop offset="0%" stop-color="${p.accent}" stop-opacity="${g[0]}"/>
        <stop offset="45%" stop-color="${p.accent}" stop-opacity="${g[1]}"/>
        <stop offset="72%" stop-color="${p.accent}" stop-opacity="${g[2]}"/>
        <stop offset="100%" stop-color="${p.accent}" stop-opacity="0"/>
      </radialGradient>
    </defs>
    <circle cx="${MOTIF_BOX / 2}" cy="${MOTIF_BOX / 2}" r="${MOTIF_BOX / 2}" fill="url(#glow)"/>
    <g transform="translate(${MOTIF_ART_INSET},${MOTIF_ART_INSET})">${rings}${dots}${centre}${chosen}</g>
  </svg>`;
}

/** The motif is a pure function of the theme — rasterize each at most once. */
const motifCache = new Map<RematchCardTheme, Buffer | null>();

function motifPng(theme: RematchCardTheme): Buffer | null {
  const hit = motifCache.get(theme);
  if (hit !== undefined) return hit;
  let png: Buffer | null = null;
  try {
    png = Buffer.from(
      new Resvg(motifSvg(theme), { fitTo: { mode: "width", value: MOTIF_BOX * 2 } })
        .render()
        .asPng(),
    );
  } catch (err) {
    console.warn("[rematch-card] motif render failed:", err);
  }
  motifCache.set(theme, png);
  return png;
}

/* ------------------------------------------------------------------ */
/* Shared chrome                                                       */
/* ------------------------------------------------------------------ */

let cachedGrain: Buffer | null = null;
function grainTile(): Buffer {
  if (!cachedGrain) cachedGrain = grainPng(REMATCH_CARD_W, REMATCH_CARD_H, 9);
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
 * The FULL Unbounded (`unbounded-700.woff`), not the two subset files — same
 * reason `expiry-card.ts` documents at length: the Google Fonts `latin` +
 * `cyrillic` subsets carry no Polish, so `PODEJŚCIE` would drop Ś into Roboto
 * mid-word and satori reports nothing when it does. One file also removes the
 * registration-order hazard entirely (satori does not fall through *within* a
 * family), which is the trap the match card walked into.
 */
export function loadFonts(): SatoriFonts {
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

export interface RematchCardInput {
  /** Small letterspaced context line above the headline. */
  overline: string;
  /** Headline; split on `\n` into stacked lines, last line accented. */
  headline: string;
  /** What is on offer; split on `\n` into stacked lines. */
  subline: string;
  /** Recipient's chosen theme — drives the light/dark chrome. */
  theme: RematchCardTheme;
}

interface BuildInput extends RematchCardInput {
  motif: Buffer | null;
  logo: ButterflyMark | null;
  grain: Buffer | null;
}

export function buildRematchCardElement(input: BuildInput): CardNode {
  const p = palette(input.theme);
  const headlineLines = input.headline.split("\n");

  return el(
    "div",
    {
      display: "flex",
      flexDirection: "column",
      width: `${REMATCH_CARD_W}px`,
      height: `${REMATCH_CARD_H}px`,
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
                width: `${REMATCH_CARD_W}px`,
                height: `${REMATCH_CARD_H}px`,
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

export async function renderRematchCard(input: RematchCardInput): Promise<Buffer | null> {
  try {
    const element = buildRematchCardElement({
      ...input,
      motif: motifPng(input.theme),
      logo: await loadLogo(),
      // The dark film grain would dirty the cream light card — skip it there.
      grain: input.theme === "light" ? null : grainTile(),
    });

    const svg = await satori(element as unknown as Parameters<typeof satori>[0], {
      width: REMATCH_CARD_W,
      height: REMATCH_CARD_H,
      fonts: loadFonts(),
    });
    const png = new Resvg(svg, {
      fitTo: { mode: "width", value: REMATCH_CARD_W },
      background: palette(input.theme).bg,
    })
      .render()
      .asPng();
    return Buffer.from(png);
  } catch (err) {
    console.warn("[rematch-card] render failed:", err);
    return null;
  }
}
