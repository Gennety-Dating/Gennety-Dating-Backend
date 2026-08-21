import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@gennety/db", () => ({
  prisma: {
    match: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findFirst: vi.fn().mockResolvedValue({ id: "m1" }),
      findUnique: vi.fn().mockResolvedValue(null),
    },
  },
}));

vi.mock("../handlers/matching/pitch.js", () => ({
  sendMatchProposal: vi.fn().mockResolvedValue(undefined),
  sendMatchWelcomeGiftPreroll: vi.fn().mockResolvedValue({
    sent: 0,
    sentA: false,
    sentB: false,
  }),
}));

import { prisma } from "@gennety/db";
import {
  sendMatchProposal,
  sendMatchWelcomeGiftPreroll,
} from "../handlers/matching/pitch.js";
import { dispatchMatches } from "./dispatch-queue.js";

type MockFn = ReturnType<typeof vi.fn>;
const mSendPitch = sendMatchProposal as unknown as MockFn;
const mSendPreroll = sendMatchWelcomeGiftPreroll as unknown as MockFn;
const mMatch = prisma.match as unknown as {
  updateMany: MockFn;
  findUnique: MockFn;
  findFirst: MockFn;
};
const mMatchUpdateMany = mMatch.updateMany;
const mMatchFindUnique = mMatch.findUnique;

describe("dispatchMatches", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("dispatches all matches and stamps dispatchedAt", async () => {
    const api = {} as any;
    const ids = ["m1", "m2", "m3"];

    const result = await dispatchMatches(api, ids, 0); // no delay in tests

    expect(result.dispatched).toBe(3);
    expect(result.failed).toBe(0);
    expect(result.errors).toHaveLength(0);
    expect(mSendPitch).toHaveBeenCalledTimes(3);
    expect(mMatchUpdateMany).toHaveBeenCalledTimes(3);

    // Each update should set dispatchedAt.
    for (const call of mMatchUpdateMany.mock.calls) {
      const arg = call[0] as { data: { dispatchedAt?: Date } };
      expect(arg.data.dispatchedAt).toBeInstanceOf(Date);
    }
  });

  it("continues on failure and reports errors", async () => {
    mSendPitch
      .mockResolvedValueOnce(undefined) // m1 OK
      .mockRejectedValueOnce(new Error("Telegram 429"))
      .mockRejectedValueOnce(new Error("Telegram 429"))
      .mockRejectedValueOnce(new Error("Telegram 429")) // m2 exhausts retries
      .mockResolvedValueOnce(undefined); // m3 OK

    const result = await dispatchMatches({} as any, ["m1", "m2", "m3"], 0);

    expect(result.dispatched).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.errors[0]!.matchId).toBe("m2");
    expect(result.errors[0]!.error).toContain("429");
  });

  it("retries a transient partial delivery before stamping dispatchedAt", async () => {
    mSendPitch
      .mockRejectedValueOnce(new Error("temporary Telegram failure"))
      .mockResolvedValueOnce(undefined);

    const result = await dispatchMatches({} as any, ["m1"], 0);

    expect(result).toMatchObject({ dispatched: 1, failed: 0 });
    expect(mSendPitch).toHaveBeenCalledTimes(2);
    expect(mMatchUpdateMany).toHaveBeenCalledOnce();
  });

  it("handles empty input gracefully", async () => {
    const result = await dispatchMatches({} as any, [], 0);
    expect(result.dispatched).toBe(0);
    expect(result.failed).toBe(0);
    expect(mSendPitch).not.toHaveBeenCalled();
  });

  it("does not deliver a proposal that was cancelled while it waited in the queue", async () => {
    mMatch.findFirst.mockResolvedValueOnce(null);

    const result = await dispatchMatches({} as any, ["cancelled"], 0);

    expect(result).toMatchObject({ dispatched: 0, failed: 0 });
    expect(mSendPitch).not.toHaveBeenCalled();
    expect(mMatchUpdateMany).not.toHaveBeenCalled();
  });

  it("sends first-match gift pre-rolls before pitching when configured", async () => {
    mSendPreroll
      .mockResolvedValueOnce({ sent: 1, sentA: true, sentB: false })
      .mockResolvedValueOnce({ sent: 0, sentA: false, sentB: false });

    const result = await dispatchMatches({} as any, ["m1", "m2"], 0, 3, 10);

    expect(result).toMatchObject({ dispatched: 2, failed: 0 });
    expect(mSendPreroll).toHaveBeenCalledWith({}, "m1");
    expect(mSendPreroll).toHaveBeenCalledWith({}, "m2");
    expect(mSendPreroll.mock.invocationCallOrder[1]).toBeLessThan(
      mSendPitch.mock.invocationCallOrder[0],
    );
    expect(mSendPitch).toHaveBeenNthCalledWith(1, {}, "m1", {
      skipWelcomeGiftPreroll: { A: true, B: false },
    });
    expect(mSendPitch).toHaveBeenNthCalledWith(2, {}, "m2", {});
  });

  it("salvages dispatchedAt when one side got the pitch but dispatch threw", async () => {
    // Pitch throws every retry (e.g. side B blocked the bot), but side A already
    // received the pitch. Without the salvage the row keeps dispatchedAt=null and
    // is excluded from the 24h TTL expiry forever — stranded in `proposed`.
    mSendPitch.mockRejectedValue(new Error("Forbidden: bot was blocked by the user"));
    mMatchFindUnique.mockResolvedValue({
      dispatchedAt: null,
      pitchMessageIdA: 555,
      pitchMessageIdB: null,
    });

    const result = await dispatchMatches({} as any, ["m1"], 0);

    expect(result.failed).toBe(1);
    // The success-path update never ran; the salvage updateMany started the TTL.
    expect(mMatchUpdateMany).toHaveBeenCalledTimes(1);
    const arg = mMatchUpdateMany.mock.calls[0]![0] as {
      where: { id: string; dispatchedAt: null };
      data: { dispatchedAt?: Date };
    };
    expect(arg.where).toMatchObject({ id: "m1", dispatchedAt: null });
    expect(arg.data.dispatchedAt).toBeInstanceOf(Date);
  });

  it("cancels the match — never stamps a TTL — when neither side got the pitch", async () => {
    // The row must not survive as `proposed` with dispatchedAt=null: every
    // consumer of a proposal (expiry sweep, countdown, both nudge cadences)
    // filters `dispatchedAt: { not: null }`, so such a row is invisible to all
    // of them while still occupying both participants' single live-match slot —
    // i.e. both users silently drop out of every drop, forever. Production held
    // one for 123 hours (DECISIONS.md 2026-08-20).
    //
    // Stamping instead would be a different bug: the expiry path classifies a
    // non-answering side as *silent* and penalises them for ghosting a message
    // that was never sent.
    mSendPitch.mockRejectedValue(new Error("network down"));
    mMatchFindUnique.mockResolvedValue({
      dispatchedAt: null,
      pitchMessageIdA: null,
      pitchMessageIdB: null,
    });

    const result = await dispatchMatches({} as any, ["m1"], 0);

    expect(result.failed).toBe(1);
    expect(mMatchUpdateMany).toHaveBeenCalledTimes(1);
    const arg = mMatchUpdateMany.mock.calls[0]![0] as {
      where: { id: string; status: string; dispatchedAt: null };
      data: { status?: string; dispatchedAt?: Date };
    };
    // Compare-and-set on the state it read, so a decision that landed while
    // Telegram was timing out wins instead of being clobbered.
    expect(arg.where).toMatchObject({ id: "m1", status: "proposed", dispatchedAt: null });
    expect(arg.data.status).toBe("cancelled");
    expect(arg.data.dispatchedAt).toBeUndefined();
    // Reported, because by now the evidence is gone: the row is `cancelled`
    // and carries no pitch ids, so a caller holding the buyer's Stars could
    // not re-derive "nobody saw it" from the database (§3.11 refund, D1).
    expect(result.undelivered).toEqual(["m1"]);
  });

  it("reports nothing undelivered when one side got the pitch", async () => {
    // The single most important negative for the paid path: a delivered pitch
    // is the product. This asserts the salvage branch stays OUT of the refund
    // list even though the dispatch itself failed.
    mSendPitch.mockRejectedValue(new Error("Forbidden: bot was blocked by the user"));
    mMatchFindUnique.mockResolvedValue({
      dispatchedAt: null,
      pitchMessageIdA: 4242,
      pitchMessageIdB: null,
    });

    const result = await dispatchMatches({} as any, ["m1"], 0);

    expect(result.failed).toBe(1);
    expect(result.undelivered).toEqual([]);
  });

  it("leaves an already-dispatched row alone when a later send throws", async () => {
    // Re-dispatch of a row that already carries a TTL must neither re-stamp it
    // nor cancel it: the pitch is on record and the 24h window is running.
    mSendPitch.mockRejectedValue(new Error("Forbidden: bot was blocked by the user"));
    mMatchFindUnique.mockResolvedValue({
      dispatchedAt: new Date("2026-08-01T10:00:00Z"),
      pitchMessageIdA: null,
      pitchMessageIdB: null,
    });

    const result = await dispatchMatches({} as any, ["m1"], 0);

    expect(result.failed).toBe(1);
    expect(mMatchUpdateMany).not.toHaveBeenCalled();
    expect(result.undelivered).toEqual([]);
  });

  it("does not cancel a match that was decided while the pitch was in flight", async () => {
    // The CAS is the whole guard: `status: "proposed"` in the WHERE means a row
    // that moved on (mutual accept from the app rail, an emergency cancel) is
    // reported as untouched rather than dragged back to `cancelled`.
    mSendPitch.mockRejectedValue(new Error("network down"));
    mMatchFindUnique.mockResolvedValue({
      dispatchedAt: null,
      pitchMessageIdA: null,
      pitchMessageIdB: null,
    });
    mMatchUpdateMany.mockResolvedValue({ count: 0 });

    const result = await dispatchMatches({} as any, ["m1"], 0);

    expect(result.failed).toBe(1);
    expect(mMatchUpdateMany).toHaveBeenCalledTimes(1);
    expect(
      (mMatchUpdateMany.mock.calls[0]![0] as { where: { status: string } }).where.status,
    ).toBe("proposed");
    // A lost race is NOT an undelivered pair. Reporting it would refund a
    // buyer whose match is alive and being acted on.
    expect(result.undelivered).toEqual([]);
  });
});
