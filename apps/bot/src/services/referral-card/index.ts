import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import satori from "satori";
import { Resvg } from "@resvg/resvg-js";
import type { Language } from "@gennety/shared";
import { monthsPhrase, t } from "@gennety/shared";

/**
 * Referral invite card (§Referral) — the "photo" a referrer forwards in one tap
 * (savePreparedInlineMessage → InlineQueryResultPhoto). Burgundy brand system:
 * wordmark header, "invited you" kicker, the fixed brand-voice headline, and
 * the Premium gift chip. The corner butterfly crest was dropped 2026-07-30
 * (founder call) pending a swap to the real brand logo asset — no accent mark
 * on this card for now.
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

/**
 * Where the Gennety wordmark sits on the card. Two candidates under founder
 * review (2026-07-31); the loser gets deleted once one is picked.
 *  - `header`     — one centred wordmark at the top, the classic lockup.
 *  - `decorative` — an oversized watermark bleeding off the bottom-left corner,
 *    a small solid wordmark beside it, and a tilted one bleeding off the
 *    top-right, so the mark frames the card instead of labelling it.
 */
export type ReferralCardLogoVariant = "header" | "decorative";

export interface ReferralCardInput {
  referrerName: string | null;
  giftMonths: number;
  lang: Language;
  logoVariant?: ReferralCardLogoVariant;
}

/** The brand wordmark, set in the logo's own typeface (title-case, not caps). */
function wordmark(style: Record<string, unknown>): Node {
  return txt({ fontFamily: "Archivo Black", letterSpacing: -1, ...style }, "Gennety");
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

    // Corner wordmarks. Absolutely positioned with negative offsets so the big
    // ones genuinely run off the card edge rather than sitting inside a margin;
    // the huge bottom-left one is nearly transparent so it reads as texture in
    // the gradient, never as a second thing to read.
    const decorative = input.logoVariant === "decorative";
    const decorations: Node[] = decorative
      ? [
          wordmark({
            position: "absolute",
            top: 40,
            right: -18,
            fontSize: 58,
            color: "rgba(247,236,236,0.92)",
            transform: "rotate(-8deg)",
          }),
          wordmark({
            position: "absolute",
            left: -86,
            bottom: -74,
            fontSize: 200,
            color: "rgba(247,236,236,0.06)",
          }),
          wordmark({
            position: "absolute",
            left: 72,
            bottom: 214,
            fontSize: 28,
            color: "rgba(247,236,236,0.5)",
          }),
        ]
      : [];

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
        ...decorations,
        // In the decorative variant the corner marks ARE the branding, so the
        // header keeps only the tagline (a fourth wordmark would be noise).
        ...(decorative
          ? []
          : [wordmark({ ...center, fontSize: 46 })]),
        txt(
          {
            ...center,
            // Clear the tilted top-right wordmark, which occupies the band the
            // tagline would otherwise sit in.
            marginTop: decorative ? 108 : 16,
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
