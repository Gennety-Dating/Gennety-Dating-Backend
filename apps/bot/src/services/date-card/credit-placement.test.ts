import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import satori from "satori";
import {
  resolveCreditPlacement,
  measureRoboto,
  CONTENT_W,
  CREDIT_MIN_GAP,
} from "./credit-placement.js";
import { CARD_W, CARD_PADDING_X, CREDIT_TEXT, CREDIT_FONT_PX, ADDRESS_FONT_PX } from "./template.js";

/**
 * The credit sits beside the address only when it fits, and "fits" is decided
 * by measuring the address before the render. The 2026-08-20 pass called that
 * unanswerable; these tests are what make the answer honest rather than a
 * guess — the last one puts the measurement against satori's own layout.
 */

const read = (file: string) =>
  readFileSync(fileURLToPath(new URL(`../../assets/fonts/${file}`, import.meta.url)));

const fonts = [
  { name: "Roboto", data: read("Roboto-Regular.ttf"), weight: 400 as const, style: "normal" as const },
];

/**
 * satori's own laid-out advance width for `text`: lay it out beside a marker of
 * known width and read where the marker starts. satori has no metrics API, so
 * this is the only way to see what it actually decided.
 */
async function satoriWidth(text: string, px: number): Promise<number> {
  const W = 4000;
  const MARKER = 20;
  const el = {
    type: "div",
    props: {
      style: { display: "flex", width: `${W}px`, height: "120px" },
      children: [
        {
          type: "div",
          props: {
            style: { display: "flex", fontFamily: "Roboto", fontSize: `${px}px`, whiteSpace: "nowrap" },
            children: text,
          },
        },
        { type: "div", props: { style: { display: "flex", width: `${MARKER}px`, height: "10px" } } },
      ],
    },
  };
  const svg = await satori(el as never, { width: W, height: 120, fonts });
  const rects = [
    ...svg.matchAll(
      /<mask id="satori_om-id[^"]*"><rect x="([-\d.]+)" y="([-\d.]+)" width="([-\d.]+)" height="([-\d.]+)"/g,
    ),
  ].map((m) => ({ x: +m[1], w: +m[3] }));
  const marker = rects.find((r) => Math.round(r.w) === MARKER);
  if (!marker) throw new Error("marker not laid out");
  return marker.x;
}

const SHORT = "вул. Хрещатик, 14, Київ";
/** The address that produced the 2026-08-20 report. */
const REPORTED = "Маріїнський парк, вулиця Михайла Грушевського, Київ, 02000";

describe("credit placement", () => {
  it("reserves exactly the credit plus the minimum gap", () => {
    const placement = resolveCreditPlacement(SHORT);
    expect(placement.kind).toBe("inline");
    if (placement.kind !== "inline") return;

    const credit = measureRoboto(CREDIT_TEXT, CREDIT_FONT_PX);
    expect(credit).not.toBeNull();
    // The arithmetic is closed: address + credit + gap IS the content column,
    // so the row cannot overflow no matter what the address says.
    expect(placement.addressWidth + (credit ?? 0) + CREDIT_MIN_GAP).toBeCloseTo(CONTENT_W, 0);
    expect(CONTENT_W).toBe(CARD_W - 2 * CARD_PADDING_X);
  });

  it("puts a short address inline and a long one on the photo", () => {
    expect(resolveCreditPlacement(SHORT).kind).toBe("inline");
    expect(resolveCreditPlacement(REPORTED).kind).toBe("photo");
  });

  it("switches branch at the reserved width, not at a character count", () => {
    // Grow an address one character at a time and find where it flips. The flip
    // must land on the measured pixel bound — a character-count heuristic would
    // put it somewhere else entirely, since "iiii" and "WWWW" are 3.6x apart.
    let flippedAt: number | null = null;
    for (let n = 1; n <= 200; n++) {
      const address = "Ш".repeat(n);
      if (resolveCreditPlacement(address).kind === "photo") {
        flippedAt = n;
        break;
      }
    }
    expect(flippedAt).not.toBeNull();

    const bound = CONTENT_W - (measureRoboto(CREDIT_TEXT, CREDIT_FONT_PX) ?? 0) - CREDIT_MIN_GAP;
    const last = "Ш".repeat((flippedAt ?? 0) - 1);
    const first = "Ш".repeat(flippedAt ?? 0);
    expect(measureRoboto(last, ADDRESS_FONT_PX)).toBeLessThanOrEqual(bound);
    expect(measureRoboto(first, ADDRESS_FONT_PX)).toBeGreaterThan(bound);
  });

  it.each([
    ["latin", "Andriivskyi descent, 2B, Kyiv, 04070"],
    ["cyrillic", "вул. Велика Васильківська, 100, Київ, 03150"],
    ["narrow glyphs", "iiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiii"],
    ["wide glyphs", "WWWWWWWWWWWWWWWWWWWW"],
    ["the credit itself", CREDIT_TEXT],
  ])(
    "agrees with satori's own layout on %s",
    async (_label, text) => {
      // The whole conditional rests on canvas predicting satori. Measured here
      // rather than assumed: canvas must never OVER-report (that would let a
      // too-wide address inline), and must be within a pixel or two so the 40px
      // gap is a real margin rather than a hope. A font swap or a satori upgrade
      // that changed shaping would land here.
      for (const px of [ADDRESS_FONT_PX, CREDIT_FONT_PX]) {
        const canvas = measureRoboto(text, px);
        expect(canvas).not.toBeNull();
        const laid = await satoriWidth(text, px);
        expect(canvas ?? 0).toBeLessThanOrEqual(laid);
        expect(laid - (canvas ?? 0)).toBeLessThan(CREDIT_MIN_GAP / 4);
      }
    },
    60_000,
  );
});
