import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@gennety/db", () => ({
  prisma: {
    match: {
      findUnique: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  },
}));

vi.mock("../../config.js", () => ({
  env: {
    WEBAPP_URL: "https://test.invalid/calendar",
    TICKET_PAYMENT_WINDOW_HOURS: 1,
    TICKET_PRICE_CENTS: 699,
    TICKET_PAYMENT_MODE: "mock",
  },
}));

vi.mock("./scheduler.js", () => ({
  startScheduling: vi.fn().mockResolvedValue(undefined),
}));

import { prisma } from "@gennety/db";
import { t } from "@gennety/shared";
import { sendTicketOffer, applyTicketPayment } from "./ticket-gate.js";
import { startScheduling } from "./scheduler.js";

type MockFn = ReturnType<typeof vi.fn>;
const mMatch = prisma.match as unknown as {
  findUnique: MockFn;
  update: MockFn;
  updateMany: MockFn;
};
const mStartScheduling = startScheduling as unknown as MockFn;

function createApi() {
  let nextMessageId = 500;
  return {
    sendMessage: vi.fn().mockImplementation(async () => ({
      message_id: nextMessageId++,
    })),
    editMessageText: vi.fn().mockResolvedValue(undefined),
  } as any;
}

function matchRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "match-1",
    status: "negotiating",
    ticketStatus: "pending",
    ticketPriceCents: 699,
    ticketPaidA: null,
    ticketPaidB: null,
    paidForPartnerByA: false,
    paidForPartnerByB: false,
    ticketExpiresAt: null,
    calendarMessageIdA: null,
    calendarMessageIdB: null,
    userAId: "uid-A",
    userBId: "uid-B",
    userA: {
      id: "uid-A",
      telegramId: 1001n,
      language: "en",
      gender: "male",
      firstName: "Alex",
      ticketBalance: 0,
    },
    userB: {
      id: "uid-B",
      telegramId: 1002n,
      language: "en",
      gender: "female",
      firstName: "Bea",
      ticketBalance: 0,
    },
    ...overrides,
  };
}

describe("ticket gate post-accept status message", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mMatch.findUnique.mockReset();
    mMatch.update.mockResolvedValue({});
    mMatch.updateMany.mockResolvedValue({ count: 1 });
    mStartScheduling.mockResolvedValue(undefined);
  });

  it("sends the ticket offer as the stored post-accept CTA for both sides", async () => {
    mMatch.findUnique.mockResolvedValueOnce(matchRow());
    const api = createApi();

    await sendTicketOffer(api, "match-1");

    expect(api.sendMessage).toHaveBeenCalledTimes(2);
    expect(api.sendMessage.mock.calls[0]![1]).toBe(t("en", "ticketCardCaption"));
    expect(mMatch.update).toHaveBeenCalledWith({
      where: { id: "match-1" },
      data: { calendarMessageIdA: 500 },
    });
    expect(mMatch.update).toHaveBeenCalledWith({
      where: { id: "match-1" },
      data: { calendarMessageIdB: 501 },
    });
  });

  it("edits the paying side's CTA into a waiting status after the first ticket", async () => {
    mMatch.findUnique
      .mockResolvedValueOnce(matchRow({ calendarMessageIdA: 501, calendarMessageIdB: 502 }))
      .mockResolvedValueOnce(
        matchRow({
          ticketPaidA: new Date("2026-06-19T10:00:00Z"),
          calendarMessageIdA: 501,
          calendarMessageIdB: 502,
        }),
      )
      .mockResolvedValueOnce(
        matchRow({
          ticketStatus: "partial",
          ticketPaidA: new Date("2026-06-19T10:00:00Z"),
          calendarMessageIdA: 501,
          calendarMessageIdB: 502,
        }),
      );
    const api = createApi();

    const result = await applyTicketPayment(api, 1001n, "match-1", "self");

    expect(result.ok).toBe(true);
    expect(api.editMessageText).toHaveBeenCalledWith(
      1001,
      501,
      t("en", "ticketGateWaiting"),
      expect.objectContaining({ reply_markup: expect.any(Object) }),
    );
    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  it("does not send a separate both-tickets DM before scheduling", async () => {
    mMatch.findUnique
      .mockResolvedValueOnce(matchRow({ calendarMessageIdA: 501, calendarMessageIdB: 502 }))
      .mockResolvedValueOnce(
        matchRow({
          ticketPaidA: new Date("2026-06-19T10:00:00Z"),
          ticketPaidB: new Date("2026-06-19T10:00:00Z"),
          paidForPartnerByA: true,
          calendarMessageIdA: 501,
          calendarMessageIdB: 502,
        }),
      )
      .mockResolvedValueOnce(
        matchRow({
          ticketStatus: "completed",
          ticketPaidA: new Date("2026-06-19T10:00:00Z"),
          ticketPaidB: new Date("2026-06-19T10:00:00Z"),
          paidForPartnerByA: true,
          calendarMessageIdA: 501,
          calendarMessageIdB: 502,
        }),
      );
    const api = createApi();

    const result = await applyTicketPayment(api, 1001n, "match-1", "both");

    expect(result.ok).toBe(true);
    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(api.editMessageText).not.toHaveBeenCalled();
    expect(mStartScheduling).toHaveBeenCalledWith(api, "match-1");
  });
});
