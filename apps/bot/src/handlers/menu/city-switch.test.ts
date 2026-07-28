import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@gennety/db", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    profile: { findUnique: vi.fn() },
  },
}));

vi.mock("../../public/home-location.js", async () => {
  const actual = await vi.importActual<typeof import("../../public/home-location.js")>(
    "../../public/home-location.js",
  );
  return { ...actual, saveHomeLocationForUser: vi.fn() };
});

import { prisma } from "@gennety/db";
import { saveHomeLocationForUser } from "../../public/home-location.js";
import {
  handleCitySwitchConfirm,
  handleCitySwitchOpen,
  isMarketPending,
} from "./city-switch.js";

type MockFn = ReturnType<typeof vi.fn>;
const mUserFindUnique = (prisma.user as unknown as { findUnique: MockFn }).findUnique;
const mProfileFindUnique = (prisma.profile as unknown as { findUnique: MockFn })
  .findUnique;
const mSave = saveHomeLocationForUser as unknown as MockFn;

function createCtx() {
  return {
    from: { id: 111 },
    session: { language: "en" as const },
    answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
    reply: vi.fn().mockResolvedValue(undefined),
    editMessageReplyMarkup: vi.fn().mockResolvedValue(undefined),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mUserFindUnique.mockResolvedValue({ id: "u1" });
});

describe("isMarketPending", () => {
  it("flags only a city Gennety has not launched", () => {
    expect(isMarketPending("de:berlin")).toBe(true);
    expect(isMarketPending("ua:kyiv")).toBe(false);
    // No city yet = still onboarding, not a pending market.
    expect(isMarketPending(null)).toBe(false);
  });
});

describe("handleCitySwitchOpen", () => {
  it("explains the situation and offers the one-tap switch", async () => {
    mProfileFindUnique.mockResolvedValue({ homeCity: "Berlin", homeCityKey: "de:berlin" });
    const ctx = createCtx();

    await handleCitySwitchOpen(ctx as never);

    const [text, options] = ctx.reply.mock.calls[0]!;
    expect(text).toContain("Berlin");
    expect(JSON.stringify(options.reply_markup)).toContain("menu:city:switch");
  });

  it("is a no-op card for a user already in a launched market", async () => {
    mProfileFindUnique.mockResolvedValue({ homeCity: "Kyiv", homeCityKey: "ua:kyiv" });
    const ctx = createCtx();

    await handleCitySwitchOpen(ctx as never);

    const [, options] = ctx.reply.mock.calls[0]!;
    expect(options).toBeUndefined();
  });
});

describe("handleCitySwitchConfirm", () => {
  it("moves the dating city to the launched market and drops the keyboard", async () => {
    const ctx = createCtx();

    await handleCitySwitchConfirm(ctx as never);

    expect(mSave).toHaveBeenCalledWith(
      "u1",
      expect.objectContaining({ homeCityKey: "ua:kyiv", homeCity: "Kyiv" }),
    );
    expect(ctx.editMessageReplyMarkup).toHaveBeenCalled();
    expect(ctx.reply.mock.calls[0]![0]).toMatch(/Kyiv/);
  });

  it("says so instead of claiming success when the save fails", async () => {
    mSave.mockRejectedValueOnce(new Error("db down"));
    const ctx = createCtx();

    await handleCitySwitchConfirm(ctx as never);

    expect(ctx.reply.mock.calls[0]![0]).toMatch(/Couldn't switch/);
    expect(ctx.editMessageReplyMarkup).not.toHaveBeenCalled();
  });
});
