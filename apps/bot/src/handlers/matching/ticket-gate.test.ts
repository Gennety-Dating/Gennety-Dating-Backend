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

vi.mock("../../services/ticket-wallet.js", () => ({
  spendTickets: vi.fn().mockResolvedValue({ ok: true }),
  grantTickets: vi.fn().mockResolvedValue(undefined),
}));

import { prisma } from "@gennety/db";
import { t } from "@gennety/shared";
import {
  sendTicketOffer,
  applyTicketPayment,
  useTicketFromBalance,
} from "./ticket-gate.js";
import { startScheduling } from "./scheduler.js";
import { spendTickets, grantTickets } from "../../services/ticket-wallet.js";

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

  it("sends the ticket card as a standalone PERSISTENT message (not tracked as the Calendar card)", async () => {
    mMatch.findUnique.mockResolvedValueOnce(matchRow());
    const api = createApi();

    await sendTicketOffer(api, "match-1");

    expect(api.sendMessage).toHaveBeenCalledTimes(2);
    expect(api.sendMessage.mock.calls[0]![1]).toBe(t("en", "ticketCardCaption"));
    // The ticket card id is NOT stored in calendarMessageId* — that field tracks
    // the SEPARATE Calendar card, so the scheduling/venue/time-lock flows never
    // edit or delete the persistent ticket entry. PRODUCT_SPEC §3.5b.
    const updateDataKeys = mMatch.update.mock.calls.flatMap((c) =>
      Object.keys((c[0] as { data: Record<string, unknown> }).data),
    );
    expect(updateDataKeys).toContain("ticketStatus");
    expect(updateDataKeys).not.toContain("calendarMessageIdA");
    expect(updateDataKeys).not.toContain("calendarMessageIdB");
  });

  it("never edits the persistent ticket card after the first ticket (Mini App shows waiting)", async () => {
    mMatch.findUnique
      .mockResolvedValueOnce(matchRow())
      .mockResolvedValueOnce(
        matchRow({ ticketPaidA: new Date("2026-06-19T10:00:00Z") }),
      )
      .mockResolvedValueOnce(
        matchRow({
          ticketStatus: "partial",
          ticketPaidA: new Date("2026-06-19T10:00:00Z"),
        }),
      );
    const api = createApi();

    const result = await applyTicketPayment(api, 1001n, "match-1", "self");

    expect(result.ok).toBe(true);
    // No in-chat edit and no new message — the persistent ticket card is left
    // alone; its live state ("waiting") lives in the Mini App.
    expect(api.editMessageText).not.toHaveBeenCalled();
    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  it("pay-for-both settles both tickets and hands off to scheduling without an extra DM", async () => {
    mMatch.findUnique
      .mockResolvedValueOnce(matchRow())
      .mockResolvedValueOnce(
        matchRow({
          ticketPaidA: new Date("2026-06-19T10:00:00Z"),
          ticketPaidB: new Date("2026-06-19T10:00:00Z"),
          paidForPartnerByA: true,
        }),
      )
      .mockResolvedValueOnce(
        matchRow({
          ticketStatus: "completed",
          ticketPaidA: new Date("2026-06-19T10:00:00Z"),
          ticketPaidB: new Date("2026-06-19T10:00:00Z"),
          paidForPartnerByA: true,
        }),
      );
    const api = createApi();

    const result = await applyTicketPayment(api, 1001n, "match-1", "both");

    expect(result.ok).toBe(true);
    // The persistent ticket cards are left untouched; the Calendar follows via
    // startScheduling as a SEPARATE message, so the covered woman can still
    // reopen her ticket card for the surprise. PRODUCT_SPEC §3.5b.
    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(api.editMessageText).not.toHaveBeenCalled();
    // afterTicketGate → Calendar card uses the plain caption (no duplicate of the
    // ticket card's "It's mutual 🔥" celebration).
    expect(mStartScheduling).toHaveBeenCalledWith(api, "match-1", {
      afterTicketGate: true,
    });
  });
});

describe("useTicketFromBalance — wallet refund accounting", () => {
  const mSpend = spendTickets as unknown as MockFn;
  const mGrant = grantTickets as unknown as MockFn;

  beforeEach(() => {
    vi.clearAllMocks();
    mMatch.findUnique.mockReset();
    mMatch.update.mockResolvedValue({});
    mMatch.updateMany.mockResolvedValue({ count: 1 });
    mStartScheduling.mockResolvedValue(undefined);
    mSpend.mockResolvedValue({ ok: true });
    mGrant.mockResolvedValue(undefined);
  });

  it("refunds the surplus ticket when 'use 2' only settles one slot (partner already paid)", async () => {
    // Male (side A) spends 2 to cover both, but his date (side B) already paid —
    // only his own slot is still open, so one of the two spent tickets must be
    // returned instead of silently burned. PRODUCT_SPEC §3.5b.
    mMatch.findUnique.mockResolvedValue(
      matchRow({ ticketPaidB: new Date("2026-06-19T10:00:00Z") }),
    );
    const api = createApi();

    const result = await useTicketFromBalance(api, 1001n, "match-1", "both");

    expect(result.ok).toBe(true);
    // Spent 2 (scope "both"), settled only 1 slot → refund exactly 1.
    expect(mSpend).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "uid-A", count: 2, reason: "spend_match" }),
    );
    expect(mGrant).toHaveBeenCalledTimes(1);
    expect(mGrant).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "uid-A", count: 1, reason: "refund" }),
    );
    // The partner-paid-for flag must NOT be set — she paid for herself.
    const claimData = mMatch.updateMany.mock.calls[0]![0].data;
    expect(claimData).not.toHaveProperty("paidForPartnerByA");
  });

  it("does not refund when 'use 2' settles both slots (neither paid yet)", async () => {
    mMatch.findUnique.mockResolvedValue(matchRow());
    const api = createApi();

    const result = await useTicketFromBalance(api, 1001n, "match-1", "both");

    expect(result.ok).toBe(true);
    expect(mSpend).toHaveBeenCalledWith(
      expect.objectContaining({ count: 2 }),
    );
    expect(mGrant).not.toHaveBeenCalled();
  });
});
