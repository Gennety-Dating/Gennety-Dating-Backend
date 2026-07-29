import { describe, it, expect, vi, beforeEach } from "vitest";
import { t } from "@gennety/shared";

vi.mock("@gennety/db", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    match: { findUnique: vi.fn(), updateMany: vi.fn() },
  },
}));

vi.mock("../../services/match-decision-shared.js", () => ({
  boostAcceptedSidePriority: vi.fn().mockResolvedValue(true),
}));

vi.mock("../../utils/elo-calculator.js", () => ({
  applySilentIgnorePenalty: vi.fn().mockResolvedValue(495),
}));

import { prisma } from "@gennety/db";
import type { BotContext } from "../../session.js";
import {
  handleStallAskCancel,
  handleStallCancelBack,
  handleStallCancelConfirm,
  handleStallStillOn,
} from "./stall-checkin.js";

const SLOT = new Date("2026-08-01T16:00:00Z");
const ASKED = new Date("2026-07-29T09:00:00Z");

/**
 * Venue-phase row where side A (the caller in these tests) has NOT submitted
 * and has a live check-in on screen; side B is done and waiting.
 */
function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "match-1",
    status: "negotiating_venue",
    userAId: "user-a",
    userBId: "user-b",
    dispatchedAt: new Date("2026-07-27T12:00:00Z"),
    schedulingOpenedAt: new Date("2026-07-28T00:00:00Z"),
    venuePromptAskedAt: new Date("2026-07-28T06:00:00Z"),
    proposedTimes: [SLOT],
    availableTimesA: [SLOT],
    availableTimesB: [SLOT],
    vibeTextA: null,
    vibeLatA: null,
    vibeLngA: null,
    vibeTextB: "park walk",
    vibeLatB: 50.4,
    vibeLngB: 30.5,
    stallCheckInSentAtA: ASKED,
    stallCheckInSentAtB: null,
    stallConfirmedAtA: null,
    stallConfirmedAtB: null,
    venueNudge1SentAt: null,
    venueNudge2SentAt: null,
    userA: { id: "user-a", telegramId: 11n, language: "en", firstName: "Alice", theme: "dark" },
    userB: { id: "user-b", telegramId: 12n, language: "en", firstName: "Bob", theme: "dark" },
    ...overrides,
  };
}

function ctx(data: string) {
  return {
    callbackQuery: { data },
    from: { id: 11 },
    session: { language: "en" },
    answerCallbackQuery: vi.fn().mockResolvedValue({}),
    editMessageReplyMarkup: vi.fn().mockResolvedValue({}),
    reply: vi.fn().mockResolvedValue({}),
    api: { sendMessage: vi.fn().mockResolvedValue({}) },
  } as unknown as BotContext & {
    reply: ReturnType<typeof vi.fn>;
    editMessageReplyMarkup: ReturnType<typeof vi.fn>;
    api: { sendMessage: ReturnType<typeof vi.fn> };
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
    id: "user-a",
    language: "en",
  });
  (prisma.match.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(row());
  (prisma.match.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 1 });
});

describe("handleStallStillOn (🟢)", () => {
  it("commits immediately, with no confirmation step", async () => {
    const c = ctx("stall:ok:match-1");
    await handleStallStillOn(c);

    expect(prisma.match.updateMany).toHaveBeenCalledTimes(1);
    expect(c.reply).toHaveBeenCalledWith(t("en", "stallStillOnAck"));
    // The answered question stops looking open.
    expect(c.editMessageReplyMarkup).toHaveBeenCalled();
  });

  it("re-arms the question on the FIRST confirmation only", async () => {
    await handleStallStillOn(ctx("stall:ok:match-1"));

    // First green: clears the stamp so one more question can be sent.
    expect(prisma.match.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ stallCheckInSentAtA: null }),
      }),
    );

    vi.clearAllMocks();
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "user-a",
      language: "en",
    });
    (prisma.match.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 1 });
    // Second question, answered again — the chain must not reopen a third time.
    (prisma.match.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      row({
        stallCheckInSentAtA: new Date("2026-07-30T09:00:00Z"),
        stallConfirmedAtA: ASKED,
      }),
    );

    await handleStallStillOn(ctx("stall:ok:match-1"));

    const data = (prisma.match.updateMany as ReturnType<typeof vi.fn>).mock.calls[0][0].data;
    expect(data).not.toHaveProperty("stallCheckInSentAtA");
  });

  it("is a no-op on a replayed tap, so a stale button can't hold the match open", async () => {
    // Confirmed at/after the question it answers = already handled.
    (prisma.match.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      row({ stallConfirmedAtA: new Date(ASKED.getTime() + 1000) }),
    );

    const c = ctx("stall:ok:match-1");
    await handleStallStillOn(c);

    expect(prisma.match.updateMany).not.toHaveBeenCalled();
    expect(c.reply).not.toHaveBeenCalled();
  });

  it("is a no-op when no question was ever sent to this side", async () => {
    (prisma.match.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      row({ stallCheckInSentAtA: null }),
    );

    await handleStallStillOn(ctx("stall:ok:match-1"));
    expect(prisma.match.updateMany).not.toHaveBeenCalled();
  });

  it("reassures the partner who was left waiting", async () => {
    const c = ctx("stall:ok:match-1");
    await handleStallStillOn(c);

    expect(Number(c.api.sendMessage.mock.calls[0][0])).toBe(12);
    expect(String(c.api.sendMessage.mock.calls[0][1])).toContain("Alice");
  });

  it("stays silent toward a partner who is also not done", async () => {
    (prisma.match.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      row({ vibeTextB: null, vibeLatB: null, vibeLngB: null }),
    );

    const c = ctx("stall:ok:match-1");
    await handleStallStillOn(c);

    expect(c.api.sendMessage).not.toHaveBeenCalled();
  });

  it("ignores a caller who is not in the match", async () => {
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "stranger",
      language: "en",
    });

    await handleStallStillOn(ctx("stall:ok:match-1"));
    expect(prisma.match.updateMany).not.toHaveBeenCalled();
  });
});

describe("handleStallAskCancel (red)", () => {
  it("opens the confirmation card and mutates nothing", async () => {
    const c = ctx("stall:no:match-1");
    await handleStallAskCancel(c);

    expect(prisma.match.updateMany).not.toHaveBeenCalled();
    const [text, opts] = c.reply.mock.calls[0];
    expect(String(text)).toContain("Bob");
    expect(JSON.stringify(opts)).toContain("stall:kill:match-1");
    expect(JSON.stringify(opts)).toContain("stall:back:match-1");
  });

  it("does nothing once the match has left the planning phases", async () => {
    (prisma.match.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      row({ status: "scheduled" }),
    );

    const c = ctx("stall:no:match-1");
    await handleStallAskCancel(c);

    expect(c.reply).not.toHaveBeenCalled();
  });
});

describe("handleStallCancelBack", () => {
  it("changes no state", async () => {
    const c = ctx("stall:back:match-1");
    await handleStallCancelBack(c);

    expect(prisma.match.updateMany).not.toHaveBeenCalled();
    expect(c.reply).toHaveBeenCalledWith(t("en", "stallCancelAborted"));
  });
});

describe("handleStallCancelConfirm", () => {
  it("cancels and acknowledges to the person who confirmed", async () => {
    const c = ctx("stall:kill:match-1");
    await handleStallCancelConfirm(c);

    expect(prisma.match.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { status: "cancelled", emergencyCancelledBy: "user-a" },
      }),
    );
    expect(String(c.reply.mock.calls[0][0])).toContain("Bob");
  });

  it("says nothing when the cancellation didn't land", async () => {
    (prisma.match.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 0 });

    const c = ctx("stall:kill:match-1");
    await handleStallCancelConfirm(c);

    expect(c.reply).not.toHaveBeenCalled();
  });
});
