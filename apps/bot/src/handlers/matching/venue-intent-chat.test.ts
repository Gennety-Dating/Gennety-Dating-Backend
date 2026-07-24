import { describe, it, expect, vi, beforeEach } from "vitest";
import type { InlineKeyboardButton } from "grammy/types";

vi.mock("@gennety/db", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    match: { findFirst: vi.fn() },
  },
}));
vi.mock("../../services/venue-intent-v2.js", () => ({
  getVenueChatDraft: vi.fn(),
  saveVenueChatDraft: vi.fn(),
  confirmVenueIntent: vi.fn(),
}));
// Keep the real chip constants (VENUE_EXPERIENCES etc.) but make `tv` echo the
// key so the "waiting for partner" branch is deterministically assertable.
vi.mock("@gennety/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@gennety/shared")>();
  return { ...actual, tv: vi.fn((_lang: unknown, key: string) => key) };
});

import { prisma } from "@gennety/db";
import {
  buildVibeChipKeyboard,
  handleVibeChipCallback,
} from "./venue-intent-chat.js";
import {
  getVenueChatDraft,
  saveVenueChatDraft,
  confirmVenueIntent,
} from "../../services/venue-intent-v2.js";

const mUser = prisma.user as unknown as { findUnique: ReturnType<typeof vi.fn> };
const mMatch = prisma.match as unknown as { findFirst: ReturnType<typeof vi.fn> };
const mGet = getVenueChatDraft as unknown as ReturnType<typeof vi.fn>;
const mSave = saveVenueChatDraft as unknown as ReturnType<typeof vi.fn>;
const mConfirm = confirmVenueIntent as unknown as ReturnType<typeof vi.fn>;

function draft(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    rawText: "quiet cafe",
    experiences: ["conversation"],
    ambiences: ["quiet"],
    formats: ["seated"],
    hardConstraints: { dietary: [], alcoholFree: false, stepFree: false, setting: null, maxPrice: null, maxCommuteKm: 8 },
    parserConfidence: 0.8,
    parserVersion: "venue-intent-v2",
    state: "draft",
    origin: { lat: 50.45, lng: 30.52, address: "Kyiv" },
    interpretedAt: "2026-07-23T00:00:00.000Z",
    confirmedAt: null,
    manualConfirmationRequired: false,
    ...overrides,
  };
}

function ctx(data: string): any {
  return {
    callbackQuery: { data },
    from: { id: 1001 },
    session: { language: "en" },
    answerCallbackQuery: vi.fn().mockResolvedValue(true),
    editMessageText: vi.fn().mockResolvedValue(true),
    editMessageReplyMarkup: vi.fn().mockResolvedValue(true),
    reply: vi.fn().mockResolvedValue({}),
  };
}

const cb = (b: InlineKeyboardButton): string | undefined =>
  (b as { callback_data?: string }).callback_data;

beforeEach(() => vi.clearAllMocks());

describe("buildVibeChipKeyboard", () => {
  it("marks active chips with ✓, emits vic:t callbacks for all 19 chips, plus a confirm button", () => {
    const kb = buildVibeChipKeyboard(draft() as never, "en");
    const flat = kb.inline_keyboard.flat();

    const conv = flat.find((b) => cb(b) === "vic:t:e:conversation")!;
    expect((conv as { text: string }).text).toContain("✓");
    const meal = flat.find((b) => cb(b) === "vic:t:e:meal_discovery")!;
    expect((meal as { text: string }).text).not.toContain("✓");

    expect(flat.filter((b) => cb(b)?.startsWith("vic:t:")).length).toBe(8 + 6 + 5);
    expect(flat.some((b) => cb(b) === "vic:ok")).toBe(true);
  });
});

describe("handleVibeChipCallback — confirm", () => {
  it("confirms the draft (with its origin) and, when the partner has NOT confirmed yet, shows the classic 'waiting for the other side' message", async () => {
    mUser.findUnique.mockResolvedValue({ id: "u1" });
    mMatch.findFirst.mockResolvedValue({ id: "m1" });
    mGet.mockResolvedValue({ side: "A", draft: draft() });
    mConfirm.mockResolvedValue({ partnerSubmitted: false });

    const c = ctx("vic:ok");
    await handleVibeChipCallback(c);

    expect(mConfirm).toHaveBeenCalledWith(
      "m1",
      "u1",
      expect.objectContaining({
        experiences: ["conversation"],
        origin: { lat: 50.45, lng: 30.52, address: "Kyiv" },
      }),
    );
    // `tv` is mocked to echo the key → the waiting line is the classic venueWaitingPeer.
    expect(c.editMessageText).toHaveBeenCalledWith("venueWaitingPeer");
  });

  it("shows the 'lining up the spot' ack once the partner has also confirmed (finalize runs)", async () => {
    mUser.findUnique.mockResolvedValue({ id: "u1" });
    mMatch.findFirst.mockResolvedValue({ id: "m1" });
    mGet.mockResolvedValue({ side: "A", draft: draft() });
    mConfirm.mockResolvedValue({ partnerSubmitted: true });

    const c = ctx("vic:ok");
    await handleVibeChipCallback(c);

    const arg = c.editMessageText.mock.calls[0][0];
    expect(arg).not.toBe("venueWaitingPeer");
    expect(arg).toContain("✅");
  });

  it("blocks confirm when no experience is selected (alert, no confirm call)", async () => {
    mUser.findUnique.mockResolvedValue({ id: "u1" });
    mMatch.findFirst.mockResolvedValue({ id: "m1" });
    mGet.mockResolvedValue({ side: "A", draft: draft({ experiences: [] }) });

    const c = ctx("vic:ok");
    await handleVibeChipCallback(c);

    expect(mConfirm).not.toHaveBeenCalled();
    expect(c.answerCallbackQuery).toHaveBeenCalledWith(
      expect.objectContaining({ show_alert: true }),
    );
  });
});

describe("handleVibeChipCallback — toggle", () => {
  it("adds a chip and re-renders the keyboard in place", async () => {
    mUser.findUnique.mockResolvedValue({ id: "u1" });
    mMatch.findFirst.mockResolvedValue({ id: "m1" });
    mGet.mockResolvedValue({ side: "A", draft: draft() });
    mSave.mockResolvedValue(draft({ experiences: ["conversation", "coffee_treats"] }));

    const c = ctx("vic:t:e:coffee_treats");
    await handleVibeChipCallback(c);

    expect(mSave).toHaveBeenCalledWith(
      "m1",
      "u1",
      expect.objectContaining({ experiences: ["conversation", "coffee_treats"] }),
    );
    expect(c.editMessageReplyMarkup).toHaveBeenCalled();
  });

  it("no-ops (with a notice) when the actor has no active negotiating_venue match", async () => {
    mUser.findUnique.mockResolvedValue({ id: "u1" });
    mMatch.findFirst.mockResolvedValue(null);

    const c = ctx("vic:t:e:coffee_treats");
    await handleVibeChipCallback(c);

    expect(mSave).not.toHaveBeenCalled();
    expect(c.answerCallbackQuery).toHaveBeenCalled();
  });
});
