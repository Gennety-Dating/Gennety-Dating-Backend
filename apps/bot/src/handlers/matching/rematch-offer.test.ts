import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Delivery of the Rematch offer DM (PRODUCT_SPEC §3.11) — the card, and the
 * four ways it must get out of the way.
 *
 * This DM is the ONLY way a paid feature is reached at all (D4: deliberately no
 * menu row), so decorating it may not make it more fragile. Every failure below
 * has to come back as exactly the plain text message that shipped before the
 * card existed, and the return value has to keep meaning "an offer reached him"
 * rather than "a picture did".
 *
 * `matching.test.ts` mocks this whole module out, so the real function is only
 * exercised here.
 */

vi.mock("@gennety/db", () => ({ prisma: { user: { findUnique: vi.fn() } } }));
vi.mock("../../config.js", () => ({
  env: { REMATCH_FEATURE_ENABLED: true, REMATCH_PRICE_USD_DISPLAY: "$2.99" },
}));
vi.mock("../../services/rematch.js", () => ({ checkRematchEligibility: vi.fn() }));
vi.mock("../../services/rematch-card.js", () => ({ renderRematchCard: vi.fn() }));

import { prisma } from "@gennety/db";
import { env } from "../../config.js";
import { checkRematchEligibility } from "../../services/rematch.js";
import { renderRematchCard } from "../../services/rematch-card.js";
import { sendRematchOfferIfEligible } from "./rematch.js";

const findUnique = prisma.user.findUnique as unknown as ReturnType<typeof vi.fn>;
const eligibility = checkRematchEligibility as unknown as ReturnType<typeof vi.fn>;
const render = renderRematchCard as unknown as ReturnType<typeof vi.fn>;

const FAKE_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]);

function api() {
  return {
    sendPhoto: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn().mockResolvedValue(undefined),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  (env as { REMATCH_PRICE_USD_DISPLAY: string }).REMATCH_PRICE_USD_DISPLAY = "$2.99";
  eligibility.mockResolvedValue({ ok: true });
  findUnique.mockResolvedValue({ telegramId: 111n, language: "ru", theme: "dark" });
  render.mockResolvedValue(FAKE_PNG);
});

describe("rematch offer delivery", () => {
  it("leads with the card, captioned with the offer copy and carrying the buy button", async () => {
    const a = api();
    const sent = await sendRematchOfferIfEligible(a as never, "buyer-1", "failed");

    expect(sent).toBe(true);
    expect(a.sendPhoto).toHaveBeenCalledTimes(1);
    expect(a.sendMessage).not.toHaveBeenCalled();

    const [chatId, , opts] = a.sendPhoto.mock.calls[0]!;
    expect(chatId).toBe(111);
    // The terms and the price live in the caption; the card carries neither.
    expect((opts as { caption: string }).caption).toContain("$2.99");
    expect((opts as { reply_markup?: unknown }).reply_markup).toBeDefined();
  });

  it("does not protect the card — there is no partner on it to protect", async () => {
    // Every other card send in the product sets `protect_content` because it
    // renders a face (§3.7a). At offer time nobody has been picked yet, so the
    // motif is abstract and protecting it would only black it out of a screen
    // recording for nothing.
    const a = api();
    await sendRematchOfferIfEligible(a as never, "buyer-1", "neutral");
    expect(a.sendPhoto.mock.calls[0]![2]).not.toHaveProperty("protect_content");
  });

  it("renders in the recipient's own theme", async () => {
    findUnique.mockResolvedValueOnce({ telegramId: 111n, language: "ru", theme: "light" });
    const a = api();
    await sendRematchOfferIfEligible(a as never, "buyer-1", "neutral");
    expect(render.mock.calls[0]![0]).toMatchObject({ theme: "light" });
  });

  it("defaults to dark for a row with no theme recorded", async () => {
    findUnique.mockResolvedValueOnce({ telegramId: 111n, language: "ru", theme: null });
    const a = api();
    await sendRematchOfferIfEligible(a as never, "buyer-1", "neutral");
    expect(render.mock.calls[0]![0]).toMatchObject({ theme: "dark" });
  });

  it("falls back to text when the render returns null", async () => {
    render.mockResolvedValueOnce(null);
    const a = api();
    const sent = await sendRematchOfferIfEligible(a as never, "buyer-1", "famine");

    expect(sent).toBe(true);
    expect(a.sendPhoto).not.toHaveBeenCalled();
    expect(a.sendMessage).toHaveBeenCalledTimes(1);
    expect(a.sendMessage.mock.calls[0]![1]).toContain("$2.99");
  });

  it("falls back to text when sendPhoto is rejected", async () => {
    const a = api();
    a.sendPhoto.mockRejectedValueOnce(new Error("PHOTO_INVALID_DIMENSIONS"));
    const sent = await sendRematchOfferIfEligible(a as never, "buyer-1", "failed");

    expect(sent).toBe(true);
    expect(a.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("skips the card outright when the caption would be truncated", async () => {
    // Telegram caps a photo caption at 1024 and silently truncates past it. The
    // caption carries the terms and the price, so a cut one is worse than no
    // card — and the render is not even attempted, because it could not be used.
    // The real copy is nowhere near the limit; the guard exists because the copy
    // is localized and translations grow.
    (env as { REMATCH_PRICE_USD_DISPLAY: string }).REMATCH_PRICE_USD_DISPLAY = "x".repeat(1200);
    const a = api();
    const sent = await sendRematchOfferIfEligible(a as never, "buyer-1", "neutral");

    expect(sent).toBe(true);
    expect(render).not.toHaveBeenCalled();
    expect(a.sendPhoto).not.toHaveBeenCalled();
    expect(a.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("reports failure only when nothing reached him at all", async () => {
    const a = api();
    a.sendPhoto.mockRejectedValueOnce(new Error("bot was blocked by the user"));
    a.sendMessage.mockRejectedValueOnce(new Error("bot was blocked by the user"));

    await expect(sendRematchOfferIfEligible(a as never, "buyer-1", "failed")).resolves.toBe(false);
  });

  it("sends nothing at all when he may not buy — a CTA that fails on tap is worse", async () => {
    eligibility.mockResolvedValueOnce({ ok: false, reason: "cooldown" });
    const a = api();

    await expect(sendRematchOfferIfEligible(a as never, "buyer-1", "failed")).resolves.toBe(false);
    expect(render).not.toHaveBeenCalled();
    expect(a.sendPhoto).not.toHaveBeenCalled();
    expect(a.sendMessage).not.toHaveBeenCalled();
  });

  it("skips a mobile-only account — Stars is a Telegram rail", async () => {
    findUnique.mockResolvedValueOnce({ telegramId: -778000001n, language: "ru", theme: "dark" });
    const a = api();

    await expect(sendRematchOfferIfEligible(a as never, "buyer-1", "failed")).resolves.toBe(false);
    expect(a.sendPhoto).not.toHaveBeenCalled();
    expect(a.sendMessage).not.toHaveBeenCalled();
  });
});
