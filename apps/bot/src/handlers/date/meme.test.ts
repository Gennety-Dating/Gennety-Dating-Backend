import { describe, it, expect, vi, beforeEach } from "vitest";
import { t } from "@gennety/shared";

const { mockFindUser, mockResolveSubject, mockAnswerFor, mockDeliver } = vi.hoisted(() => ({
  mockFindUser: vi.fn(),
  mockResolveSubject: vi.fn(),
  mockAnswerFor: vi.fn(),
  mockDeliver: vi.fn().mockResolvedValue(true),
}));

vi.mock("@gennety/db", () => ({ prisma: { user: { findUnique: mockFindUser } } }));
vi.mock("../../demo/config.js", () => ({ DEMO_MODE_ENABLED: false }));
vi.mock("../../services/meme-reveal.js", () => ({
  memeRevealFeatureLive: () => true,
  resolveMemeSubject: mockResolveSubject,
  memeAnswerFor: mockAnswerFor,
  deliverMemeReveal: mockDeliver,
}));

import { handleMemeShow } from "./meme.js";

const SUBJECT = { subjectUserId: "u-b", subjectFirstName: "Kate" };

function createCtx() {
  return {
    from: { id: 1001 },
    chat: { id: 1001 },
    callbackQuery: { data: "meme:show:m1" },
    api: {},
    answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
    editMessageReplyMarkup: vi.fn().mockResolvedValue(undefined),
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFindUser.mockResolvedValue({ id: "u-a", language: "en" });
  mockResolveSubject.mockResolvedValue(SUBJECT);
  mockAnswerFor.mockResolvedValue({ ...SUBJECT, fileId: "f", kind: "photo", description: "d", sourceUrl: null });
});

describe("handleMemeShow", () => {
  /**
   * A card from a match that is no longer on, or across a block, is dead — and
   * says so without saying why: "they re-answered in words" would be a lie, and
   * anything more specific could tell a blocked person they were blocked.
   */
  it("answers a card with no one to show as inactive, and reveals nothing", async () => {
    mockResolveSubject.mockResolvedValue(null);
    const ctx = createCtx();

    await handleMemeShow(ctx);

    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: t("en", "memeRevealUnavailable") });
    expect(ctx.editMessageReplyMarkup).toHaveBeenCalledWith({});
    expect(mockAnswerFor).not.toHaveBeenCalled();
    expect(mockDeliver).not.toHaveBeenCalled();
  });

  it("still tells a live pair when the meme itself was withdrawn", async () => {
    mockAnswerFor.mockResolvedValue(null);
    const ctx = createCtx();

    await handleMemeShow(ctx);

    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: t("en", "memeRevealGone") });
    expect(mockDeliver).not.toHaveBeenCalled();
  });

  it("reveals the meme for a live, unblocked pair", async () => {
    const ctx = createCtx();

    await handleMemeShow(ctx);

    expect(mockResolveSubject).toHaveBeenCalledWith("m1", "u-a");
    expect(mockDeliver).toHaveBeenCalledWith(ctx.api, 1001, "en", expect.objectContaining(SUBJECT));
  });
});
