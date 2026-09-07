import { describe, it, expect, vi, beforeEach } from "vitest";

const userFindUnique = vi.hoisted(() => vi.fn());
const matchFindUnique = vi.hoisted(() => vi.fn());
vi.mock("@gennety/db", () => ({
  prisma: {
    user: { findUnique: userFindUnique },
    match: { findUnique: matchFindUnique },
  },
}));
vi.mock("../handlers/matching/negative-constraints.js", () => ({
  appendNegativeConstraint: vi.fn().mockResolvedValue(true),
}));
vi.mock("./match-events.js", () => ({
  attachDeclineReasonToMatchEvent: vi.fn().mockResolvedValue(undefined),
}));

import { recordRejectionFeedback } from "./rejection-feedback.js";

/**
 * Who may explain a decline.
 *
 * This took a Telegram id and nothing else, which made it structurally
 * unreachable from the native rail — and the reason it collects lands in
 * `Profile.negativeConstraints`, which the matcher reads directly. So someone
 * living in the app declined five times and kept being offered the same type,
 * while their neighbour in Telegram tuned their matching from the first
 * decline.
 */

beforeEach(() => {
  userFindUnique.mockReset();
  matchFindUnique.mockReset();
});

describe("recordRejectionFeedback", () => {
  it("accepts our own user id, not only a Telegram one", async () => {
    userFindUnique.mockResolvedValue({ id: "u1", language: "en" });
    matchFindUnique.mockResolvedValue(null);

    await recordRejectionFeedback({
      userId: "u1",
      matchId: "m1",
      reason: "not my type at all, too much partying",
    });

    expect(userFindUnique).toHaveBeenCalledWith({
      where: { id: "u1" },
      select: { id: true, language: true },
    });
  });

  it("still accepts a Telegram id", async () => {
    userFindUnique.mockResolvedValue({ id: "u1", language: "en" });
    matchFindUnique.mockResolvedValue(null);

    await recordRejectionFeedback({
      telegramId: 4242n,
      matchId: "m1",
      reason: "not my type at all, too much partying",
    });

    expect(userFindUnique).toHaveBeenCalledWith({
      where: { telegramId: 4242n },
      select: { id: true, language: true },
    });
  });

  it("refuses when told nothing about who is explaining", async () => {
    const result = await recordRejectionFeedback({
      matchId: "m1",
      reason: "not my type at all, too much partying",
    });

    expect(result).toMatchObject({ success: false, code: "user_not_found" });
    expect(userFindUnique).not.toHaveBeenCalled();
  });

  it("keeps the concierge's floor on a vague reason", async () => {
    // The bar exists because the concierge can ask a follow-up question.
    const result = await recordRejectionFeedback({
      userId: "u1",
      matchId: "m1",
      reason: "meh",
    });

    expect(result).toMatchObject({ success: false, code: "reason_too_vague" });
  });

  it("lets a caller that cannot ask a follow-up waive it", async () => {
    // A route has one shot at whatever the person typed on the confirm card.
    userFindUnique.mockResolvedValue({ id: "u1", language: "en" });
    matchFindUnique.mockResolvedValue(null);

    const result = await recordRejectionFeedback({
      userId: "u1",
      matchId: "m1",
      reason: "meh",
      requireConcreteReason: false,
    });

    expect(result).not.toMatchObject({ code: "reason_too_vague" });
  });
});
