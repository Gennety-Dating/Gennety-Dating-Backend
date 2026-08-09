import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `flag` is a writable stand-in for the real `env`, which is readonly — the
 * same pattern `services/rematch.test.ts` uses, because the flag has to move
 * between cases and the production object deliberately forbids that.
 *
 * It lives inside `vi.hoisted` rather than as a plain const: this file imports
 * the module under test statically, and a static import is hoisted ABOVE a
 * top-level `const`, so the mock factory would run first and read `flag`
 * before its initializer.
 */
const mocks = vi.hoisted(() => ({
  matchFindMany: vi.fn(),
  applyMatchDecision: vi.fn(),
  flag: {
    SYNTHETIC_FILL_ENABLED: true,
    SYNTHETIC_DECLINE_DELAY_MS: 20 * 60 * 1000,
  },
}));
const flag = mocks.flag;

vi.mock("../config.js", () => ({ env: mocks.flag }));

vi.mock("@gennety/db", () => ({
  prisma: { match: { findMany: mocks.matchFindMany } },
}));

vi.mock("../public/matches-service.js", () => ({
  applyMatchDecision: mocks.applyMatchDecision,
}));

import { syntheticPartnerTick } from "./synthetic-partner.js";

const NOW = new Date("2026-08-09T18:00:00Z");
const HOUR = 60 * 60 * 1000;
const DELAY = 20 * 60 * 1000;

/**
 * A `proposed` row with the synthetic on side B by default — the common shape,
 * since the fill pass adds the seeded profile to a real user's leftover.
 */
function match(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: "match-1",
    userAId: "human",
    userBId: "synthetic",
    acceptedByA: true,
    acceptedByB: null,
    dispatchedAt: new Date(NOW.getTime() - HOUR),
    userA: { syntheticAt: null },
    userB: { syntheticAt: new Date("2026-08-01T00:00:00Z") },
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  flag.SYNTHETIC_FILL_ENABLED = true;
  mocks.applyMatchDecision.mockResolvedValue({ id: "match-1" });
});

describe("syntheticPartnerTick", () => {
  it("does nothing at all when the feature is off", async () => {
    flag.SYNTHETIC_FILL_ENABLED = false;
    const result = await syntheticPartnerTick({ now: NOW, delayMs: DELAY });

    expect(result.scanned).toBe(0);
    // Not even a query: the flag has to be a real kill switch, not a filter.
    expect(mocks.matchFindMany).not.toHaveBeenCalled();
  });

  it("declines once the human has answered and the hold has elapsed", async () => {
    mocks.matchFindMany.mockResolvedValue([match()]);

    const result = await syntheticPartnerTick({ now: NOW, delayMs: DELAY });

    expect(result.declined).toBe(1);
    expect(mocks.applyMatchDecision).toHaveBeenCalledWith("match-1", "synthetic", "decline");
  });

  it("declines on behalf of side A when the synthetic is A", async () => {
    mocks.matchFindMany.mockResolvedValue([
      match({
        acceptedByA: null,
        acceptedByB: false,
        userA: { syntheticAt: new Date() },
        userB: { syntheticAt: null },
      }),
    ]);

    await syntheticPartnerTick({ now: NOW, delayMs: DELAY });

    expect(mocks.applyMatchDecision).toHaveBeenCalledWith("match-1", "human", "decline");
  });

  it("waits while the human has not answered", async () => {
    // The blind-decision invariant is trivially safe because of this: the
    // synthetic never answers first, so no outcome exists before the user
    // has earned the right to see one.
    mocks.matchFindMany.mockResolvedValue([match({ acceptedByA: null })]);

    const result = await syntheticPartnerTick({ now: NOW, delayMs: DELAY });

    expect(result.declined).toBe(0);
    expect(result.pending).toBe(1);
    expect(mocks.applyMatchDecision).not.toHaveBeenCalled();
  });

  it("waits out the hold window even after the human answers", async () => {
    mocks.matchFindMany.mockResolvedValue([
      match({ dispatchedAt: new Date(NOW.getTime() - 60_000) }),
    ]);

    const result = await syntheticPartnerTick({ now: NOW, delayMs: DELAY });

    expect(result.declined).toBe(0);
    expect(result.pending).toBe(1);
  });

  it("never answers twice for the same match", async () => {
    mocks.matchFindMany.mockResolvedValue([match({ acceptedByB: false })]);

    const result = await syntheticPartnerTick({ now: NOW, delayMs: DELAY });

    expect(result.declined).toBe(0);
    expect(mocks.applyMatchDecision).not.toHaveBeenCalled();
  });

  it("leaves a both-synthetic row alone", async () => {
    // `previewSyntheticFill` refuses to build one, but a hand-seeded row could
    // exist and answering for both sides would resolve a match nobody saw.
    mocks.matchFindMany.mockResolvedValue([
      match({ userA: { syntheticAt: new Date() }, acceptedByA: null }),
    ]);

    const result = await syntheticPartnerTick({ now: NOW, delayMs: DELAY });

    expect(result.declined).toBe(0);
    expect(mocks.applyMatchDecision).not.toHaveBeenCalled();
  });

  it("counts a refusal instead of swallowing it", async () => {
    // `applyMatchDecision` answers null when the row is no longer `proposed`.
    // Dropping that on the floor is how a permanently stuck match ends up
    // looking exactly like a healthy one.
    mocks.applyMatchDecision.mockResolvedValue(null);
    mocks.matchFindMany.mockResolvedValue([match()]);

    const result = await syntheticPartnerTick({ now: NOW, delayMs: DELAY });

    expect(result.declined).toBe(0);
    expect(result.refused).toBe(1);
  });

  it("survives a throw and keeps processing", async () => {
    mocks.applyMatchDecision
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ id: "match-2" });
    mocks.matchFindMany.mockResolvedValue([match(), match({ id: "match-2" })]);

    const result = await syntheticPartnerTick({ now: NOW, delayMs: DELAY });

    expect(result.refused).toBe(1);
    expect(result.declined).toBe(1);
  });
});
