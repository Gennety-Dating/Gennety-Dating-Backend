import { describe, expect, it, vi } from "vitest";
import { claimMatchDecision } from "./match-decision-claim.js";

describe("claimMatchDecision", () => {
  it("claims an undecided side and returns the fresh pair of decisions", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const findUnique = vi.fn().mockResolvedValue({
      status: "proposed",
      acceptedByA: true,
      acceptedByB: false,
    });

    const result = await claimMatchDecision(
      { matchId: "match-1", side: "A", decision: true },
      { updateMany, findUnique },
    );

    expect(result).toEqual({
      claimed: true,
      status: "proposed",
      acceptedByA: true,
      acceptedByB: false,
    });
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "match-1", status: "proposed", acceptedByA: null },
      data: { acceptedByA: true },
    });
  });

  it("rejects a concurrent second decision from the same side", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 0 });
    const findUnique = vi.fn();

    const result = await claimMatchDecision(
      { matchId: "match-1", side: "B", decision: false },
      { updateMany, findUnique },
    );

    expect(result).toEqual({ claimed: false });
    expect(findUnique).not.toHaveBeenCalled();
  });
});
