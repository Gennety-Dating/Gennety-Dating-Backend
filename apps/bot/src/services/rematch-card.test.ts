import { describe, it, expect, vi } from "vitest";
import { SUPPORTED_LANGUAGES, t } from "@gennety/shared";

import {
  renderRematchCard,
  REMATCH_CARD_W,
  REMATCH_CARD_H,
  type RematchCardTheme,
} from "./rematch-card.js";

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

/**
 * Satori parses the bundled fonts (and resvg rasterizes the motif) on the first
 * render. Cold that is several seconds, and under full-suite parallel load it
 * runs past the 10s global default — the flake `expiry-card.test.ts` and
 * `time-card.test.ts` already carry this budget for.
 */
const RENDER_TIMEOUT_MS = 60_000;

const THEMES: RematchCardTheme[] = ["dark", "light"];

const SAMPLE = {
  overline: "YOUR MATCHMAKER",
  headline: "ONE MORE\nSEARCH",
  subline: "A new person, picked the same way.",
};

/** PNG IHDR carries the real raster size at bytes 16..23, big-endian. */
function pngSize(png: Buffer): { width: number; height: number } {
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

describe("renderRematchCard", () => {
  it.each(THEMES)(
    "renders the %s theme as a PNG at the declared size",
    async (theme) => {
      const png = await renderRematchCard({ ...SAMPLE, theme });
      expect(png).not.toBeNull();
      expect(png!.subarray(0, 4)).toEqual(PNG_MAGIC);
      // The declared constants are what the caller reasons about; assert the
      // raster actually matches them rather than trusting the constants alone.
      expect(pngSize(png!)).toEqual({ width: REMATCH_CARD_W, height: REMATCH_CARD_H });
    },
    RENDER_TIMEOUT_MS,
  );

  it("is a square poster — the expiry card's silhouette", () => {
    expect(REMATCH_CARD_W).toBe(REMATCH_CARD_H);
  });

  it(
    "never throws on nonsense input — a bad render must cost the picture, not the offer",
    async () => {
      // The offer DM is how a paid feature is reached at all. Every failure mode
      // here has to come back as null so the caller falls through to the plain
      // text message that shipped before the card existed.
      const png = await renderRematchCard({
        overline: "",
        headline: "",
        subline: "",
        theme: "dark",
      });
      expect(png === null || png.subarray(0, 4).equals(PNG_MAGIC)).toBe(true);
    },
    RENDER_TIMEOUT_MS,
  );

  it(
    "renders the real localized copy in every language",
    async () => {
      for (const lang of SUPPORTED_LANGUAGES) {
        const png = await renderRematchCard({
          overline: t(lang, "rematchCardOverline"),
          headline: t(lang, "rematchCardHeadline"),
          subline: t(lang, "rematchCardSubline"),
          theme: "dark",
        });
        expect(png, `${lang} failed to render`).not.toBeNull();
      }
    },
    RENDER_TIMEOUT_MS,
  );

  it(
    "renders the same bytes twice from a cold module — the motif is authored, not random",
    async () => {
      // `preference-layout.ts` states the rule: a
      // pattern re-rolled per render can never be reviewed twice and no test can
      // pin it. Resetting modules clears the motif cache, so this compares two
      // genuinely independent rasterizations rather than one cache hit.
      //
      // LIGHT on purpose. The shared film grain (`grainPng`, date-card/image.ts)
      // is real `Math.random()` noise, so a dark card is deliberately NOT
      // byte-reproducible across processes — that is the grain's whole job and
      // it is not this module's to fix. Light skips the grain, which leaves the
      // motif and the layout as the only variables, i.e. exactly what this rule
      // is about.
      vi.resetModules();
      const first = await (
        await import("./rematch-card.js")
      ).renderRematchCard({ ...SAMPLE, theme: "light" });
      vi.resetModules();
      const second = await (
        await import("./rematch-card.js")
      ).renderRematchCard({ ...SAMPLE, theme: "light" });

      expect(first).not.toBeNull();
      expect(first!.equals(second!)).toBe(true);
    },
    RENDER_TIMEOUT_MS,
  );

  it(
    "actually recolours per theme",
    async () => {
      // Cheap proof that `theme` reaches the motif and the palette rather than
      // being accepted and dropped — the two cards must not be byte-identical.
      const [dark, light] = await Promise.all([
        renderRematchCard({ ...SAMPLE, theme: "dark" }),
        renderRematchCard({ ...SAMPLE, theme: "light" }),
      ]);
      expect(dark!.equals(light!)).toBe(false);
    },
    RENDER_TIMEOUT_MS,
  );
});

describe("card copy", () => {
  it("never carries a price", () => {
    // A PNG is immutable and Telegram caches it, while the price lives in env
    // (`REMATCH_PRICE_USD_DISPLAY` / `REMATCH_STARS`). A figure baked into the
    // card would go stale silently on the one screen that asks for money — so
    // the price belongs in the caption and on the button, and only there.
    for (const lang of SUPPORTED_LANGUAGES) {
      const copy = [
        t(lang, "rematchCardOverline"),
        t(lang, "rematchCardHeadline"),
        t(lang, "rematchCardSubline"),
      ].join(" ");
      expect(copy, `${lang} card copy looks priced`).not.toMatch(/\d|[$€₴£]|⭐|\{price\}/);
    }
  });

  it("keeps the headline to two stacked lines", () => {
    // The layout accents the LAST line and is sized for two at 92px; a third
    // would overflow the text column silently, which satori never reports.
    for (const lang of SUPPORTED_LANGUAGES) {
      const lines = t(lang, "rematchCardHeadline").split("\n");
      expect(lines, `${lang} headline`).toHaveLength(2);
      expect(lines.every((line) => line.trim().length > 0)).toBe(true);
    }
  });
});
