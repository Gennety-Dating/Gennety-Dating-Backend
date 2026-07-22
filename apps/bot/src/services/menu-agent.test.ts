import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------
vi.mock("@gennety/db", () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    profile: {
      update: vi.fn(),
      upsert: vi.fn(),
      findUnique: vi.fn(),
    },
    match: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    matchEvent: {
      updateMany: vi.fn(),
    },
    systemKnowledge: {
      findMany: vi.fn().mockResolvedValue([]),
    },
  },
}));

vi.mock("../config.js", () => ({
  env: {
    BOT_TOKEN: "test",
    DATABASE_URL: "test",
    OPENAI_API_KEY: "test-key",
    SMTP_HOST: "test",
    SMTP_PORT: 587,
    SMTP_USER: "test",
    SMTP_PASS: "test",
    SMTP_FROM: "test@test.com",
    CUSTOM_EMOJI_LIKE_ID: "",
    CUSTOM_EMOJI_DISLIKE_ID: "",
    CUSTOM_EMOJI_MENU_ID: "",
    WEBAPP_URL: "https://test.invalid/calendar",
  },
}));

// `appendNegativeConstraint` calls the LLM under the hood; stub it out.
vi.mock("../handlers/matching/negative-constraints.js", () => ({
  appendNegativeConstraint: vi.fn(),
}));

import { prisma } from "@gennety/db";
import { runMenuAgentTurn, splitReplyIntoBubbles } from "./menu-agent.js";
import { clearKnowledgeCache } from "./prompt-builder.js";
import { appendNegativeConstraint } from "../handlers/matching/negative-constraints.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function textResponse(content: string) {
  return {
    ok: true,
    json: async () => ({
      choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
    }),
    text: async () => "",
  };
}

function toolCallResponse(
  calls: Array<{ id: string; name: string; args: Record<string, unknown> }>,
) {
  return {
    ok: true,
    json: async () => ({
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: calls.map((c) => ({
              id: c.id,
              type: "function",
              function: { name: c.name, arguments: JSON.stringify(c.args) },
            })),
          },
          finish_reason: "tool_calls",
        },
      ],
    }),
    text: async () => "",
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("menu-agent record_rejection_feedback", () => {
  const telegramId = BigInt(1001);
  const matchId = "match-1";

  beforeEach(() => {
    vi.resetAllMocks();
    clearKnowledgeCache();

    // `appendNegativeConstraint` is reset by resetAllMocks, so re-stub.
    (appendNegativeConstraint as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    // `systemKnowledge.findMany` is reset too — re-stub.
    (prisma.systemKnowledge.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    // Default: buildSystemPrompt → no pending rejection
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockImplementation(
      async (args: { select?: Record<string, unknown> }) => {
        // Query from prompt-builder.fetchUserContext (selects id + matchesAsA/B)
        if (args.select && "matchesAsA" in args.select) {
          return {
            id: "uid-A",
            firstName: "Alice",
            universityDomain: "stanford.edu",
            status: "active",
            language: "en",
            matchesAsA: [],
            matchesAsB: [],
          };
        }
        // Query from runMenuAgentTurn for messageHistory
        if (args.select && "messageHistory" in args.select) {
          return { messageHistory: [] };
        }
        // Query from executor (select: { id, language })
        return { id: "uid-A", language: "en" };
      },
    );
    (prisma.user.update as ReturnType<typeof vi.fn>).mockResolvedValue({});
    (prisma.user.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 1 });
    (prisma.match.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (prisma.match.update as ReturnType<typeof vi.fn>).mockResolvedValue({});
  });

  it("persists rejection reason on the match and fires appendNegativeConstraint", async () => {
    (prisma.match.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      userAId: "uid-A",
      userBId: "uid-B",
      status: "cancelled",
      acceptedByA: false,
      acceptedByB: null,
      rejectionReasonA: null,
      rejectionReasonB: null,
    });

    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(
        toolCallResponse([
          {
            id: "call-1",
            name: "record_rejection_feedback",
            args: {
              match_id: matchId,
              reason: "prefers more extroverted social partners",
            },
          },
        ]),
      )
      .mockResolvedValueOnce(textResponse("got it, noted"));

    const result = await runMenuAgentTurn(telegramId, "he was too quiet for me", {
      fetchFn: mockFetch,
    });

    expect(result.reply).toBe("got it, noted");
    expect(prisma.match.update).toHaveBeenCalledWith({
      where: { id: matchId },
      data: { rejectionReasonA: "prefers more extroverted social partners" },
    });
    expect(prisma.matchEvent.updateMany).toHaveBeenCalledWith({
      where: {
        matchId,
        actorId: "uid-A",
        targetId: "uid-B",
        actionType: "DECLINED",
      },
      data: {
        metadata: {
          rejectionReason: "prefers more extroverted social partners",
        },
      },
    });
    expect(appendNegativeConstraint).toHaveBeenCalledWith(
      "uid-A",
      "prefers more extroverted social partners",
      "en",
    );
  });

  it("rejects short/vague reasons without writing to DB", async () => {
    (prisma.match.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      userAId: "uid-A",
      userBId: "uid-B",
      status: "cancelled",
      acceptedByA: false,
      acceptedByB: null,
      rejectionReasonA: null,
      rejectionReasonB: null,
    });

    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(
        toolCallResponse([
          { id: "call-1", name: "record_rejection_feedback", args: { match_id: matchId, reason: "idk" } },
        ]),
      )
      .mockResolvedValueOnce(textResponse("ok tell me more — what didn't click?"));

    await runMenuAgentTurn(telegramId, "idk", { fetchFn: mockFetch });

    expect(prisma.match.update).not.toHaveBeenCalled();
    expect(appendNegativeConstraint).not.toHaveBeenCalled();
  });

  it("refuses when the match does not belong to the caller", async () => {
    (prisma.match.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      userAId: "uid-X",
      userBId: "uid-Y",
      status: "cancelled",
      acceptedByA: false,
      acceptedByB: null,
      rejectionReasonA: null,
      rejectionReasonB: null,
    });

    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(
        toolCallResponse([
          {
            id: "call-1",
            name: "record_rejection_feedback",
            args: { match_id: matchId, reason: "too quiet and reserved" },
          },
        ]),
      )
      .mockResolvedValueOnce(textResponse("sorry, something's off"));

    await runMenuAgentTurn(telegramId, "he was too quiet", { fetchFn: mockFetch });

    expect(prisma.match.update).not.toHaveBeenCalled();
    expect(appendNegativeConstraint).not.toHaveBeenCalled();
  });

  it("persists when the first decliner is still in proposed state", async () => {
    (prisma.match.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      userAId: "uid-A",
      userBId: "uid-B",
      status: "proposed",
      acceptedByA: false,
      acceptedByB: null,
      rejectionReasonA: null,
      rejectionReasonB: null,
    });

    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(
        toolCallResponse([
          {
            id: "call-1",
            name: "record_rejection_feedback",
            args: { match_id: matchId, reason: "too quiet and reserved" },
          },
        ]),
      )
      .mockResolvedValueOnce(textResponse("saved for next time"));

    await runMenuAgentTurn(telegramId, "x", { fetchFn: mockFetch });

    expect(prisma.match.update).toHaveBeenCalledWith({
      where: { id: matchId },
      data: { rejectionReasonA: "too quiet and reserved" },
    });
    expect(appendNegativeConstraint).toHaveBeenCalledWith(
      "uid-A",
      "too quiet and reserved",
      "en",
    );
  });

  it("refuses when the user has not personally declined", async () => {
    (prisma.match.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      userAId: "uid-A",
      userBId: "uid-B",
      status: "proposed",
      acceptedByA: null,
      acceptedByB: null,
      rejectionReasonA: null,
      rejectionReasonB: null,
    });

    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(
        toolCallResponse([
          {
            id: "call-1",
            name: "record_rejection_feedback",
            args: { match_id: matchId, reason: "too quiet and reserved" },
          },
        ]),
      )
      .mockResolvedValueOnce(textResponse("no active rejection"));

    await runMenuAgentTurn(telegramId, "x", { fetchFn: mockFetch });

    expect(prisma.match.update).not.toHaveBeenCalled();
    expect(appendNegativeConstraint).not.toHaveBeenCalled();
  });

  it("is idempotent when a reason is already recorded", async () => {
    (prisma.match.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      userAId: "uid-A",
      userBId: "uid-B",
      status: "cancelled",
      acceptedByA: false,
      acceptedByB: null,
      rejectionReasonA: "already here",
      rejectionReasonB: null,
    });

    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(
        toolCallResponse([
          {
            id: "call-1",
            name: "record_rejection_feedback",
            args: { match_id: matchId, reason: "a second reason being submitted" },
          },
        ]),
      )
      .mockResolvedValueOnce(textResponse("already noted"));

    await runMenuAgentTurn(telegramId, "also he was too tall", { fetchFn: mockFetch });

    // Executor returns success but must not overwrite or re-append.
    expect(prisma.match.update).not.toHaveBeenCalled();
    expect(appendNegativeConstraint).not.toHaveBeenCalled();
  });
});

describe("menu-agent resume_matching", () => {
  const telegramId = BigInt(1001);

  beforeEach(() => {
    vi.resetAllMocks();
    clearKnowledgeCache();
    (prisma.systemKnowledge.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (prisma.user.update as ReturnType<typeof vi.fn>).mockResolvedValue({});
    (prisma.user.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 1 });
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockImplementation(
      async (args: { select?: Record<string, unknown> }) => {
        if (args.select && "matchesAsA" in args.select) {
          return {
            id: "uid-A",
            firstName: "Alice",
            universityDomain: "stanford.edu",
            status: "banned",
            language: "en",
            matchesAsA: [],
            matchesAsB: [],
          };
        }
        if (args.select && "messageHistory" in args.select) {
          return { messageHistory: [] };
        }
        if (args.select && "status" in args.select) {
          return { status: "banned" };
        }
        return { id: "uid-A", language: "en" };
      },
    );
  });

  it("refuses to reactivate users outside the paused state", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(
        toolCallResponse([{ id: "call-1", name: "resume_matching", args: {} }]),
      )
      .mockResolvedValueOnce(textResponse("I can't resume matching from this account state."));

    await runMenuAgentTurn(telegramId, "resume me", { fetchFn: mockFetch });

    expect(prisma.user.updateMany).not.toHaveBeenCalled();
    const secondCallBody = JSON.parse(mockFetch.mock.calls[1][1].body);
    const toolMessage = secondCallBody.messages.find((m: { role: string }) => m.role === "tool");
    expect(toolMessage).toBeDefined();
    expect(JSON.parse(toolMessage.content).success).toBe(false);
  });
});

describe("splitReplyIntoBubbles", () => {
  it("keeps a reply without blank lines as one bubble", () => {
    expect(splitReplyIntoBubbles("готово ✨ жду вторую сторону")).toEqual([
      "готово ✨ жду вторую сторону",
    ]);
    expect(splitReplyIntoBubbles("line one\nstill same bubble")).toEqual([
      "line one\nstill same bubble",
    ]);
  });

  it("splits on blank lines into separate bubbles", () => {
    expect(splitReplyIntoBubbles("первая мысль\n\nвторая мысль")).toEqual([
      "первая мысль",
      "вторая мысль",
    ]);
  });

  it("caps at three bubbles, folding overflow into the last", () => {
    const out = splitReplyIntoBubbles("a\n\nb\n\nc\n\nd\n\ne");
    expect(out).toHaveLength(3);
    expect(out[0]).toBe("a");
    expect(out[1]).toBe("b");
    expect(out[2]).toBe("c\n\nd\n\ne");
  });

  it("strips markdown emphasis — bubbles are sent as plain text", () => {
    expect(
      splitReplyIntoBubbles("у тебя уже есть дата: **четверг, 16 июля, 19:00**, **Kyiv Food Market**."),
    ).toEqual(["у тебя уже есть дата: четверг, 16 июля, 19:00, Kyiv Food Market."]);
    expect(splitReplyIntoBubbles("могу напомнить, __как вы найдёте друг друга__")).toEqual([
      "могу напомнить, как вы найдёте друг друга",
    ]);
    expect(splitReplyIntoBubbles("набери `/menu` в чате")).toEqual([
      "набери /menu в чате",
    ]);
  });

  it("drops empty fragments and trims whitespace", () => {
    expect(splitReplyIntoBubbles("  привет  \n\n\n\n  как дела  ")).toEqual([
      "привет",
      "как дела",
    ]);
  });
});

describe("menu-agent offer_cancel_premium", () => {
  const telegramId = BigInt(2002);
  const FUTURE = new Date("2026-08-19T12:00:00Z");

  beforeEach(() => {
    vi.resetAllMocks();
    clearKnowledgeCache();
    (prisma.systemKnowledge.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (prisma.user.update as ReturnType<typeof vi.fn>).mockResolvedValue({});
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockImplementation(
      async (args: { select?: Record<string, unknown> }) => {
        if (args.select && "matchesAsA" in args.select) {
          return {
            id: "uid-A",
            firstName: "Alice",
            universityDomain: "stanford.edu",
            status: "active",
            language: "en",
            matchesAsA: [],
            matchesAsB: [],
          };
        }
        if (args.select && "messageHistory" in args.select) {
          return { messageHistory: [] };
        }
        // getPremiumCancelContext — an active Telegram Stars subscriber.
        if (args.select && "premiumUntil" in args.select) {
          return {
            premiumUntil: FUTURE,
            premiumProvider: "telegram_stars",
            premiumExternalId: "charge-x",
            premiumAutoRenew: true,
          };
        }
        // evaluatePremiumCancelOffer's own id+language lookup.
        return { id: "uid-A", language: "en" };
      },
    );
  });

  it("returns the confirm-card action for an active Stars subscriber", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(
        toolCallResponse([{ id: "c1", name: "offer_cancel_premium", args: {} }]),
      )
      .mockResolvedValueOnce(textResponse("sure — one sec"));

    const result = await runMenuAgentTurn(telegramId, "cancel my premium please", {
      fetchFn: mockFetch,
    });

    expect(result.reply).toBe("sure — one sec");
    expect(result.action).toEqual({ kind: "premium_cancel_confirm" });
  });

  it("has no action when the user has no active subscription", async () => {
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockImplementation(
      async (args: { select?: Record<string, unknown> }) => {
        if (args.select && "matchesAsA" in args.select) {
          return {
            id: "uid-A",
            firstName: "Alice",
            universityDomain: "stanford.edu",
            status: "active",
            language: "en",
            matchesAsA: [],
            matchesAsB: [],
          };
        }
        if (args.select && "messageHistory" in args.select) return { messageHistory: [] };
        if (args.select && "premiumUntil" in args.select) {
          return {
            premiumUntil: null,
            premiumProvider: null,
            premiumExternalId: null,
            premiumAutoRenew: false,
          };
        }
        return { id: "uid-A", language: "en" };
      },
    );

    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(
        toolCallResponse([{ id: "c1", name: "offer_cancel_premium", args: {} }]),
      )
      .mockResolvedValueOnce(textResponse("you don't have an active sub"));

    const result = await runMenuAgentTurn(telegramId, "cancel premium", {
      fetchFn: mockFetch,
    });

    expect(result.action).toBeUndefined();
  });
});
