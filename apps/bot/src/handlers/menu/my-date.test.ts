import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@gennety/db", () => ({
  prisma: { match: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) } },
}));

vi.mock("../../config.js", () => ({
  env: {
    WEBAPP_URL: "https://test.invalid/calendar",
    DATE_CARD_FEATURE_ENABLED: true,
    VENUE_CHANGE_FEATURE_ENABLED: true,
    COORDINATION_FEATURE_ENABLED: true,
    TICKET_FEATURE_ENABLED: true,
  },
}));

vi.mock("../../services/active-match.js", () => ({
  findActiveMatchForTelegramId: vi.fn(),
}));

vi.mock("../../services/date-card/index.js", () => ({
  renderDateCard: vi.fn(),
  buildShareButton: vi.fn((matchId: string) => ({
    text: "Share",
    callback_data: `datecard:share:${matchId}`,
  })),
}));

vi.mock("../../services/analysis-status.js", () => ({
  dateCardSteps: vi.fn().mockReturnValue([]),
}));

vi.mock("../../services/ai-stream.js", () => ({
  runStatusSequence: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../services/coordination.js", () => ({
  isProxyOpen: vi.fn().mockReturnValue(false),
}));

vi.mock("../../services/venue-change.js", () => ({
  evaluateVenueBoardEligibility: vi.fn().mockReturnValue({ ok: true, side: "A" }),
}));

vi.mock("../matching/venue-change.js", () => ({
  shouldOfferVenueChange: vi.fn().mockReturnValue(true),
  buildVenueChangeButton: vi.fn((matchId: string) => ({
    text: "Change venue",
    web_app: { url: `https://test.invalid/venue-change.html?match=${matchId}` },
  })),
}));

import { prisma } from "@gennety/db";
import { findActiveMatchForTelegramId } from "../../services/active-match.js";
import { renderDateCard } from "../../services/date-card/index.js";
import { isProxyOpen } from "../../services/coordination.js";
import { handleMyDate } from "./my-date.js";

const mActive = findActiveMatchForTelegramId as ReturnType<typeof vi.fn>;
const mRender = renderDateCard as ReturnType<typeof vi.fn>;
const mProxyOpen = isProxyOpen as ReturnType<typeof vi.fn>;
const mUpdate = prisma.match.updateMany as ReturnType<typeof vi.fn>;

function scheduledActive(over: { match?: Record<string, unknown> } = {}) {
  return {
    side: "A" as const,
    self: { id: "uid-A", theme: "dark", firstName: "Alice", telegramId: 1001n, language: "en", photos: [] },
    partner: { id: "uid-B", theme: "dark", firstName: "Bob", telegramId: 1002n, language: "en", photos: ["b-photo"] },
    match: {
      id: "match-1",
      status: "scheduled",
      agreedTime: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000),
      venueName: "Blur Cafe",
      venueAddress: "1 Main St",
      venueGoogleMapsUri: "https://maps.google.com/?q=blur",
      venueLat: 50.4,
      venueLng: 30.5,
      venuePhotoUrl: null,
      venuePhotoName: null,
      proxyOpenedAt: null,
      proxyClosedAt: null,
      proxyClosesAt: null,
      venueChangeStatus: null,
      ticketStatus: null,
      dateCardFileIdA: null,
      dateCardFileIdB: null,
      ...over.match,
    },
  };
}

function createCtx() {
  const sentPhoto = { photo: [{ file_id: "small" }, { file_id: "big-file-id" }] };
  return {
    session: { language: "en" },
    from: { id: 1001 },
    chat: { id: 1001 },
    answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
    reply: vi.fn().mockResolvedValue(undefined),
    replyWithPhoto: vi.fn().mockResolvedValue(sentPhoto),
    replyWithMediaGroup: vi.fn().mockResolvedValue(undefined),
    api: {},
  } as any;
}

describe("handleMyDate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mProxyOpen.mockReturnValue(false);
  });

  it("tells the user when there is no active date", async () => {
    mActive.mockResolvedValue(null);
    const ctx = createCtx();
    await handleMyDate(ctx);
    expect(ctx.answerCallbackQuery).toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledOnce();
    expect(ctx.replyWithPhoto).not.toHaveBeenCalled();
  });

  it("re-sends the cached date card instantly (no re-render)", async () => {
    mActive.mockResolvedValue(scheduledActive({ match: { dateCardFileIdA: "cached-file-id" } }));
    const ctx = createCtx();
    await handleMyDate(ctx);

    expect(ctx.replyWithPhoto).toHaveBeenCalledOnce();
    const [photoArg, opts] = ctx.replyWithPhoto.mock.calls[0];
    expect(photoArg).toBe("cached-file-id");
    expect(opts.protect_content).toBe(true);
    expect(mRender).not.toHaveBeenCalled();
    expect(mUpdate).not.toHaveBeenCalled();

    const kb = JSON.stringify(opts.reply_markup.inline_keyboard);
    expect(kb).toContain("emerg:start:match-1");
    expect(kb).toContain("report:open:match-1");
    expect(kb).toContain("menu:back");
    expect(kb).toContain("datecard:share:match-1");
  });

  it("marks the cancel button danger-styled", async () => {
    mActive.mockResolvedValue(scheduledActive({ match: { dateCardFileIdA: "cached-file-id" } }));
    const ctx = createCtx();
    await handleMyDate(ctx);
    const rows = ctx.replyWithPhoto.mock.calls[0][1].reply_markup.inline_keyboard;
    const cancel = rows.flat().find((b: any) => b.callback_data === "emerg:start:match-1");
    expect(cancel.style).toBe("danger");
  });

  it("renders fresh and caches the file_id when none is stored", async () => {
    mActive.mockResolvedValue(scheduledActive());
    mRender.mockResolvedValue(Buffer.from("png-bytes"));
    const ctx = createCtx();
    await handleMyDate(ctx);

    expect(mRender).toHaveBeenCalledOnce();
    expect(ctx.replyWithPhoto).toHaveBeenCalledOnce();
    // Largest rendition's file_id is persisted for next time.
    expect(mUpdate).toHaveBeenCalledOnce();
    expect(mUpdate.mock.calls[0][0].data).toEqual({ dateCardFileIdA: "big-file-id" });
    expect(mUpdate.mock.calls[0][0].where).toEqual({
      id: "match-1",
      userA: { id: "uid-A", language: "en", theme: "dark" },
    });
  });

  it("shows an Enter chat button only while the proxy window is open", async () => {
    mProxyOpen.mockReturnValue(true);
    mActive.mockResolvedValue(scheduledActive({ match: { dateCardFileIdA: "cached-file-id" } }));
    const ctx = createCtx();
    await handleMyDate(ctx);
    const kb = JSON.stringify(ctx.replyWithPhoto.mock.calls[0][1].reply_markup.inline_keyboard);
    expect(kb).toContain("coord:enter:match-1");
  });

  it("surfaces the map picker for the venue-negotiation stage", async () => {
    mActive.mockResolvedValue(
      scheduledActive({ match: { status: "negotiating_venue", venueName: null, agreedTime: null } }),
    );
    const ctx = createCtx();
    await handleMyDate(ctx);
    expect(ctx.replyWithPhoto).not.toHaveBeenCalled();
    const kb = JSON.stringify(ctx.reply.mock.calls[0][1].reply_markup.inline_keyboard);
    expect(kb).toContain("location.html");
    expect(kb).toContain("report:open:match-1");
  });

  it("suppresses the calendar button while the ticket gate is still open", async () => {
    mActive.mockResolvedValue(
      scheduledActive({
        match: { status: "negotiating", venueName: null, agreedTime: null, ticketStatus: "pending" },
      }),
    );
    const ctx = createCtx();
    await handleMyDate(ctx);
    const kb = JSON.stringify(ctx.reply.mock.calls[0][1].reply_markup.inline_keyboard);
    expect(kb).toContain("ticket.html?match=match-1");
    expect(kb).not.toContain('"https://test.invalid/calendar?');
  });

  it.each(["pending", "partial", "refund_pending"])(
    "restores the match-specific Ticket CTA for %s",
    async (ticketStatus) => {
      mActive.mockResolvedValue(
        scheduledActive({
          match: { status: "negotiating", venueName: null, agreedTime: null, ticketStatus },
        }),
      );
      const ctx = createCtx();
      await handleMyDate(ctx);
      const kb = JSON.stringify(ctx.reply.mock.calls[0][1].reply_markup.inline_keyboard);
      expect(kb).toContain("ticket.html?match=match-1");
      expect(kb).toContain("lang=en");
      expect(kb).toContain("theme=dark");
    },
  );

  it.each([null, "completed", "refunded", "expired"])(
    "restores Calendar for terminal ticket status %s",
    async (ticketStatus) => {
      mActive.mockResolvedValue(
        scheduledActive({
          match: { status: "negotiating", venueName: null, agreedTime: null, ticketStatus },
        }),
      );
      const ctx = createCtx();
      await handleMyDate(ctx);
      const kb = JSON.stringify(ctx.reply.mock.calls[0][1].reply_markup.inline_keyboard);
      expect(kb).toContain("https://test.invalid/calendar?match=match-1");
      expect(kb).toContain("lang=en");
      expect(kb).toContain("theme=dark");
      expect(kb).not.toContain("ticket.html");
    },
  );
});
