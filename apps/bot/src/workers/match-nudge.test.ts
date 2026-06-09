import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@gennety/db", () => ({
  prisma: {
    match: {
      findMany: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
  },
}));

vi.mock("../config.js", () => ({
  env: { OPENAI_API_KEY: "test-key" },
}));

import { prisma } from "@gennety/db";
import {
  matchNudgeTick,
  PROPOSAL_NUDGE1_MS,
  PROPOSAL_NUDGE2_MS,
} from "./match-nudge.js";

// 2024-06-15 — Kyiv summer time (UTC+3). C-8 anchored quiet hours to Kyiv,
// so we pick UTC instants whose Kyiv-local hour is unambiguously day/quiet.
const DAY_TIME = new Date("2024-06-15T11:00:00Z"); //   14:00 Kyiv — daytime
const QUIET_TIME = new Date("2024-06-15T02:00:00Z"); // 05:00 Kyiv — quiet

function createMockApi() {
  return { sendMessage: vi.fn().mockResolvedValue({}) } as any;
}

function openaiOk(content: string) {
  return {
    ok: true,
    json: async () => ({ choices: [{ message: { content } }] }),
  };
}

function makeProposedMatch(overrides: Record<string, unknown> = {}) {
  const dispatched = new Date(DAY_TIME.getTime() - PROPOSAL_NUDGE1_MS - 60_000); // 3h+1m ago
  return {
    id: "match-1",
    dispatchedAt: dispatched,
    proposalNudge1SentAt: null,
    proposalNudge2SentAt: null,
    acceptedByA: null,
    acceptedByB: null,
    pitchForA: "She loves jazz and late-night philosophy debates.",
    pitchForB: "He's into hiking and cooking.",
    userA: { telegramId: BigInt(1), language: "en", firstName: "Alice" },
    userB: { telegramId: BigInt(2), language: "en", firstName: "Bob" },
    ...overrides,
  };
}

function makeNegotiatingMatch(overrides: Record<string, unknown> = {}) {
  // Both accepted, neither has picked a slot. Anchor `dispatchedAt` 6h+1m ago
  // to clear the scheduling-phase nudge1 cutoff (SCHED_NUDGE1_MS = 6h).
  const dispatched = new Date(DAY_TIME.getTime() - 6 * 60 * 60_000 - 60_000);
  return {
    id: "match-2",
    dispatchedAt: dispatched,
    schedNudge1SentAt: null,
    schedNudge2SentAt: null,
    pickedTimeA: null,
    pickedTimeB: null,
    schedulingIteration: 1,
    userA: { telegramId: BigInt(11), language: "en", firstName: "Carol" },
    userB: { telegramId: BigInt(12), language: "en", firstName: "Dan" },
    ...overrides,
  };
}

describe("matchNudgeTick", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (prisma.match.update as ReturnType<typeof vi.fn>).mockResolvedValue({});
    (prisma.match.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 1 });
  });

  it("returns zeros during quiet hours without DB query", async () => {
    const api = createMockApi();
    const result = await matchNudgeTick(api, { now: QUIET_TIME });

    expect(result).toEqual({ proposalNudges: 0, schedNudges: 0 });
    expect(prisma.match.findMany).not.toHaveBeenCalled();
  });

  it("sends nudge 1 to both users who haven't accepted", async () => {
    (prisma.match.findMany as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([makeProposedMatch()]) // proposal query
      .mockResolvedValueOnce([]);                   // scheduling query

    const mockFetch = vi.fn().mockResolvedValue(openaiOk("Did you see your match? 👀"));
    const api = createMockApi();

    const result = await matchNudgeTick(api, { fetchFn: mockFetch, now: DAY_TIME });

    expect(result.proposalNudges).toBe(2); // Alice + Bob
    expect(api.sendMessage).toHaveBeenCalledTimes(2);
    expect(api.sendMessage).toHaveBeenCalledWith(1, expect.any(String), expect.anything());
    expect(api.sendMessage).toHaveBeenCalledWith(2, expect.any(String), expect.anything());
    // stamps proposalNudge1SentAt (C-6 split column)
    expect(prisma.match.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { proposalNudge1SentAt: DAY_TIME } }),
    );
  });

  it("sends nudge 1 only to the user who hasn't accepted", async () => {
    const match = makeProposedMatch({ acceptedByA: true }); // A accepted, B didn't
    (prisma.match.findMany as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([match])
      .mockResolvedValueOnce([]);

    const mockFetch = vi.fn().mockResolvedValue(openaiOk("Hey!"));
    const api = createMockApi();

    const result = await matchNudgeTick(api, { fetchFn: mockFetch, now: DAY_TIME });

    expect(result.proposalNudges).toBe(1);
    expect(api.sendMessage).toHaveBeenCalledOnce();
    expect(api.sendMessage).toHaveBeenCalledWith(2, expect.any(String), expect.anything());
  });

  it("sends nudge 2 (not nudge 1 again) when ≥10h elapsed and nudge1 already sent", async () => {
    const dispatched = new Date(DAY_TIME.getTime() - PROPOSAL_NUDGE2_MS - 60_000);
    const match = makeProposedMatch({
      dispatchedAt: dispatched,
      proposalNudge1SentAt: new Date(DAY_TIME.getTime() - 5 * 60 * 60_000),
      proposalNudge2SentAt: null,
    });

    (prisma.match.findMany as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([match])
      .mockResolvedValueOnce([]);

    const mockFetch = vi.fn().mockResolvedValue(openaiOk("Last chance!"));
    const api = createMockApi();

    await matchNudgeTick(api, { fetchFn: mockFetch, now: DAY_TIME });

    expect(prisma.match.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { proposalNudge2SentAt: DAY_TIME } }),
    );
  });

  it("C-6: scheduling-phase reads schedNudge*, NOT proposalNudge*", async () => {
    // Regression: pre-fix, proposal-phase stamps blocked scheduling-phase
    // nudges via the shared nudge1/2SentAt columns. Verify that a row with
    // proposalNudge1/2 set still gets a fresh schedNudge1.
    const match = makeNegotiatingMatch({
      proposalNudge1SentAt: new Date(DAY_TIME.getTime() - 8 * 60 * 60_000),
      proposalNudge2SentAt: new Date(DAY_TIME.getTime() - 7 * 60 * 60_000),
    });

    (prisma.match.findMany as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([]) // proposal query empty
      .mockResolvedValueOnce([match]); // scheduling query

    const mockFetch = vi.fn().mockResolvedValue(openaiOk("Pick a time!"));
    const api = createMockApi();

    const result = await matchNudgeTick(api, { fetchFn: mockFetch, now: DAY_TIME });

    expect(result.schedNudges).toBe(2); // both Carol + Dan
    // Stamps schedNudge1SentAt — NOT proposalNudge*.
    expect(prisma.match.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { schedNudge1SentAt: DAY_TIME } }),
    );
  });

  it("C-6: scheduling phase skips mobile-only users (telegramId <= 0n)", async () => {
    const match = makeNegotiatingMatch({
      userB: { telegramId: -10n, language: "en", firstName: "MobileDan" },
    });

    (prisma.match.findMany as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([match]);

    const mockFetch = vi.fn().mockResolvedValue(openaiOk("Pick a time!"));
    const api = createMockApi();
    await matchNudgeTick(api, { fetchFn: mockFetch, now: DAY_TIME });

    // Only Carol (positive id) is messaged.
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    expect(api.sendMessage).toHaveBeenCalledWith(11, expect.any(String), expect.anything());
  });

  it("uses fallback when OpenAI fails", async () => {
    (prisma.match.findMany as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([makeProposedMatch()])
      .mockResolvedValueOnce([]);

    const mockFetch = vi.fn().mockRejectedValue(new Error("network error"));
    const api = createMockApi();

    const result = await matchNudgeTick(api, { fetchFn: mockFetch, now: DAY_TIME });

    expect(result.proposalNudges).toBe(2);
    const sentText: string = api.sendMessage.mock.calls[0][1];
    expect(sentText.length).toBeGreaterThan(0);
  });

  it("skips blocked users and continues", async () => {
    (prisma.match.findMany as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([makeProposedMatch()])
      .mockResolvedValueOnce([]);

    const mockFetch = vi.fn().mockResolvedValue(openaiOk("Hey!"));
    const api = createMockApi();
    api.sendMessage.mockRejectedValue(new Error("Forbidden"));

    const result = await matchNudgeTick(api, { fetchFn: mockFetch, now: DAY_TIME });

    // Failed sends don't increment the count, but we still stamped the match
    expect(result.proposalNudges).toBe(0);
    expect(prisma.match.updateMany).toHaveBeenCalled();
  });

  it("does not send when another worker already claimed the nudge", async () => {
    (prisma.match.findMany as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([makeProposedMatch()])
      .mockResolvedValueOnce([]);
    (prisma.match.updateMany as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ count: 0 });
    const api = createMockApi();

    const result = await matchNudgeTick(api, { now: DAY_TIME });

    expect(result.proposalNudges).toBe(0);
    expect(api.sendMessage).not.toHaveBeenCalled();
  });
});
