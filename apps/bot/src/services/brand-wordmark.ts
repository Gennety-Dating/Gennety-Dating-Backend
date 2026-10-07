import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createCanvas, loadImage } from "@napi-rs/canvas";

/**
 * The drawn "Gennety" logotype for the rendered cards (2026-10-07).
 *
 * The cards used to TYPE the word — in Archivo Black or Unbounded — which gave
 * a similar word but not the brand mark: the logotype has its own proportions,
 * joins and "y" tail. This is the iOS `GennetyWordmark` asset itself
 * (888 × 220 alpha mask, `Packages/DesignSystem/…/gennety-wordmark.png`), so
 * the cards, the app and the site carry the same drawing.
 *
 * Like on iOS, the file is a MASK and the colour comes from the caller: one
 * asset serves the dark card, the light card and the burgundy one.
 */

export interface WordmarkImage {
  png: Buffer;
  width: number;
  height: number;
}

/** Canvas of the asset — the caller sets a width and takes the height from it. */
export const WORDMARK_ASPECT = 888 / 220;

/**
 * Where the cap height's middle sits on the canvas: the "y" hangs below the
 * baseline, so centring the box would lift the word. Same number as iOS.
 */
export const WORDMARK_CAP_CENTRE = 91.5 / 220;

const cache = new Map<string, Promise<WordmarkImage | null>>();

/** The logotype filled with `color`; `null` if the asset cannot be read. */
export function wordmarkPng(color: string): Promise<WordmarkImage | null> {
  let hit = cache.get(color);
  if (!hit) {
    hit = tint(color);
    cache.set(color, hit);
  }
  return hit;
}

async function tint(color: string): Promise<WordmarkImage | null> {
  try {
    const mask = await loadImage(
      readFileSync(fileURLToPath(new URL("../assets/brand/gennety-wordmark.png", import.meta.url))),
    );
    const canvas = createCanvas(mask.width, mask.height);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(mask, 0, 0);
    ctx.globalCompositeOperation = "source-in";
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, mask.width, mask.height);
    return { png: canvas.toBuffer("image/png"), width: mask.width, height: mask.height };
  } catch (err) {
    console.warn("[brand-wordmark] could not render the logotype:", err);
    return null;
  }
}

/** `data:` URI for a satori `<img>`. */
export function wordmarkSrc(mark: WordmarkImage): string {
  return `data:image/png;base64,${mark.png.toString("base64")}`;
}

/** Satori node shape, structurally compatible with every card's own `CardNode`. */
export interface WordmarkNode {
  type: string;
  props: { style: Record<string, unknown>; src: string };
}

/**
 * The logotype at `width` (height from the asset), or the card's own
 * `fallback` when the asset could not be read, so a card never loses its
 * brand line. The fallback is the word each card used to TYPE in its own
 * display face, which is why it is the caller's node and not one made here.
 */
export function wordmarkNode<T>(
  mark: WordmarkImage | null,
  width: number,
  fallback: T,
  extraStyle: Record<string, unknown> = {},
): WordmarkNode | T {
  if (!mark) return fallback;
  return {
    type: "img",
    props: {
      style: { width: `${width}px`, height: `${Math.round(width / WORDMARK_ASPECT)}px`, ...extraStyle },
      src: wordmarkSrc(mark),
    },
  };
}
