import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@gennety/db", () => ({
  prisma: {
    match: {
      findMany: vi.fn(),
      update: vi.fn(),
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

const DAY_TIME  = new Date("2024-06-15T11:00:00Z"); // 11:00 UTC — daytime
const QUIET_TIME = new Date("2024-06-15T02:00:00Z"); // 02:00 UTC — quiet

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
    nudge1SentAt: null,
    nudge2SentAt: null,
    acceptedByA: null,
    acceptedByB: null,
    pitchForA: "She loves jazz and late-night philosophy debates.",
    pitchForB: "He's into hiking and cooking.",
    userA: { telegramId: BigInt(1), language: "en", firstName: "Alice" },
    userB: { telegramId: BigInt(2), language: "en", firstName: "Bob" },
    ...overrides,
  };
}

describe("matchNudgeTick", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (prisma.match.update as ReturnType<typeof vi.fn>).mockResolvedValue({});
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
    // stamps nudge1SentAt
    expect(prisma.match.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { nudge1SentAt: DAY_TIME } }),
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
      nudge1SentAt: new Date(DAY_TIME.getTime() - 5 * 60 * 60_000),
      nudge2SentAt: null,
    });

    (prisma.match.findMany as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([match])
      .mockResolvedValueOnce([]);

    const mockFetch = vi.fn().mockResolvedValue(openaiOk("Last chance!"));
    const api = createMockApi();

    await matchNudgeTick(api, { fetchFn: mockFetch, now: DAY_TIME });

    expect(prisma.match.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { nudge2SentAt: DAY_TIME } }),
    );
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
    expect(prisma.match.update).toHaveBeenCalled();
  });
});
