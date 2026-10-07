import { describe, it, expect } from "vitest";
import { Resvg } from "@resvg/resvg-js";

import {
  renderExpiryCard,
  EXPIRY_CARD_W,
  EXPIRY_CARD_H,
  type ExpiryCardVariant,
} from "./expiry-card.js";
import { hourglassArt } from "./expiry-card-hourglass.js";

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

const VARIANTS: ExpiryCardVariant[] = ["expired", "penalty", "peer_ignored", "missed_date"];

/**
 * Satori parses the bundled fonts (and resvg rasterizes the motifs) on the
 * first render. Cold, that is ~5s on its own; under full-suite parallel load it
 * runs past the 10s global default, so this file went red nondeterministically
 * while passing in isolation. Every render test here therefore carries the same
 * generous budget `time-card.test.ts` already uses for the same reason.
 */
const RENDER_TIMEOUT_MS = 60_000;

describe("renderExpiryCard", () => {
  it.each(VARIANTS)(
    "renders %s as a PNG",
    async (variant) => {
      const png = await renderExpiryCard({
        variant,
        overline: "OVERLINE",
        headline: "FIRST\nSECOND",
        subline: "One line.\nAnother line.",
        theme: "dark",
      });
      expect(png).not.toBeNull();
      expect(png!.subarray(0, 4)).toEqual(PNG_MAGIC);
    },
    RENDER_TIMEOUT_MS,
  );

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
  }, RENDER_TIMEOUT_MS);

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
  }, RENDER_TIMEOUT_MS);
});

describe("card dimensions", () => {
  it("is a square poster", () => {
    expect(EXPIRY_CARD_W).toBe(EXPIRY_CARD_H);
  });
});

/**
 * The hourglass is imported artwork rather than authored primitives, so these
 * guard the two things an export can silently get wrong. Both were true of the
 * original file and both fail loudly in production rather than at build time:
 * a baked colour is invisible on one theme, a background rect covers the glow.
 */
describe("hourglass artwork", () => {
  it("takes every colour from its arguments, so both themes recolour it", () => {
    const fills = [...hourglassArt("#8B253B", "#F5F5F5").matchAll(/fill="([^"]+)"/g)].map(
      (m) => m[1],
    );

    // The mark is ~30 paths; a handful would mean the import lost most of it.
    expect(fills.length).toBeGreaterThan(20);
    expect(new Set(fills)).toEqual(new Set(["#8B253B", "#F5F5F5"]));
  });

  it("carries no background of its own — the glow is painted behind it", () => {
    expect(hourglassArt("#8B253B", "#F5F5F5")).not.toContain("<rect");
  });

  it("fits the 300-unit art box the other three motifs are drawn in", () => {
    const BOX = 300;
    // Rendered with a BOX-wide margin on every side, because a canvas cropped
    // to the art box cannot show overflow — it clips it and reports a perfect
    // fit. Verified: this test only goes red for a mis-scaled mark once the
    // margin exists.
    const M = BOX;
    const N = BOX + 2 * M;
    // One colour throughout: the knockouts collapse into the silhouette, which
    // is the outline the fit actually has to respect.
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${-M} ${-M} ${N} ${N}" ` +
      `width="${N}" height="${N}">${hourglassArt("#000000", "#000000")}</svg>`;
    const { pixels } = new Resvg(svg, { fitTo: { mode: "width", value: N } }).render();

    let x0 = N, y0 = N, x1 = -1, y1 = -1;
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        if (pixels[(y * N + x) * 4 + 3] > 8) {
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
      }
    }
    // Back into art-box coordinates.
    [x0, x1, y0, y1] = [x0 - M, x1 - M, y0 - M, y1 - M];

    // Inside the box on both axes, and the height is spent rather than left as
    // margin — an hourglass is taller than it is wide, so a width-bound fit
    // would overflow it by a factor of two.
    expect(x0).toBeGreaterThanOrEqual(0);
    expect(x1).toBeLessThan(BOX);
    expect(y0).toBeGreaterThanOrEqual(0);
    expect(y1).toBeLessThan(BOX);
    expect(y1 - y0).toBeGreaterThan(BOX - 6);
    // Optically centred: an off-centre mark reads as a layout bug, not a style.
    expect(Math.abs((x0 + x1) / 2 - BOX / 2)).toBeLessThan(3);
  });
});
