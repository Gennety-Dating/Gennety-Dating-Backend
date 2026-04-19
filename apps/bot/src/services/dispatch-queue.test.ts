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
}));

import { prisma } from "@gennety/db";
import { sendMatchProposal } from "../handlers/matching/pitch.js";
import { dispatchMatches } from "./dispatch-queue.js";

type MockFn = ReturnType<typeof vi.fn>;
const mSendPitch = sendMatchProposal as unknown as MockFn;
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
      .mockRejectedValueOnce(new Error("Telegram 429")) // m2 fails
      .mockResolvedValueOnce(undefined); // m3 OK

    const result = await dispatchMatches({} as any, ["m1", "m2", "m3"], 0);

    expect(result.dispatched).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.errors[0]!.matchId).toBe("m2");
    expect(result.errors[0]!.error).toContain("429");
  });

  it("handles empty input gracefully", async () => {
    const result = await dispatchMatches({} as any, [], 0);
    expect(result.dispatched).toBe(0);
    expect(result.failed).toBe(0);
    expect(mSendPitch).not.toHaveBeenCalled();
  });
});
