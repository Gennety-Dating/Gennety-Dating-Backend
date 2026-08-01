import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import satori from "satori";
import { Resvg } from "@resvg/resvg-js";

import {
  renderExpiryCard,
  EXPIRY_CARD_W,
  EXPIRY_CARD_H,
  type ExpiryCardVariant,
} from "./expiry-card.js";

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

const VARIANTS: ExpiryCardVariant[] = ["expired", "penalty", "peer_ignored", "missed_date"];

describe("renderExpiryCard", () => {
  it.each(VARIANTS)("renders %s as a PNG", async (variant) => {
    const png = await renderExpiryCard({
      variant,
      overline: "OVERLINE",
      headline: "FIRST\nSECOND",
      subline: "One line.\nAnother line.",
      theme: "dark",
    });
    expect(png).not.toBeNull();
    expect(png!.subarray(0, 4)).toEqual(PNG_MAGIC);
  });

  it("renders the light theme too", async () => {
    const png = await renderExpiryCard({
      variant: "expired",
      overline: "OVERLINE",
      headline: "FIRST\nSECOND",
      subline: "One line.",
      theme: "light",
    });
    expect(png).not.toBeNull();
    expect(png!.subarray(0, 4)).toEqual(PNG_MAGIC);
  });

  it("never throws on nonsense input — the expiry sweep must not wedge", async () => {
    const png = await renderExpiryCard({
      variant: "expired",
      overline: "",
      headline: "",
      subline: "",
      theme: "dark",
    });
    // Either a card or null, but never a rejection.
    expect(png === null || png.subarray(0, 4).equals(PNG_MAGIC)).toBe(true);
  });
});

/**
 * Regression guard for the headline font.
 *
 * The other card renderers load Unbounded as the Google Fonts `latin` +
 * `cyrillic` subsets, and Polish is in NEITHER — `latin-ext` carries Ą Ł Ż Ś Ć
 * Ź Ń Ę. Satori does not report a missing glyph; it silently resolves it from
 * another registered family, so "CZAS MINĄŁ" renders with ĄŁ in Roboto
 * mid-word and nothing fails. This card therefore loads the FULL
 * `unbounded-700.woff`, and the check below is what keeps it that way.
 *
 * No font parser is available (and adding one for a test isn't worth a new
 * dependency), so coverage is proven by differential render: the same Polish
 * string drawn with [Unbounded, Roboto] versus [Roboto] alone. If Unbounded
 * carries the glyphs the two rasters differ; if it doesn't, both fall through
 * to Roboto and come out byte-identical.
 */
describe("headline font coverage", () => {
  const read = (file: string) =>
    readFileSync(fileURLToPath(new URL(`../assets/fonts/${file}`, import.meta.url)));

  async function rasterize(text: string, fonts: Parameters<typeof satori>[1]["fonts"]) {
    const svg = await satori(
      {
        type: "div",
        props: {
          style: {
            display: "flex",
            width: "600px",
            height: "140px",
            fontFamily: "Unbounded",
            fontWeight: 700,
            fontSize: "64px",
            color: "#FFFFFF",
            backgroundColor: "#000000",
          },
          children: text,
        },
      } as unknown as Parameters<typeof satori>[0],
      { width: 600, height: 140, fonts },
    );
    return Buffer.from(new Resvg(svg).render().asPng());
  }

  const roboto = () => [
    { name: "Roboto", data: read("Roboto-Medium.ttf"), weight: 500 as const, style: "normal" as const },
  ];
  const unboundedPlusRoboto = () => [
    { name: "Unbounded", data: read("unbounded-700.woff"), weight: 700 as const, style: "normal" as const },
    ...roboto(),
  ];

  it("covers Polish diacritics (Ą Ł Ż Ś Ć Ź Ń Ę)", async () => {
    const [withUnbounded, robotoOnly] = await Promise.all([
      rasterize("ŁĄŻŚĆŹŃĘ", unboundedPlusRoboto()),
      rasterize("ŁĄŻŚĆŹŃĘ", roboto()),
    ]);
    expect(withUnbounded.equals(robotoOnly)).toBe(false);
  });

  it("covers Cyrillic (RU + the Ukrainian-only letters)", async () => {
    const [withUnbounded, robotoOnly] = await Promise.all([
      rasterize("ВЫШЛОЇЄҐІ", unboundedPlusRoboto()),
      rasterize("ВЫШЛОЇЄҐІ", roboto()),
    ]);
    expect(withUnbounded.equals(robotoOnly)).toBe(false);
  });

  it("covers German umlauts", async () => {
    const [withUnbounded, robotoOnly] = await Promise.all([
      rasterize("ÄÖÜ", unboundedPlusRoboto()),
      rasterize("ÄÖÜ", roboto()),
    ]);
    expect(withUnbounded.equals(robotoOnly)).toBe(false);
  });

  it("proves the differential actually detects a gap", async () => {
    // Control: the `latin` subset every other renderer uses genuinely lacks
    // Polish, so it must come out identical to Roboto-only. Without this the
    // three assertions above could pass for the wrong reason.
    const latinSubset = [
      { name: "Unbounded", data: read("unbounded-lat-700.woff"), weight: 700 as const, style: "normal" as const },
      ...roboto(),
    ];
    const [withSubset, robotoOnly] = await Promise.all([
      rasterize("ŁĄŻ", latinSubset),
      rasterize("ŁĄŻ", roboto()),
    ]);
    expect(withSubset.equals(robotoOnly)).toBe(true);
  });
});

describe("card dimensions", () => {
  it("is a square poster", () => {
    expect(EXPIRY_CARD_W).toBe(EXPIRY_CARD_H);
  });
});
