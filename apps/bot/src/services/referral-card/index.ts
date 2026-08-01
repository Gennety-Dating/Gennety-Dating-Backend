import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import satori from "satori";
import { Resvg } from "@resvg/resvg-js";
import type { Language } from "@gennety/shared";
import { monthsPhrase, t } from "@gennety/shared";
import { butterflyPng } from "../match-card/collage.js";

/**
 * Referral invite card (§Referral) — the "photo" a referrer forwards in one tap
 * (savePreparedInlineMessage → InlineQueryResultPhoto). Burgundy brand system,
 * top down: the brand butterfly + wordmark lockup, the "invited you" kicker,
 * the fixed brand-voice headline, a row of member portraits (so the card shows
 * people rather than only claiming them), and the Premium gift chip.
 *
 * Same pure satori→resvg stack as the date/match cards (no headless browser).
 * Returns a PNG Buffer, or null on any failure so the share flow can degrade to
 * a text article.
 */

const CARD_W = 900;
const CARD_H = 1000;

/** Cream the brand mark is tinted to — the card's own body-text colour. */
const CREAM = "#F7ECEC";

/** How many portrait slots the card lays out. */
const PORTRAIT_SLOTS = 5;

type SatoriFonts = Parameters<typeof satori>[1]["fonts"];
let cachedFonts: SatoriFonts | null = null;
function loadFonts(): SatoriFonts {
  if (cachedFonts) return cachedFonts;
  const read = (file: string) =>
    readFileSync(fileURLToPath(new URL(`../../assets/fonts/${file}`, import.meta.url)));
  cachedFonts = [
    { name: "Roboto", data: read("Roboto-Regular.ttf"), weight: 400, style: "normal" },
    { name: "Roboto", data: read("Roboto-Medium.ttf"), weight: 500, style: "normal" },
    { name: "Roboto", data: read("Roboto-Bold.ttf"), weight: 700, style: "normal" },
    { name: "Archivo Black", data: read("ArchivoBlack-Regular.ttf"), weight: 400, style: "normal" },
    // Archivo Black ships Latin-only (no Cyrillic glyphs at all) — registering
    // a second font under the SAME name does NOT give satori per-glyph
    // fallthrough within a family (verified empirically: it only ever primary-
    // matches the first entry for a given name/weight/style, same trap
    // ARCHITECTURE.md flags for Unbounded). The fix is a distinct family name
    // that resolves unambiguously, picked per-language below.
    { name: "Headline Cyr", data: read("unbounded-cyr-700.woff"), weight: 400, style: "normal" },
  ];
  return cachedFonts;
}

// Minimal satori node helpers (this is a .ts file, so no JSX). Every box carries
// an explicit display so satori never has to guess.
type Node = { type: string; props: Record<string, unknown> };
function box(style: Record<string, unknown>, children: unknown): Node {
  return { type: "div", props: { style: { display: "flex", ...style }, children } };
}
function txt(style: Record<string, unknown>, value: string): Node {
  return { type: "div", props: { style: { display: "flex", ...style }, children: value } };
}

export interface ReferralCardInput {
  referrerName: string | null;
  giftMonths: number;
  lang: Language;
  /**
   * Member portraits filling the card's portrait row, as `data:` URIs, in
   * layout order (left → right). Fewer than `PORTRAIT_SLOTS` is fine; every
   * unfilled slot renders as a numbered placeholder ring, which is what the
   * founder reviews the layout against before supplying the real photos.
   */
  portraits?: readonly string[];
}

/** The brand wordmark, set in the logo's own typeface (title-case, not caps). */
function wordmark(style: Record<string, unknown>): Node {
  return txt({ fontFamily: "Archivo Black", letterSpacing: -1, ...style }, "Gennety");
}

/**
 * The production portrait set, bundled with the bot at
 * `assets/referral-portraits/<n>.<ext>` (1-indexed, left → right). Read once and
 * cached as data URIs — the card renders on every share and on every public
 * `GET /v1/referral/card` hit, so this must not touch the disk per request.
 *
 * Missing files are not an error: the row simply falls back to numbered
 * placeholder rings for those slots, which is also how the layout is reviewed
 * before the photos land. They are ordinary repo assets, so they ship with the
 * standard code rsync and need no storage bucket or CDN.
 */
const PORTRAIT_EXTENSIONS = ["jpg", "jpeg", "png", "webp"] as const;
const PORTRAIT_MIME: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};
let cachedPortraits: string[] | null = null;
function bundledPortraits(): string[] {
  if (cachedPortraits) return cachedPortraits;
  const out: string[] = [];
  for (let i = 1; i <= PORTRAIT_SLOTS; i++) {
    let uri = "";
    for (const ext of PORTRAIT_EXTENSIONS) {
      try {
        const data = readFileSync(
          fileURLToPath(new URL(`../../assets/referral-portraits/${i}.${ext}`, import.meta.url)),
        );
        uri = `data:${PORTRAIT_MIME[ext]};base64,${data.toString("base64")}`;
        break;
      } catch {
        // Try the next extension; a slot with no file stays a placeholder.
      }
    }
    // Keep the index alignment: slot N is always position N, so one missing
    // file leaves a hole rather than shifting every later photo left.
    out.push(uri);
  }
  cachedPortraits = out;
  return out;
}

// The mark keeps its natural aspect ratio (width/height) — forcing it into a
// square box squishes the butterfly.
let cachedButterfly: { uri: string; w: number; h: number } | null = null;
async function butterflyMark(): Promise<{ uri: string; w: number; h: number } | null> {
  if (cachedButterfly) return cachedButterfly.uri ? cachedButterfly : null;
  const mark = await butterflyPng(360, CREAM);
  cachedButterfly = mark
    ? { uri: `data:image/png;base64,${mark.png.toString("base64")}`, w: mark.width, h: mark.height }
    : { uri: "", w: 0, h: 0 };
  return cachedButterfly.uri ? cachedButterfly : null;
}

/**
 * Where each portrait tile sits. Absolute, scattered around the card's edges and
 * corners, most of them running off an edge so the card reads as a window onto a
 * larger crowd rather than a tidy grid of five. Deliberately NOT symmetrical —
 * the offsets and angles are hand-placed, and the two low-opacity ones sit
 * furthest into the text column so the copy always wins.
 *
 * Tiles are tall (9:14-ish) because the source photos are full-length shots: a
 * circular crop reduced them to a torso, which is what this layout replaces.
 */
interface PortraitSlot {
  /** Exactly one horizontal anchor; negative bleeds the tile off that edge. */
  left?: number;
  right?: number;
  top?: number;
  bottom?: number;
  w: number;
  h: number;
  rotate: number;
  opacity: number;
}

const PORTRAIT_LAYOUT: readonly PortraitSlot[] = [
  { left: -62, top: 54, w: 168, h: 250, rotate: -9, opacity: 0.62 },
  { right: -70, top: 128, w: 156, h: 232, rotate: 8, opacity: 0.55 },
  { left: -80, top: 452, w: 162, h: 240, rotate: 7, opacity: 0.42 },
  { right: -58, top: 566, w: 170, h: 252, rotate: -8, opacity: 0.5 },
  // Bleeds off the left rather than sitting inside it: the gift chip's fill is
  // semi-transparent, so a tile under its left end shows through and muddies it.
  { left: -52, bottom: -86, w: 158, h: 236, rotate: 6, opacity: 0.55 },
];

/**
 * The scattered portrait tiles. A slot with a photo renders it cropped to the
 * tile; an empty one renders a numbered frame, so the layout stays reviewable
 * (and the slots referable by number) before the photos land.
 */
function portraitTiles(portraits: readonly string[]): Node[] {
  return PORTRAIT_LAYOUT.map((slot, i) => {
    const common = {
      position: "absolute",
      ...(slot.left !== undefined ? { left: slot.left } : {}),
      ...(slot.right !== undefined ? { right: slot.right } : {}),
      ...(slot.top !== undefined ? { top: slot.top } : {}),
      ...(slot.bottom !== undefined ? { bottom: slot.bottom } : {}),
      width: slot.w,
      height: slot.h,
      borderRadius: 22,
      opacity: slot.opacity,
      transform: `rotate(${slot.rotate}deg)`,
    };
    const src = portraits[i];
    return src
      ? {
          type: "img",
          props: { src, style: { display: "flex", objectFit: "cover", ...common } },
        }
      : box(
          {
            ...common,
            alignItems: "center",
            justifyContent: "center",
            background: "rgba(247,236,236,0.10)",
            border: "2px solid rgba(247,236,236,0.25)",
          },
          [txt({ fontSize: 40, fontWeight: 700, color: "rgba(247,236,236,0.5)" }, String(i + 1))],
        );
  });
}

export async function renderReferralCard(input: ReferralCardInput): Promise<Buffer | null> {
  try {
    const kicker = input.referrerName
      ? t(input.lang, "referralCardInvitedBy", { name: input.referrerName })
      : t(input.lang, "referralCardInvitedGeneric");
    // en/de/pl spell the unit word out (`{monthsPhrase}`, fully declined);
    // ru/uk keep the abbreviated `{months} мес`/`міс`, which doesn't decline —
    // pass both so either template resolves.
    const giftLine = t(input.lang, "referralCardGift", {
      months: input.giftMonths,
      monthsPhrase: monthsPhrase(input.lang, input.giftMonths),
    });

    // Everything is centre-formatted: a full-width row with the text centred.
    const center = { width: "100%", justifyContent: "center", textAlign: "center" } as const;

    // Archivo Black has no Cyrillic glyphs, so ru/uk headlines use the bundled
    // Unbounded Cyrillic weight instead (see loadFonts) — same bold display
    // register, different (but already-established, match-card) typeface.
    // Unbounded's letterforms run wider than Archivo Black's at the same size,
    // so the Cyrillic headline is set a size down to keep each line to one row
    // (the same two-line "Head A. / Head B." shape every other language gets).
    const isCyrillicHeadline = input.lang === "ru" || input.lang === "uk";
    const headlineFontFamily = isCyrillicHeadline ? "Headline Cyr" : "Archivo Black";

    // Archivo Black/Unbounded are already the heaviest weight each family
    // ships, so "bolder" is faked with a same-colour text stroke that thickens
    // the strokes without changing the letterforms (satori honors
    // WebkitTextStroke).
    const headline = box(
      {
        width: "100%",
        flexDirection: "column",
        alignItems: "center",
        fontFamily: headlineFontFamily,
        fontSize: isCyrillicHeadline ? 56 : 76,
        lineHeight: 1.03,
      },
      [
        txt(
          { ...center, color: "#F7ECEC", WebkitTextStroke: "2px #F7ECEC" },
          t(input.lang, "referralCardHeadA"),
        ),
        txt(
          { ...center, color: "#F0B7A0", WebkitTextStroke: "2px #F0B7A0" },
          t(input.lang, "referralCardHeadB"),
        ),
      ],
    );

    const butterfly = await butterflyMark();
    // Header lockup mark, aspect-correct (never squished into a square box).
    const markH = 74;
    const markW = butterfly ? Math.round((butterfly.w / butterfly.h) * markH) : markH;

    const tree = box(
      {
        width: CARD_W,
        height: CARD_H,
        position: "relative",
        flexDirection: "column",
        alignItems: "center",
        padding: 72,
        background: "linear-gradient(158deg, #17090D 0%, #2A0E17 42%, #6E1B2E 100%)",
        color: "#F7ECEC",
        fontFamily: "Roboto",
      },
      [
        // Portraits come FIRST so they paint behind everything else — satori
        // paints in document order, and the copy must always sit on top.
        ...portraitTiles(input.portraits ?? bundledPortraits()),
        // Brand lockup: the butterfly mark, tinted to the card's own cream, over
        // the wordmark and tagline.
        butterfly
          ? {
              type: "img",
              props: {
                src: butterfly.uri,
                style: { display: "flex", width: markW, height: markH, marginBottom: 20 },
              },
            }
          : box({}, []),
        wordmark({ ...center, fontSize: 46 }),
        txt(
          {
            ...center,
            marginTop: 14,
            fontSize: 29,
            fontWeight: 700,
            letterSpacing: 0.5,
            color: "rgba(247,236,236,0.74)",
          },
          "Your personal AI matchmaker",
        ),
        box({ flex: 1 }, []),
        txt(
          {
            ...center,
            fontSize: 27,
            fontWeight: 700,
            letterSpacing: 3,
            textTransform: "uppercase",
            color: "#E7C7A6",
            marginBottom: 22,
          },
          kicker,
        ),
        headline,
        box({ flex: 1 }, []),
        // The Premium gift badge is the bottom element (replaces gennety.com).
        txt(
          {
            alignItems: "center",
            justifyContent: "center",
            padding: "22px 42px",
            borderRadius: 999,
            background: "rgba(255,255,255,0.12)",
            fontSize: 34,
            fontWeight: 700,
          },
          giftLine,
        ),
      ],
    );

    const svg = await satori(tree as unknown as Parameters<typeof satori>[0], {
      width: CARD_W,
      height: CARD_H,
      fonts: loadFonts(),
    });
    const png = new Resvg(svg, {
      fitTo: { mode: "width", value: CARD_W },
      background: "#17090D",
    })
      .render()
      .asPng();
    return Buffer.from(png);
  } catch (err) {
    console.warn("[referral-card] render failed", err);
    return null;
  }
}
