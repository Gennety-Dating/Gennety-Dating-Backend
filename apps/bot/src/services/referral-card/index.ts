import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import satori from "satori";
import { Resvg } from "@resvg/resvg-js";
import type { Language } from "@gennety/shared";
import { t } from "@gennety/shared";
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
const CARD_H = 1125;

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
    const support = t(input.lang, "referralCardSupport");
    const giftLine = t(input.lang, "referralCardGift", { months: String(input.giftMonths) });

    // Aspect-correct butterfly (never squished into a square box).
    const bfH = 56;
    const bfW = butterfly ? Math.round((butterfly.w / butterfly.h) * bfH) : bfH;
    const header = box(
      { justifyContent: "space-between", alignItems: "center" },
      [
        txt(
          {
            fontSize: 30,
            fontWeight: 700,
            letterSpacing: 6,
            textTransform: "uppercase",
            opacity: 0.92,
          },
          "GENNETY",
        ),
        butterfly
          ? {
              type: "img",
              props: { src: butterfly.uri, style: { display: "flex", width: bfW, height: bfH } },
            }
          : box({ width: bfH, height: bfH }, []),
      ],
    );

    // Fixed English brand tagline right under the header — says what Gennety is
    // and fills the top of the card so it no longer reads as an empty void.
    const tagline = txt(
      {
        marginTop: 16,
        fontSize: 28,
        fontWeight: 500,
        letterSpacing: 0.5,
        color: "rgba(247,236,236,0.62)",
      },
      "Your personal AI matchmaker",
    );

    const headline = box(
      { flexDirection: "column", fontFamily: "Archivo Black", fontSize: 78, lineHeight: 1.02 },
      [
        txt({ color: "#F7ECEC" }, t(input.lang, "referralCardHeadA")),
        txt({ color: "#F0B7A0" }, t(input.lang, "referralCardHeadB")),
      ],
    );

    const tree = box(
      {
        width: CARD_W,
        height: CARD_H,
        flexDirection: "column",
        padding: 64,
        background: "linear-gradient(158deg, #17090D 0%, #2A0E17 42%, #6E1B2E 100%)",
        color: "#F7ECEC",
        fontFamily: "Roboto",
      },
      [
        header,
        tagline,
        // Content sits in the lower-middle; the header + tagline anchor the top
        // so the card is balanced top-to-bottom, not empty-over-crammed.
        box({ flex: 0.5 }, []),
        txt(
          {
            fontSize: 26,
            fontWeight: 700,
            letterSpacing: 3,
            textTransform: "uppercase",
            color: "#E7C7A6",
            marginBottom: 20,
          },
          kicker,
        ),
        headline,
        // Real "what is this" line so the card carries information, not just a
        // slogan (and no "AI matchmaker" cliché).
        txt(
          {
            marginTop: 26,
            fontSize: 31,
            lineHeight: 1.34,
            color: "rgba(247,236,236,0.74)",
          },
          support,
        ),
        txt(
          {
            marginTop: 34,
            alignSelf: "flex-start",
            alignItems: "center",
            padding: "18px 28px",
            borderRadius: 999,
            border: "1px solid rgba(255,255,255,0.22)",
            background: "rgba(255,255,255,0.10)",
            fontSize: 30,
            fontWeight: 600,
          },
          giftLine,
        ),
        box({ flex: 0.4 }, []),
        txt(
          {
            fontSize: 24,
            fontWeight: 500,
            letterSpacing: 2,
            color: "rgba(247,236,236,0.5)",
          },
          t(input.lang, "referralCardFooter"),
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
