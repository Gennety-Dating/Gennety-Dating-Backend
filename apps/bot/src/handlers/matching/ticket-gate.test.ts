import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@gennety/db", () => ({
  prisma: {
    $transaction: vi.fn(async (callback: (tx: unknown) => unknown) =>
      callback((await import("@gennety/db")).prisma),
    ),
    user: {
      findUnique: vi.fn(),
    },
    match: {
      findUnique: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    ticketLedger: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
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
  sendCalendarCard: vi.fn().mockResolvedValue(undefined),
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
  applyStarsTicketPayment,
  useTicketFromBalance,
  notePartnerPaidSeen,
  refundAndFallbackToScheduling,
  retryPendingStarsGateRefunds,
} from "./ticket-gate.js";
import { startScheduling, sendCalendarCard } from "./scheduler.js";
import { spendTickets, grantTickets } from "../../services/ticket-wallet.js";

type MockFn = ReturnType<typeof vi.fn>;
const mMatch = prisma.match as unknown as {
  findUnique: MockFn;
  update: MockFn;
  updateMany: MockFn;
};
const mUser = prisma.user as unknown as { findUnique: MockFn };
const mLedger = prisma.ticketLedger as unknown as {
  findUnique: MockFn;
  findFirst: MockFn;
  findMany: MockFn;
  create: MockFn;
  updateMany: MockFn;
};
const mStartScheduling = startScheduling as unknown as MockFn;
const mSendCalendarCard = sendCalendarCard as unknown as MockFn;

function createApi() {
  let nextMessageId = 500;
  return {
    sendMessage: vi.fn().mockImplementation(async () => ({
      message_id: nextMessageId++,
    })),
    editMessageText: vi.fn().mockResolvedValue(undefined),
    refundStarPayment: vi.fn().mockResolvedValue(true),
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
    partnerPaidSeenAt: null,
    partnerPaidNudgedAt: null,
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
      ticketDiscountPct: 0,
      ticketDiscountExpiresAt: null,
      ticketDiscountConsumedAt: null,
      profile: { photos: ["alex-photo"] },
    },
    userB: {
      id: "uid-B",
      telegramId: 1002n,
      language: "en",
      gender: "female",
      firstName: "Bea",
      ticketBalance: 0,
      ticketDiscountPct: 0,
      ticketDiscountExpiresAt: null,
      ticketDiscountConsumedAt: null,
      profile: { photos: ["bea-photo"] },
    },
    ...overrides,
  };
}

beforeEach(() => {
  mUser.findUnique.mockResolvedValue({ id: "uid-A" });
  mLedger.findUnique.mockResolvedValue(null);
  mLedger.findFirst.mockResolvedValue(null);
  mLedger.findMany.mockResolvedValue([]);
  mLedger.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: "ledger-1",
    userId: data.userId,
    matchId: data.matchId,
    reason: data.reason,
    externalPaymentId: data.externalPaymentId,
    bundleSize: data.bundleSize,
  }));
  mLedger.updateMany.mockResolvedValue({ count: 1 });
});

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

  it("pay-for-both confirms the gesture to him (takt 1) and nudges her since she hadn't opened", async () => {
    const paid = new Date("2026-06-19T10:00:00Z");
    mMatch.findUnique
      // settle load (nothing paid yet)
      .mockResolvedValueOnce(matchRow())
      // recompute `after` (both now paid, he covered her)
      .mockResolvedValueOnce(
        matchRow({ ticketPaidA: paid, ticketPaidB: paid, paidForPartnerByA: true }),
      )
      // completion `done` load — she never opened, so seen/nudged are null
      .mockResolvedValueOnce(
        matchRow({
          ticketStatus: "completed",
          ticketPaidA: paid,
          ticketPaidB: paid,
          paidForPartnerByA: true,
        }),
      )
      // final load
      .mockResolvedValueOnce(
        matchRow({
          ticketStatus: "completed",
          ticketPaidA: paid,
          ticketPaidB: paid,
          paidForPartnerByA: true,
        }),
      );
    const api = createApi();

    const result = await applyTicketPayment(api, 1001n, "match-1", "both");

    expect(result.ok).toBe(true);
    // The persistent ticket cards are still never EDITED; the Calendar follows
    // as a SEPARATE message. But the goodwill cover now produces two DMs
    // (PRODUCT_SPEC §3.5b read-receipt): takt-1 confirmation to him + the
    // guaranteed "he covered your ticket ❤️" nudge to her (she hadn't opened).
    expect(api.editMessageText).not.toHaveBeenCalled();
    const texts = api.sendMessage.mock.calls.map((c: unknown[]) => c[1]);
    expect(texts).toContain(t("en", "ticketCoveredHerConfirm", { name: "Bea" }));
    expect(texts).toContain(t("en", "ticketPartnerPaidDm", { name: "Alex" }));
    // afterTicketGate → Calendar card uses the plain caption (no duplicate of the
    // ticket card's "It's mutual 🔥" celebration).
    expect(mStartScheduling).toHaveBeenCalledWith(api, "match-1", {
      afterTicketGate: true,
      // Her Calendar is withheld until she opens the reveal (covered side = B).
      skipSide: "B",
    });
  });

  it("does not nudge her at completion if she already opened the reveal (seen stamped)", async () => {
    const paid = new Date("2026-06-19T10:00:00Z");
    mMatch.findUnique
      .mockResolvedValueOnce(matchRow())
      .mockResolvedValueOnce(
        matchRow({ ticketPaidA: paid, ticketPaidB: paid, paidForPartnerByA: true }),
      )
      // `done` load — she already opened, so partnerPaidSeenAt is set
      .mockResolvedValueOnce(
        matchRow({
          ticketStatus: "completed",
          ticketPaidA: paid,
          ticketPaidB: paid,
          paidForPartnerByA: true,
          partnerPaidSeenAt: paid,
        }),
      )
      .mockResolvedValueOnce(
        matchRow({
          ticketStatus: "completed",
          ticketPaidA: paid,
          ticketPaidB: paid,
          paidForPartnerByA: true,
          partnerPaidSeenAt: paid,
        }),
      );
    const api = createApi();

    await applyTicketPayment(api, 1001n, "match-1", "both");

    const texts = api.sendMessage.mock.calls.map((c: unknown[]) => c[1]);
    // Takt-1 still confirms to him, but no duplicate nudge to her.
    expect(texts).toContain(t("en", "ticketCoveredHerConfirm", { name: "Bea" }));
    expect(texts).not.toContain(t("en", "ticketPartnerPaidDm", { name: "Alex" }));
  });
});

describe("notePartnerPaidSeen — goodwill read-receipt (takt 2)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mMatch.findUnique.mockReset();
    mMatch.updateMany.mockResolvedValue({ count: 1 });
  });

  it("stamps seen once and DMs the payer that she saw his gesture", async () => {
    // Side B (Bea) was covered by side A (Alex); she opens her reveal.
    mMatch.findUnique
      .mockResolvedValueOnce(matchRow({ paidForPartnerByA: true }))
      .mockResolvedValueOnce(matchRow({ paidForPartnerByA: true }));
    const api = createApi();

    await notePartnerPaidSeen(api, 1002n, "match-1");

    // CAS stamp on partnerPaidSeenAt: null.
    const seenClaim = mMatch.updateMany.mock.calls.find(
      (c) => "partnerPaidSeenAt" in (c[0] as { data: Record<string, unknown> }).data,
    );
    expect(seenClaim).toBeTruthy();
    // Payer (Alex, 1001) is told SHE (Bea) saw it.
    const texts = api.sendMessage.mock.calls.map((c: unknown[]) => c[1]);
    expect(texts).toContain(t("en", "ticketPartnerSawItDm", { name: "Bea" }));
  });

  it("delivers her deferred Calendar once she opens the reveal (gate completed)", async () => {
    // Gate already completed via pay-for-both; her Calendar was withheld (skipSide).
    const covered = matchRow({
      ticketStatus: "completed",
      ticketPaidA: new Date(),
      ticketPaidB: new Date(),
      paidForPartnerByA: true,
    });
    mMatch.findUnique
      .mockResolvedValueOnce(covered) // notePartnerPaidSeen participation load
      .mockResolvedValueOnce(covered); // markPartnerPaidSeenAndNotify load
    const api = createApi();

    await notePartnerPaidSeen(api, 1002n, "match-1");

    // She (side B) now receives her Calendar card.
    expect(mSendCalendarCard).toHaveBeenCalledWith(api, "match-1", "B");
  });

  it("is a no-op when the viewer was not covered", async () => {
    mMatch.findUnique.mockResolvedValueOnce(matchRow()); // nobody covered
    const api = createApi();

    await notePartnerPaidSeen(api, 1002n, "match-1");

    expect(mMatch.updateMany).not.toHaveBeenCalled();
    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  it("does not re-DM when the receipt was already stamped", async () => {
    mMatch.findUnique.mockResolvedValueOnce(
      matchRow({ paidForPartnerByA: true, partnerPaidSeenAt: new Date() }),
    );
    const api = createApi();

    await notePartnerPaidSeen(api, 1002n, "match-1");

    expect(mMatch.updateMany).not.toHaveBeenCalled();
    expect(api.sendMessage).not.toHaveBeenCalled();
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

  it("refunds both wallet tickets when a stale 'both' claim loses to the partner payment", async () => {
    const partnerPaid = new Date("2026-06-19T10:00:00Z");
    mMatch.findUnique
      .mockResolvedValueOnce(matchRow()) // wallet preflight
      .mockResolvedValueOnce(matchRow()) // settlement read: both slots looked open
      .mockResolvedValueOnce(matchRow({ ticketPaidB: partnerPaid })); // lost CAS reread
    mMatch.updateMany.mockResolvedValueOnce({ count: 0 });
    const api = createApi();

    const result = await useTicketFromBalance(api, 1001n, "match-1", "both");

    expect(result).toEqual({ ok: false, reason: "wrong-state" });
    expect(mMatch.updateMany.mock.calls[0]![0].where).toEqual(
      expect.objectContaining({ ticketPaidA: null, ticketPaidB: null }),
    );
    expect(mGrant).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "uid-A", count: 2, reason: "refund" }),
    );
  });
});

describe("applyStarsTicketPayment — M1 refund on a closed match", () => {
  const mGrant = grantTickets as unknown as MockFn;

  beforeEach(() => {
    vi.clearAllMocks();
    mMatch.findUnique.mockReset();
    mMatch.update.mockResolvedValue({});
    mStartScheduling.mockResolvedValue(undefined);
    mGrant.mockResolvedValue(undefined);
  });

  it("refunds the Stars when the gate no longer settles (match cancelled after pre_checkout)", async () => {
    // The invoice link is reusable and pre_checkout raced the cancellation: the
    // match is no longer `negotiating`, so the settle CAS claims 0 slots and the
    // gate settles nothing. The Stars must be given back, not silently kept.
    mMatch.findUnique.mockResolvedValue(matchRow({ status: "cancelled" }));
    mMatch.updateMany.mockResolvedValue({ count: 0 }); // CAS on status:"negotiating" claims nothing
    const api = createApi();

    const result = await applyStarsTicketPayment(api, 1001n, "match-1", "self", "charge_x");

    expect(result.ok).toBe(false);
    expect(api.refundStarPayment).toHaveBeenCalledWith(1001, "charge_x");
    // No surplus wallet ticket minted — the real Stars refund is the remedy.
    expect(mGrant).not.toHaveBeenCalled();
    expect(mStartScheduling).not.toHaveBeenCalled();
  });

  it("does not refund a successful settle", async () => {
    // Fresh gate, self scope claims cleanly → no refund.
    mMatch.findUnique.mockResolvedValue(matchRow());
    mMatch.updateMany.mockResolvedValue({ count: 1 });
    const api = createApi();

    const result = await applyStarsTicketPayment(api, 1001n, "match-1", "self", "charge_ok");

    expect(result.ok).toBe(true);
    expect(api.refundStarPayment).not.toHaveBeenCalled();
    expect(mLedger.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          reason: "gate_payment",
          externalPaymentId: "charge_ok",
          matchId: "match-1",
        }),
      }),
    );
  });

  it("does not mint a surplus ticket when Telegram redelivers an already-settled charge", async () => {
    mLedger.findUnique.mockResolvedValueOnce({
      id: "ledger-settled",
      userId: "uid-A",
      matchId: "match-1",
      reason: "gate_settled",
      externalPaymentId: "charge_redelivered",
      bundleSize: 1,
    });
    mMatch.findUnique.mockResolvedValueOnce(
      matchRow({ ticketStatus: "partial", ticketPaidA: new Date("2026-06-19T10:00:00Z") }),
    );
    const api = createApi();

    const result = await applyStarsTicketPayment(
      api,
      1001n,
      "match-1",
      "self",
      "charge_redelivered",
    );

    expect(result.ok).toBe(true);
    expect(mGrant).not.toHaveBeenCalled();
    expect(api.refundStarPayment).not.toHaveBeenCalled();
    expect(mMatch.updateMany).not.toHaveBeenCalled();
  });

  it("refunds a distinct charge that loses the atomic slot claim", async () => {
    mMatch.findUnique
      .mockResolvedValueOnce(matchRow())
      .mockResolvedValueOnce(
        matchRow({ ticketStatus: "partial", ticketPaidA: new Date("2026-06-19T10:00:00Z") }),
      );
    mMatch.updateMany.mockResolvedValueOnce({ count: 0 });
    const api = createApi();

    const result = await applyStarsTicketPayment(
      api,
      1001n,
      "match-1",
      "self",
      "charge_lost_race",
    );

    expect(result).toEqual({ ok: false, reason: "wrong-state" });
    expect(api.refundStarPayment).toHaveBeenCalledWith(1001, "charge_lost_race");
    expect(mGrant).not.toHaveBeenCalled();
    expect(mLedger.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ reason: "gate_refund_pending" }) }),
    );
  });

  it("credits a one-ticket surplus exactly once when a both charge wins only one slot", async () => {
    const partnerPaid = new Date("2026-06-19T10:00:00Z");
    mMatch.findUnique.mockResolvedValue(
      matchRow({ ticketStatus: "partial", ticketPaidB: partnerPaid }),
    );
    mMatch.updateMany.mockResolvedValue({ count: 1 });
    const api = createApi();

    const result = await applyStarsTicketPayment(
      api,
      1001n,
      "match-1",
      "both",
      "charge_surplus",
    );

    expect(result.ok).toBe(true);
    expect(mGrant).toHaveBeenCalledWith({
      userId: "uid-A",
      count: 1,
      reason: "refund",
      matchId: "match-1",
      externalPaymentId: "gate-surplus:charge_surplus",
    });
    expect(mLedger.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { reason: "gate_settled" } }),
    );
  });
});

describe("ticket expiry — durable provider and wallet refunds", () => {
  const mGrant = grantTickets as unknown as MockFn;

  beforeEach(() => {
    vi.clearAllMocks();
    mMatch.findUnique.mockReset();
    mMatch.updateMany.mockResolvedValue({ count: 1 });
    mStartScheduling.mockResolvedValue(undefined);
    mGrant.mockResolvedValue(undefined);
  });

  it("refunds the original Stars charge before opening free scheduling", async () => {
    mMatch.findUnique.mockResolvedValueOnce(
      matchRow({ ticketStatus: "partial", ticketPaidA: new Date("2026-06-19T10:00:00Z") }),
    );
    mLedger.findMany.mockResolvedValueOnce([
      {
        id: "stars-ledger",
        userId: "uid-A",
        matchId: "match-1",
        reason: "gate_settled",
        externalPaymentId: "charge_expired",
        bundleSize: 1,
      },
      {
        id: "losing-ledger",
        userId: "uid-A",
        matchId: "match-1",
        reason: "gate_refunded",
        externalPaymentId: "charge_already_refunded",
        bundleSize: 1,
      },
    ]);
    const api = createApi();

    await refundAndFallbackToScheduling(api, "match-1");

    expect(api.refundStarPayment).toHaveBeenCalledWith(1001, "charge_expired");
    expect(api.refundStarPayment).toHaveBeenCalledTimes(1);
    expect(mStartScheduling).toHaveBeenCalledWith(api, "match-1", { afterTicketGate: true });
    expect(mMatch.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ ticketStatus: "refund_pending" }),
        data: expect.objectContaining({ ticketStatus: "refunded" }),
      }),
    );
    expect(api.sendMessage).toHaveBeenCalledWith(1001, t("en", "ticketRefundedDm"));
  });

  it("restores a wallet ticket exactly once when a wallet-funded gate expires", async () => {
    mMatch.findUnique.mockResolvedValueOnce(
      matchRow({ ticketStatus: "partial", ticketPaidA: new Date("2026-06-19T10:00:00Z") }),
    );
    mLedger.findMany.mockResolvedValueOnce([]); // no Stars payment
    mLedger.findFirst.mockResolvedValueOnce({ id: "wallet-spend" });
    const api = createApi();

    await refundAndFallbackToScheduling(api, "match-1");

    expect(mGrant).toHaveBeenCalledWith({
      userId: "uid-A",
      count: 1,
      reason: "refund",
      matchId: "match-1",
      externalPaymentId: "wallet-expiry-refund:match-1:uid-A",
    });
    expect(api.refundStarPayment).not.toHaveBeenCalled();
    expect(mStartScheduling).toHaveBeenCalledTimes(1);
  });

  it("keeps the match retryable and withholds scheduling when the Stars refund fails", async () => {
    mMatch.findUnique.mockResolvedValueOnce(
      matchRow({ ticketStatus: "partial", ticketPaidA: new Date("2026-06-19T10:00:00Z") }),
    );
    mLedger.findMany.mockResolvedValueOnce([
      {
        id: "stars-ledger",
        userId: "uid-A",
        matchId: "match-1",
        reason: "gate_payment",
        externalPaymentId: "charge_retry",
        bundleSize: 1,
      },
    ]);
    const api = createApi();
    api.refundStarPayment.mockRejectedValueOnce(new Error("temporary network failure"));

    await expect(refundAndFallbackToScheduling(api, "match-1")).rejects.toThrow(
      "Ticket refund remains pending",
    );

    expect(mStartScheduling).not.toHaveBeenCalled();
    expect(mMatch.updateMany).toHaveBeenCalledTimes(1);
    expect(mMatch.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ ticketStatus: "refund_pending" }) }),
    );
    expect(mLedger.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { reason: "gate_refund_pending" } }),
    );
  });

  it("retries durable Stars refunds left pending by an earlier callback", async () => {
    mLedger.findMany.mockResolvedValueOnce([
      {
        id: "stars-ledger",
        userId: "uid-A",
        matchId: "match-1",
        reason: "gate_refund_pending",
        externalPaymentId: "charge_retry",
        user: { telegramId: 1001n },
      },
    ]);
    const api = createApi();

    await expect(retryPendingStarsGateRefunds(api)).resolves.toBe(1);

    expect(api.refundStarPayment).toHaveBeenCalledWith(1001, "charge_retry");
    expect(mLedger.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: { reason: "gate_refunded" } }),
    );
    const retryWhere = mLedger.findMany.mock.calls[0]![0].where;
    expect(retryWhere.OR[0].reason).toEqual({
      in: ["gate_refund_pending", "gate_surplus_pending"],
    });
    expect(retryWhere.OR[1]).toEqual({
      reason: "gate_payment",
      createdAt: { lt: expect.any(Date) },
    });
  });

  it("does not refund an abandoned-row candidate that concurrently became settled", async () => {
    mLedger.findMany.mockResolvedValueOnce([
      {
        id: "stars-ledger",
        userId: "uid-A",
        matchId: "match-1",
        reason: "gate_payment",
        externalPaymentId: "charge_racing",
        bundleSize: 1,
        user: { telegramId: 1001n },
      },
    ]);
    mLedger.updateMany.mockResolvedValueOnce({ count: 0 });
    mLedger.findUnique.mockResolvedValueOnce({ reason: "gate_settled" });
    const api = createApi();

    await expect(retryPendingStarsGateRefunds(api)).resolves.toBe(0);

    expect(api.refundStarPayment).not.toHaveBeenCalled();
  });
});
