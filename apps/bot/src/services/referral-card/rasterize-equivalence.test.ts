import { afterAll, describe, expect, it, vi } from "vitest";
import { createCanvas } from "@napi-rs/canvas";
import { Resvg } from "@resvg/resvg-js";
import type { RenderJob } from "../render/jobs.js";

/**
 * The referral card's `Resvg.render()` moved from the request path into the
 * render pool. The bytes a referrer shares must not change, so this rasterizes
 * the very SVG the card handed to the pool the way the card did before — on
 * this thread, straight through resvg — and requires byte-identical PNG and
 * JPEG and the same reported dimensions.
 */

const jobs = vi.hoisted(() => [] as RenderJob[]);

vi.mock("../render/pool.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../render/pool.js")>();
  return {
    ...actual,
    runRenderJob: (job: RenderJob) => {
      jobs.push(job);
      return actual.runRenderJob(job);
    },
  };
});

import { shutdownRenderPool } from "../render/pool.js";
import { referralCardImage, renderReferralCard, type ReferralCardInput } from "./index.js";

const RENDER_TIMEOUT_MS = 60_000;

/** The pre-pool rasterization, verbatim. */
function rasterizeOnThisThread(svg: string) {
  return new Resvg(svg, {
    fitTo: { mode: "width", value: 900 },
    background: "#17090D",
  }).render();
}

/** The card's own SVG, as the last card job handed it to the pool. */
function lastCardSvg(kind: "svg-to-png" | "svg-to-rgba"): string {
  const job = [...jobs].reverse().find((j) => j.kind === kind && j.fitToWidth === 900);
  if (!job || (job.kind !== "svg-to-png" && job.kind !== "svg-to-rgba")) {
    throw new Error(`no ${kind} card job was recorded`);
  }
  return job.svg;
}

afterAll(async () => {
  await shutdownRenderPool();
});

describe("referral card rasterization through the render pool", () => {
  it.each<[string, ReferralCardInput]>([
    ["Cyrillic headline", { referrerName: "Глеб", giftTickets: 1, lang: "ru" }],
    ["Latin headline", { referrerName: "Anna", giftTickets: 3, lang: "en" }],
    ["generic kicker", { referrerName: null, giftTickets: 1, lang: "uk" }],
  ])(
    "encodes the same JPEG with the same dimensions (%s)",
    async (_label, input) => {
      const card = await referralCardImage(input);
      expect(card).not.toBeNull();

      const rendered = rasterizeOnThisThread(lastCardSvg("svg-to-rgba"));
      const canvas = createCanvas(rendered.width, rendered.height);
      const ctx = canvas.getContext("2d");
      const pixels = ctx.createImageData(rendered.width, rendered.height);
      pixels.data.set(rendered.pixels);
      ctx.putImageData(pixels, 0, 0);
      const expected = await canvas.encode("jpeg", 88);

      expect(card!.width).toBe(rendered.width);
      expect(card!.height).toBe(rendered.height);
      expect(card!.jpeg.equals(expected)).toBe(true);
    },
    RENDER_TIMEOUT_MS,
  );

  it(
    "renders the same PNG",
    async () => {
      const png = await renderReferralCard({ referrerName: "Глеб", giftTickets: 1, lang: "ru" });
      expect(png).not.toBeNull();
      const expected = Buffer.from(rasterizeOnThisThread(lastCardSvg("svg-to-png")).asPng());
      expect(png!.equals(expected)).toBe(true);
    },
    RENDER_TIMEOUT_MS,
  );
});
