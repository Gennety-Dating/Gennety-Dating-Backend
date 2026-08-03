import { describe, it, expect } from "vitest";

import {
  referralCardImage,
  referralCardContentVersion,
  renderReferralCard,
  type ReferralCardInput,
} from "./index.js";

/**
 * Satori parses the bundled fonts and resvg rasterizes the butterfly + five
 * portrait tiles on the first render — several seconds cold, and more under
 * full-suite parallel load. Same generous budget the other card render tests
 * carry, for the same reason.
 */
const RENDER_TIMEOUT_MS = 60_000;

const BASE: ReferralCardInput = { referrerName: "Глеб", giftMonths: 1, lang: "ru" };

/** A JPEG starts with SOI and ends with EOI; a truncated one has no EOI. */
function isCompleteJpeg(buf: Buffer): boolean {
  return (
    buf.length > 4 &&
    buf[0] === 0xff &&
    buf[1] === 0xd8 &&
    buf[buf.length - 2] === 0xff &&
    buf[buf.length - 1] === 0xd9
  );
}

describe("referralCardImage", () => {
  it(
    "encodes a complete JPEG — Telegram's photo_url contract, and the format " +
      "whose end marker proves the bytes are whole",
    async () => {
      const card = await referralCardImage(BASE);
      expect(card).not.toBeNull();
      expect(isCompleteJpeg(card!.jpeg)).toBe(true);
    },
    RENDER_TIMEOUT_MS,
  );

  it(
    "reports the card's real dimensions so the result never makes Telegram probe",
    async () => {
      const card = await referralCardImage(BASE);
      expect(card!.width).toBe(900);
      expect(card!.height).toBe(1000);
    },
    RENDER_TIMEOUT_MS,
  );

  it(
    "is dramatically smaller than the PNG — the transfer size is what stops a " +
      "slow link delivering a half-decoded card",
    async () => {
      const [card, png] = await Promise.all([referralCardImage(BASE), renderReferralCard(BASE)]);
      expect(png).not.toBeNull();
      // ~93 KB vs ~453 KB in practice; assert the order of magnitude, not the
      // exact encoder output, so a font or portrait tweak can't fail this.
      expect(card!.jpeg.length).toBeLessThan(png!.length / 3);
    },
    RENDER_TIMEOUT_MS,
  );

  it(
    "memoizes, so the public /card endpoint Telegram fetches never re-renders",
    async () => {
      const first = await referralCardImage(BASE);
      const second = await referralCardImage(BASE);
      // Same object identity: served straight from the cache, no second render.
      expect(second).toBe(first);
    },
    RENDER_TIMEOUT_MS,
  );

  it(
    "keys the cache by content, so one referrer never gets another's card",
    async () => {
      const anna = await referralCardImage({ ...BASE, referrerName: "Anna" });
      const boris = await referralCardImage({ ...BASE, referrerName: "Boris" });
      expect(anna!.version).not.toBe(boris!.version);
      expect(anna!.jpeg.equals(boris!.jpeg)).toBe(false);
    },
    RENDER_TIMEOUT_MS,
  );
});

describe("referralCardContentVersion", () => {
  it("is stable for identical content", () => {
    expect(referralCardContentVersion(BASE)).toBe(referralCardContentVersion(BASE));
  });

  it.each([
    ["name", { referrerName: "Anna" }],
    ["language", { lang: "en" as const }],
    ["gift months", { giftMonths: 3 }],
  ])(
    "changes when the %s changes, so Telegram's per-URL media cache is busted",
    (_label, patch) => {
      expect(referralCardContentVersion({ ...BASE, ...patch })).not.toBe(
        referralCardContentVersion(BASE),
      );
    },
  );

  it("is URL-safe and short enough to sit in a query string", () => {
    expect(referralCardContentVersion(BASE)).toMatch(/^[0-9a-f]{12}$/);
  });
});
