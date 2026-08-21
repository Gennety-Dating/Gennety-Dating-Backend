import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The paid-Rematch settlement path (PRODUCT_SPEC §3.11), specifically the search
 * animation laid over the engine run.
 *
 * Its own file rather than a block in `payments.test.ts`: this branch reaches
 * for six modules through dynamic `import()` and needs a `rematchPurchase`
 * table, so the mock set has almost nothing in common with the store/gate/
 * premium harness next door.
 *
 * Two of the assertions here are the whole point. `NEVER_CUT_SHORT` is what
 * keeps the ten-second floor true in the COMMON case (the engine usually
 * answers in a second or two), and nothing else in the code states that — a
 * well-meant switch to the default `until` behaviour would silently cut the
 * script to half its first beat. And a status is decoration on a path where
 * money has already moved, so it must never be able to cost a delivered match.
 */

vi.mock("@gennety/db", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    match: { findUnique: vi.fn() },
    rematchPurchase: { create: vi.fn(), update: vi.fn() },
  },
}));
vi.mock("../config.js", () => ({
  env: {
    TICKET_BUNDLE_STARS: { 1: 350, 3: 830, 6: 1350 },
    PREMIUM_STARS: 500,
    MESSAGE_EFFECT_REMATCH_ID: "",
  },
}));
vi.mock("../services/ticket-wallet.js", () => ({
  grantTickets: vi.fn(),
  isUniqueViolation: (e: unknown) =>
    typeof e === "object" && e !== null && (e as { code?: string }).code === "P2002",
}));
vi.mock("../services/premium.js", () => ({
  activateOrExtendPremium: vi.fn(),
  formatPremiumUntil: () => "19 August 2026",
}));
vi.mock("../services/founder-notify.js", () => ({ notifyFounderPurchase: vi.fn() }));
vi.mock("../services/rematch.js", () => ({
  runRematch: vi.fn(),
  REMATCH_PROCESSING: "processing",
  REMATCH_SETTLED: "settled",
  REMATCH_REFUNDED_UNDELIVERED: "refunded_undelivered",
}));
vi.mock("../services/rematch-refund.js", () => ({
  refundRematchPurchase: vi.fn(),
  refundStatusForReason: () => "refunded_no_candidate",
}));
vi.mock("../services/dispatch-queue.js", () => ({ dispatchMatches: vi.fn() }));
// The real `NEVER_CUT_SHORT` value has to survive the mock — the assertions
// below compare against it, and a stand-in would make them tautological.
vi.mock("../services/ai-stream.js", () => ({
  runStatusSequence: vi.fn().mockResolvedValue(undefined),
  NEVER_CUT_SHORT: Number.POSITIVE_INFINITY,
}));

import { prisma } from "@gennety/db";
import { env } from "../config.js";
import { runStatusSequence, NEVER_CUT_SHORT } from "../services/ai-stream.js";
import { runRematch } from "../services/rematch.js";
import { refundRematchPurchase } from "../services/rematch-refund.js";
import { dispatchMatches } from "../services/dispatch-queue.js";
import { handleSuccessfulPayment } from "./payments.js";

const findUnique = prisma.user.findUnique as unknown as ReturnType<typeof vi.fn>;
const createPurchase = prisma.rematchPurchase.create as unknown as ReturnType<typeof vi.fn>;
const updatePurchase = prisma.rematchPurchase.update as unknown as ReturnType<typeof vi.fn>;
const status = runStatusSequence as unknown as ReturnType<typeof vi.fn>;
const engine = runRematch as unknown as ReturnType<typeof vi.fn>;
const refund = refundRematchPurchase as unknown as ReturnType<typeof vi.fn>;
const dispatch = dispatchMatches as unknown as ReturnType<typeof vi.fn>;

const MATCH_ID = "33333333-3333-4333-8333-333333333333";

beforeEach(() => {
  vi.clearAllMocks();
  (env as { MESSAGE_EFFECT_REMATCH_ID: string }).MESSAGE_EFFECT_REMATCH_ID = "";
  findUnique.mockResolvedValue({ id: "buyer-1", language: "ru" });
  createPurchase.mockResolvedValue({
    id: "purchase-1",
    externalPaymentId: "charge-1",
    status: "processing",
  });
  updatePurchase.mockResolvedValue({});
  engine.mockResolvedValue({ ok: true, matchId: MATCH_ID, partnerId: "her-1", framing: "neutral" });
  refund.mockResolvedValue(true);
  dispatch.mockResolvedValue({ dispatched: 1, failed: 0, errors: [], undelivered: [] });
  status.mockResolvedValue(undefined);
});

function payCtx() {
  const reply = vi.fn().mockResolvedValue(undefined);
  const ctx = {
    message: {
      successful_payment: {
        invoice_payload: "rematch:v1",
        currency: "XTR",
        total_amount: 150,
        telegram_payment_charge_id: "charge-1",
      },
    },
    from: { id: 111 },
    session: { language: "ru" },
    api: {},
    reply,
  } as unknown as Parameters<typeof handleSuccessfulPayment>[0];
  return { ctx, reply };
}

describe("rematch search animation", () => {
  it("always plays the full script, even when the engine answers instantly", async () => {
    const { ctx } = payCtx();
    await handleSuccessfulPayment(ctx);

    expect(status).toHaveBeenCalledTimes(1);
    const opts = status.mock.calls[0]![3] as Record<string, unknown>;
    // The founder's requirement lives in exactly one place: this flag. Without
    // it, a sub-second `runRematch` truncates the ten seconds to a flicker.
    expect(opts.untilFromStepIndex).toBe(NEVER_CUT_SHORT);
    expect(opts.rich).toBe(true);
    expect(opts.until).toBeInstanceOf(Promise);
  });

  it("covers the engine run rather than following it", async () => {
    // The `until` handed to the status must be the SAME work the handler then
    // awaits — otherwise the animation is a fixed-length stub that happens to
    // sit nearby, and a slow engine would run on in silence after it ends.
    let resolveRun: (v: unknown) => void = () => {};
    engine.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveRun = resolve;
      }),
    );
    const { ctx } = payCtx();

    const inFlight = handleSuccessfulPayment(ctx);
    // `vi.waitFor`, not a bare microtask tick: the handler reaches the status
    // through several awaits and two dynamic `import()`s first.
    await vi.waitFor(() => expect(status).toHaveBeenCalledTimes(1));
    // Still pending: the handler has not settled the purchase yet.
    expect(updatePurchase).not.toHaveBeenCalled();

    resolveRun({ ok: true, matchId: MATCH_ID, partnerId: "her-1", framing: "neutral" });
    await inFlight;
    expect(updatePurchase).toHaveBeenCalledTimes(1);
  });

  it("runs before the outcome is announced", async () => {
    const { ctx, reply } = payCtx();
    await handleSuccessfulPayment(ctx);
    // A verdict landing above a shimmer still claiming to search is the exact
    // self-contradiction §1.4's outcome gate exists to prevent.
    expect(status.mock.invocationCallOrder[0]!).toBeLessThan(reply.mock.invocationCallOrder[0]!);
  });

  it("plays before a refund too — the ten seconds are the proof we looked", async () => {
    engine.mockResolvedValueOnce({ ok: false, reason: "no_candidate" });
    const { ctx, reply } = payCtx();
    await handleSuccessfulPayment(ctx);

    expect(status).toHaveBeenCalledTimes(1);
    expect(refund).toHaveBeenCalledTimes(1);
    expect(status.mock.invocationCallOrder[0]!).toBeLessThan(reply.mock.invocationCallOrder[0]!);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("never costs a paid match when the status itself fails", async () => {
    status.mockRejectedValueOnce(new Error("telegram is having a day"));
    const { ctx } = payCtx();

    await expect(handleSuccessfulPayment(ctx)).resolves.toBeUndefined();
    expect(updatePurchase).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith(expect.anything(), [MATCH_ID]);
  });

  it("leaves the row `processing` for the sweep when the engine throws", async () => {
    // The refund contract predates this change and must survive it: an engine
    // throw is NOT caught here, so the durable pre-transaction row stays
    // `processing` and the hourly sweep reverses the charge.
    engine.mockRejectedValueOnce(new Error("db is down"));
    const { ctx } = payCtx();

    await expect(handleSuccessfulPayment(ctx)).rejects.toThrow("db is down");
    expect(updatePurchase).not.toHaveBeenCalled();
    expect(refund).not.toHaveBeenCalled();
  });
});

describe("rematch found effect", () => {
  it("ships inert — no effect when the env id is empty", async () => {
    const { ctx, reply } = payCtx();
    await handleSuccessfulPayment(ctx);
    expect(reply).toHaveBeenCalledWith(expect.any(String), {});
  });

  it("rides the payoff line when an id is configured", async () => {
    (env as { MESSAGE_EFFECT_REMATCH_ID: string }).MESSAGE_EFFECT_REMATCH_ID = "5104841245755180586";
    const { ctx, reply } = payCtx();
    await handleSuccessfulPayment(ctx);
    expect(reply).toHaveBeenCalledWith(expect.any(String), {
      message_effect_id: "5104841245755180586",
    });
  });

  it("never rides the refund line", async () => {
    (env as { MESSAGE_EFFECT_REMATCH_ID: string }).MESSAGE_EFFECT_REMATCH_ID = "5104841245755180586";
    engine.mockResolvedValueOnce({ ok: false, reason: "no_candidate" });
    const { ctx, reply } = payCtx();
    await handleSuccessfulPayment(ctx);
    // Celebrating a refund would be the worst possible read of the animation.
    expect(reply).toHaveBeenCalledTimes(1);
    expect(reply.mock.calls[0]![1]).toBeUndefined();
  });
});

describe("a pitch that reached nobody", () => {
  const undelivered = {
    dispatched: 0,
    failed: 1,
    errors: [{ matchId: MATCH_ID, error: "Pitch delivery failed for 1 side(s)" }],
    undelivered: [MATCH_ID],
  };

  it("refunds the purchase — he paid for an introduction nobody was shown", async () => {
    dispatch.mockResolvedValueOnce(undelivered);
    const { ctx, reply } = payCtx();
    await handleSuccessfulPayment(ctx);

    expect(refund).toHaveBeenCalledTimes(1);
    // The audit row must say WHY. `refunded_no_candidate` would claim the city
    // is empty, which is the opposite of what happened.
    expect(refund.mock.calls[0]![3]).toBe("refunded_undelivered");
    // ...and it refunds the charge that was actually taken.
    expect(refund.mock.calls[0]![1]).toMatchObject({ externalPaymentId: "charge-1" });
    // Two messages: the payoff line, then the reversal. Only the payoff may
    // carry the effect.
    expect(reply).toHaveBeenCalledTimes(2);
    expect(reply.mock.calls[1]![1]).toBeUndefined();
  });

  it("never announces a refund the provider did not make", async () => {
    dispatch.mockResolvedValueOnce(undelivered);
    refund.mockResolvedValueOnce(false);
    const { ctx, reply } = payCtx();
    await handleSuccessfulPayment(ctx);

    // The row is parked in `refund_failed` for the hourly sweep, so the copy
    // must promise the Stars are COMING, not that they are back.
    expect(reply).toHaveBeenCalledTimes(2);
    expect(reply.mock.calls[1]![0]).not.toBe(reply.mock.calls[0]![0]);
  });

  it("does NOT refund when one side got the card", async () => {
    // The single most important negative: a delivered pitch is the product.
    // A decline or a ghost after this is his risk, and the offer copy says so.
    dispatch.mockResolvedValueOnce({
      dispatched: 0,
      failed: 1,
      errors: [{ matchId: MATCH_ID, error: "Pitch delivery failed for 1 side(s)" }],
      undelivered: [],
    });
    const { ctx, reply } = payCtx();
    await handleSuccessfulPayment(ctx);

    expect(refund).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledTimes(1);
  });

  it("does NOT refund when the queue itself threw", async () => {
    // Unknown is not undelivered: the partner may be reading the card right now.
    dispatch.mockRejectedValueOnce(new Error("queue exploded"));
    const { ctx } = payCtx();

    await expect(handleSuccessfulPayment(ctx)).resolves.toBeUndefined();
    expect(refund).not.toHaveBeenCalled();
  });

  it("does NOT refund the ordinary delivered path", async () => {
    const { ctx } = payCtx();
    await handleSuccessfulPayment(ctx);
    expect(refund).not.toHaveBeenCalled();
  });
});
