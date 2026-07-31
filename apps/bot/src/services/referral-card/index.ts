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
 * matching the approved mockup: wordmark + butterfly header, "invited you"
 * kicker, the fixed brand-voice headline, and the Premium gift chip.
 *
 * Same pure satori→resvg stack as the date/match cards (no headless browser).
 * Returns a PNG Buffer, or null on any failure so the share flow can degrade to
 * a text article.
 */

const CARD_W = 900;
const CARD_H = 1000;

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
  ];
  return cachedFonts;
}

// The mark keeps its natural aspect ratio (width/height) — forcing it into a
// square box squished the butterfly on the card.
let cachedButterfly: { uri: string; w: number; h: number } | null = null;
async function butterflyMark(): Promise<{ uri: string; w: number; h: number } | null> {
  if (cachedButterfly) return cachedButterfly.uri ? cachedButterfly : null;
  const mark = await butterflyPng(180, "#F0C9B0");
  cachedButterfly = mark
    ? { uri: `data:image/png;base64,${mark.png.toString("base64")}`, w: mark.width, h: mark.height }
    : { uri: "", w: 0, h: 0 };
  return cachedButterfly.uri ? cachedButterfly : null;
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
}

export async function renderReferralCard(input: ReferralCardInput): Promise<Buffer | null> {
  try {
    const butterfly = await butterflyMark();
    const kicker = input.referrerName
      ? t(input.lang, "referralCardInvitedBy", { name: input.referrerName })
      : t(input.lang, "referralCardInvitedGeneric");
    const giftLine = t(input.lang, "referralCardGift", {
      monthsPhrase: monthsPhrase(input.lang, input.giftMonths),
    });

    // Bigger butterfly crest, tilted ~20° clockwise — the mark, like our other
    // cards. Aspect-correct (never squished into a square box).
    const bfH = 122;
    const bfW = butterfly ? Math.round((butterfly.w / butterfly.h) * bfH) : bfH;

    // Everything is centre-formatted: a full-width row with the text centred.
    const center = { width: "100%", justifyContent: "center", textAlign: "center" } as const;

    const headline = box(
      {
        width: "100%",
        flexDirection: "column",
        alignItems: "center",
        fontFamily: "Archivo Black",
        fontSize: 76,
        lineHeight: 1.03,
      },
      [
        txt({ ...center, color: "#F7ECEC" }, t(input.lang, "referralCardHeadA")),
        txt({ ...center, color: "#F0B7A0" }, t(input.lang, "referralCardHeadB")),
      ],
    );

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
        // Butterfly crest — bigger, in the top-right corner, tilted ~20° clockwise.
        butterfly
          ? {
              type: "img",
              props: {
                src: butterfly.uri,
                style: {
                  display: "flex",
                  position: "absolute",
                  top: 52,
                  right: 58,
                  width: bfW,
                  height: bfH,
                  transform: "rotate(20deg)",
                },
              },
            }
          : box({}, []),
        // Heavier wordmark — Archivo Black (Roboto tops out at 700).
        txt(
          { ...center, fontFamily: "Archivo Black", fontSize: 40, letterSpacing: 4, textTransform: "uppercase" },
          "GENNETY",
        ),
        txt(
          {
            ...center,
            marginTop: 16,
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
