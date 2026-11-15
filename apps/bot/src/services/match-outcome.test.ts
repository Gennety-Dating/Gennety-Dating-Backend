import { beforeEach, describe, expect, it, vi } from "vitest";

const findFirstMatch = vi.fn();
const findFirstEvent = vi.fn();

vi.mock("@gennety/db", () => ({
  prisma: {
    match: { findFirst: (...args: unknown[]) => findFirstMatch(...args) },
    matchEvent: { findFirst: (...args: unknown[]) => findFirstEvent(...args) },
  },
}));

import { classifyMatchOutcome, lastMatchOutcomeFor, type OutcomeRow } from "./match-outcome.js";

const ME = "user-a";
const PARTNER = "user-b";

function row(over: Partial<OutcomeRow>): OutcomeRow {
  return {
    status: "expired",
    userAId: ME,
    acceptedByA: null,
    acceptedByB: null,
    emergencyCancelledBy: null,
    ...over,
  };
}

describe("classifyMatchOutcome", () => {
  it("expiry: silent caller, silent partner → you_silent (no word about the partner)", () => {
    expect(classifyMatchOutcome(row({}), ME)).toBe("expired_you_silent");
  });

  it("expiry: silent caller whose partner said yes → missed_date (Telegram says the same)", () => {
    expect(classifyMatchOutcome(row({ acceptedByB: true }), ME)).toBe("expired_missed_date");
  });

  it("expiry: silent caller whose partner passed → you_silent, the pass is NOT revealed", () => {
    expect(classifyMatchOutcome(row({ acceptedByB: false }), ME)).toBe("expired_you_silent");
  });

  it("expiry: caller said yes, partner silent → peer_silent", () => {
    expect(classifyMatchOutcome(row({ acceptedByA: true }), ME)).toBe("expired_peer_silent");
  });

  it("expiry: caller passed → you_declined", () => {
    expect(classifyMatchOutcome(row({ acceptedByA: false }), ME)).toBe("expired_you_declined");
  });

  it("works from side B as well", () => {
    expect(classifyMatchOutcome(row({ acceptedByA: true }), PARTNER)).toBe("expired_missed_date");
  });

  it("cancelled after both decided: caller yes, partner no → declined_by_partner", () => {
    expect(
      classifyMatchOutcome(row({ status: "cancelled", acceptedByA: true, acceptedByB: false }), ME),
    ).toBe("declined_by_partner");
  });

  it("cancelled after both decided: caller passed → declined_by_you", () => {
    expect(
      classifyMatchOutcome(row({ status: "cancelled", acceptedByA: false, acceptedByB: true }), ME),
    ).toBe("declined_by_you");
  });

  it("blind rule: a partner's decline on a row the caller never answered is only 'cancelled'", () => {
    expect(
      classifyMatchOutcome(row({ status: "cancelled", acceptedByA: null, acceptedByB: false }), ME),
    ).toBe("cancelled");
  });

  it("cancelled after the mutual yes: who cancelled", () => {
    const both = { status: "cancelled", acceptedByA: true, acceptedByB: true };
    expect(classifyMatchOutcome(row({ ...both, emergencyCancelledBy: ME }), ME)).toBe(
      "cancelled_by_you",
    );
    expect(classifyMatchOutcome(row({ ...both, emergencyCancelledBy: PARTNER }), ME)).toBe(
      "cancelled_by_partner",
    );
    expect(classifyMatchOutcome(row(both), ME)).toBe("cancelled");
  });

  it("an active or completed row has no outcome", () => {
    expect(classifyMatchOutcome(row({ status: "scheduled" }), ME)).toBeNull();
    expect(classifyMatchOutcome(row({ status: "completed" }), ME)).toBeNull();
  });
});

describe("lastMatchOutcomeFor", () => {
  const NOW = new Date("2026-11-15T12:00:00Z");
  const UPDATED = new Date("2026-11-15T10:00:00Z");

  beforeEach(() => {
    findFirstMatch.mockReset();
    findFirstEvent.mockReset();
  });

  it("asks only for shown, recently ended matches of the caller", async () => {
    findFirstMatch.mockResolvedValue(null);
    await expect(lastMatchOutcomeFor(ME, NOW)).resolves.toBeNull();
    const where = findFirstMatch.mock.calls[0]![0].where;
    expect(where.status).toEqual({ in: ["expired", "cancelled"] });
    expect(where.dispatchedAt).toEqual({ not: null });
    expect(where.updatedAt.gte.toISOString()).toBe("2026-11-12T12:00:00.000Z");
  });

  it("reads the penalty from the expiry event, not from the profile counter", async () => {
    findFirstMatch.mockResolvedValue({ id: "m1", ...row({}), updatedAt: UPDATED });
    findFirstEvent.mockResolvedValue({ metadata: { penalised: true, offenseCount: 2 } });
    await expect(lastMatchOutcomeFor(ME, NOW)).resolves.toEqual({
      matchId: "m1",
      kind: "expired_you_silent",
      penalized: true,
      at: UPDATED.toISOString(),
    });
  });

  it("an expiry recorded before the metadata existed reads as the warning", async () => {
    findFirstMatch.mockResolvedValue({ id: "m1", ...row({}), updatedAt: UPDATED });
    findFirstEvent.mockResolvedValue({ metadata: null });
    const out = await lastMatchOutcomeFor(ME, NOW);
    expect(out?.penalized).toBe(false);
  });

  it("does not look for a penalty on a non-silent outcome", async () => {
    findFirstMatch.mockResolvedValue({
      id: "m2",
      ...row({ status: "cancelled", acceptedByA: true, acceptedByB: false }),
      updatedAt: UPDATED,
    });
    const out = await lastMatchOutcomeFor(ME, NOW);
    expect(out?.kind).toBe("declined_by_partner");
    expect(out?.penalized).toBe(false);
    expect(findFirstEvent).not.toHaveBeenCalled();
  });
});
