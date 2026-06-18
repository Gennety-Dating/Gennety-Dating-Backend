import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@gennety/db", () => ({
  prisma: {
    match: {
      update: vi.fn().mockResolvedValue({}),
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
const mMatchUpdate = (prisma.match as unknown as { update: MockFn }).update;

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
    expect(mMatchUpdate).toHaveBeenCalledTimes(3);

    // Each update should set dispatchedAt.
    for (const call of mMatchUpdate.mock.calls) {
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
    expect(mMatchUpdate).toHaveBeenCalledOnce();
  });

  it("handles empty input gracefully", async () => {
    const result = await dispatchMatches({} as any, [], 0);
    expect(result.dispatched).toBe(0);
    expect(result.failed).toBe(0);
    expect(mSendPitch).not.toHaveBeenCalled();
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
});
