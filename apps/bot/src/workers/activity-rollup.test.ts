import { describe, it, expect, beforeEach, vi } from "vitest";

const { chatEventFindMany, activityFindMany, mark } = vi.hoisted(() => ({
  chatEventFindMany: vi.fn(),
  activityFindMany: vi.fn(),
  mark: vi.fn(),
}));

vi.mock("@gennety/db", () => ({
  prisma: {
    chatEvent: { findMany: chatEventFindMany },
    userActivityDay: { findMany: activityFindMany },
  },
}));

vi.mock("../services/activity.js", async () => {
  // The real `activityDay` — the reconcile and the live path MUST agree on
  // what a day is, so stubbing it would make the test pass on a disagreement.
  const actual = await vi.importActual<typeof import("../services/activity.js")>(
    "../services/activity.js",
  );
  return { activityDay: actual.activityDay, markUserActive: mark };
});

const { activityRollupTick } = await import("./activity-rollup.js");

const NOW = new Date("2026-08-27T00:20:00.000Z");

beforeEach(() => {
  chatEventFindMany.mockReset();
  activityFindMany.mockReset();
  mark.mockReset();
  mark.mockResolvedValue(undefined);
  activityFindMany.mockResolvedValue([]);
});

describe("activityRollupTick", () => {
  it("repairs a day the live mark dropped", async () => {
    chatEventFindMany.mockResolvedValue([
      { userId: "u1", createdAt: new Date("2026-08-26T18:00:00.000Z") },
    ]);
    const r = await activityRollupTick(NOW);
    expect(r).toEqual({ scanned: 1, repaired: 1, failed: 0 });
    expect(mark).toHaveBeenCalledWith("u1", "telegram", {
      at: new Date("2026-08-26T18:00:00.000Z"),
      force: true,
    });
  });

  it("leaves rows that already exist alone", async () => {
    // The job is to find holes, not to rewrite every row nightly.
    chatEventFindMany.mockResolvedValue([
      { userId: "u1", createdAt: new Date("2026-08-26T18:00:00.000Z") },
    ]);
    activityFindMany.mockResolvedValue([
      { userId: "u1", activityDate: new Date("2026-08-26T00:00:00.000Z") },
    ]);
    const r = await activityRollupTick(NOW);
    expect(r).toEqual({ scanned: 1, repaired: 0, failed: 0 });
    expect(mark).not.toHaveBeenCalled();
  });

  it("repairs with the EARLIEST instant of the day", async () => {
    // A repaired row must carry a real `firstSeenAt`, not the moment the sweep
    // happened to run — otherwise every repaired day claims the user showed up
    // at 00:20.
    chatEventFindMany.mockResolvedValue([
      { userId: "u1", createdAt: new Date("2026-08-26T22:00:00.000Z") },
      { userId: "u1", createdAt: new Date("2026-08-26T09:00:00.000Z") },
      { userId: "u1", createdAt: new Date("2026-08-26T15:00:00.000Z") },
    ]);
    const r = await activityRollupTick(NOW);
    expect(r.repaired).toBe(1);
    expect(mark).toHaveBeenCalledTimes(1);
    expect(mark.mock.calls[0]?.[2]).toMatchObject({
      at: new Date("2026-08-26T09:00:00.000Z"),
    });
  });

  it("reads only inbound events", async () => {
    // The reconcile and the live mark must agree on what activity IS. Counting
    // outbound would invent days out of nudges the product sent on its own.
    chatEventFindMany.mockResolvedValue([]);
    await activityRollupTick(NOW);
    expect(chatEventFindMany.mock.calls[0]?.[0]?.where).toMatchObject({
      direction: "in",
    });
  });

  it("looks back two days, so the minutes before midnight are covered", async () => {
    chatEventFindMany.mockResolvedValue([]);
    await activityRollupTick(NOW);
    const from = chatEventFindMany.mock.calls[0]?.[0]?.where?.createdAt?.gte as Date;
    expect(from.toISOString()).toBe("2026-08-26T00:00:00.000Z");
  });

  it("keeps going when one repair fails", async () => {
    // A single bad row must not abandon the rest of the night's repairs.
    chatEventFindMany.mockResolvedValue([
      { userId: "u1", createdAt: new Date("2026-08-26T10:00:00.000Z") },
      { userId: "u2", createdAt: new Date("2026-08-26T11:00:00.000Z") },
    ]);
    mark.mockRejectedValueOnce(new Error("write failed"));
    const r = await activityRollupTick(NOW);
    expect(r).toMatchObject({ scanned: 2, repaired: 1, failed: 1 });
  });

  it("does nothing when the timeline is empty", async () => {
    chatEventFindMany.mockResolvedValue([]);
    expect(await activityRollupTick(NOW)).toEqual({ scanned: 0, repaired: 0, failed: 0 });
    expect(activityFindMany).not.toHaveBeenCalled();
  });
});
